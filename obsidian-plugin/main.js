/* Ponte Segundo Cérebro — plugin do Obsidian (JavaScript puro, sem build).
 *
 * O que faz:
 *  - Envia cada nota criada/alterada para public.notas no Supabase (só se mudou: hash).
 *  - Remove da nuvem as notas apagadas; trata renomeações.
 *  - No "dispositivo principal": reconcilia tudo periodicamente, traz para
 *    "00 - Entrada" as memórias que o Claude/ChatGPT salvaram e cria os arquivos
 *    que o Claude pediu (fila pedidos_vault). Só cria arquivos NOVOS: nunca
 *    sobrescreve, nunca apaga; só .md/.base e snippets CSS.
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
const MAX_CHARS = 200000;

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
    if (r.status >= 300) throw new Error(r.json?.error_description || r.json?.msg || `Erro ${r.status}`);
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
  async token() {
    const s = this.sessao;
    if (!s) return null;
    if (Date.now() < s.expira - 60000) return s.access_token;
    try {
      this.guardarSessao(await this.auth("/token?grant_type=refresh_token", { refresh_token: s.refresh_token }));
      return this.sessao.access_token;
    } catch (e) {
      this.sessao = null;
      new Notice("Segundo Cérebro: faça login de novo nas configurações do plugin.");
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
    try { await this.aplicarPedidos(); } catch (e) { console.warn("[Segundo Cérebro] pedidos:", e.message); }
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

  async aplicarPedidos() {
    const pend = await this.rest("GET", "pedidos_vault?select=id,caminho,conteudo,acao&aplicado_em=is.null&order=criado_em&limit=50");
    if (!pend?.length) return 0;
    let n = 0;
    for (const p of pend) {
      let resultado;
      try {
        const caminho = normalizePath(p.caminho);
        if (!caminhoSeguro(caminho)) {
          resultado = "recusado: caminho não permitido";
        } else if (p.acao === "substituir") {
          resultado = await this.substituirComBackup(caminho, p.conteudo);
          if (resultado.startsWith("substituído") || resultado === "criado") n++;
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
      await this.rest("PATCH", `pedidos_vault?id=eq.${p.id}`, { aplicado_em: new Date().toISOString(), resultado },
        { Prefer: "return=minimal" });
    }
    if (n) new Notice(`Segundo Cérebro: ${n} arquivo(s) novo(s) criado(s) pelo Claude.`);
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
