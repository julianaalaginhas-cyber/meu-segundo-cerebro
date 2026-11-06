/* Ponte Segundo Cérebro — plugin do Obsidian (JavaScript puro, sem build).
 *
 * O que faz:
 *  - Envia cada nota criada/alterada para public.notas no Supabase (só se mudou: hash).
 *  - Remove da nuvem as notas apagadas; trata renomeações.
 *  - No "dispositivo principal": reconcilia tudo periodicamente, traz para
 *    "00 - Entrada" as memórias que o Claude/ChatGPT salvaram e cria os arquivos
 *    que o Claude pediu (fila pedidos_vault): cria arquivos novos (nunca sobrescreve)
 *    e, a pedido, edita, atualiza tarefas, move ou exclui notas existentes — sempre
 *    com trava de versão, cópia em "05 - Sistema/Backups/" e registro no histórico.
 *
 * Segurança:
 *  - Login com e-mail/senha do Supabase; a SENHA NUNCA é guardada.
 *  - A sessão (refresh token) fica no armazenamento LOCAL do aparelho
 *    (app.saveLocalStorage), que NÃO é sincronizado pelo Obsidian Sync.
 *  - Notas com `privado: true` (ou `cerebro: false`) e pastas excluídas nunca saem do Vault.
 *  - Usa só a chave pública + token da usuária: o RLS do Supabase protege os dados.
 */
const { Plugin, PluginSettingTab, Setting, Notice, TFile, requestUrl, Platform, normalizePath } = require("obsidian");

const DEFAULTS = {
  supabaseUrl: "",
  supabaseKey: "",
  pastasExcluidas: "05 - Sistema/Modelos",
  pastaEntrada: "00 - Entrada",
  intervaloMin: 10,
};
const LS_SESSAO = "ponte-segundo-cerebro:sessao";
const LS_PRINCIPAL = "ponte-segundo-cerebro:principal";
const LS_CONFIG = "ponte-segundo-cerebro:config-aplicada";
const NOTA_CONFIG = "05 - Sistema/⚙️ Configuração do Segundo Cérebro.md";
const NOTA_RESULTADO = "05 - Sistema/⚙️ Resultado da configuração.md";
const NOTA_HISTORICO = "05 - Sistema/📜 Histórico de alterações da IA.md";
const MAX_CHARS = 200000;
// Nenhuma IA altera, move ou exclui estes arquivos.
const PASTAS_PROTEGIDAS = ["05 - Sistema/Backups/", "05 - Sistema/Modelos/"];
const NOTAS_PROTEGIDAS = [NOTA_CONFIG, NOTA_RESULTADO, NOTA_HISTORICO];
const EDICOES = ["editar", "tarefa", "mover", "apagar", "imagem"];
const IMAGEM_RE = /\.(png|jpe?g|webp|gif)$/i;
const ORIGENS = { "944323a9-269c-4468-bdf0-01ea7e4b9613": "ChatGPT", "94c90271-9a50-4a65-b4d4-b345fa8043f5": "Claude" };
const nomeOrigem = (o) => ORIGENS[o] || (String(o || "").startsWith("claude-code") ? "Claude Code" : String(o || "").startsWith("teste") ? "teste" : "outro app");

