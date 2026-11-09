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
const { Plugin, PluginSettingTab, Setting, Notice, TFile, requestUrl, Platform, normalizePath, Modal, MarkdownRenderChild } = require("obsidian");

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
    this.addCommand({ id: "vencimentos", name: "Verificar vencimentos agora", callback: () => this.verificarVencimentos(true) });

    // Agenda semanal por horário: bloco ```agenda-semana``` em qualquer nota.
    instalarEstiloAgenda();
    this.register(() => document.getElementById(ID_ESTILO_AGENDA)?.remove());
    this.registerMarkdownCodeBlockProcessor("agenda-semana", (fonte, el, ctx) => {
      ctx.addChild(new AgendaSemana(this, el, fonte));
    });

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
      // avisos de vencimento (documentos, contratos, procurações, prazos): ao abrir e a cada 6 h
      setTimeout(() => { this.verificarVencimentos(false); this.limparPastasVazias().catch(() => {}); }, 60000);
      this.registerInterval(window.setInterval(() => this.verificarVencimentos(false), 6 * 3600000));
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
    // Em "05 - Sistema" só pode sair um painel .base que deixou de ser usado (o servidor das IAs só aceita notas .md).
    const painel = /^05 - Sistema\/Painéis\/[^/]+\.base$/.test(caminho);
    if (caminho.startsWith("05 - Sistema/") && !painel) return "recusado: notas de '05 - Sistema' não podem ser excluídas";
    let ok;
    if (painel) {  // painel .base: mesma trava de versão, sem a regra "só .md" das notas
      const f = this.app.vault.getAbstractFileByPath(caminho);
      const nota = f instanceof TFile ? await this.montarNota(f) : null;
      ok = !nota ? { erro: "recusado: a nota não existe (nada foi criado)" }
        : nota.hash !== baseHash ? { erro: "recusado: a nota mudou depois que a IA leu (nada foi alterado)" } : { f };
    } else ok = await this.conferirNota(caminho, baseHash);
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
    try { await this.limparPastasVazias(); } catch (e) { console.warn("[Segundo Cérebro] pastas vazias:", e.message); }
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

  // ---------- pastas que ficaram vazias depois que a IA moveu notas ----------
  // Só considera as pastas de ORIGEM das notas movidas (ou apagadas) pela IA (lidas do histórico), e só apaga
  // pasta realmente vazia. Nunca mexe nas pastas de nível 1, nas protegidas nem nas pastas
  // que a configuração manda manter (Agenda, Diário, Treinos…). Nenhum arquivo é apagado.
  async limparPastasVazias() {
    if (!this.principal) return;
    const h = this.app.vault.getAbstractFileByPath(NOTA_HISTORICO);
    if (!(h instanceof TFile)) return;
    const texto = await this.app.vault.cachedRead(h);
    const origens = new Set();
    for (const m of texto.matchAll(/\*\*(?:mover|apagar)\*\* · `([^`]+)`(?: → `[^`]+`)? · [^\n]*(?:movido para|apagado \()/g)) {
      const partes = m[1].split("/").slice(0, -1);
      while (partes.length >= 2) { origens.add(partes.join("/")); partes.pop(); }
    }
    if (!origens.size) return;
    let manter = [this.settings.pastaEntrada, "07 - Agenda"];
    const cfgF = this.app.vault.getAbstractFileByPath(NOTA_CONFIG);
    if (cfgF instanceof TFile) {
      try { manter = manter.concat(JSON.parse((await this.app.vault.cachedRead(cfgF)).match(/```json\n([\s\S]*?)\n```/)[1]).pastas || []); } catch {}
    }
    // das mais fundas para as mais rasas, para que a pasta-mãe fique vazia depois das filhas
    const lista = [...origens].sort((a, b) => b.split("/").length - a.split("/").length);
    const removidas = [];
    for (const pasta of lista) {
      if (manter.includes(pasta) || PASTAS_PROTEGIDAS.some((p) => (pasta + "/").startsWith(p))) continue;
      const f = this.app.vault.getAbstractFileByPath(pasta);
      if (!f || f instanceof TFile || !Array.isArray(f.children) || f.children.length) continue;
      await this.app.vault.delete(f, false);
      removidas.push(pasta);
    }
    if (removidas.length) console.log("[Segundo Cérebro] pastas vazias removidas:", removidas);
  }

  // ---------- avisos de vencimento ----------
  // Para cada nota com `vencimento` (ou `validade`) de um tipo acompanhado, cria UMA tarefa na
  // Agenda quando faltar `alerta_dias` (ou o padrão do tipo). Nunca repete o mesmo aviso
  // (nota + data); se a data mudar (renovação), um novo aviso vale para a nova data.
  // Só no dispositivo principal. Não cria avisos de coisas vencidas há mais de 30 dias.
  async verificarVencimentos(manual) {
    if (!manual && !this.principal) return;
    if (this.verificandoVenc) return;
    this.verificandoVenc = true;
    try {
      const hoje = isoDia(new Date());
      const feitos = this.settings.alertas || (this.settings.alertas = {});
      const criados = [];
      for (const f of this.app.vault.getMarkdownFiles()) {
        if (f.path.startsWith("05 - Sistema/") || f.path.startsWith("07 - Agenda/")) continue;
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
        if (!fm) continue;
        const tipo = String(fm.tipo || "");
        const padrao = DIAS_ALERTA[tipo];
        if (padrao === undefined && fm.alerta_dias == null) continue;
        if (fm.alerta === false || fm.feita === true) continue;  // desligado ou já concluído (caixinha ✓)
        if (/encerrad|revogad|substitu|feit|conclu|cancelad|cumprid|resolvid|arquivad|baixad/i.test(String(fm.status || ""))) continue;
        // processos: o próximo prazo fica em `prazo`; o resto usa `vencimento` (ou `validade`)
        const venc = dataIsoDe(tipo === "processo" ? fm.prazo : (fm.vencimento ?? fm.validade));
        if (!venc) continue;
        const dias = Number.isFinite(Number(fm.alerta_dias)) && fm.alerta_dias !== "" ? Number(fm.alerta_dias) : padrao ?? 60;
        if (hoje < somarDias(venc, -dias)) continue;          // ainda não é hora de avisar
        if (somarDias(venc, 30) < hoje) continue;             // venceu há mais de 30 dias
        const chave = `${f.path}|${venc}`;
        if (feitos[chave]) continue;
        const nome = `⏰ ${tipo === "processo" ? "Prazo" : "Vence"} ${brData(venc)} - ${f.basename}`.replace(/[\\/:*?"<>|#^[\]]/g, "-").slice(0, 140).trim();
        const caminho = `07 - Agenda/${nome}.md`;
        if (!this.app.vault.getAbstractFileByPath(caminho)) {
          const link = `[[${f.path.replace(/\.md$/, "")}|${f.basename}]]`;
          const area = f.path.startsWith("02 - Trabalho/") ? "trabalho" : "vida";
          const conteudo = "---\n" +
            `tipo: tarefa\nfeita: false\ndata: ${hoje}\nprazo: ${venc}\narea: ${area}\nprioridade: alta\n` +
            `documento: "${link.replace(/"/g, "'")}"\norigem: aviso de vencimento\n---\n` +
            `**${link}** vence em **${brData(venc)}** (aviso com ${dias} dias de antecedência).\n\n` +
            "- [ ] Ver o que precisa ser feito (renovar, renegociar, encerrar ou cumprir)\n" +
            "- [ ] Atualizar a nota do documento (nova data ou status)\n";
          await this.garantirPasta("07 - Agenda");
          await this.app.vault.create(caminho, conteudo);
          criados.push(`- ${new Date().toLocaleString("pt-BR")} · **aviso de vencimento** · \`${caminho}\` · para \`${f.path}\` · Ponte`);
        }
        feitos[chave] = hoje;
      }
      await this.salvarConfig();
      if (criados.length) {
        await this.registrarHistorico(criados);
        new Notice(`⏰ ${criados.length} aviso(s) de vencimento na Agenda`, 10000);
      } else if (manual) new Notice("Nenhum vencimento novo para avisar.");
    } catch (e) { console.warn("[Segundo Cérebro] vencimentos:", e.message); }
    finally { this.verificandoVenc = false; }
  }
};

// ---------- datas ----------
// Dias de antecedência padrão por tipo de nota (cada nota pode trocar com `alerta_dias`).
const DIAS_ALERTA = { contrato: 90, societario: 60, procuracao: 60, documento: 60, prazo: 30, licenca: 60, certidao: 30, processo: 7 };
const pad2 = (n) => String(n).padStart(2, "0");
const isoDia = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const diaDeIso = (s) => { const [a, m, d] = s.split("-").map(Number); return new Date(a, m - 1, d); };
const somarDias = (iso, n) => { const d = diaDeIso(iso); d.setDate(d.getDate() + n); return isoDia(d); };
const brData = (iso) => iso.split("-").reverse().join("/");
function dataIsoDe(v) {
  if (v instanceof Date && !isNaN(v)) return isoDia(v);
  const m = String(v ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
// "14h30", "14:30", "14h", "9", "09:00" → minutos desde 0h (ou null)
function minutosDe(v) {
  const m = String(v ?? "").trim().toLowerCase().match(/^(\d{1,2})(?:\s*(?:h|:)\s*(\d{2})?)?\s*(?:h|min)?$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2] || 0);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}
const horaTexto = (min) => `${Math.floor(min / 60)}h${pad2(min % 60)}`;

// ---------- agenda semanal por horário ----------
const ID_ESTILO_AGENDA = "sc-agenda-semana-css";
const AGENDAVEIS = ["tarefa", "compromisso", "lembrete"];
const DIAS_SEMANA = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const ALTURA_HORA = 48;

function instalarEstiloAgenda() {
  if (document.getElementById(ID_ESTILO_AGENDA)) return;
  const s = document.createElement("style");
  s.id = ID_ESTILO_AGENDA;
  s.textContent = `
.sc-semana{--h:${ALTURA_HORA}px;border:1px solid var(--background-modifier-border);border-radius:12px;background:var(--background-primary);overflow:hidden;font-size:13px;margin:8px 0}
.sc-semana-barra{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--background-modifier-border)}
.sc-semana-barra .titulo{font-weight:600;font-size:15px;margin-right:auto}
.sc-semana-barra button{padding:4px 10px;font-size:13px;height:auto}
.sc-semana-grade{display:grid;overflow:auto;max-height:72vh;position:relative}
.sc-semana-cab{position:sticky;top:0;z-index:3;background:var(--background-primary);border-bottom:1px solid var(--background-modifier-border);text-align:center;padding:6px 2px;line-height:1.2}
.sc-semana-cab .dn{font-size:11px;text-transform:uppercase;color:var(--text-muted);letter-spacing:.04em}
.sc-semana-cab .dd{font-size:18px;font-weight:600}
.sc-semana-cab.hoje .dd{color:var(--text-on-accent);background:var(--interactive-accent);border-radius:999px;display:inline-block;min-width:30px;padding:0 6px}
.sc-semana-cab.canto{position:sticky;left:0;z-index:4}
.sc-semana-dia-todo{border-bottom:1px solid var(--background-modifier-border);border-left:1px solid var(--background-modifier-border);padding:3px;min-height:26px;display:flex;flex-direction:column;gap:2px;background:var(--background-primary)}
.sc-semana-rot{font-size:10px;color:var(--text-faint);text-align:right;padding:2px 6px 0 0;position:sticky;left:0;background:var(--background-primary);z-index:1}
.sc-semana-horas{position:relative;border-left:1px solid var(--background-modifier-border);background:repeating-linear-gradient(to bottom,var(--background-modifier-border) 0 1px,transparent 1px var(--h))}
.sc-semana-horas.hoje{background-color:var(--background-secondary)}
.sc-semana-horas.alvo{outline:2px dashed var(--interactive-accent);outline-offset:-2px}
.sc-ev{position:absolute;left:2px;right:2px;border-radius:6px;padding:2px 5px;overflow:hidden;cursor:pointer;line-height:1.25;font-size:12px;border-left:3px solid var(--sc-cor);background:color-mix(in srgb,var(--sc-cor) 18%,var(--background-primary));color:var(--text-normal);box-sizing:border-box}
.sc-ev:hover{filter:brightness(1.06);z-index:2}
.sc-ev .h{font-size:10.5px;color:var(--text-muted);display:block}
.sc-ev.feita,.sc-chip.feita{opacity:.5;text-decoration:line-through}
.sc-chip{border-radius:5px;padding:1px 5px;font-size:11.5px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-left:3px solid var(--sc-cor);background:color-mix(in srgb,var(--sc-cor) 16%,var(--background-primary))}
.sc-agora{position:absolute;left:0;right:0;height:2px;background:var(--color-red);z-index:2;pointer-events:none}
.sc-agora::before{content:"";position:absolute;left:-4px;top:-4px;width:10px;height:10px;border-radius:50%;background:var(--color-red)}
.sc-semana-legenda{display:flex;flex-wrap:wrap;gap:4px 14px;padding:8px 12px;border-top:1px solid var(--background-modifier-border);font-size:12px;color:var(--text-muted)}
.sc-semana-legenda i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px;background:var(--sc-cor)}
.sc-ev-compromisso{--sc-cor:var(--interactive-accent)} .sc-ev-tarefa{--sc-cor:var(--color-green)}
.sc-ev-lembrete{--sc-cor:var(--color-orange)} .sc-ev-vencimento{--sc-cor:var(--color-red)}
`;
  document.head.appendChild(s);
}

class AgendaSemana extends MarkdownRenderChild {
  constructor(plugin, el, fonte) {
    super(el);
    this.plugin = plugin;
    this.app = plugin.app;
    const op = {};
    for (const l of String(fonte || "").split("\n")) { const m = l.match(/^\s*([a-z_]+)\s*:\s*(.+?)\s*$/i); if (m) op[m[1].toLowerCase()] = m[2]; }
    this.hIni = Math.min(23, Math.max(0, parseInt(op.inicio ?? "7", 10) || 0));
    this.hFim = Math.min(24, Math.max(this.hIni + 1, parseInt(op.fim ?? "22", 10) || 22));
    this.diasFixo = op.dias ? Math.min(7, Math.max(1, parseInt(op.dias, 10) || 7)) : null;
    this.pasta = op.pasta || "07 - Agenda";
    this.base = new Date(); this.base.setHours(0, 0, 0, 0);
  }

  onload() {
    this.desenhar();
    const agendar = () => { clearTimeout(this.t); this.t = setTimeout(() => this.desenhar(), 400); };
    this.registerEvent(this.app.metadataCache.on("changed", agendar));
    this.registerEvent(this.app.vault.on("delete", agendar));
    this.registerEvent(this.app.vault.on("rename", agendar));
    this.registerInterval(window.setInterval(() => this.desenhar(), 5 * 60000));
  }
  onunload() { clearTimeout(this.t); }

  get nDias() { return this.diasFixo || ((this.containerEl.clientWidth || window.innerWidth) < 640 ? 3 : 7); }

  inicio() {
    const d = new Date(this.base);
    if (this.nDias === 7) d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // semana começa na segunda
    return d;
  }

  coletar(dias) {
    const porDia = new Map(dias.map((d) => [d, { horas: [], todo: [] }]));
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (f.path.startsWith("05 - Sistema/")) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      if (!fm || !fm.tipo) continue;
      const tipo = String(fm.tipo);
      const status = String(fm.status || "").toLowerCase();
      if (status === "cancelada") continue;
      if (AGENDAVEIS.includes(tipo)) {
        const dia = dataIsoDe(fm.data) || dataIsoDe(fm.prazo);
        const slot = dia && porDia.get(dia);
        if (!slot) continue;
        const feita = fm.feita === true || status === "feita";
        const ini = minutosDe(fm.hora);
        const ev = { f, tipo, feita, titulo: f.basename, local: fm.local, campoDia: fm.data ? "data" : "prazo", fm };
        if (ini === null) { slot.todo.push(ev); continue; }
        let fim = minutosDe(fm.hora_fim);
        if (fim === null || fim <= ini) fim = ini + (Number(fm.duracao_min) > 0 ? Number(fm.duracao_min) : tipo === "compromisso" ? 60 : 30);
        Object.assign(ev, { ini, fim: Math.min(fim, 24 * 60) });
        slot.horas.push(ev);
      } else {
        const v = tipo === "processo" ? dataIsoDe(fm.prazo) : dataIsoDe(fm.vencimento) || dataIsoDe(fm.validade);
        const slot = v && porDia.get(v);
        if (!slot) continue;
        if (/pago|encerrad|revogad|substitu|feit|cancelad|conclu|arquivad/.test(status)) continue;
        slot.todo.push({ f, tipo: "vencimento", feita: false, titulo: "⏰ " + f.basename });
      }
    }
    return porDia;
  }

  abrir(f, ev) { this.app.workspace.getLeaf(ev && (ev.ctrlKey || ev.metaKey) ? "tab" : false).openFile(f); }

  async mover(caminho, dia, minuto) {
    const f = this.app.vault.getAbstractFileByPath(caminho);
    if (!(f instanceof TFile)) return;
    await this.app.fileManager.processFrontMatter(f, (fm) => {
      const ini = minutosDe(fm.hora), fim = minutosDe(fm.hora_fim);
      const dur = ini !== null && fim !== null && fim > ini ? fim - ini : null;
      if (fm.data || !fm.prazo) fm.data = dia; else fm.prazo = dia;
      if (minuto !== null) {
        fm.hora = horaTexto(minuto);
        if (dur !== null) fm.hora_fim = horaTexto(Math.min(minuto + dur, 23 * 60 + 59));
      }
    });
  }

  novo(dia, minuto) {
    new PerguntaModal(this.app, `Novo compromisso · ${brData(dia)} às ${horaTexto(minuto)}`, "O que é?", async (titulo) => {
      const nome = titulo.replace(/[\\/:*?"<>|#^[\]]/g, "-").trim().slice(0, 120);
      if (!nome) return;
      await this.plugin.garantirPasta(this.pasta);
      let caminho = `${this.pasta}/${nome}.md`, n = 2;
      while (this.app.vault.getAbstractFileByPath(caminho)) caminho = `${this.pasta}/${nome} (${n++}).md`;
      const f = await this.app.vault.create(caminho,
        `---\ntipo: compromisso\ndata: ${dia}\nhora: "${horaTexto(minuto)}"\nhora_fim: "${horaTexto(Math.min(minuto + 60, 23 * 60 + 59))}"\nlocal:\npessoa:\n---\n`);
      this.app.workspace.getLeaf(false).openFile(f);
    }).open();
  }

  desenhar() {
    const el = this.containerEl;
    const n = this.nDias;
    const ini = this.inicio();
    const dias = Array.from({ length: n }, (_, i) => { const d = new Date(ini); d.setDate(d.getDate() + i); return isoDia(d); });
    const hoje = isoDia(new Date());
    const porDia = this.coletar(dias);

    // a grade cresce se houver algo fora do horário padrão
    let hI = this.hIni, hF = this.hFim;
    for (const { horas } of porDia.values()) for (const e of horas) { hI = Math.min(hI, Math.floor(e.ini / 60)); hF = Math.max(hF, Math.ceil(e.fim / 60)); }

    el.empty();
    const caixa = el.createDiv({ cls: "sc-semana" });
    const barra = caixa.createDiv({ cls: "sc-semana-barra" });
    const d0 = diaDeIso(dias[0]), d1 = diaDeIso(dias[n - 1]);
    const rotulo = d0.getMonth() === d1.getMonth()
      ? `${d0.getDate()} – ${d1.getDate()} de ${MESES[d1.getMonth()]} ${d1.getFullYear()}`
      : `${d0.getDate()} ${MESES[d0.getMonth()]} – ${d1.getDate()} ${MESES[d1.getMonth()]} ${d1.getFullYear()}`;
    barra.createSpan({ cls: "titulo", text: rotulo });
    const passo = n === 7 ? 7 : n;
    const nav = (txt, fn, dica) => { const b = barra.createEl("button", { text: txt, attr: { "aria-label": dica } }); b.onclick = () => { fn(); this.desenhar(); }; };
    nav("‹", () => this.base.setDate(this.base.getDate() - passo), "Anterior");
    nav("Hoje", () => { this.base = new Date(); this.base.setHours(0, 0, 0, 0); }, "Hoje");
    nav("›", () => this.base.setDate(this.base.getDate() + passo), "Próxima");

    const grade = caixa.createDiv({ cls: "sc-semana-grade" });
    grade.style.gridTemplateColumns = `46px repeat(${n}, minmax(${n === 7 ? 92 : 80}px, 1fr))`;
    grade.createDiv({ cls: "sc-semana-cab canto" });
    for (const dia of dias) {
      const d = diaDeIso(dia);
      const cab = grade.createDiv({ cls: "sc-semana-cab" + (dia === hoje ? " hoje" : "") });
      cab.createDiv({ cls: "dn", text: DIAS_SEMANA[d.getDay()] });
      cab.createDiv({ cls: "dd", text: String(d.getDate()) });
    }
    // linha "o dia todo": tarefas sem hora e vencimentos
    const fixos = [grade.createDiv({ cls: "sc-semana-rot", text: "dia" })];
    fixos[0].style.zIndex = "4";
    for (const dia of dias) {
      const c = grade.createDiv({ cls: "sc-semana-dia-todo" });
      fixos.push(c);
      for (const e of porDia.get(dia).todo) {
        const chip = c.createDiv({ cls: `sc-chip sc-ev-${e.tipo}` + (e.feita ? " feita" : ""), text: e.titulo, attr: { title: e.titulo } });
        chip.onclick = (ev) => this.abrir(e.f, ev);
        if (e.tipo !== "vencimento") this.arrastavel(chip, e.f.path);
      }
    }
    // coluna das horas
    const alturaTotal = (hF - hI) * ALTURA_HORA;
    const rot = grade.createDiv({ cls: "sc-semana-rot" });
    rot.style.height = alturaTotal + "px";
    rot.style.position = "sticky";
    for (let h = hI; h < hF; h++) {
      const r = rot.createDiv({ text: `${h}h` });
      r.style.height = ALTURA_HORA + "px";
    }
    for (const dia of dias) {
      const col = grade.createDiv({ cls: "sc-semana-horas" + (dia === hoje ? " hoje" : "") });
      col.style.height = alturaTotal + "px";
      col.onclick = (ev) => {
        if (ev.target !== col) return;
        const min = hI * 60 + Math.floor((ev.offsetY / ALTURA_HORA) * 4) * 15;
        this.novo(dia, Math.min(min, 23 * 60 + 45));
      };
      col.addEventListener("dragover", (ev) => { ev.preventDefault(); col.addClass("alvo"); });
      col.addEventListener("dragleave", () => col.removeClass("alvo"));
      col.addEventListener("drop", (ev) => {
        ev.preventDefault(); col.removeClass("alvo");
        const caminho = ev.dataTransfer.getData("text/sc-agenda");
        if (!caminho) return;
        const y = ev.clientY - col.getBoundingClientRect().top - (Number(ev.dataTransfer.getData("text/sc-offset")) || 0);
        const min = hI * 60 + Math.max(0, Math.round((y / ALTURA_HORA) * 4)) * 15;
        this.mover(caminho, dia, Math.min(min, 23 * 60 + 45));
      });
      // eventos com hora, lado a lado quando se sobrepõem
      const evs = porDia.get(dia).horas.sort((a, b) => a.ini - b.ini || b.fim - a.fim);
      let grupo = [], fimGrupo = -1;
      const fechar = () => {
        const faixas = [];
        for (const e of grupo) {
          let i = faixas.findIndex((fimFaixa) => fimFaixa <= e.ini);
          if (i < 0) { i = faixas.length; faixas.push(0); }
          faixas[i] = e.fim; e.faixa = i;
        }
        for (const e of grupo) e.nFaixas = faixas.length;
        grupo = [];
      };
      for (const e of evs) { if (e.ini >= fimGrupo && grupo.length) fechar(); grupo.push(e); fimGrupo = Math.max(fimGrupo, e.fim); }
      if (grupo.length) fechar();
      for (const e of evs) {
        const b = col.createDiv({ cls: `sc-ev sc-ev-${e.tipo}` + (e.feita ? " feita" : "") });
        b.style.top = ((e.ini - hI * 60) / 60) * ALTURA_HORA + 1 + "px";
        b.style.height = Math.max(20, ((e.fim - e.ini) / 60) * ALTURA_HORA - 2) + "px";
        const w = 100 / e.nFaixas;
        b.style.left = `calc(${e.faixa * w}% + 2px)`;
        b.style.width = `calc(${w}% - 4px)`;
        b.style.right = "auto";
        b.createSpan({ cls: "h", text: `${horaTexto(e.ini)}–${horaTexto(e.fim)}${e.local ? " · " + e.local : ""}` });
        b.createSpan({ text: e.titulo });
        b.setAttr("title", `${e.titulo}\n${horaTexto(e.ini)}–${horaTexto(e.fim)}${e.local ? "\n" + e.local : ""}`);
        b.onclick = (ev) => { ev.stopPropagation(); this.abrir(e.f, ev); };
        this.arrastavel(b, e.f.path);
      }
      if (dia === hoje) {
        const agora = new Date(), m = agora.getHours() * 60 + agora.getMinutes();
        if (m >= hI * 60 && m <= hF * 60) { const l = col.createDiv({ cls: "sc-agora" }); l.style.top = ((m - hI * 60) / 60) * ALTURA_HORA + "px"; }
      }
    }
    const leg = caixa.createDiv({ cls: "sc-semana-legenda" });
    for (const [t, nome] of [["compromisso", "Compromisso"], ["tarefa", "Tarefa"], ["lembrete", "Lembrete"], ["vencimento", "Vencimento"]]) {
      const s = leg.createSpan({ cls: `sc-ev-${t}` }); s.createEl("i"); s.appendText(nome);
    }
    leg.createSpan({ text: Platform.isMobile ? "Toque num horário vazio para criar." : "Clique num horário vazio para criar · arraste para mudar o dia ou a hora." });

    // a linha "dia" fica presa logo abaixo do cabeçalho ao rolar as horas
    requestAnimationFrame(() => {
      const alt = grade.querySelector(".sc-semana-cab")?.offsetHeight || 52;
      for (const c of fixos) { c.style.position = "sticky"; c.style.top = alt + "px"; c.style.zIndex = c.style.zIndex || "2"; c.style.background = "var(--background-primary)"; }
    });
    // rola até perto da hora atual (ou do 1º compromisso) na primeira vez
    if (!this.rolou) {
      this.rolou = true;
      const alvo = Math.max(hI, Math.min(new Date().getHours() - 1, hF - 6));
      requestAnimationFrame(() => { grade.scrollTop = (alvo - hI) * ALTURA_HORA; });
    }
  }

  arrastavel(elem, caminho) {
    if (Platform.isMobile) return;
    elem.setAttr("draggable", "true");
    elem.addEventListener("dragstart", (ev) => {
      ev.dataTransfer.setData("text/sc-agenda", caminho);
      ev.dataTransfer.setData("text/sc-offset", String(ev.offsetY || 0));
      ev.dataTransfer.effectAllowed = "move";
    });
  }
}

class PerguntaModal extends Modal {
  constructor(app, titulo, rotulo, aoConfirmar) { super(app); this.titulo = titulo; this.rotulo = rotulo; this.aoConfirmar = aoConfirmar; }
  onOpen() {
    this.titleEl.setText(this.titulo);
    const input = this.contentEl.createEl("input", { type: "text", attr: { placeholder: this.rotulo, style: "width:100%" } });
    const ok = () => { const v = input.value.trim(); this.close(); if (v) this.aoConfirmar(v); };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") ok(); });
    const b = this.contentEl.createDiv({ attr: { style: "margin-top:12px;text-align:right" } }).createEl("button", { text: "Criar", cls: "mod-cta" });
    b.onclick = ok;
    setTimeout(() => input.focus(), 20);
  }
  onClose() { this.contentEl.empty(); }
}

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