function caminhoSeguro(c) {
  if (typeof c !== "string" || c.length < 4 || c.length > 300) return false;
  if (/(^\/|\\|\.\.\/|\/\.\.|^\.\.|\/\/|[<>:"|?*\x00-\x1f])/.test(c)) return false;
  if (/^\.obsidian\/snippets\/[^/]+\.css$/.test(c)) return true;
  return /\.(md|base)$/.test(c) && !/(^|\/)\./.test(c);
}

async function sha256(texto) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

module.exports = class PonteSegundoCerebro extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.fila = new Map();      // caminho -> "upsert" | "delete"
    this.timer = null;
    this.ocupado = false;
    this.status = this.addStatusBarItem();
    this.setStatus("🧠");

    this.addSettingTab(new Configuracoes(this.app, this));
    this.addCommand({ id: "sincronizar", name: "Sincronizar agora", callback: () => this.sincronizarTudo(true) });
    this.addCommand({ id: "entrar", name: "Entrar (login)", callback: () => this.abrirConfig() });
    this.addCommand({ id: "sair", name: "Sair (desconectar este aparelho)", callback: () => this.sair() });
    this.addCommand({ id: "configurar", name: "Aplicar configuração (favoritos, início, captura, diário)", callback: () => this.aplicarConfiguracao(true) });

    this.registerEvent(this.app.metadataCache.on("changed", (f) => this.agendar(f.path, "upsert")));
    this.registerEvent(this.app.vault.on("delete", (f) => { if (f instanceof TFile) this.agendar(f.path, "delete"); }));
    this.registerEvent(this.app.vault.on("rename", (f, antigo) => {
      if (!(f instanceof TFile)) return;
      this.agendar(antigo, "delete");
      this.agendar(f.path, "upsert");
    }));

    this.app.workspace.onLayoutReady(() => {
      // espera o Obsidian Sync assentar antes da primeira reconciliação
      setTimeout(() => this.sincronizarTudo(false), 15000);
      this.registerInterval(window.setInterval(() => this.sincronizarTudo(false),
        Math.max(2, Number(this.settings.intervaloMin) || 10) * 60000));
      // pedidos do Claude chegam mais rápido (a cada 2 min, só no principal)
      this.registerInterval(window.setInterval(() => this.verificarPedidos(), 120000));
    });
  }

  // ---------- preferências locais ----------
  get principal() {
    const v = this.app.loadLocalStorage(LS_PRINCIPAL);
    return v === null || v === undefined ? !Platform.isMobile : v === "1";
  }
  set principal(v) { this.app.saveLocalStorage(LS_PRINCIPAL, v ? "1" : "0"); }
  get sessao() { try { return JSON.parse(this.app.loadLocalStorage(LS_SESSAO) || "null"); } catch { return null; } }
  set sessao(s) { this.app.saveLocalStorage(LS_SESSAO, s ? JSON.stringify(s) : null); }

  setStatus(t) { this.status.setText(t); }
  abrirConfig() { this.app.setting.open(); this.app.setting.openTabById(this.manifest.id); }
  async salvarConfig() { await this.saveData(this.settings); }

  // ---------- autenticação ----------
  async auth(path, body) {
    const r = await requestUrl({
      url: `${this.settings.supabaseUrl}/auth/v1${path}`, method: "POST", throw: false,
      headers: { apikey: this.settings.supabaseKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.status >= 300) {
      const e = new Error(r.json?.error_description || r.json?.msg || `Erro ${r.status}`);
      e.status = r.status; e.code = r.json?.error_code || r.json?.error;
      throw e;
    }
    return r.json;
  }
  guardarSessao(d) {
    this.sessao = { access_token: d.access_token, refresh_token: d.refresh_token,
      expira: Date.now() + (d.expires_in || 3600) * 1000, user_id: d.user?.id, email: d.user?.email };
  }
  async entrar(email, senha) {
    this.guardarSessao(await this.auth("/token?grant_type=password", { email, password: senha }));
  }
  async sair() {
    this.sessao = null;
    this.setStatus("🧠 desconectado");
    new Notice("Segundo Cérebro: este aparelho foi desconectado.");
  }
  // Renova o acesso uma vez por hora. Só pede login de novo quando o Supabase diz que a sessão
  // acabou de verdade (400/401). Falha de internet (ex.: notebook acordando) não desloga:
  // tenta de novo no próximo ciclo. Uma renovação por vez, para não gastar o mesmo token duas vezes.
  async token() {
    const s = this.sessao;
    if (!s) return null;
    if (Date.now() < s.expira - 60000) return s.access_token;
    if (!this.renovando) this.renovando = this.renovar(s).finally(() => { this.renovando = null; });
    return this.renovando;
  }
  async renovar(s) {
    try {
      this.guardarSessao(await this.auth("/token?grant_type=refresh_token", { refresh_token: s.refresh_token }));
      return this.sessao.access_token;
    } catch (e) {
      const atual = this.sessao; // outro aparelho/janela pode ter renovado e salvo uma sessão nova
      if (atual && atual.refresh_token !== s.refresh_token && Date.now() < atual.expira - 60000) return atual.access_token;
      if (e.status === 400 || e.status === 401 || e.status === 403) {
        this.sessao = null;
        this.setStatus("🧠 desconectado");
        new Notice("Segundo Cérebro: a sessão expirou. Faça login de novo nas configurações do plugin.");
      } else {
        this.setStatus("🧠 ⚠︎ sem internet");
        console.warn("[Segundo Cérebro] não deu para renovar o acesso agora; tento de novo depois:", e.message);
      }
      return null;
    }
  }

  async rest(method, path, body, extraHeaders = {}) {
    const tk = await this.token();
    if (!tk) throw new Error("sem_login");
    const r = await requestUrl({
      url: `${this.settings.supabaseUrl}/rest/v1/${path}`, method, throw: false,
      headers: { apikey: this.settings.supabaseKey, Authorization: `Bearer ${tk}`,
        "Content-Type": "application/json", ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.status >= 300) throw new Error(`rest ${r.status}`);
    return r.status === 204 || !r.text ? null : r.json;
  }

  // ---------- regras ----------
  excluida(caminho) {
    if (!caminho.toLowerCase().endsWith(".md")) return true;
    if (caminho.split("/").some((p) => p.startsWith("."))) return true;
    if (caminho.startsWith("05 - Sistema/Backups/")) return true; // backups das telas não vão para a nuvem
    const pastas = this.settings.pastasExcluidas.split(/\n|,/).map((s) => s.trim()).filter(Boolean);
    return pastas.some((p) => caminho === p || caminho.startsWith(p.replace(/\/$/, "") + "/"));
  }

  async montarNota(file) {
    const cache = this.app.metadataCache.getFileCache(file) || {};
    const fm = cache.frontmatter ? { ...cache.frontmatter } : {};
    delete fm.position;
    if (fm.privado === true || fm.cerebro === false) return null;
    let texto = await this.app.vault.cachedRead(file);
    if (cache.frontmatterPosition) texto = texto.slice(cache.frontmatterPosition.end.offset).replace(/^\s+/, "");
    texto = texto.slice(0, MAX_CHARS);
    const propriedades = JSON.parse(JSON.stringify(fm)); // remove tipos não serializáveis
    const titulo = file.basename;
    const hash = await sha256(JSON.stringify([titulo, texto, propriedades]));
    return { usuario_id: this.sessao.user_id, caminho: file.path, titulo, conteudo: texto, propriedades, hash,
      modificado_em: new Date(file.stat.mtime).toISOString() };
  }

  // ---------- fila incremental ----------
  agendar(caminho, acao) {
    if (!caminho.toLowerCase().endsWith(".md")) return;
    this.fila.set(caminho, acao);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.processarFila(), 4000);
  }

  async processarFila() {
    if (this.ocupado || !this.sessao || !this.settings.supabaseUrl) return;
    this.ocupado = true;
    const itens = [...this.fila.entries()];
    this.fila.clear();
    try {
      for (const [caminho, acao] of itens) {
        const file = this.app.vault.getAbstractFileByPath(caminho);
        const nota = acao === "upsert" && file instanceof TFile && !this.excluida(caminho) ? await this.montarNota(file) : null;
        if (nota) {
          await this.rest("POST", "notas?on_conflict=usuario_id,caminho", [nota],
            { Prefer: "resolution=merge-duplicates,return=minimal" });
        } else {
          // apagada, excluída, ou marcada como privada → some da nuvem
          await this.rest("DELETE", `notas?caminho=eq.${encodeURIComponent(caminho)}`);
        }
      }
      this.setStatus(`🧠 ${new Date().toLocaleTimeString().slice(0, 5)}`);
    } catch (e) {
      for (const [c, a] of itens) if (!this.fila.has(c)) this.fila.set(c, a); // tenta de novo depois
      this.setStatus("🧠 ⚠︎");
      console.warn("[Segundo Cérebro] falha ao sincronizar:", e.message);
    } finally {
      this.ocupado = false;
    }
  }

  // ---------- reconciliação completa ----------
  async sincronizarTudo(manual) {
    if (!this.settings.supabaseUrl || !this.settings.supabaseKey) { if (manual) this.abrirConfig(); return; }
    if (!this.sessao) { if (manual) { new Notice("Segundo Cérebro: faça login primeiro."); this.abrirConfig(); } return; }
    if (this.ocupado) return;
    this.ocupado = true;
    this.setStatus("🧠 …");
    let enviadas = 0, removidas = 0, importadas = 0, criados = 0;
    try {
      const remotas = new Map();
      for (let de = 0; ; de += 1000) {
        const pagina = await this.rest("GET", `notas?select=caminho,hash&order=caminho&offset=${de}&limit=1000`);
        pagina.forEach((r) => remotas.set(r.caminho, r.hash));
        if (pagina.length < 1000) break;
      }
      const lote = [];
      const locais = new Set();
      for (const file of this.app.vault.getMarkdownFiles()) {
        if (this.excluida(file.path)) continue;
        const nota = await this.montarNota(file);
        if (!nota) continue;
        locais.add(file.path);
        if (remotas.get(file.path) !== nota.hash) lote.push(nota);
      }
      for (let i = 0; i < lote.length; i += 50) {
        await this.rest("POST", "notas?on_conflict=usuario_id,caminho", lote.slice(i, i + 50),
          { Prefer: "resolution=merge-duplicates,return=minimal" });
      }
      enviadas = lote.length;
      // Remoções em massa e importação só no dispositivo principal
      // (evita que um aparelho ainda sincronizando apague notas da nuvem ou duplique a Entrada).
      if (this.principal) {
        const sobrando = [...remotas.keys()].filter((c) => !locais.has(c));
        if (sobrando.length > 0 && sobrando.length > Math.max(20, remotas.size * 0.3) && !manual) {
          console.warn("[Segundo Cérebro] muitas remoções pendentes; aguardando sincronização manual.");
        } else {
          for (const c of sobrando) await this.rest("DELETE", `notas?caminho=eq.${encodeURIComponent(c)}`);
          removidas = sobrando.length;
        }
        importadas = await this.importarMemorias();
        criados = await this.aplicarPedidos();
        await this.aplicarConfiguracao(false);
      }
      this.setStatus(`🧠 ${new Date().toLocaleTimeString().slice(0, 5)}`);
      if (manual) new Notice(`Segundo Cérebro sincronizado: ${enviadas} enviadas, ${removidas} removidas, ${importadas} trazidas para a Entrada, ${criados} arquivo(s) criados pelo Claude.`);
    } catch (e) {
      this.setStatus("🧠 ⚠︎");
      if (manual) new Notice("Segundo Cérebro: não foi possível sincronizar (" + e.message + ").");
      console.warn("[Segundo Cérebro]", e.message);
    } finally {
      this.ocupado = false;
    }
  }

  // ---------- arquivos que o Claude pediu para criar ----------
  async verificarPedidos() {
    if (!this.principal || !this.sessao || this.ocupado || !this.settings.supabaseUrl) return;
    this.ocupado = true;
    try { await this.aplicarPedidos(); await this.aplicarConfiguracao(false); } catch (e) { console.warn("[Segundo Cérebro] pedidos:", e.message); }
    finally { this.ocupado = false; }
  }

  async garantirPasta(pasta) {
    const partes = pasta.split("/").filter(Boolean);
    let atual = "";
    for (const p of partes) {
      atual = atual ? `${atual}/${p}` : p;
      if (!this.app.vault.getAbstractFileByPath(atual) && !(await this.app.vault.adapter.exists(atual))) {
        await this.app.vault.createFolder(atual);
      }
    }
  }

  // Substitui SOMENTE telas do sistema (notas com cssclasses sc-painel/sc-app, painéis .base
  // em "05 - Sistema/Painéis" e snippets CSS). Sempre guarda uma cópia antes em
  // "05 - Sistema/Backups/<data-hora>/". Notas pessoais são recusadas.
  async substituirComBackup(caminho, conteudo) {
    const ehConfig = caminho.startsWith(".obsidian/");
    const real = ehConfig ? `${this.app.vault.configDir}/${caminho.slice(".obsidian/".length)}` : caminho;
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(real))) {
      const dir = real.split("/").slice(0, -1).join("/");
      if (ehConfig) { if (!(await adapter.exists(dir))) await adapter.mkdir(dir); await adapter.write(real, conteudo); }
      else { if (dir) await this.garantirPasta(dir); await this.app.vault.create(real, conteudo); }
      return "criado";
    }
    const atual = await adapter.read(real);
    const cabecalho = atual.startsWith("---") ? atual.split(/\n---\s*\n/)[0] : "";
    const telaDoSistema = (ehConfig && /^\.obsidian\/snippets\/[^/]+\.css$/.test(caminho))
      || (caminho.startsWith("05 - Sistema/Painéis/") && caminho.endsWith(".base"))
      || (caminho.endsWith(".md") && /cssclasses:[\s\S]*\bsc-(painel|app)\b/.test(cabecalho));
    if (!telaDoSistema) return "recusado: só telas do sistema podem ser substituídas";
    if (atual === conteudo) return "substituído (sem mudanças)";
    const carimbo = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "h");
    const nomeBackup = (ehConfig ? "config-" + caminho.slice(".obsidian/".length) : caminho).replace(/\//g, " ∕ ");
    const pastaBackup = `05 - Sistema/Backups/${carimbo}`;
    await this.garantirPasta(pastaBackup);
    let destino = `${pastaBackup}/${nomeBackup}`;
    for (let i = 2; await adapter.exists(destino); i++) destino = `${pastaBackup}/${i} - ${nomeBackup}`;
    await this.app.vault.create(destino, atual);
    if (ehConfig) await adapter.write(real, conteudo);
    else {
      const f = this.app.vault.getAbstractFileByPath(real);
      if (f instanceof TFile) await this.app.vault.modify(f, conteudo); else await adapter.write(real, conteudo);
    }
    return `substituído (backup em ${destino})`;
  }

  // ---------- edição de notas existentes pedida pelo Claude/ChatGPT ----------
  // Regras comuns: só .md fora de pastas protegidas, nunca nota privada, só se a nota ainda for
  // a mesma versão que a IA leu (hash do espelho), e sempre uma cópia antes em
  // "05 - Sistema/Backups/<data-hora>/". Tudo fica registrado no histórico (sem conteúdo).
  protegido(caminho) {
    return !caminho.endsWith(".md") || caminho.startsWith(".obsidian/")
      || PASTAS_PROTEGIDAS.some((p) => caminho.startsWith(p)) || NOTAS_PROTEGIDAS.includes(caminho);
  }

  async conferirNota(caminho, baseHash) {
    if (this.protegido(caminho)) return { erro: "recusado: nota protegida (configuração, histórico, modelos ou backups)" };
    const f = this.app.vault.getAbstractFileByPath(caminho);
    if (!(f instanceof TFile)) return { erro: "recusado: a nota não existe (nada foi criado)" };
    const nota = await this.montarNota(f);
    if (!nota) return { erro: "recusado: nota privada" };
    if (!baseHash || nota.hash !== baseHash) return { erro: "recusado: a nota mudou depois que a IA leu (nada foi alterado)" };
    return { f };
  }

  async guardarBackup(caminho, texto) {
    const carimbo = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "h");
    const pastaBackup = `05 - Sistema/Backups/${carimbo}`;
    await this.garantirPasta(pastaBackup);
    const nomeBackup = caminho.replace(/\//g, " ∕ ");
    let destino = `${pastaBackup}/${nomeBackup}`;
    for (let i = 2; await this.app.vault.adapter.exists(destino); i++) destino = `${pastaBackup}/${i} - ${nomeBackup}`;
    await this.app.vault.create(destino, texto);
    return destino;
  }

  // Edita: arquivo inteiro (conteudo) e/ou mudanças pequenas em dados:
  //   propriedades {k: v | null}, trocar [{de, para}], acrescentar "texto", item+concluida (checklist).
  async editarComBackup(caminho, conteudo, baseHash, dados) {
    const ok = await this.conferirNota(caminho, baseHash);
    if (ok.erro) return ok.erro;
    const f = ok.f;
    dados = dados && typeof dados === "object" ? dados : {};
    const temConteudo = typeof conteudo === "string" && conteudo.trim().length > 0;
    const props = dados.propriedades && typeof dados.propriedades === "object" ? dados.propriedades : null;
    if (!temConteudo && !props && !dados.trocar && !dados.acrescentar && !dados.item) return "recusado: nada para alterar";
    const atual = await this.app.vault.read(f);
    let novo = temConteudo ? conteudo : atual;
    const feito = [];
    if (temConteudo) feito.push("nota reescrita");

    // corpo = texto depois do frontmatter (trocas e checklist nunca mexem nas propriedades)
    const m = novo.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/);
    const cabeca = m ? m[0] : "";
    let corpo = novo.slice(cabeca.length);
    for (const t of Array.isArray(dados.trocar) ? dados.trocar : []) {
      if (typeof t?.de !== "string" || !t.de || typeof t.para !== "string") return "recusado: troca inválida";
      const n = corpo.split(t.de).length - 1;
      if (n !== 1) return `recusado: o trecho "${t.de.slice(0, 40)}" aparece ${n} vez(es) (nada foi alterado)`;
      corpo = corpo.replace(t.de, () => t.para);
    }
    if (Array.isArray(dados.trocar) && dados.trocar.length) feito.push(`${dados.trocar.length} trecho(s) trocado(s)`);
    if (typeof dados.item === "string" && dados.item.trim()) {
      const alvo = dados.item.trim().toLowerCase();
      const linhas = corpo.split("\n");
      const idx = linhas.map((l, i) => (/^\s*[-*+] \[[ xX]\] /.test(l) && l.toLowerCase().includes(alvo) ? i : -1)).filter((i) => i >= 0);
      if (idx.length !== 1) return `recusado: ${idx.length} itens de checklist com esse texto (nada foi alterado)`;
      linhas[idx[0]] = linhas[idx[0]].replace(/\[[ xX]\]/, dados.concluida ? "[x]" : "[ ]");
      corpo = linhas.join("\n");
      feito.push(dados.concluida ? "item marcado como feito" : "item desmarcado");
    }
    if (typeof dados.acrescentar === "string" && dados.acrescentar.trim()) {
      corpo = corpo.replace(/\s*$/, "") + "\n\n" + dados.acrescentar.trim() + "\n";
      feito.push("texto acrescentado");
    }
    novo = cabeca + corpo;

    let mudouProps = false;
    if (props) {
      const fmAtual = { ...(this.app.metadataCache.getFileCache(f)?.frontmatter || {}) };
      mudouProps = Object.entries(props).some(([k, v]) =>
        v === null ? k in fmAtual : JSON.stringify(fmAtual[k]) !== JSON.stringify(v));
    }
    if (novo === atual && !mudouProps) return "editado (sem mudanças)";

    const backup = await this.guardarBackup(caminho, atual);
    if (novo !== atual) await this.app.vault.modify(f, novo);
    if (props && mudouProps) {
      await this.app.fileManager.processFrontMatter(f, (fm) => {
        for (const [k, v] of Object.entries(props)) {
          if (k === "position") continue;
          if (v === null) delete fm[k]; else fm[k] = v;
        }
      });
      feito.push("propriedades: " + Object.keys(props).join(", "));
    }
    return `editado: ${feito.join("; ")} (backup em ${backup})`;
  }

  // Move/renomeia sem sobrescrever. O Obsidian atualiza os links internos se a opção
  // "Atualizar links internos automaticamente" estiver ligada.
  async moverNota(caminho, destino, baseHash) {
    if (!destino || !caminhoSeguro(destino) || this.protegido(destino)) return "recusado: destino não permitido";
    const ok = await this.conferirNota(caminho, baseHash);
    if (ok.erro) return ok.erro;
    if (this.app.vault.getAbstractFileByPath(destino) || await this.app.vault.adapter.exists(destino)) {
      return "recusado: já existe um arquivo no destino (nada foi movido)";
    }
    const pasta = destino.split("/").slice(0, -1).join("/");
    if (pasta) await this.garantirPasta(pasta);
    await this.app.fileManager.renameFile(ok.f, destino);
    const links = this.app.vault.getConfig?.("alwaysUpdateLinks");
    return `movido para ${destino}` + (links === false
      ? " (atenção: links internos não atualizados; ligue 'Atualizar links internos automaticamente' em Configurações › Arquivos e links)"
      : " (links internos atualizados)");
  }

  // Exclui: cópia em Backups e arquivo para a lixeira (recuperável).
  async apagarComBackup(caminho, baseHash) {
    if (caminho.startsWith("05 - Sistema/")) return "recusado: notas de '05 - Sistema' não podem ser excluídas";
    const ok = await this.conferirNota(caminho, baseHash);
    if (ok.erro) return ok.erro.replace("nada foi alterado", "nada foi apagado");
    const backup = await this.guardarBackup(caminho, await this.app.vault.read(ok.f));
    if (this.app.fileManager.trashFile) await this.app.fileManager.trashFile(ok.f);
    else await this.app.vault.trash(ok.f, true);
    return `apagado (foi para a lixeira; cópia em ${backup})`;
  }

  // Imagem pedida pela IA: o servidor já conferiu e guardou no bucket privado; aqui ela é baixada,
  // conferida de novo, gravada no Vault sem sobrescrever nada e (se pedido) ligada à nota.
  // A cópia temporária na nuvem é apagada no fim.
  async salvarImagem(caminho, dados) {
    if (!IMAGEM_RE.test(caminho) || /(^\/|\\|\.\.|\/\/)/.test(caminho) || caminho.split("/").some((x) => x.startsWith("."))
        || PASTAS_PROTEGIDAS.some((x) => caminho.startsWith(x))) return "recusado: caminho de imagem não permitido";
    const objeto = String(dados.objeto || "");
    if (!objeto.startsWith(`${this.sessao?.user_id}/`) || objeto.includes("..")) return "recusado: imagem inválida";
    const tk = await this.token();
    if (!tk) throw new Error("sem_login");
    const base = `${this.settings.supabaseUrl}/storage/v1/object`;
    const cab = { apikey: this.settings.supabaseKey, Authorization: `Bearer ${tk}` };
    const r = await requestUrl({ url: `${base}/authenticated/vault-imagens/${objeto}`, method: "GET", headers: cab, throw: false });
    if (r.status >= 300) return `erro: não consegui baixar a imagem (${r.status})`;
    const b = new Uint8Array(r.arrayBuffer);
    const ehImagem = (b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0x47 && b[1] === 0x49)
      || (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45);
    if (!ehImagem || b.length > 10 * 1024 * 1024) return "recusado: o arquivo não é uma imagem válida";
    const pasta = caminho.split("/").slice(0, -1).join("/");
    if (pasta) await this.garantirPasta(pasta);
    const ext = caminho.match(IMAGEM_RE)[0];
    const semExt = caminho.slice(0, -ext.length);
    let destino = caminho;
    for (let i = 2; this.app.vault.getAbstractFileByPath(destino) || await this.app.vault.adapter.exists(destino); i++) destino = `${semExt} ${i}${ext}`;
    await this.app.vault.createBinary(destino, r.arrayBuffer);
    let ligado = "";
    if (dados.nota) {
      const nota = normalizePath(String(dados.nota));
      const prop = String(dados.propriedade || "foto");
      const res = await this.editarComBackup(nota, "", dados.nota_hash, { propriedades: { [prop]: `[[${destino}]]` } });
      ligado = res.startsWith("editado") ? `; ligada em '${prop}' de ${nota}` : `; NÃO ligada à nota (${res})`;
    }
    try { await requestUrl({ url: `${base}/vault-imagens/${objeto}`, method: "DELETE", headers: cab, throw: false }); } catch {}
    return `imagem salva em ${destino}${ligado}`;
  }

  // Histórico legível no próprio Vault: data, ação, nota, quem pediu e resultado. Nunca o conteúdo.
  async registrarHistorico(linhas) {
    if (!linhas.length) return;
    let f = this.app.vault.getAbstractFileByPath(NOTA_HISTORICO);
    if (!(f instanceof TFile)) {
      await this.garantirPasta("05 - Sistema");
      f = await this.app.vault.create(NOTA_HISTORICO,
        "---\ntipo: sistema\n---\n# 📜 Histórico de alterações da IA\n\n" +
        "> O que o Claude/ChatGPT mudou nas notas existentes. Só caminhos e resultados, nunca o conteúdo.\n" +
        "> Para desfazer uma edição ou exclusão, abra a cópia indicada em `05 - Sistema/Backups/`.\n\n");
    }
    await this.app.vault.process(f, (t) => t.replace(/\s*$/, "\n") + linhas.join("\n") + "\n");
  }

  // ---------- configuração do Obsidian (favoritos, página inicial, captura, diário) ----------
  // Lê o bloco JSON da nota de configuração. Aplica uma vez por versão, só no dispositivo
  // principal (ou quando a usuária roda o comando). Sempre guarda cópia dos arquivos antes.
  async lerJsonConfig(rel) {
    const real = `${this.app.vault.configDir}/${rel}`;
    if (!(await this.app.vault.adapter.exists(real))) return null;
    try { return JSON.parse(await this.app.vault.adapter.read(real)); } catch { return null; }
  }
  async gravarJsonConfig(rel, dados, pastaBackup) {
    const adapter = this.app.vault.adapter;
    const real = `${this.app.vault.configDir}/${rel}`;
    if (await adapter.exists(real)) {
      await this.garantirPasta(pastaBackup);
      let destino = `${pastaBackup}/config-${rel.replace(/\//g, " ∕ ")}`;
      for (let i = 2; await adapter.exists(destino); i++) destino = `${pastaBackup}/${i} - config-${rel.replace(/\//g, " ∕ ")}`;
      await this.app.vault.create(destino, await adapter.read(real));
    }
    const dir = real.split("/").slice(0, -1).join("/");
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    await adapter.write(real, JSON.stringify(dados, null, 2));
  }
  async recarregarPlugin(id, antesDeLigar) {
    const pl = this.app.plugins;
    const estava = !!pl.plugins[id];
    if (estava) await pl.disablePlugin(id);
    await antesDeLigar();
    if (pl.enablePluginAndSave) await pl.enablePluginAndSave(id); else await pl.enablePlugin(id);
    return estava;
  }

  async aplicarConfiguracao(manual) {
    const f = this.app.vault.getAbstractFileByPath(NOTA_CONFIG);
    if (!(f instanceof TFile)) { if (manual) new Notice("Segundo Cérebro: nota de configuração não encontrada."); return; }
    if (!manual && !this.principal) return;
    let cfg;
    try { cfg = JSON.parse((await this.app.vault.read(f)).match(/```json\n([\s\S]*?)\n```/)[1]); }
    catch (e) { if (manual) new Notice("Segundo Cérebro: a configuração está com erro de formato."); return; }
    const aplicada = Number(this.app.loadLocalStorage(LS_CONFIG) || 0);
    if (!manual && Number(cfg.versao) <= aplicada) return;

    const carimbo = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "h");
    const backup = `05 - Sistema/Backups/${carimbo} configuração`;
    const log = [];
    const passo = async (nome, fn) => {
      try { log.push(`✅ ${nome}: ${(await fn()) || "ok"}`); }
      catch (e) { log.push(`⚠️ ${nome}: ${String(e && e.message || e).slice(0, 160)}`); }
    };
    const internos = this.app.internalPlugins;
    const ligarInterno = async (id) => {
      const w = internos?.plugins?.[id];
      if (w && !w.enabled) { if (w.enable) await w.enable(true); }
      return w;
    };

    if (cfg.organizar) await passo("Organização das pastas", async () => {
      const feitos = [];
      const fm = this.app.fileManager;
      for (const m of cfg.organizar.mover || []) {
        const f = this.app.vault.getAbstractFileByPath(m.de);
        if (!f) { continue; }                                   // já movido ou não existe
        if (this.app.vault.getAbstractFileByPath(m.para)) { feitos.push(`mantido: ${m.de} (já existe ${m.para})`); continue; }
        const pai = m.para.split("/").slice(0, -1).join("/");
        if (pai) await this.garantirPasta(pai);
        await fm.renameFile(f, m.para);                          // atualiza os links para a nota/pasta movida
        feitos.push(`movido: ${m.de} → ${m.para}`);
      }
      const usado = (caminho) => Object.values(this.app.metadataCache.resolvedLinks || {}).some((alvos) => alvos && alvos[caminho]);
      for (const l of cfg.organizar.lixeira || []) {
        const f = this.app.vault.getAbstractFileByPath(l.caminho);
        if (!(f instanceof TFile)) continue;
        if (l.condicao === "canvas_vazio") {
          let vazio = false;
          try { const j = JSON.parse((await this.app.vault.read(f)) || "{}"); vazio = !(j.nodes || []).length && !(j.edges || []).length; } catch { vazio = false; }
          if (!vazio) { feitos.push(`mantido: ${l.caminho} (não está vazio)`); continue; }
        } else if (l.condicao === "sem_uso") {
          if (usado(l.caminho)) { feitos.push(`mantido: ${l.caminho} (ainda é usado)`); continue; }
        } else continue;                                          // sem condição conhecida, nunca apaga
        try { await this.app.vault.trash(f, true); } catch { await this.app.vault.trash(f, false); }
        feitos.push(`lixeira: ${l.caminho}`);
      }
      return feitos.length ? "\n  - " + feitos.join("\n  - ") : "nada a mudar";
    });

    if (Array.isArray(cfg.pastas)) await passo("Pastas", async () => {
      for (const pasta of cfg.pastas) if (typeof pasta === "string" && caminhoSeguro(pasta + "/x.md")) await this.garantirPasta(pasta);
      return cfg.pastas.join(", ");
    });

    if (cfg.diario) await passo("Diário (notas diárias)", async () => {
      await this.garantirPasta(cfg.diario.pasta);
      const w = await ligarInterno("daily-notes");
      const atual = (await this.lerJsonConfig("daily-notes.json")) || {};
      const novo = { ...atual, folder: cfg.diario.pasta, template: cfg.diario.modelo, format: cfg.diario.formato };
      await this.gravarJsonConfig("daily-notes.json", novo, backup);
      if (w?.instance?.options) Object.assign(w.instance.options, novo);
      return `pasta ${cfg.diario.pasta}`;
    });

    if (cfg.favoritos) await passo("Favoritos (menu lateral)", async () => {
      const w = await ligarInterno("bookmarks");
      const atual = (await this.lerJsonConfig("bookmarks.json")) || { items: [] };
      const itens = Array.isArray(atual.items) ? atual.items : [];
      const base = Date.now();
      const grupo = { type: "group", ctime: base, title: cfg.favoritos.grupo,
        items: cfg.favoritos.itens.map((x, i) => ({ type: "file", ctime: base + i + 1, path: x.caminho, title: x.titulo, ...(x.subpath ? { subpath: x.subpath } : {}) })) };
      const outros = itens.filter((x) => !(x.type === "group" && x.title === cfg.favoritos.grupo));
      const novo = { ...atual, items: [grupo, ...outros] };
      const inst = w?.instance;
      if (inst && Array.isArray(inst.items) && typeof inst.saveData === "function") {
        await this.gravarJsonConfig("bookmarks.json", atual, backup); // backup + mantém arquivo igual
        inst.items.splice(0, inst.items.length, ...novo.items);
        await inst.saveData();
        if (inst.onItemsChanged) inst.onItemsChanged(true);
        if (inst.trigger) inst.trigger("changed");
      } else {
        if (w?.disable) await w.disable(true);
        await this.gravarJsonConfig("bookmarks.json", novo, backup);
        if (w?.enable) await w.enable(true);
      }
      return `${grupo.items.length} atalhos (seus favoritos anteriores foram mantidos)`;
    });

    if (cfg.inicio) await passo("Página inicial (Homepage)", async () => {
      if (!this.app.plugins.manifests?.homepage) return "plugin Homepage não instalado — pulei";
      await this.recarregarPlugin("homepage", async () => {
        const atual = await this.lerJsonConfig("plugins/homepage/data.json");
        const base = atual && atual.version === 5 ? atual : { version: 5, homepages: {}, separateMobile: false, ...(atual?.version === 5 ? atual : {}) };
        const hp = base.homepages?.["Main Homepage"] || {};
        base.homepages = { ...(base.homepages || {}), "Main Homepage": {
          value: "Home.md", kind: "File", openOnStartup: true, openMode: "Replace all open notes", manualOpenMode: "Keep open notes",
          view: "Default view", revertView: true, openWhenEmpty: false, openOnNewTab: false, refreshDataview: false, autoCreate: false,
          autoScroll: false, pin: false, commands: [], alwaysApply: false, hideReleaseNotes: false,
          ...hp, value: cfg.inicio.nota + ".md", kind: "File", openOnStartup: true, view: cfg.inicio.modo } };
        await this.gravarJsonConfig("plugins/homepage/data.json", base, backup);
      });
      return `abre "${cfg.inicio.nota}" em modo leitura`;
    });

    if (cfg.captura) await passo("Captura rápida (QuickAdd)", async () => {
      if (!this.app.plugins.manifests?.quickadd) return "plugin QuickAdd não instalado — pulei";
      let n = 0;
      await this.recarregarPlugin("quickadd", async () => {
        const atual = (await this.lerJsonConfig("plugins/quickadd/data.json")) || {};
        const ids = new Set(cfg.captura.escolhas.map((c) => c.id));
        const mantidas = (Array.isArray(atual.choices) ? atual.choices : []).filter((c) => !ids.has(c.id));
        const novo = { ...atual, choices: [...cfg.captura.escolhas, ...mantidas] };
        if (cfg.captura.iconeNaBarra) novo.enableRibbonIcon = true;
        n = cfg.captura.escolhas.length;
        await this.gravarJsonConfig("plugins/quickadd/data.json", novo, backup);
      });
      return `${n} opções de captura (as suas anteriores foram mantidas)`;
    });

    this.app.saveLocalStorage(LS_CONFIG, String(cfg.versao));
    const texto = `---\ntipo: configuracao\n---\n# ⚙️ Resultado da configuração\n\nVersão ${cfg.versao} aplicada em ${carimbo}.\n\n${log.map((l) => "- " + l).join("\n")}\n\nCópias dos arquivos anteriores: \`${backup}\`\n`;
    await this.app.vault.adapter.write(NOTA_RESULTADO, texto);
    new Notice("Segundo Cérebro configurado:\n" + log.join("\n"), 12000);
  }

  async aplicarPedidos() {
    const pend = await this.rest("GET", "pedidos_vault?select=id,caminho,conteudo,acao,base_hash,dados,destino,origem&aplicado_em=is.null&order=criado_em&limit=50");
    if (!pend?.length) return 0;
    let n = 0;
    const historico = [];
    for (const p of pend) {
      let resultado;
      try {
        const caminho = normalizePath(p.caminho);
        if (p.acao === "imagem") {
          resultado = await this.salvarImagem(caminho, p.dados || {});
          if (resultado.startsWith("imagem salva")) n++;
        } else if (!caminhoSeguro(caminho)) {
          resultado = "recusado: caminho não permitido";
        } else if (p.acao === "substituir") {
          resultado = await this.substituirComBackup(caminho, p.conteudo);
          if (resultado.startsWith("substituído") || resultado === "criado") n++;
        } else if (p.acao === "editar" || p.acao === "tarefa") {
          resultado = await this.editarComBackup(caminho, p.conteudo, p.base_hash, p.dados);
          if (resultado.startsWith("editado:")) n++;
        } else if (p.acao === "mover") {
          resultado = await this.moverNota(caminho, p.destino ? normalizePath(p.destino) : "", p.base_hash);
          if (resultado.startsWith("movido")) n++;
        } else if (p.acao === "apagar") {
          resultado = await this.apagarComBackup(caminho, p.base_hash);
          if (resultado.startsWith("apagado")) n++;
        } else if (EDICOES.includes(p.acao)) {
          resultado = "recusado: ação desconhecida (atualize o plugin)";
        } else if (caminho.startsWith(".obsidian/")) {
          const real = `${this.app.vault.configDir}/${caminho.slice(".obsidian/".length)}`;
          const dir = real.split("/").slice(0, -1).join("/");
          if (await this.app.vault.adapter.exists(real)) resultado = "já existia (não alterado)";
          else {
            if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
            await this.app.vault.adapter.write(real, p.conteudo);
            resultado = "criado"; n++;
          }
        } else if (this.app.vault.getAbstractFileByPath(caminho) || await this.app.vault.adapter.exists(caminho)) {
          resultado = "já existia (não alterado)";
        } else {
          const pasta = caminho.split("/").slice(0, -1).join("/");
          if (pasta) await this.garantirPasta(pasta);
          await this.app.vault.create(caminho, p.conteudo);
          resultado = "criado"; n++;
        }
      } catch (e) {
        resultado = "erro: " + String(e.message || e).slice(0, 120);
      }
      const edicao = EDICOES.includes(p.acao);
      // Nas edições, o conteúdo enviado não fica guardado na nuvem depois de aplicado.
      await this.rest("PATCH", `pedidos_vault?id=eq.${p.id}`,
        { aplicado_em: new Date().toISOString(), resultado, ...(edicao ? { conteudo: "", dados: null } : {}) },
        { Prefer: "return=minimal" });
      if (edicao) {
        const quando = new Date().toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
        historico.push(`- ${quando} · **${p.acao}** · \`${p.caminho}\`${p.destino ? ` → \`${p.destino}\`` : ""} · ${nomeOrigem(p.origem)} · ${resultado}`);
      }
    }
    try { await this.registrarHistorico(historico); } catch (e) { console.warn("[Segundo Cérebro] histórico:", e.message); }
    if (n) new Notice(`Segundo Cérebro: ${n} arquivo(s) criado(s), atualizado(s), movido(s) ou apagado(s) pela IA.`);
    return n;
  }

  // ---------- o que as IAs salvaram → 00 - Entrada ----------
  async importarMemorias() {
    const pendentes = await this.rest("GET",
      "memorias?select=id,titulo,conteudo,categoria,fonte,criado_em&importado_em=is.null&order=criado_em&limit=100");
    if (!pendentes?.length) return 0;
    const pasta = normalizePath(this.settings.pastaEntrada || "00 - Entrada");
    if (!this.app.vault.getAbstractFileByPath(pasta)) await this.app.vault.createFolder(pasta);
    let n = 0;
    for (const m of pendentes) {
      const base = (m.titulo || "Memória").replace(/[\\/:*?"<>|#^\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "Memória";
      let caminho = normalizePath(`${pasta}/${base}.md`);
      for (let i = 2; this.app.vault.getAbstractFileByPath(caminho); i++) caminho = normalizePath(`${pasta}/${base} (${i}).md`);
      const yaml = (v) => JSON.stringify(v ?? "");
      const corpo = `---\ntipo: memoria\nfonte: ${yaml(m.fonte)}\ncategoria: ${yaml(m.categoria)}\ncriado_em: ${yaml(String(m.criado_em).slice(0, 10))}\nid_memoria: ${yaml(m.id)}\n---\n${m.conteudo}\n`;
      await this.app.vault.create(caminho, corpo);
      await this.rest("PATCH", `memorias?id=eq.${m.id}`, { importado_em: new Date().toISOString() },
        { Prefer: "return=minimal" });
      n++;
    }
    if (n) new Notice(`Segundo Cérebro: ${n} anotação(ões) nova(s) em "${pasta}".`);
    return n;
  }
};

class Configuracoes extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    const p = this.plugin;
    containerEl.empty();
    containerEl.createEl("h2", { text: "🧠 Ponte Segundo Cérebro" });

    const s = p.sessao;
    if (s) {
      new Setting(containerEl).setName("Conectado").setDesc(`Como ${s.email || "usuária"} neste aparelho.`)
        .addButton((b) => b.setButtonText("Sincronizar agora").setCta().onClick(() => p.sincronizarTudo(true)))
        .addButton((b) => b.setButtonText("Sair").onClick(async () => { await p.sair(); this.display(); }));
    } else {
      let email = "", senha = "";
      new Setting(containerEl).setName("E-mail").addText((t) => t.setPlaceholder("seu e-mail do Supabase").onChange((v) => (email = v.trim())));
      new Setting(containerEl).setName("Senha").setDesc("Não é guardada. Só a sessão fica salva neste aparelho.")
        .addText((t) => { t.inputEl.type = "password"; t.onChange((v) => (senha = v)); });
      new Setting(containerEl).addButton((b) => b.setButtonText("Entrar").setCta().onClick(async () => {
        try { await p.entrar(email, senha); new Notice("Conectado!"); this.display(); p.sincronizarTudo(true); }
        catch (e) { new Notice("Não foi possível entrar: " + e.message); }
      }));
    }

    new Setting(containerEl).setName("Este é o dispositivo principal")
      .setDesc("Liga no computador. O principal faz a limpeza completa e traz o que as IAs salvaram para a Entrada.")
      .addToggle((t) => t.setValue(p.principal).onChange((v) => (p.principal = v)));
    new Setting(containerEl).setName("Pastas que NUNCA vão para a nuvem").setDesc("Uma por linha. Dica: em qualquer nota, a propriedade `privado: true` também impede o envio.")
      .addTextArea((t) => t.setValue(p.settings.pastasExcluidas).onChange(async (v) => { p.settings.pastasExcluidas = v; await p.salvarConfig(); }));
    new Setting(containerEl).setName("Pasta de entrada").addText((t) => t.setValue(p.settings.pastaEntrada)
      .onChange(async (v) => { p.settings.pastaEntrada = v.trim() || "00 - Entrada"; await p.salvarConfig(); }));

    containerEl.createEl("h3", { text: "Avançado" });
    new Setting(containerEl).setName("URL do Supabase").addText((t) => t.setValue(p.settings.supabaseUrl)
      .onChange(async (v) => { p.settings.supabaseUrl = v.trim().replace(/\/$/, ""); await p.salvarConfig(); }));
    new Setting(containerEl).setName("Chave pública (publishable)").setDesc("Chave pública do projeto (não é segredo).")
      .addText((t) => t.setValue(p.settings.supabaseKey).onChange(async (v) => { p.settings.supabaseKey = v.trim(); await p.salvarConfig(); }));
  }
}
