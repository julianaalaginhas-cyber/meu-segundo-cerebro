// Segundo Cérebro — app (PWA). Lê e escreve pelo Supabase; o Obsidian continua sendo o arquivo oficial.
const API = "https://vqzittywsskczitgarnh.supabase.co/functions/v1/app-api";
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const brl = (v) => (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const DIAS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const MESES_LONGOS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const hojeISO = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Recife" }).format(new Date());
const somaDias = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const somaMes = (m, n) => { const x = new Date(m + "-15T12:00:00Z"); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 7); };
const diaSemana = (d) => new Date(d + "T12:00:00Z").getUTCDay();
const fmtDia = (d) => { const [, m, dd] = d.split("-"); return `${DIAS[diaSemana(d)]} ${Number(dd)}/${Number(m)}`; };
const fmtDiaLongo = (d) => { const [, m, dd] = d.split("-"); return `${["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"][diaSemana(d)]}, ${Number(dd)} de ${MESES_LONGOS[Number(m) - 1]}`; };
const AREAS = {
  pessoal: ["#ec4899", "Pessoal"], vida: ["#ec4899", "Pessoal"], saude: ["#ec4899", "Saúde"], treino: ["#ec4899", "Treino"],
  casa: ["#eab308", "Casa"], compras: ["#eab308", "Compras"], trabalho: ["#1d4ed8", "Trabalho"], juridico: ["#1d4ed8", "Jurídico"],
  afiloop: ["#8b5cf6", "Afiloop"], projetos: ["#8b5cf6", "Projetos"], financeiro: ["#14b8a6", "Financeiro"], familia: ["#f97316", "Família"],
  metas: ["#f97316", "Metas"], nicolas: ["#22c55e", "Nicolas"], guy: ["#38bdf8", "Guy"],
};
const corItem = (i) => {
  const quem = `${i.pessoa ?? ""} ${i.titulo ?? ""}`;
  if (/nicolas/i.test(quem)) return AREAS.nicolas[0];
  if (/\bguy\b/i.test(i.pessoa ?? "")) return AREAS.guy[0];
  return corArea(i.area || "pessoal");
};
const corArea = (a) => (AREAS[String(a ?? "").toLowerCase()] ?? ["#8e8e93", a || ""])[0];
const nomeArea = (a) => (AREAS[String(a ?? "").toLowerCase()] ?? ["", a || ""])[1];
const ABAS = [
  { id: "hoje", nome: "Início", cor: "var(--hoje)", ic: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 9.8V20h13V9.8"/><path d="M10 20v-5h4v5"/>' },
  { id: "agenda", nome: "Agenda", cor: "var(--agenda)", ic: '<rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>' },
  { id: "chat", nome: "Chat", cor: "var(--hoje)", ic: '<path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z"/><path d="M8.5 11h.01M12 11h.01M15.5 11h.01"/>' },
  { id: "financeiro", nome: "Financeiro", cor: "var(--fin)", ic: '<rect x="2.5" y="5.5" width="19" height="13" rx="3"/><path d="M2.5 10h19M6.5 14.5h4"/>' },
  { id: "eu", nome: "Eu", cor: "var(--eu)", ic: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.2-4 4.3-6 8-6s6.8 2 8 6"/>' },
];
const ICONE = (p, extra = "") => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ${extra}>${p}</svg>`;

const lerToken = () => { try { return localStorage.getItem("sc_token") || sessionStorage.getItem("sc_token"); } catch { return null; } };
let token = lerToken() || null;
try { if (token) localStorage.setItem("sc_token", token); } catch {}
let estado = { aba: "hoje", agendaModo: "semana", agendaRef: hojeISO(), agendaDiaSel: hojeISO(), finMes: hojeISO().slice(0, 7), euDia: hojeISO(), cache: {} };

// ---------------- API ----------------
async function api(caminho, corpo) {
  const r = await fetch(API + caminho, {
    method: corpo === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && token) { bloquear(); throw new Error("Entre de novo."); }
  if (!r.ok) throw new Error(j.erro || "Algo deu errado.");
  return j;
}
function toast(msg) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}
async function acao(fn, ok) {
  try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { toast(e.message); throw e; }
}

// ---------------- acesso (Face ID / Windows Hello / PIN) ----------------
const UA = navigator.userAgent;
const nomeDesbloqueio = () => /Windows/i.test(UA) ? "Windows Hello" : /iPhone|iPad/i.test(UA) ? "Face ID" : /Macintosh/i.test(UA) ? "Touch ID" : /Android/i.test(UA) ? "a digital" : "o desbloqueio do aparelho";
const nomeAparelho = () => /Windows/i.test(UA) ? "Windows Hello (computador)" : /iPhone/i.test(UA) ? "Face ID (iPhone)" : /iPad/i.test(UA) ? "iPad" : /Macintosh/i.test(UA) ? "Touch ID (Mac)" : /Android/i.test(UA) ? "Android" : "Aparelho";
// este navegador já tem a chave cadastrada? (o iPhone já tinha antes desta marca existir)
const temChaveAqui = () => { try { return localStorage.getItem("sc_chave") === "1" || /iPhone|iPad/i.test(UA); } catch { return false; } };
const marcarChaveAqui = () => { try { localStorage.setItem("sc_chave", "1"); } catch {} };
async function podeDesbloqueio() { try { return !!window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch { return false; } }
function telaAcesso(conteudo) {
  $("#app").innerHTML = `<div class="acesso"><img class="logo" src="icons/icon-192.png" alt=""><h1>Segundo Cérebro</h1>${conteudo}</div>`;
  $(".abas").classList.add("esconder"); $(".fab").classList.add("esconder");
}
async function iniciar() {
  if (token) return abrirApp();
  let est;
  try { est = await api("/estado"); } catch { return telaAcesso(`<p>Sem conexão. Verifique a internet e abra de novo.</p>`); }
  if (!est.configurado) return telaPrimeiroAcesso();
  telaAcesso(`<p>Toque para entrar.</p><div class="caixa">
    ${est.tem_passkey ? `<button class="btn" id="b-face" style="--area:var(--txt)">Entrar com ${nomeDesbloqueio()}</button>` : ""}
    <button class="btn sec" id="b-pin">Usar PIN</button><div class="erro" id="erro"></div></div>`);
  $("#b-pin").onclick = telaPin;
  if (est.tem_passkey) { $("#b-face").onclick = entrarFace; if (temChaveAqui() && !sessionStorage.getItem("sc_face_falhou")) entrarFace(); }
}
async function entrarFace() {
  try {
    const op = await api("/login/opcoes", {});
    const resp = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: op });
    const s = await api("/login/passkey", { resposta: resp });
    marcarChaveAqui(); guardarSessao(s.token); abrirApp();
  } catch (e) {
    sessionStorage.setItem("sc_face_falhou", "1");
    const el = $("#erro"); if (el) el.textContent = e.name === "NotAllowedError" ? `${nomeDesbloqueio()} cancelado.` : e.message;
  }
}
function telaPin() {
  telaAcesso(`<p>Digite o seu PIN.</p><div class="caixa"><input id="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off">
    <button class="btn" id="b-ok" style="--area:var(--txt)">Entrar</button><button class="btn-link" id="b-volta" style="--area:var(--txt2)">Voltar</button><div class="erro" id="erro"></div></div>`);
  $("#pin").focus();
  const ir = async () => {
    try {
      const s = await api("/login/pin", { pin: $("#pin").value }); guardarSessao(s.token); abrirApp();
      if (!temChaveAqui() && await podeDesbloqueio()) setTimeout(() => folhaDesbloqueio(true), 900);
    }
    catch (e) { $("#erro").textContent = e.message; $("#pin").value = ""; }
  };
  $("#b-ok").onclick = ir; $("#pin").onkeyup = (e) => { if (e.key === "Enter" || e.target.value.length === 6) ir(); };
  $("#b-volta").onclick = () => { sessionStorage.removeItem("sc_face_falhou"); iniciar(); };
}
// cadastra o desbloqueio deste aparelho (Windows Hello, Face ID, Touch ID...) para entrar sem PIN
function folhaDesbloqueio(aposPin = false) {
  const nome = nomeDesbloqueio();
  folha(`<h2>Entrar sem PIN ${/Windows/i.test(UA) ? "neste computador" : "neste aparelho"}</h2>
    <p style="color:var(--txt2);margin-top:-4px">Da próxima vez você entra com ${nome}${/Windows/i.test(UA) ? " (digital, rosto ou o desbloqueio do Windows)" : ""}. O PIN continua valendo como reserva.</p>
    <div id="d-pin" class="esconder"><label class="campo"><span>Para confirmar, digite o seu PIN</span><input id="d-pin-in" type="password" inputmode="numeric" maxlength="6" autocomplete="off"></label></div>
    <div class="erro" id="d-erro" style="color:var(--perigo);font-size:14px;margin:0 4px 10px"></div>
    <button class="btn" id="d-ok" style="--area:var(--txt)">Ativar ${nome}</button>
    ${aposPin ? `<button class="btn-link" id="d-depois" style="--area:var(--txt2);width:100%;margin-top:6px">Agora não</button>` : ""}`, (f, fechar) => {
    let op = null;
    const depois = $("#d-depois", f); if (depois) depois.onclick = fechar;
    $("#d-ok", f).onclick = async () => {
      const erro = $("#d-erro", f); erro.textContent = "";
      try {
        op = op ?? await api("/aparelho/opcoes", {});
        const pin = $("#d-pin-in", f).value.trim();
        if (op.precisa_pin && !pin) { $("#d-pin", f).classList.remove("esconder"); $("#d-pin-in", f).focus(); return; }
        const { precisa_pin, ...opcoes } = op;
        const resposta = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: opcoes });
        await api("/aparelho/concluir", { resposta, pin, nome: nomeAparelho() });
        marcarChaveAqui(); fechar(); toast(`Pronto ✓ Da próxima vez é só ${nome}.`);
      } catch (e) {
        op = null; // cada tentativa pede um desafio novo
        erro.textContent = e.name === "NotAllowedError" ? `${nome} cancelado.` : e.name === "InvalidStateError" ? "Este aparelho já está cadastrado." : e.message;
        if (e.name === "InvalidStateError") marcarChaveAqui();
      }
    };
  });
}
function telaPrimeiroAcesso() {
  const temPasskey = !!window.PublicKeyCredential;
  telaAcesso(`<p>Primeiro acesso: digite o código que o Claude te passou e crie um PIN de reserva.</p>
    <div class="caixa"><input id="codigo" placeholder="CÓDIGO" autocapitalize="characters" maxlength="8" style="letter-spacing:.2em">
    <input id="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="PIN (4 a 6 números)" style="font-size:17px;letter-spacing:.1em">
    <button class="btn" id="b-ok" style="--area:var(--txt)">${temPasskey ? "Ativar Face ID" : "Continuar"}</button><div class="erro" id="erro"></div></div>`);
  $("#b-ok").onclick = async () => {
    const codigo = $("#codigo").value.trim().toUpperCase(), pin = $("#pin").value.trim();
    if (!/^\d{4,6}$/.test(pin)) return ($("#erro").textContent = "O PIN precisa ter de 4 a 6 números.");
    try {
      let resposta = null;
      if (temPasskey) {
        const op = await api("/setup/opcoes", { codigo });
        resposta = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: op });
      }
      const s = await api("/setup/concluir", { codigo, pin, resposta });
      guardarSessao(s.token); abrirApp(); setTimeout(() => toast("Pronto! Da próxima vez é só o Face ID."), 600);
    } catch (e) { $("#erro").textContent = e.name === "NotAllowedError" ? "Face ID cancelado. Tente de novo." : e.message; }
  };
}
function guardarSessao(t) { token = t; try { localStorage.setItem("sc_token", t); } catch {} sessionStorage.setItem("sc_token", t); sessionStorage.removeItem("sc_face_falhou"); }
function bloquear() { token = null; try { localStorage.removeItem("sc_token"); } catch {} sessionStorage.removeItem("sc_token"); estado.cache = {}; iniciar(); }
// sem bloqueio automático: ao voltar para o app, só atualiza a tela
document.addEventListener("visibilitychange", () => { if (!document.hidden && token) render(); });

// ---------------- estrutura ----------------
function abrirApp() {
  $(".abas").classList.remove("esconder"); $(".fab").classList.remove("esconder");
  if (lerLinkPost()) return render();
  const a = location.hash.replace("#", "");
  if (ABAS.some((x) => x.id === a)) estado.aba = a;
  render();
}
const STUDIO = "https://afiloop.julianaa-laginhas.workers.dev"; // o Afiloop (posts, propostas, pack) agora fica no Afiloop Studio
// links antigos (#afiloop e #afiloop/post/ID, de notificações já enviadas) abrem o Afiloop Studio
function lerLinkPost() {
  const m = location.hash.match(/^#afiloop(?:\/post\/(\d+))?/);
  if (!m) return false;
  location.replace(`${STUDIO}/#${m[1] ? `posts/${m[1]}` : "posts"}`);
  return true;
}
window.addEventListener("hashchange", () => { if (token && lerLinkPost()) render(); });
function montarAbas() {
  const nav = $(".abas");
  nav.innerHTML = `<div class="abas-marca"><img src="icons/icon-192.png" alt="">Segundo Cérebro</div>` +
    ABAS.map((a) => `<button data-aba="${a.id}" class="${a.fora ? "fora" : ""}" style="--c:${a.cor}">${ICONE(a.ic)}<span>${a.nome}</span></button>`).join("");
  nav.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; estado.aba = b.dataset.aba; history.replaceState(null, "", "#" + estado.aba); render(); scrollTo(0, 0); };
  $(".fab").innerHTML = ICONE('<path d="M12 5v14M5 12h14"/>', 'stroke-width="2.4"');
  $(".fab").onclick = abrirCaptura;
}
function topo(titulo, sub, extra = "") {
  return `<header class="topo"><div><h1>${esc(titulo)}</h1>${sub ? `<div class="sub">${sub}</div>` : ""}</div>
    <div style="display:flex;gap:8px">${extra}<button class="icone-btn" data-acao="buscar" aria-label="Buscar no Segundo Cérebro">${ICONE('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>')}</button><button class="icone-btn" data-acao="ajustes" aria-label="Ajustes">${ICONE('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>')}</button></div></header>`;
}
async function render() {
  if (!token) return;
  document.querySelectorAll(".abas button").forEach((b) => b.classList.toggle("on", b.dataset.aba === estado.aba));
  document.body.classList.toggle("inicio", estado.aba === "hoje" || estado.aba === "chat");
  document.body.classList.toggle("no-chat", estado.aba === "chat");
  const aba = ABAS.find((a) => a.id === estado.aba);
  document.documentElement.style.setProperty("--area", aba.cor);
  const el = $("#app");
  const desenhar = { hoje: telaHoje, agenda: telaAgenda, financeiro: telaFinanceiro, eu: telaEu, chat: telaChat }[estado.aba];
  if (!el.dataset.aba || el.dataset.aba !== estado.aba) el.innerHTML = `<div class="carregando">Carregando…</div>`;
  el.dataset.aba = estado.aba;
  try {
    el.innerHTML = await desenhar();
  }
  catch (e) { el.innerHTML = topo(aba.nome) + `<main><div class="aviso">⚠️ ${esc(e.message)}</div><button class="btn sec" onclick="render()">Tentar de novo</button></main>`; }
}
window.render = render;

// itens de agenda
function linhaItem(i, opts = {}) {
  const c = i.origem === "meta" ? "var(--metas)" : corItem(i);
  const sub = [opts.mostrarDia && i.dia ? fmtDia(i.dia) : "", i.hora_fim ? `até ${i.hora_fim}` : "", /nicolas/i.test(`${i.pessoa} ${i.titulo}`) ? "Nicolas" : nomeArea(i.area), i.pessoa && !["Juliana", "Nicolas"].includes(i.pessoa) ? i.pessoa : "", i.prioridade === "alta" ? "❗ alta" : ""].filter(Boolean).join(" · ");
  return `<div class="linha-item ${i.feito ? "feito" : ""}" style="box-shadow:inset 4px 0 0 ${c}" data-item='${esc(JSON.stringify({ c: i.caminho, o: i.origem, t: i.titulo, f: i.feito }))}'>
    <button class="check ${i.feito ? "on" : ""}" style="--c:${c}" data-acao="marcar" aria-label="Concluir"></button>
    ${i.hora ? `<div class="hora">${i.hora}</div>` : ""}
    <div class="txt"><div class="t1">${esc(i.titulo)}${i.pendente ? '<span class="sinc">⏳</span>' : ""}</div>${sub ? `<div class="t2">${esc(sub)}</div>` : ""}</div></div>`;
}
function bannerSync(s) {
  if (!s) return "";
  const parado = s.ultima_aplicacao && Date.now() - new Date(s.ultima_aplicacao).getTime() > 12 * 3600e3;
  if (parado && (s.pendentes_ponte || s.pendentes_app)) return `<div class="aviso">⏳ O Obsidian não sincroniza há mais de 12 h. Abra o Obsidian no computador principal para aplicar ${s.pendentes_app + s.pendentes_ponte} mudança(s).</div>`;
  if (s.pendentes_app) return `<div class="aviso" style="background:color-mix(in srgb,var(--agenda) 10%,transparent)">⏳ ${s.pendentes_app} mudança(s) sincronizando com o Obsidian…</div>`;
  return "";
}

// ---------------- HOJE ----------------
const ATALHOS = [
  ["agenda", "Agenda", '<rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4M7.5 13.5h3M7.5 17h6"/>', "#ffd9c2", "#a8501f"],
  ["financeiro", "Finanças", '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>', "#cfe3f7", "#2c5b8c"],
  ["diario", "Diário", '<path d="M12 21s-7.5-4.6-9.3-9.2C1.4 8.4 3.6 5 7 5c2 0 3.4 1.1 5 3 1.6-1.9 3-3 5-3 3.4 0 5.6 3.4 4.3 6.8C19.5 16.4 12 21 12 21z"/>', "#f9d6de", "#a1354f"],
  ["habitos", "Hábitos", '<path d="M4 12h3M17 12h3M7 8v8M17 8v8M7 12h10"/>', "#d3ebcf", "#3b7637"],
  ["metas", "Metas", '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>', "#fbe7a6", "#86610e"],
  ["compras", "Compras", '<path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6"/><circle cx="10" cy="20" r="1.2"/><circle cx="17" cy="20" r="1.2"/>', "#fdebc8", "#8a5410"],
  ["wishlist", "Wishlist", '<rect x="3.5" y="8" width="17" height="12.5" rx="2"/><path d="M12 8v12.5M3.5 12.5h17M12 8C10 4 6.5 4.5 7.2 7c.4 1.3 2.8 1 4.8 1zM12 8c2-4 5.5-3.5 4.8-1-.4 1.3-2.8 1-4.8 1z"/>', "#f3d3ea", "#8f3a76"],
  ["saude", "Saúde", '<path d="M12 21s-7.5-4.6-9.3-9.2C1.4 8.4 3.6 5 7 5c2 0 3.4 1.1 5 3 1.6-1.9 3-3 5-3 3.4 0 5.6 3.4 4.3 6.8C19.5 16.4 12 21 12 21z"/><path d="M8 12h2l1-2 2 4 1-2h2"/>', "#f6cfc9", "#9c3f35"],
  ["nicolas", "Nicolas", '<circle cx="12" cy="9" r="4.5"/><path d="M10.3 8.5h.01M13.7 8.5h.01M10.5 10.8c.9.7 2.1.7 3 0M5.5 20.5c1-3.3 3.6-5 6.5-5s5.5 1.7 6.5 5"/>', "#cdebdd", "#2b7553"],
  ["juridico", "Jurídico", '<path d="M12 3v18M7 21h10M5 7h14M5 7l-2.5 6a3 3 0 0 0 5 0zM19 7l-2.5 6a3 3 0 0 0 5 0z"/>', "#d3daf2", "#36478a"],
  ["afiloop", "Afiloop", '<path d="M4 7h16v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M8 7a4 4 0 0 1 8 0"/>', "#e3d7f5", "#6641a3"],
  ["midia", "Filmes e livros", '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10 9.5v5l4.5-2.5z"/>', "#c9e8e4", "#2a6a64"],
];
const atalhosOcultos = () => { try { return JSON.parse(localStorage.getItem("sc_atalhos_ocultos") || "[]"); } catch { return []; } };
async function abrirAtalho(k) {
  const ir = async (aba, alvo) => { estado.aba = aba; history.replaceState(null, "", "#" + aba); await render(); scrollTo(0, 0); if (alvo) document.getElementById(alvo)?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  ({
    agenda: () => ir("agenda"), financeiro: () => ir("financeiro"), diario: () => ir("eu"), habitos: () => ir("eu", "eu-habitos"), metas: () => ir("eu", "eu-metas"),
    afiloop: () => window.open(`${STUDIO}/#posts`, "_blank", "noopener"), compras: () => folhaListas(false), wishlist: () => folhaListas(true), saude: () => { saudePessoa = "Juliana"; folhaSaude(); },
    nicolas: () => { saudePessoa = "Nicolas"; folhaSaude(); }, juridico: folhaJuridico, midia: folhaMidia,
  })[k]?.();
}
function folhaEditarInicio() {
  const ocultos = new Set(atalhosOcultos());
  folha(`<h2>Editar tela inicial</h2><p style="color:var(--txt2);font-size:14px;margin:-6px 4px 12px">Toque para mostrar ou esconder cada atalho.</p>
    <div class="card acoes-lista">${ATALHOS.map(([k, n]) => `<button data-tg-atalho="${k}">${ocultos.has(k) ? "◻️" : "✅"} ${esc(n)}</button>`).join("")}</div>`, (f) => {
    f.onclick = (e) => {
      const b = e.target.closest("[data-tg-atalho]"); if (!b) return;
      const k = b.dataset.tgAtalho;
      ocultos.has(k) ? ocultos.delete(k) : ocultos.add(k);
      try { localStorage.setItem("sc_atalhos_ocultos", JSON.stringify([...ocultos])); } catch {}
      b.textContent = `${ocultos.has(k) ? "◻️" : "✅"} ${ATALHOS.find((x) => x[0] === k)[1]}`;
      if (estado.aba === "hoje") render();
    };
  });
}
async function telaHoje() {
  const h0 = hojeISO();
  const [d, sem] = await Promise.all([api("/hoje"), api(`/agenda?de=${somaDias(h0, 1)}&ate=${somaDias(h0, 7)}`)]);
  estado.cache.hoje = d;
  const hr = Number(new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", timeZone: "America/Recife", hour12: false }));
  const saud = hr < 12 ? "Bom dia" : hr < 18 ? "Boa tarde" : "Boa noite";
  const ocultos = new Set(atalhosOcultos());
  const porDia = {};
  for (const i of sem.itens.filter((x) => !x.feito)) (porDia[i.dia] ??= []).push(i);
  const diasSemana = Object.keys(porDia).sort();
  return `<header class="topo inicio"><div><h1 class="serif">${saud}, Juliana</h1><div class="sub">${fmtDiaLongo(d.hoje)}</div></div>
    <div style="display:flex;gap:8px"><button class="icone-btn" data-acao="ajustes" aria-label="Ajustes">${ICONE('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>')}</button></div></header>
  <main>${bannerSync(d.sincronizacao)}
    <button class="falar-barra" data-ir="chat">${ICONE('<path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z"/>')}<span>Converse com o Segundo Cérebro…</span>${ICONE('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>')}</button>
    <p class="dica">Pergunte, registre ou mande uma foto. Ex.: "o que tenho amanhã?", "gastei 45 no mercado no Nubank".</p>
    <div class="atalhos-grade">${ATALHOS.filter(([k]) => !ocultos.has(k)).map(([k, n, ic, bg, fg]) => `<button class="tile" data-atalho="${k}" style="--bg:${bg};--fg:${fg}">${ICONE(ic)}<span>${esc(n)}</span></button>`).join("")}</div>
    <div style="text-align:right;margin-top:8px"><button class="btn-link" style="--area:var(--txt2);font-weight:500" data-acao="editar-inicio">Editar tela inicial</button></div>

    <h2 class="serif sec">Hoje</h2>
    <div class="card">${d.agenda.length ? d.agenda.map((i) => linhaItem(i)).join("") : `<div class="vazio">Nada marcado para hoje ✨</div>`}
      ${d.total_atrasadas ? `<button class="linha-item btn-link" style="width:100%;--area:var(--txt2);border:0;border-top:1px solid var(--linha);font-weight:600" data-ir="agenda">${d.total_atrasadas} pendente(s) de dias anteriores · ver</button>` : ""}</div>
    ${d.financeiro.contas.length ? `<div class="secao-titulo" style="--area:var(--fin)"><span class="ponto"></span>Contas vencendo</div><div class="card">${d.financeiro.contas.map(contaHtml).join("")}</div>` : ""}

    <h2 class="serif sec">Minha semana</h2>
    <p class="dica" style="text-align:left;margin-top:-6px">Seus próximos 7 dias.</p>
    ${diasSemana.length ? diasSemana.map((dia) => `<div class="secao-titulo">${fmtDia(dia)}</div><div class="card">${porDia[dia].map((i) => linhaItem(i)).join("")}</div>`).join("") : `<div class="card"><div class="vazio">Semana livre por enquanto</div></div>`}

    <h2 class="serif sec">Como você está?</h2>
    <div class="card"><div class="humores">${["😄 Muito bem", "🙂 Bem", "😐 Normal", "😔 Para baixo", "😣 Difícil"].map((x) =>
      `<button class="${d.diario.humor === x ? "on" : ""}" data-humor="${x}" aria-label="${x}">${x.split(" ")[0]}</button>`).join("")}</div></div>
  </main>`;
}
const ofertaHtml = (o) => `<a class="oferta" href="${esc(o.link_afiliado)}" target="_blank" rel="noopener">${o.imagem_url ? `<img src="${esc(o.imagem_url)}" alt="" loading="lazy">` : ""}
  <div class="txt" style="flex:1;min-width:0"><div class="t1" style="font-size:14px;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(o.nome)}</div>
  <div class="t2" style="font-size:13px;color:var(--txt2)">${brl(o.preco)} · ${Number(o.comissao_pct || 0).toFixed(0)}% comissão${o.nicho ? " · " + esc(o.nicho) : ""}</div></div></a>`;
const contaHtml = (c) => `<div class="linha-item" data-conta="${esc(c.caminho)}"><button class="check" style="--c:var(--fin)" data-acao="pagar" aria-label="Paguei"></button>
  <div class="txt"><div class="t1">${esc(c.titulo)}${c.pendente ? '<span class="sinc">⏳</span>' : ""}</div><div class="t2">vence ${fmtDia(c.vencimento)}${c.forma ? " · " + esc(c.forma) : ""}</div></div>
  ${c.valor ? `<b style="font-variant-numeric:tabular-nums">${brl(c.valor)}</b>` : ""}</div>`;

// ---------------- AGENDA ----------------
const categoriaDe = (i) => /nicolas/i.test(`${i.pessoa ?? ""} ${i.titulo}`) ? "nicolas" : /\bguy\b/i.test(i.pessoa ?? "") ? "guy" : i.origem === "meta" ? "metas" : (i.origem === "prazo" ? "juridico" : (String(i.area || "pessoal").toLowerCase()));
const nomeCategoria = (k) => (AREAS[k] ?? ["", k])[1] || k;
async function telaAgenda() {
  const ref = estado.agendaRef, modo = estado.agendaModo;
  const h = hojeISO();
  const cab = topo("Agenda", "", `<button class="icone-btn" data-acao="nova-tarefa" aria-label="Nova tarefa" style="color:var(--agenda)">${ICONE('<path d="M12 5v14M5 12h14"/>')}</button>`) +
    `<main><div class="segmentado">${[["dia", "Dia"], ["semana", "Semana"], ["mes", "Mês"], ["categorias", "Categorias"]].map(([m, n]) => `<button class="${modo === m ? "on" : ""}" data-modo="${m}">${n}</button>`).join("")}</div>`;
  const rodapeAtrasadas = (d, de) => { const atr = d.atrasadas.filter((i) => i.dia < de); return atr.length ? `<div class="secao-titulo" style="--area:var(--perigo)"><span class="ponto"></span>Atrasadas (${atr.length})</div>
      <div class="card">${atr.map((i) => linhaItem(i, { mostrarDia: true })).join("")}</div>` : ""; };

  // ----- Categorias: o que está em aberto, agrupado por cor -----
  if (modo === "categorias") {
    const d = await api(`/agenda?de=${h}&ate=${somaDias(h, 60)}`);
    const abertos = [...d.atrasadas, ...d.itens.filter((i) => !i.feito), ...d.sem_data];
    const grupos = {};
    for (const i of abertos) (grupos[categoriaDe(i)] ??= []).push(i);
    const ordem = ["pessoal", "vida", "saude", "nicolas", "familia", "casa", "compras", "financeiro", "afiloop", "projetos", "metas", "trabalho", "juridico", "guy"];
    const chaves = Object.keys(grupos).sort((a, b) => (ordem.indexOf(a) + 99) % 99 - (ordem.indexOf(b) + 99) % 99);
    return cab + `<p style="color:var(--txt2);font-size:13px;margin:2px 4px 6px">Tudo em aberto nos próximos 60 dias, atrasadas e sem data.</p>
      <div class="chips" style="margin-bottom:6px">${chaves.map((k) => `<a href="#cat-${k}" class="pilula" style="--c:${corArea(k)}">${esc(nomeCategoria(k))} · ${grupos[k].length}</a>`).join("")}</div>
      ${chaves.map((k) => `<div class="secao-titulo" id="cat-${k}"><span class="pilula" style="--c:${corArea(k)}">${esc(nomeCategoria(k))}</span></div>
        <div class="card">${grupos[k].sort((a, b) => String(a.dia ?? "9").localeCompare(String(b.dia ?? "9"))).map((i) => linhaItem(i, { mostrarDia: true })).join("")}</div>`).join("") || `<div class="card"><div class="vazio">Nada em aberto 🎉</div></div>`}</main>`;
  }

  // ----- Mês: calendário com os itens dentro dos dias + lista do dia escolhido -----
  if (modo === "mes") {
    const mes = ref.slice(0, 7), primeiro = mes + "-01", ultimo = somaDias(somaMes(mes, 1) + "-01", -1);
    const ini = somaDias(primeiro, -diaSemana(primeiro)), fim = somaDias(ultimo, 6 - diaSemana(ultimo));
    const d = await api(`/agenda?de=${ini}&ate=${fim}`);
    const porDia = {};
    for (const i of d.itens) (porDia[i.dia] ??= []).push(i);
    if (!estado.agendaDiaSel.startsWith(mes)) estado.agendaDiaSel = h.startsWith(mes) ? h : primeiro;
    const sel = estado.agendaDiaSel;
    const celulas = [];
    for (let x = ini; x <= fim; x = somaDias(x, 1)) celulas.push(x);
    const doDia = (porDia[sel] ?? []).sort((a, b) => (a.hora ?? "99").localeCompare(b.hora ?? "99"));
    return cab + `<div class="navdatas"><button data-nav="-1" aria-label="Mês anterior">‹</button><b>${MESES_LONGOS[Number(mes.slice(5)) - 1]} de ${mes.slice(0, 4)}</b><button data-nav="1" aria-label="Próximo mês">›</button></div>
      <div class="card cal"><div class="cal-sem">${["D", "S", "T", "Q", "Q", "S", "S"].map((x) => `<span>${x}</span>`).join("")}</div>
      <div class="cal-grade">${celulas.map((x) => {
        const its = (porDia[x] ?? []).sort((a, b) => (a.hora ?? "99").localeCompare(b.hora ?? "99"));
        return `<button class="cal-dia ${x.slice(0, 7) !== mes ? "fora" : ""} ${x === sel ? "sel" : ""} ${x === h ? "hoje" : ""}" data-diasel="${x}">
          <span class="num">${Number(x.slice(8))}</span>
          ${its.slice(0, 3).map((i) => `<span class="ev ${i.feito ? "ok" : ""}" style="--c:${i.origem === "meta" ? "var(--metas)" : corItem(i)}">${esc(i.titulo)}</span>`).join("")}
          ${its.length > 3 ? `<span class="mais">+${its.length - 3}</span>` : ""}</button>`;
      }).join("")}</div></div>
      <div class="secao-titulo" style="color:var(--txt)">${sel === h ? "Hoje · " : ""}${fmtDiaLongo(sel)}<button class="acao" data-acao="nova-tarefa">+ Novo</button></div>
      <div class="card">${doDia.length ? doDia.map((i) => linhaItem(i)).join("") : `<div class="vazio">Dia livre</div>`}</div>
      ${rodapeAtrasadas(d, h)}</main>`;
  }

  // ----- Dia e Semana -----
  let de, ate, titulo;
  if (modo === "dia") { de = ate = ref; titulo = fmtDiaLongo(ref); }
  else { de = somaDias(ref, -((diaSemana(ref) + 6) % 7)); ate = somaDias(de, 6); titulo = `${fmtDia(de)} – ${fmtDia(ate)}`; }
  const d = await api(`/agenda?de=${de}&ate=${ate}`);
  const porDia = {};
  for (const i of d.itens) (porDia[i.dia] ??= []).push(i);
  const dias = Array.from({ length: (Date.parse(ate) - Date.parse(de)) / 864e5 + 1 }, (_, k) => somaDias(de, k));
  return cab + `<div class="navdatas"><button data-nav="-1" aria-label="Anterior">‹</button><b>${titulo}</b><button data-nav="1" aria-label="Próximo">›</button></div>
    ${ref !== h ? `<div style="text-align:center;margin-top:-4px"><button class="btn-link" data-nav="hoje">Voltar para hoje</button></div>` : ""}
    ${dias.map((dia) => {
      const its = porDia[dia] ?? [];
      if (modo !== "dia" && !its.length && dia !== h) return "";
      const comHora = its.filter((i) => i.hora), semHora = its.filter((i) => !i.hora);
      return `<div class="secao-titulo"${dia === h ? ' style="color:var(--agenda)"' : ""}>${dia === h ? "Hoje · " : ""}${fmtDia(dia)}</div>
        <div class="card">${its.length ? [...comHora, ...semHora].map((i) => linhaItem(i)).join("") : `<div class="vazio">Dia livre</div>`}</div>`;
    }).join("") || `<div class="card"><div class="vazio">Nada neste período</div></div>`}
    ${rodapeAtrasadas(d, de)}
    ${d.sem_data.length ? `<div class="secao-titulo">Sem data (${d.sem_data.length})</div><div class="card">${d.sem_data.map((i) => linhaItem(i)).join("")}</div>` : ""}
  </main>`;
}

// ---------------- FINANCEIRO ----------------
async function telaFinanceiro() {
  const m = estado.finMes;
  const d = await api(`/financeiro?mes=${m}`);
  estado.cache.fin = d;
  const max = (arr) => Math.max(1, ...arr.map((x) => x.total));
  const barras = (arr) => arr.map((x) => `<div class="barra-lin"><div class="top"><span>${esc(x.nome)}</span><span>${brl(x.total)}</span></div>
    <div class="trilho"><i style="width:${(x.total / max(arr)) * 100}%"></i></div></div>`).join("") || `<div class="vazio">Sem lançamentos</div>`;
  const saldo = d.total_receitas - d.total_despesas;
  return topo("Financeiro", "", `<button class="icone-btn" data-acao="novo-gasto" aria-label="Lançar gasto" style="color:var(--fin)">${ICONE('<path d="M12 5v14M5 12h14"/>')}</button>`) + `<main>
    <div class="navdatas"><button data-mes="-1" aria-label="Mês anterior">‹</button><b>${MESES_LONGOS[Number(m.slice(5)) - 1]} de ${m.slice(0, 4)}</b><button data-mes="1" aria-label="Próximo mês">›</button></div>
    <div class="card"><div class="kpi"><div class="rot">Gasto no mês</div><div class="val">${brl(d.total_despesas)}</div></div>
      <div class="grade2" style="border-top:1px solid var(--linha)"><div class="kpi"><div class="rot">Recebido</div><div class="val peq">${brl(d.total_receitas)}</div></div>
      <div class="kpi"><div class="rot">Sobra</div><div class="val peq" style="color:${saldo < 0 ? "var(--perigo)" : "var(--ok)"}">${brl(saldo)}</div></div></div></div>
    <div class="secao-titulo"><span class="ponto"></span>Contas a pagar</div>
    <div class="card">${d.contas.length ? d.contas.map(contaHtml).join("") : `<div class="vazio">Nenhuma conta vencendo nos próximos 15 dias</div>`}</div>
    <div style="margin-top:12px"><button class="btn" data-acao="novo-gasto">+ Lançar gasto</button></div>
    <div class="secao-titulo"><span class="ponto"></span>Por cartão</div><div class="card">${barras(d.por_cartao)}</div>
    <div class="secao-titulo"><span class="ponto"></span>Por categoria</div><div class="card">${barras(d.por_categoria)}</div>
    <div class="secao-titulo"><span class="ponto" style="background:var(--afiloop)"></span>Comissões do Afiloop</div>
    <div class="card"><div class="kpi"><div class="val peq">${brl(d.comissoes_afiloop)}</div><div class="rot">entram aqui como receita quando começarem</div></div></div>
    <div class="secao-titulo"><span class="ponto"></span>Lançamentos do mês</div>
    <div class="card">${d.lancamentos.map((l) => `<div class="linha-item"><div class="txt"><div class="t1">${esc(l.titulo.replace(/^\d{4}-\d{2}(-\d{2})? - (\d+ - )?/, ""))}${l.pendente ? '<span class="sinc">⏳</span>' : ""}</div>
      <div class="t2">${[l.data ? fmtDia(String(l.data)) : "", l.categoria, l.forma].filter(Boolean).map(esc).join(" · ")}</div></div>
      <b style="font-variant-numeric:tabular-nums;${l.natureza === "receita" ? "color:var(--ok)" : ""}">${l.natureza === "receita" ? "+" : ""}${brl(l.valor)}</b></div>`).join("") || `<div class="vazio">Nada lançado</div>`}</div></main>`;
}

// ---------------- EU ----------------
const EMOCOES = ["grata", "feliz", "tranquila", "produtiva", "animada", "cansada", "ansiosa", "estressada", "triste", "irritada", "sobrecarregada"];
async function telaEu() {
  const dataRef = estado.euDia;
  const deHab = [somaDias(dataRef, -6), dataRef.slice(0, 7) + "-01"].sort()[0];
  const [d, metas, mesH, hab] = await Promise.all([api(`/dia?data=${dataRef}`), api("/metas"), api(`/humor-mes?mes=${dataRef.slice(0, 7)}`), api(`/habitos?de=${deHab}&ate=${dataRef}`)]);
  estado.cache.dia = d;
  const escala = (k, v) => `<div class="escala">${[1, 2, 3, 4, 5].map((n) => `<button class="${Number(v) === n ? "on" : ""}" data-escala="${k}" data-v="${n}">${n}</button>`).join("")}</div>`;
  const h = hojeISO();
  return topo("Eu", "") + `<main>
    <div class="navdatas"><button data-euDia="-1" aria-label="Dia anterior">‹</button><b>${dataRef === h ? "Hoje · " : ""}${fmtDia(dataRef)}</b><button data-euDia="1" aria-label="Próximo dia" ${dataRef >= h ? "disabled style='opacity:.3'" : ""}>›</button></div>
    ${d.pendente ? `<div class="aviso" style="background:color-mix(in srgb,var(--agenda) 10%,transparent)">⏳ Sincronizando com o Obsidian…</div>` : ""}
    <div class="card"><div class="humores">${d.humores.map((x) => `<button class="${d.humor === x ? "on" : ""}" data-humor="${x}" aria-label="${x}">${x.split(" ")[0]}</button>`).join("")}</div>
      <div style="text-align:center;font-size:13px;color:var(--txt2);margin:-4px 0 8px">${esc(d.humor ? d.humor.split(" ").slice(1).join(" ") : "Como você está?")}</div>
      <div class="rotulo-lin"><span>Energia</span>${escala("energia", d.energia)}</div>
      <div class="rotulo-lin"><span>Sono</span>${escala("sono", d.sono)}</div>
      <div class="pad" style="border-top:1px solid var(--linha)"><div style="font-size:13px;color:var(--txt2);margin-bottom:8px;font-weight:600">Emoções</div>
      <div class="chips">${[...new Set([...EMOCOES, ...d.emocoes])].map((e) => `<button class="chip ${d.emocoes.includes(e) ? "on" : ""}" data-emocao="${esc(e)}">${esc(e)}</button>`).join("")}</div></div></div>
    <div class="secao-titulo" id="eu-habitos"><span class="ponto"></span>Hábitos</div>
    <div class="card">${d.habitos_lista.map((x) => `<div class="linha-item"><button class="check ${d.habitos[x.propriedade] ? "on" : ""}" style="--c:var(--eu)" data-habito="${esc(x.propriedade)}" aria-label="${esc(x.titulo)}"></button>
      <div class="txt"><div class="t1">${esc(x.titulo)}</div><div class="t2">${x.feitos_semana} de ${x.meta_semana} nos últimos 7 dias</div></div></div>`).join("")}</div>
    ${habitosGrade(hab, dataRef)}
    <div class="secao-titulo"><span class="ponto"></span>Journal</div>
    <div class="card">${d.secoes.map((s) => `<div class="jsecao"><h3>${esc(s)}</h3>${d.journal[s]?.length ? `<ul>${d.journal[s].map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}
      <div class="add"><textarea rows="1" placeholder="Escreva aqui…" data-journal="${esc(s)}"></textarea><button class="btn pequeno" data-acao="journal" data-secao="${esc(s)}">Salvar</button></div></div>`).join("")}
      <div class="jsecao"><h3>Observações</h3><div class="add"><textarea rows="1" data-obs placeholder="Algo mais sobre o dia">${esc(d.observacoes)}</textarea><button class="btn pequeno" data-acao="obs">Salvar</button></div></div></div>
    <div class="secao-titulo"><span class="ponto"></span>Humor, sono e energia no mês</div>
    <div class="card">${grafico(mesH)}<div class="legenda"><span><i style="background:var(--eu)"></i>humor</span><span><i style="background:var(--agenda)"></i>sono</span><span><i style="background:var(--hoje)"></i>energia</span></div></div>
    <div class="secao-titulo" id="eu-metas" style="--area:var(--metas)"><span class="ponto"></span>Metas <button class="acao" data-acao="nova-meta">+ Nova</button></div>
    <div class="card">${metas.length ? metas.map(metaHtml).join("") : `<div class="vazio">Nenhuma meta ainda. Toque em "+ Nova".</div>`}</div></main>`;
}

const CORES_HAB = ["#ec4899", "#22c55e", "#8b5cf6", "#f59e0b", "#3b82f6", "#14b8a6"];
function habitosGrade(hab, ref) {
  if (!hab.habitos.length) return "";
  const semana = Array.from({ length: 7 }, (_, k) => somaDias(ref, k - 6));
  const mes = ref.slice(0, 7), primeiro = mes + "-01";
  const diasMes = []; for (let x = primeiro; x.startsWith(mes) && x <= ref; x = somaDias(x, 1)) diasMes.push(x);
  const fim = somaDias(somaMes(mes, 1) + "-01", -1);
  const todos = []; for (let x = primeiro; x <= fim; x = somaDias(x, 1)) todos.push(x);
  const feito = (dia, p) => !!hab.dias[dia]?.[p];
  return `<div class="secao-titulo"><span class="ponto"></span>Últimos 7 dias</div>
    <div class="card pad hab-sem"><div class="hab-lin cab"><span></span>${semana.map((x) => `<i>${"DSTQQSS"[diaSemana(x)]}</i>`).join("")}</div>
    ${hab.habitos.map((x, k) => `<div class="hab-lin"><span>${esc(x.titulo)}</span>${semana.map((dia) => `<b class="${feito(dia, x.propriedade) ? "on" : ""} ${dia === ref ? "hj" : ""}" style="--c:${CORES_HAB[k % 6]}"></b>`).join("")}</div>`).join("")}</div>
    <div class="secao-titulo"><span class="ponto"></span>${MESES_LONGOS[Number(mes.slice(5)) - 1]}</div>
    <div class="hab-meses">${hab.habitos.map((x, k) => {
      const n = diasMes.filter((dia) => feito(dia, x.propriedade)).length;
      const alvo = Math.round(diasMes.length * Math.min(7, x.meta_semana) / 7) || 1;
      return `<div class="card hab-mes" style="--c:${CORES_HAB[k % 6]}"><div class="tit">${esc(x.titulo)}</div>
        <div class="hab-cal">${Array.from({ length: diaSemana(primeiro) }, () => "<em></em>").join("")}${todos.map((dia) => `<b class="${feito(dia, x.propriedade) ? "on" : ""} ${dia > ref ? "fut" : ""}">${Number(dia.slice(8))}</b>`).join("")}</div>
        <div class="rod"><span>${Math.min(100, Math.round((n / alvo) * 100))}% da meta</span><span>${n} dia${n === 1 ? "" : "s"}</span></div></div>`;
    }).join("")}</div>`;
}
function grafico(pts) {
  const val = pts.filter((p) => p.humor || p.sono || p.energia);
  if (val.length < 2) return `<div class="vazio">O gráfico aparece depois de alguns dias registrados.</div>`;
  const W = 320, H = 110, n = pts.length;
  const x = (i) => 12 + (i * (W - 24)) / Math.max(1, n - 1), y = (v) => H - 10 - ((v - 1) / 4) * (H - 20);
  const linha = (k, cor) => {
    const seg = pts.map((p, i) => (p[k] ? `${x(i).toFixed(1)},${y(p[k]).toFixed(1)}` : null));
    const d = seg.reduce((acc, s, i) => s ? acc + (seg[i - 1] ? " L" : " M") + s : acc, "");
    return d ? `<path d="${d}" fill="none" stroke="${cor}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>` +
      pts.map((p, i) => p[k] ? `<circle cx="${x(i)}" cy="${y(p[k])}" r="2.6" fill="${cor}"/>` : "").join("") : "";
  };
  return `<svg class="grafico" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Gráfico do mês">
    ${[1, 3, 5].map((v) => `<line x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="var(--linha)" stroke-width="1"/>`).join("")}
    ${linha("energia", "var(--hoje)")}${linha("sono", "var(--agenda)")}${linha("humor", "var(--eu)")}</svg>`;
}
function metaHtml(m) {
  const pct = Math.round((m.progresso || 0) * 100);
  const info = [m.prazo ? `até ${fmtDia(m.prazo)}` : "", m.area, m.formato === "numero" && m.valor_alvo ? `${m.valor_atual} de ${m.valor_alvo}${m.unidade ? " " + m.unidade : ""}` : "", m.status !== "ativa" ? m.status : ""].filter(Boolean).join(" · ");
  return `<div class="meta" data-meta="${esc(m.caminho)}"><div class="cab"><b>${esc(m.titulo)}${m.pendente ? '<span class="sinc">⏳</span>' : ""}</b><span class="pct">${pct}%</span></div>
    <div class="t2" style="color:var(--txt2);font-size:13px">${esc(info)}</div><div class="trilho"><i style="width:${pct}%"></i></div>
    ${m.subitens.map((s) => `<div class="subitem ${s.feito ? "feito" : ""}"><button class="check ${s.feito ? "on" : ""}" data-sub="${esc(s.texto)}" data-feito="${s.feito ? 1 : 0}" aria-label="Concluir etapa"></button>
      <span>${esc(s.texto)}${s.prazo ? ` <small style="color:var(--txt2)">· ${fmtDia(s.prazo)}</small>` : ""}</span></div>`).join("")}
    <div style="display:flex;gap:14px;margin-top:6px">${m.formato === "numero" ? `<button class="btn-link" style="--area:var(--metas)" data-acao="meta-valor">Atualizar valor</button>` : ""}
      <button class="btn-link" style="--area:var(--metas)" data-acao="meta-sub">+ Etapa</button>
      ${m.status !== "concluida" ? `<button class="btn-link" style="--area:var(--txt2)" data-acao="meta-concluir">Concluir</button>` : ""}</div></div>`;
}

// ---------------- folhas ----------------
function folha(html, aoAbrir) {
  const fundo = document.createElement("div"); fundo.className = "fundo";
  const f = document.createElement("div"); f.className = "folha" + (html.includes("data-cheia") ? " cheia" : ""); f.innerHTML = `<div class="alca"></div><button class="fechar-folha" aria-label="Fechar">Fechar</button>${html}`;
  document.body.append(fundo, f);
  requestAnimationFrame(() => { fundo.classList.add("on"); f.classList.add("on"); });
  const esc = (e) => { if (e.key === "Escape" && f === [...document.querySelectorAll(".folha")].pop()) fechar(); };
  const fechar = () => { document.removeEventListener("keydown", esc); fundo.classList.remove("on"); f.classList.remove("on"); setTimeout(() => { fundo.remove(); f.remove(); }, 250); };
  document.addEventListener("keydown", esc); // no computador, Esc fecha a janela de cima
  fundo.onclick = fechar;
  f.querySelector(".fechar-folha").onclick = fechar;
  aoAbrir?.(f, fechar);
  return { f, fechar };
}
const opcoes = (lista, sel) => lista.map((x) => `<option ${x === sel ? "selected" : ""}>${esc(x)}</option>`).join("");

function folhaTarefa(pre = {}) {
  folha(`<h2>Nova tarefa</h2>
    <label class="campo"><span>O quê</span><input id="f-titulo" value="${esc(pre.titulo ?? "")}" placeholder="Ex.: Levar o Nicolas no pediatra"></label>
    <div class="linha-campos"><label class="campo"><span>Dia</span><input id="f-data" type="date" value="${esc(pre.data ?? hojeISO())}"></label>
    <label class="campo"><span>Hora (opcional)</span><input id="f-hora" type="time" value="${esc(pre.hora ?? "")}"></label></div>
    <div class="linha-campos"><label class="campo"><span>Área</span><select id="f-area">${["vida", "familia", "saude", "casa", "trabalho", "financeiro", "compras", "afiloop", "projetos"].map((a) => `<option value="${a}" ${a === (pre.area ?? "vida") ? "selected" : ""}>${nomeArea(a)}</option>`).join("")}</select></label>
    <label class="campo"><span>Prioridade</span><select id="f-prio">${["normal", "alta", "baixa"].map((p) => `<option ${p === (pre.prioridade ?? "normal") ? "selected" : ""}>${p}</option>`).join("")}</select></label></div>
    <button class="btn" id="f-ok" style="--area:var(--agenda)">Salvar na Agenda</button>`, (f, fechar) => {
    $("#f-ok", f).onclick = async () => {
      const b = { titulo: $("#f-titulo", f).value, data: $("#f-data", f).value || null, hora: $("#f-hora", f).value || null, area: $("#f-area", f).value, prioridade: $("#f-prio", f).value };
      if (!b.titulo.trim()) return $("#f-titulo", f).classList.add("falta");
      await acao(() => api("/tarefa/criar", b), "Salvo ✓ (vai para o Obsidian)"); fechar(); pre.onSalvo?.(); if (estado.aba !== "chat") render();
    };
  });
}
async function folhaGasto(pre = {}) {
  const fin = estado.cache.fin ?? await api("/financeiro");
  const cartaoMes = (forma, data) => forma?.startsWith("Cartão") ? somaMes((data || hojeISO()).slice(0, 7), 1) : (data || hojeISO()).slice(0, 7);
  folha(`<h2>${pre.natureza === "receita" ? "Nova receita" : "Lançar gasto"}</h2>
    <div class="linha-campos"><label class="campo"><span>Valor (R$)</span><input id="g-valor" inputmode="decimal" value="${esc(pre.valor ?? "")}" placeholder="0,00"></label>
    <label class="campo"><span>Data</span><input id="g-data" type="date" value="${esc(pre.data ?? hojeISO())}"></label></div>
    <label class="campo"><span>Descrição</span><input id="g-desc" value="${esc(pre.descricao ?? "")}" placeholder="Ex.: Mercado da semana"></label>
    <label class="campo"><span>Categoria</span><select id="g-cat"><option value="">Escolha…</option>${opcoes(fin.categorias, pre.categoria)}</select></label>
    <label class="campo"><span>Forma de pagamento</span><select id="g-forma"><option value="">Escolha…</option>${opcoes(fin.formas, pre.forma_pagamento)}</select></label>
    <div class="linha-campos"><label class="campo"><span>Parcelas</span><input id="g-parc" type="number" min="1" max="48" value="${esc(pre.parcelas ?? 1)}"></label>
    <label class="campo"><span>Mês de pagamento</span><input id="g-mes" type="month" value="${cartaoMes(pre.forma_pagamento, pre.data)}"></label></div>
    <button class="btn" id="g-ok" style="--area:var(--fin)">Salvar</button>`, (f, fechar) => {
    $("#g-forma", f).onchange = () => { $("#g-mes", f).value = cartaoMes($("#g-forma", f).value, $("#g-data", f).value); };
    $("#g-ok", f).onclick = async () => {
      const b = { valor: $("#g-valor", f).value.replace(",", "."), data: $("#g-data", f).value, descricao: $("#g-desc", f).value, categoria: $("#g-cat", f).value,
        forma_pagamento: $("#g-forma", f).value, parcelas: Number($("#g-parc", f).value) || 1, mes_pagamento: $("#g-mes", f).value, natureza: pre.natureza ?? "despesa" };
      let falta = false;
      for (const [id, v] of [["g-valor", Number(b.valor) > 0], ["g-cat", b.categoria], ["g-forma", b.forma_pagamento]]) { $("#" + id, f).classList.toggle("falta", !v); if (!v) falta = true; }
      if (falta) return toast("Preencha valor, categoria e forma de pagamento.");
      await acao(() => api("/lancamento/criar", b), "Lançado ✓"); fechar(); estado.cache.fin = null; pre.onSalvo?.(); if (estado.aba !== "chat") render();
    };
  });
}
function folhaMeta(pre = {}) {
  folha(`<h2>Nova meta</h2>
    <label class="campo"><span>Meta</span><input id="m-titulo" value="${esc(pre.titulo ?? "")}" placeholder="Ex.: Afiloop pagar as contas da casa"></label>
    <div class="linha-campos"><label class="campo"><span>Área</span><select id="m-area">${["pessoal", "afiloop", "financeiro", "saude", "familia", "trabalho"].map((a) => `<option value="${a}">${nomeArea(a)}</option>`).join("")}</select></label>
    <label class="campo"><span>Prazo</span><input id="m-prazo" type="date"></label></div>
    <label class="campo"><span>Tipo</span><select id="m-formato"><option value="projeto">Projeto (com etapas)</option><option value="numero">Número (ex.: R$, seguidores)</option><option value="habito">Hábito</option></select></label>
    <div id="m-num" class="linha-campos esconder"><label class="campo"><span>Alvo</span><input id="m-alvo" inputmode="decimal"></label><label class="campo"><span>Unidade</span><input id="m-unid" placeholder="R$, seguidores…"></label></div>
    <label class="campo"><span>Etapas (uma por linha; prazo opcional no fim: "texto - 15/12")</span><textarea id="m-subs" placeholder="Bater 1.000 seguidores - 15/12&#10;Virar afiliada TikTok Shop - 31/01"></textarea></label>
    <button class="btn" id="m-ok" style="--area:var(--metas)">Criar meta</button>`, (f, fechar) => {
    $("#m-formato", f).onchange = (e) => $("#m-num", f).classList.toggle("esconder", e.target.value !== "numero");
    $("#m-ok", f).onclick = async () => {
      const ano = hojeISO().slice(0, 4);
      const subitens = $("#m-subs", f).value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
        const m = l.match(/^(.*?)(?:\s*[-–]\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?)?$/);
        let prazo = null;
        if (m[2]) { let a = m[4] ? (m[4].length === 2 ? "20" + m[4] : m[4]) : ano; prazo = `${a}-${m[3].padStart(2, "0")}-${m[2].padStart(2, "0")}`; if (!m[4] && prazo < hojeISO()) prazo = `${Number(a) + 1}${prazo.slice(4)}`; }
        return { texto: m[1].trim(), prazo };
      });
      const b = { titulo: $("#m-titulo", f).value, area: $("#m-area", f).value, prazo: $("#m-prazo", f).value || null, formato: $("#m-formato", f).value,
        valor_alvo: $("#m-alvo", f).value.replace(",", "."), unidade: $("#m-unid", f).value, subitens };
      if (!b.titulo.trim()) return $("#m-titulo", f).classList.add("falta");
      await acao(() => api("/meta/criar", b), "Meta criada ✓"); fechar(); pre.onSalvo?.(); if (estado.aba !== "chat") render();
    };
  });
}
function folhaItem(dados) {
  const amanha = somaDias(hojeISO(), 1), prox = somaDias(hojeISO(), 7 - ((diaSemana(hojeISO()) + 6) % 7));
  folha(`<h2 style="font-size:18px">${esc(dados.t)}</h2><div class="card acoes-lista">
    <button data-f="feito">${dados.f ? "↩️ Marcar como não feita" : "✅ Marcar como feita"}</button>
    ${dados.o === "agenda" ? `<button data-f="amanha">⏰ Adiar para amanhã</button><button data-f="semana">📆 Adiar para a próxima semana</button>
    <button data-f="alta">❗ Prioridade alta</button><button data-f="normal">➖ Prioridade normal</button>` : ""}</div>`, (f, fechar) => {
    f.onclick = async (e) => {
      const b = e.target.closest("button[data-f]"); if (!b) return;
      const corpo = { feito: { feito: !dados.f }, amanha: { data: amanha }, semana: { data: prox }, alta: { prioridade: "alta" }, normal: { prioridade: "normal" } }[b.dataset.f];
      if (dados.o === "meta") { await acao(() => api("/meta/atualizar", { caminho: dados.c, subitem: { item: dados.t.split(" · ")[0], feito: !dados.f } }), "Atualizado ✓"); }
      else await acao(() => api("/tarefa/atualizar", { caminho: dados.c, ...corpo }), "Atualizado ✓");
      fechar(); render();
    };
  });
}
async function folhaAjustes() {
  const sync = await api("/sync").catch(() => null);
  const quando = (t) => t ? new Date(t).toLocaleString("pt-BR", { timeZone: "America/Recife", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
  const permissao = "Notification" in window ? Notification.permission : "indisponível";
  folha(`<h2>Ajustes</h2><div class="card acoes-lista">
    <button data-f="notif">🔔 ${permissao === "granted" ? "Notificações ligadas · enviar teste" : "Ligar notificações"}</button>
    <button data-f="telegram">📦 Telegram do pack</button>
    ${temChaveAqui() ? "" : `<button data-f="desbloqueio">🔓 Entrar sem PIN neste aparelho (${nomeDesbloqueio()})</button>`}
    <button data-f="tema">🌗 Tema: ${({ light: "claro", dark: "escuro" })[localStorage.getItem("sc_tema")] ?? "automático (segue o iPhone)"}</button>
    <button data-f="sair">🚪 Sair deste aparelho</button></div>
    <div class="secao-titulo">Sincronização com o Obsidian</div><div class="card pad" style="font-size:14px;line-height:1.7">
    Última mudança aplicada no Obsidian: <b>${quando(sync?.ultima_aplicacao)}</b><br>Última leitura das notas: <b>${quando(sync?.ultima_sincronizacao)}</b><br>
    Na fila: <b>${(sync?.pendentes_app ?? 0) + (sync?.pendentes_ponte ?? 0)}</b> mudança(s)</div>
    ${permissao !== "granted" && !navigator.standalone && /iPhone|iPad/.test(navigator.userAgent) ? `<p style="color:var(--txt2);font-size:13px;margin:12px 4px">No iPhone, as notificações só funcionam com o app na Tela de Início: Safari → Compartilhar → "Adicionar à Tela de Início".</p>` : ""}`,
  (f, fechar) => {
    f.onclick = async (e) => {
      const b = e.target.closest("button[data-f]"); if (!b) return;
      if (b.dataset.f === "sair") { await api("/sair", {}).catch(() => {}); fechar(); bloquear(); }
      if (b.dataset.f === "tema") {
        const prox = { "": "light", light: "dark", dark: "" }[localStorage.getItem("sc_tema") ?? ""];
        prox ? localStorage.setItem("sc_tema", prox) : localStorage.removeItem("sc_tema"); aplicarTema(); fechar(); folhaAjustes();
      }
      if (b.dataset.f === "notif") { await ligarNotificacoes(); fechar(); }
      if (b.dataset.f === "telegram") { fechar(); setTimeout(folhaTelegram, 260); }
      if (b.dataset.f === "desbloqueio") { fechar(); if (await podeDesbloqueio()) setTimeout(() => folhaDesbloqueio(), 260); else toast(`Este navegador não tem ${nomeDesbloqueio()} disponível.`); }
    };
  });
}
function aplicarTema() { const t = localStorage.getItem("sc_tema"); t ? document.documentElement.setAttribute("data-theme", t) : document.documentElement.removeAttribute("data-theme"); }


// ---------------- busca e leitura do Segundo Cérebro ----------------
const AREAS_RAIZ = [["01 - Vida", "🏡 Vida"], ["02 - Trabalho", "⚖️ Trabalho"], ["03 - Conhecimento", "📚 Conhecimento"], ["04 - Projetos", "🚀 Projetos"],
  ["06 - Financeiro", "💰 Financeiro"], ["07 - Agenda", "📅 Agenda"], ["00 - Entrada", "📥 Entrada"]];
function folhaBusca() {
  folha(`<h2>Segundo Cérebro</h2>
    <label class="campo"><input id="b-q" type="search" placeholder="Pergunte ou busque: qual meu título de eleitor?" enterkeyhint="search"></label>
    <button class="btn" id="b-perg" style="--area:var(--eu);margin:-2px 0 12px">✨ Perguntar ao Segundo Cérebro</button>
    <div id="b-resp"></div>
    <div id="b-res"><div class="atalhos">${[["compras","🛒","Compras"],["wishlist","🎁","Wishlist"],["saude","🩺","Saúde"],["juridico","⚖️","Jurídico"],["midia","🎬","Filmes e livros"]].map(([k,e,n]) => `<button data-central="${k}"><span>${e}</span>${n}</button>`).join("")}</div>
    <div class="secao-titulo" style="margin-top:4px">Áreas</div><div class="card acoes-lista">${AREAS_RAIZ.map(([p, n]) => `<button data-pasta="${esc(p)}">${n}</button>`).join("")}</div></div>`,
  (f) => {
    let timer;
    const res = $("#b-res", f);
    $("#b-q", f).oninput = (e) => {
      clearTimeout(timer);
      const termo = e.target.value.trim();
      if (termo.length < 2) return;
      timer = setTimeout(async () => {
        res.innerHTML = `<div class="carregando">Buscando…</div>`;
        try {
          const r = await api(`/buscar?q=${encodeURIComponent(termo)}`);
          res.innerHTML = r.length ? `<div class="card">${r.map((x) => `<div class="linha-item" data-nota="${esc(x.caminho)}" role="button"><div class="txt"><div class="t1">${esc(x.titulo)}</div>
            <div class="t2">${esc(x.caminho.split("/").slice(0, -1).join(" › "))}</div></div></div>`).join("")}</div>` : `<div class="vazio">Nada encontrado.</div>`;
        } catch (er) { res.innerHTML = `<div class="vazio">${esc(er.message)}</div>`; }
      }, 350);
    };
    const perguntar = async () => {
      const pergunta = $("#b-q", f).value.trim(); if (!pergunta) return $("#b-q", f).focus();
      const bt = $("#b-perg", f); bt.disabled = true; bt.textContent = "Procurando nas suas notas…";
      try {
        const r = await api("/perguntar", { pergunta });
        $("#b-resp", f).innerHTML = `<div class="card pad" style="margin-bottom:14px"><div style="font-size:16px;line-height:1.5">${mdInline(r.resposta).replace(/\n/g, "<br>")}</div>
          ${r.fontes.length ? `<div style="margin-top:10px;font-size:13px;color:var(--txt2)">Fonte: ${r.fontes.map((x) => `<a href="#" data-nota="${esc(x.caminho)}" style="color:var(--agenda);font-weight:600;text-decoration:none">${esc(x.titulo)}</a>`).join(" · ")}</div>` : ""}</div>`;
      } catch (er) { $("#b-resp", f).innerHTML = `<div class="aviso">${esc(er.message)}</div>`; }
      bt.disabled = false; bt.textContent = "✨ Perguntar ao Segundo Cérebro";
    };
    $("#b-perg", f).onclick = perguntar;
    $("#b-q", f).onkeydown = (e) => { if (e.key === "Enter" && /\?$|^(qual|quando|onde|quanto|quem|como|o que|que)\b/i.test(e.target.value.trim())) { e.preventDefault(); perguntar(); } };
    f.addEventListener("click", (e) => {
      const n = e.target.closest("[data-nota]"); if (n) { e.preventDefault(); return abrirNota(n.dataset.nota); }
      const p = e.target.closest("[data-pasta]"); if (p) return abrirPasta(p.dataset.pasta, res);
      const c = e.target.closest("[data-central]"); if (c) return ({ compras: () => folhaListas(false), wishlist: () => folhaListas(true), saude: folhaSaude, juridico: folhaJuridico, midia: folhaMidia })[c.dataset.central]();
    });
  });
}
async function abrirPasta(pasta, alvo) {
  alvo.innerHTML = `<div class="carregando">Carregando…</div>`;
  const d = await api(`/pasta?p=${encodeURIComponent(pasta)}`);
  const pai = pasta.includes("/") ? pasta.split("/").slice(0, -1).join("/") : "";
  alvo.innerHTML = `<div class="secao-titulo" style="margin-top:4px">${esc(pasta.split("/").join(" › "))}</div>
    <button class="btn-link" data-pasta-voltar="${esc(pai)}">‹ Voltar</button>
    ${d.subpastas.length ? `<div class="card acoes-lista" style="margin-bottom:12px">${d.subpastas.map((s) => `<button data-pasta="${esc(pasta + "/" + s.nome)}">📁 ${esc(s.nome)} <span style="margin-left:auto;color:var(--txt2);font-size:14px">${s.total}</span></button>`).join("")}</div>` : ""}
    ${d.notas.length ? `<div class="card">${d.notas.map((x) => `<div class="linha-item" data-nota="${esc(x.caminho)}" role="button"><div class="txt"><div class="t1">${esc(x.titulo)}</div>${x.tipo ? `<div class="t2">${esc(x.tipo)}</div>` : ""}</div></div>`).join("")}</div>` : ""}`;
  const v = alvo.querySelector("[data-pasta-voltar]");
  v.onclick = (e) => { e.stopPropagation(); const p = v.dataset.pastaVoltar; if (p) abrirPasta(p, alvo); else alvo.innerHTML = `<div class="secao-titulo" style="margin-top:4px">Áreas</div><div class="card acoes-lista">${AREAS_RAIZ.map(([pp, n]) => `<button data-pasta="${esc(pp)}">${n}</button>`).join("")}</div>`; };
}
function mdInline(t) {
  return esc(t)
    .replace(/!\[\[([^\]]+)\]\]/g, "🖼️ $1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, (_, a, b) => `<a href="#" data-link="${a}">${b}</a>`)
    .replace(/\[\[([^\]]+)\]\]/g, (_, a) => `<a href="#" data-link="${a}">${a.split("/").pop().replace(/\.md$/, "")}</a>`)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1<i>$2</i>").replace(/`([^`]+)`/g, "<code>$1</code>");
}
function markdown(md) {
  const linhas = md.replace(/```[\s\S]*?```/g, "\n_(painel do Obsidian)_\n").split("\n");
  let html = "", lista = null, tabela = [];
  const fecharLista = () => { if (lista) { html += `</${lista}>`; lista = null; } };
  const fecharTabela = () => {
    if (!tabela.length) return;
    const rows = tabela.filter((r) => !/^\|?\s*:?-{2,}/.test(r)).map((r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
    html += `<div style="overflow-x:auto"><table class="md-tab">${rows.map((r, i) => `<tr>${r.map((c) => i === 0 ? `<th>${mdInline(c)}</th>` : `<td>${mdInline(c)}</td>`).join("")}</tr>`).join("")}</table></div>`;
    tabela = [];
  };
  for (let l of linhas) {
    l = l.replace(/^>\s?\[!([\w-]+)\][-+]?\s*/, "").replace(/^>\s?/, "");
    if (/^\s*\|/.test(l)) { fecharLista(); tabela.push(l.trim()); continue; } else fecharTabela();
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h) { fecharLista(); html += `<h${Math.min(h[1].length + 1, 4)}>${mdInline(h[2])}</h${Math.min(h[1].length + 1, 4)}>`; continue; }
    const c = l.match(/^\s*[-*] \[([ xX])\]\s+(.*)/);
    if (c) { if (lista !== "ul") { fecharLista(); html += '<ul class="md-check">'; lista = "ul"; } html += `<li>${c[1] === " " ? "☐" : "☑️"} ${mdInline(c[2])}</li>`; continue; }
    const b = l.match(/^\s*[-*+]\s+(.*)/);
    if (b) { if (lista !== "ul") { fecharLista(); html += "<ul>"; lista = "ul"; } html += `<li>${mdInline(b[1])}</li>`; continue; }
    const n = l.match(/^\s*\d+\.\s+(.*)/);
    if (n) { if (lista !== "ol") { fecharLista(); html += "<ol>"; lista = "ol"; } html += `<li>${mdInline(n[1])}</li>`; continue; }
    fecharLista();
    if (l.trim()) html += `<p>${mdInline(l)}</p>`;
  }
  fecharLista(); fecharTabela();
  return html;
}
async function abrirNota(caminho, titulo) {
  let n;
  try { n = await api(`/nota?c=${encodeURIComponent(caminho ?? "")}${titulo ? `&t=${encodeURIComponent(titulo)}` : ""}`); }
  catch (e) { return toast(e.message); }
  const props = Object.entries(n.propriedades ?? {}).filter(([k, v]) => v !== null && v !== "" && !["cssclasses", "position"].includes(k));
  folha(`<div style="font-size:12px;color:var(--txt2);margin:0 2px 4px">${esc(n.caminho.split("/").slice(0, -1).join(" › "))}</div>
    <h2 style="margin-top:0">${esc(n.titulo)}</h2>
    ${props.length ? `<div class="card pad" style="font-size:14px;margin-bottom:12px">${props.map(([k, v]) => `<div style="display:flex;gap:10px;padding:3px 0"><span style="color:var(--txt2);min-width:110px">${esc(k.replace(/_/g, " "))}</span><span>${mdInline(Array.isArray(v) ? v.join(", ") : String(v))}</span></div>`).join("")}</div>` : ""}
    <div class="card pad md">${markdown(n.conteudo || "") || '<span style="color:var(--txt2)">Nota sem texto.</span>'}</div>`,
  (f) => {
    f.addEventListener("click", (e) => {
      const a = e.target.closest("a[data-link]"); if (!a) return;
      e.preventDefault();
      const alvo = a.dataset.link.replace(/#.*$/, "");
      abrirNota(alvo.endsWith(".md") ? alvo : alvo.includes("/") ? alvo + ".md" : "", alvo.split("/").pop().replace(/\.md$/, ""));
    });
  });
}


// ---------------- central: compras, wishlist, saúde, jurídico, filmes e livros ----------------
function folhaViva(titulo, desenhar, aoClicar) {
  return folha(`<h2>${titulo}</h2><div class="viva" data-cheia><div class="carregando">Carregando…</div></div>`, async (f, fechar) => {
    const alvo = $(".viva", f);
    const redesenhar = async (dados) => { try { alvo.innerHTML = await desenhar(dados); } catch (e) { alvo.innerHTML = `<div class="aviso">${esc(e.message)}</div>`; } };
    f.addEventListener("click", (e) => aoClicar(e, redesenhar, f, fechar));
    redesenhar();
  });
}
let listaAtual = "supermercado";
function folhaListas(wish) {
  let cache = null;
  const desenhar = async (dados) => {
    cache = dados ?? cache ?? await api("/listas");
    const ls = cache.filter((l) => wish ? l.lista === "wishlist" : l.lista !== "wishlist");
    const atual = wish ? ls[0] : (ls.find((l) => l.lista === listaAtual) ?? ls[0]);
    const abertos = atual.itens.filter((i) => !i.feito), feitos = atual.itens.filter((i) => i.feito);
    const item = (i) => `<div class="linha-item ${i.feito ? "feito" : ""}"><button class="check ${i.feito ? "on" : ""}" style="--c:${wish ? "var(--eu)" : "#eab308"}" data-tg="${esc(i.linha)}" data-f="${i.feito ? 1 : 0}" aria-label="Marcar"></button>
      <div class="txt"><div class="t1">${esc(i.nome)}</div>${wish && (i.preco || i.prioridade) ? `<div class="t2">${esc([i.preco, i.prioridade ? "prioridade " + i.prioridade : ""].filter(Boolean).join(" · "))}</div>` : ""}</div>
      ${i.link ? `<a href="${esc(i.link)}" target="_blank" rel="noopener" class="btn pequeno sec" style="text-decoration:none">Ver</a>` : ""}
      ${wish && !i.feito ? `<button class="btn pequeno" style="--area:var(--eu)" data-comprei="${esc(i.linha)}" data-preco="${esc(i.preco ?? "")}" data-nome="${esc(i.nome)}">Comprei</button>` : ""}</div>`;
    return `${wish ? "" : `<div class="segmentado">${ls.map((l) => `<button class="${l === atual ? "on" : ""}" data-lista="${esc(l.lista)}">${esc(l.titulo)}${l.itens.filter((i) => !i.feito).length ? ` (${l.itens.filter((i) => !i.feito).length})` : ""}</button>`).join("")}</div>`}
      ${atual.pendente ? `<div class="aviso" style="background:color-mix(in srgb,var(--agenda) 10%,transparent)">⏳ Sincronizando com o Obsidian…</div>` : ""}
      <div class="card pad" style="display:grid;gap:8px"><input id="l-novo" placeholder="${wish ? "O que você quer?" : "Adicionar item"}" style="border:0;background:var(--card2);border-radius:10px;padding:11px 12px;font-size:16px">
        ${wish ? `<div class="linha-campos" style="margin:0"><input id="l-preco" inputmode="decimal" placeholder="Preço (R$)" style="border:0;background:var(--card2);border-radius:10px;padding:11px 12px;font-size:16px">
        <select id="l-prio" style="border:0;background:var(--card2);border-radius:10px;padding:11px 12px;font-size:16px"><option value="">Prioridade</option><option>alta</option><option>média</option><option>baixa</option></select></div>
        <input id="l-link" inputmode="url" placeholder="Link (opcional)" style="border:0;background:var(--card2);border-radius:10px;padding:11px 12px;font-size:16px">` : ""}
        <button class="btn" style="--area:${wish ? "var(--eu)" : "#eab308"}" data-add="${esc(atual.caminho)}">Adicionar</button></div>
      <div class="card" style="margin-top:12px">${abertos.length ? abertos.map(item).join("") : `<div class="vazio">${wish ? "Sua wishlist está vazia." : "Lista vazia 🎉"}</div>`}</div>
      ${feitos.length ? `<div class="secao-titulo">${wish ? "Comprados" : "Já peguei"} (${feitos.length}) ${wish ? "" : `<button class="acao" data-limpar="${esc(atual.caminho)}">Limpar</button>`}</div><div class="card">${feitos.map(item).join("")}</div>` : ""}`
      .replace(/data-tg=/g, `data-cam="${esc(atual.caminho)}" data-tg=`);
  };
  folhaViva(wish ? "🎁 Wishlist" : "🛒 Compras", desenhar, async (e, redesenhar, f) => {
    const t = e.target.closest("button"); if (!t) return;
    if (t.dataset.lista) { listaAtual = t.dataset.lista; return redesenhar(); }
    if (t.dataset.add) {
      const novo = $("#l-novo", f).value.trim(); if (!novo) return $("#l-novo", f).focus();
      const corpo = { caminho: t.dataset.add, novo, ...(wish ? { preco: $("#l-preco", f).value.trim(), prioridade: $("#l-prio", f).value, link: $("#l-link", f).value.trim() } : {}) };
      t.disabled = true; return redesenhar(await acao(() => api("/lista/item", corpo), "Adicionado ✓"));
    }
    if (t.dataset.tg) { t.classList.toggle("on"); return redesenhar(await acao(() => api("/lista/item", { caminho: t.dataset.cam, item: t.dataset.tg, feito: t.dataset.f !== "1" }))); }
    if (t.dataset.limpar) {
      const l = cache.find((x) => x.caminho === t.dataset.limpar);
      let r; for (const i of l.itens.filter((x) => x.feito)) r = await api("/lista/item", { caminho: l.caminho, remover: i.linha });
      toast("Lista limpa ✓"); return redesenhar(r);
    }
    if (t.dataset.comprei) {
      const l = cache.find((x) => x.lista === "wishlist");
      await acao(() => api("/lista/item", { caminho: l.caminho, item: t.dataset.comprei, feito: true }), "Marcado como comprado ✓");
      redesenhar(null);
      const valor = (t.dataset.preco || "").replace(/[^\d,.]/g, "").replace(/\.(?=\d{3})/g, "").replace(",", ".");
      setTimeout(() => folhaGasto({ valor, descricao: t.dataset.nome }), 300);
    }
  });
}
let saudePessoa = "Nicolas";
function folhaSaude() {
  folhaViva("🩺 Saúde", async () => {
    const d = await api(`/saude?p=${saudePessoa}`);
    const cor = { Juliana: "#ec4899", Nicolas: "#22c55e", Guy: "#38bdf8" }[d.pessoa];
    return `<div class="segmentado">${["Juliana", "Nicolas", "Guy"].map((p) => `<button class="${p === d.pessoa ? "on" : ""}" data-pessoa="${p}">${p}</button>`).join("")}</div>
      <div class="secao-titulo" style="--area:${cor}"><span class="ponto"></span>Próximos</div>
      <div class="card">${d.proximos.length ? d.proximos.map((i) => linhaItem(i, { mostrarDia: true })).join("") : `<div class="vazio">Nada marcado</div>`}</div>
      <div class="secao-titulo" style="--area:${cor}"><span class="ponto"></span>Registros e documentos</div>
      <div class="card">${d.registros.length ? d.registros.map((r) => `<div class="linha-item" data-nota="${esc(r.caminho)}" role="button" style="box-shadow:inset 4px 0 0 ${cor}"><div class="txt"><div class="t1">${esc(r.titulo)}</div>
        <div class="t2">${esc([r.data ? fmtDia(r.data) + " " + r.data.slice(0, 4) : "", r.tipo].filter(Boolean).join(" · "))}</div></div></div>`).join("") : `<div class="vazio">Nenhum registro</div>`}</div>`;
  }, async (e, redesenhar) => {
    const t = e.target.closest("[data-pessoa],[data-nota],[data-acao='marcar']"); if (!t) return;
    if (t.dataset.pessoa) { saudePessoa = t.dataset.pessoa; return redesenhar(); }
    if (t.dataset.nota) return abrirNota(t.dataset.nota);
    const d = JSON.parse(t.closest("[data-item]").dataset.item);
    t.classList.toggle("on"); await acao(() => api("/tarefa/atualizar", { caminho: d.c, feito: !d.f }), "Atualizado ✓"); redesenhar();
  });
}
function folhaJuridico() {
  folhaViva("⚖️ Jurídico", async () => {
    const d = await api("/juridico");
    const cor = "#1d4ed8";
    return `<div class="secao-titulo" style="--area:${cor}"><span class="ponto"></span>Prazos em aberto (${d.prazos.length})</div>
      <div class="card">${d.prazos.map((p) => `<div class="linha-item" style="box-shadow:inset 4px 0 0 ${p.vencimento && p.vencimento < d.hoje ? "var(--perigo)" : cor}">
        <button class="check" style="--c:${cor}" data-prazo="${esc(p.caminho)}" aria-label="Cumprido"></button>
        <div class="txt" data-nota="${esc(p.caminho)}" role="button"><div class="t1">${esc(p.titulo)}</div><div class="t2">${esc([p.vencimento ? (p.vencimento < d.hoje ? "⚠️ venceu " : "vence ") + fmtDia(p.vencimento) + "/" + p.vencimento.slice(2, 4) : p.quando, p.instrumento].filter(Boolean).join(" · "))}</div></div></div>`).join("") || `<div class="vazio">Nenhum prazo em aberto</div>`}</div>
      <div class="secao-titulo" style="--area:${cor}"><span class="ponto"></span>Processos (${d.processos.length})</div>
      <div class="card">${d.processos.map((p) => `<div class="linha-item" data-nota="${esc(p.caminho)}" role="button"><div class="txt"><div class="t1">${esc(p.titulo.replace(/^⚖️\s*/, ""))}</div>
        <div class="t2">${esc([p.status, p.fase, p.prazo ? "prazo " + fmtDia(p.prazo) : "", p.empresa].filter(Boolean).join(" · "))}</div></div></div>`).join("") || `<div class="vazio">Nenhum processo</div>`}</div>
      <div class="secao-titulo" style="--area:${cor}"><span class="ponto"></span>Contratos: próximos vencimentos</div>
      <div class="card">${d.contratos.map((c) => `<div class="linha-item" data-nota="${esc(c.caminho)}" role="button"><div class="txt"><div class="t1">${esc(c.titulo)}</div>
        <div class="t2">${esc(["vence " + c.vencimento.split("-").reverse().join("/"), c.risco ? "risco " + c.risco : ""].filter(Boolean).join(" · "))}</div></div></div>`).join("")}</div>`;
  }, async (e, redesenhar) => {
    const t = e.target.closest("[data-prazo],[data-nota]"); if (!t) return;
    if (t.dataset.nota) return abrirNota(t.dataset.nota);
    t.classList.add("on"); await acao(() => api("/tarefa/atualizar", { caminho: t.dataset.prazo, feito: true }), "Prazo marcado como cumprido ✓"); redesenhar();
  });
}
let midiaFiltro = "quero";
function folhaMidia() {
  folhaViva("🎬 Filmes, séries e livros", async () => {
    const d = await api("/midia");
    const grupos = { agora: ["assistindo", "lendo"], quero: ["quero assistir", "quero ler"], feitos: ["assistido", "lido", "abandonei"] };
    const ls = d.filter((m) => grupos[midiaFiltro].includes(m.status));
    return `<div class="segmentado">${[["agora", "Em andamento"], ["quero", "Quero ver/ler"], ["feitos", "Concluídos"]].map(([k, n]) => `<button class="${k === midiaFiltro ? "on" : ""}" data-mf="${k}">${n}</button>`).join("")}</div>
      <div class="card">${ls.map((m) => `<div class="linha-item" data-midia='${esc(JSON.stringify({ c: m.caminho, t: m.titulo, s: m.status, e: m.estrelas, f: m.formato }))}' role="button"><div class="txt"><div class="t1">${esc(m.titulo)}${m.pendente ? '<span class="sinc">⏳</span>' : ""}</div>
        <div class="t2">${esc([m.formato, m.onde, m.status].filter(Boolean).join(" · "))}${m.estrelas ? " · " + "★".repeat(m.estrelas) : ""}</div></div></div>`).join("") || `<div class="vazio">Nada aqui</div>`}</div>`;
  }, async (e, redesenhar) => {
    const t = e.target.closest("[data-mf],[data-midia]"); if (!t) return;
    if (t.dataset.mf) { midiaFiltro = t.dataset.mf; return redesenhar(); }
    const m = JSON.parse(t.dataset.midia);
    const livro = m.f === "Livro";
    const opcoesStatus = livro ? ["quero ler", "lendo", "lido", "abandonei"] : ["quero assistir", "assistindo", "assistido", "abandonei"];
    folha(`<h2 style="font-size:18px">${esc(m.t)}</h2><div class="chips" style="margin-bottom:14px">${opcoesStatus.map((x) => `<button class="chip ${x === m.s ? "on" : ""}" data-st="${x}">${x}</button>`).join("")}</div>
      <div style="font-size:13px;color:var(--txt2);margin:0 4px 6px;font-weight:600">Estrelas</div><div class="escala">${[1, 2, 3, 4, 5].map((n) => `<button class="${m.e === n ? "on" : ""}" data-es="${n}">${"★".repeat(n)}</button>`).join("")}</div>
      <button class="btn-link" style="margin-top:12px" data-nota="${esc(m.c)}">Abrir nota</button>`, (f2, fechar2) => {
      f2.onclick = async (ev) => {
        const b = ev.target.closest("button"); if (!b) return;
        if (b.dataset.nota) return abrirNota(b.dataset.nota);
        if (b.dataset.st) await acao(() => api("/midia/atualizar", { caminho: m.c, status: b.dataset.st }), "Atualizado ✓");
        else if (b.dataset.es) await acao(() => api("/midia/atualizar", { caminho: m.c, estrelas: Number(b.dataset.es) }), "Atualizado ✓");
        else return;
        fechar2(); redesenhar();
      };
    });
  });
}


// ---------------- CHAT com o Segundo Cérebro ----------------
const chatEstado = { msgs: (() => { try { return JSON.parse(localStorage.getItem("sc_chat") || "[]"); } catch { return []; } })(), enviando: false, imagem: null };
const salvarChat = () => { try { localStorage.setItem("sc_chat", JSON.stringify(chatEstado.msgs.slice(-60).map((m) => ({ ...m, imagem: m.imagem ? "1" : undefined })))); } catch {} };
const NOMES_LISTA = { supermercado: "Supermercado", "farmácia": "Farmácia", casa: "Casa", pessoal: "Pessoal", pets: "Pets", outros: "Outros", wishlist: "Wishlist" };
function resumoProposta(p) {
  const c = p.campos || {};
  return ({
    lancamento: () => `💸 ${c.natureza === "receita" ? "Receita" : "Gasto"} de ${brl(c.valor)}${c.descricao ? " · " + c.descricao : ""}${c.categoria ? " · " + c.categoria : ""}${c.forma_pagamento ? " · " + c.forma_pagamento : " · forma de pagamento a escolher"}`,
    tarefa: () => `✅ ${c.titulo ?? "Tarefa"}${c.data ? " · " + fmtDia(c.data) : ""}${c.hora ? " às " + c.hora : ""}`,
    ideia_post: () => `💡 Ideia de post: ${c.titulo ?? ""}${c.nicho ? " · " + c.nicho : ""}`,
    diario: () => `📔 Diário: ${[c.humor, c.observacoes, c.gratidao ? "gratidão: " + c.gratidao : ""].filter(Boolean).join(" · ")}`,
    meta: () => `🎯 Meta: ${c.titulo ?? ""}${c.prazo ? " · até " + fmtDia(c.prazo) : ""}`,
    item_lista: () => `${c.lista === "wishlist" ? "🎁" : "🛒"} ${c.item ?? ""} → ${NOMES_LISTA[c.lista] ?? c.lista}${c.preco ? " · R$ " + String(c.preco).replace(/^R\$\s*/, "") : ""}`,
    salvar_imagem: () => `🖼️ Salvar a foto no Obsidian como "${c.nome ?? "Imagem"}" em ${c.pasta || "00 - Entrada"}`,
  }[p.tipo] ?? (() => p.tipo))();
}
async function executarProposta(mi, pi) {
  const m = chatEstado.msgs[mi], p = m.propostas[pi], c = p.campos || {};
  const feito = () => { p.salvo = true; salvarChat(); desenharMensagens(); };
  if (p.tipo === "lancamento") return folhaGasto({ ...c, onSalvo: feito });
  if (p.tipo === "tarefa") return folhaTarefa({ ...c, onSalvo: feito });
  if (p.tipo === "meta") return folhaMeta({ ...c, onSalvo: feito });
  if (p.tipo === "ideia_post" || p.tipo === "diario") return confirmarCaptura({ tipo: p.tipo, campos: c }, "", feito);
  if (p.tipo === "item_lista") {
    const ls = await api("/listas");
    const l = ls.find((x) => x.lista === c.lista) ?? ls.find((x) => x.lista === "outros");
    await acao(() => api("/lista/item", { caminho: l.caminho, novo: c.item, preco: c.preco, prioridade: c.prioridade === "media" ? "média" : c.prioridade, link: c.link }), `Adicionado em ${l.titulo} ✓`);
    return feito();
  }
  if (p.tipo === "salvar_imagem") {
    const img = chatEstado.imagensSessao?.[m.imgId];
    if (!img) return toast("A foto não está mais disponível. Mande de novo.");
    await acao(() => api("/imagem/salvar", { imagem: img, nome: c.nome, pasta: c.pasta }), "Foto enviada ao Obsidian ✓");
    return feito();
  }
}
function bolha(m, i) {
  if (m.papel === "user") return `<div class="msg eu">${m.imagem ? `<div class="msg-img">${chatEstado.imagensSessao?.[m.imgId] ? `<img src="${chatEstado.imagensSessao[m.imgId]}" alt="">` : "🖼️ foto"}</div>` : ""}${m.texto ? `<div class="txt">${esc(m.texto).replace(/\n/g, "<br>")}</div>` : ""}</div>`;
  return `<div class="msg ia"><div class="txt">${mdInline(m.texto || "").replace(/\n/g, "<br>")}</div>
    ${(m.propostas ?? []).map((p, k) => `<div class="proposta ${p.salvo ? "ok" : ""}"><div>${esc(resumoProposta(p))}</div>
      ${p.salvo ? `<span class="salvo">✓ Salvo</span>` : `<button class="btn pequeno" data-proposta="${i}:${k}">${p.tipo === "item_lista" ? "Adicionar" : p.tipo === "salvar_imagem" ? "Salvar foto" : "Revisar e salvar"}</button>`}</div>`).join("")}
    ${m.fontes?.length ? `<div class="fontes">Fonte: ${m.fontes.map((f) => `<a href="#" data-nota="${esc(f.caminho)}">${esc(f.titulo)}</a>`).join(" · ")}</div>` : ""}</div>`;
}
function desenharMensagens() {
  const el = $("#chat-msgs"); if (!el) return;
  const sugestoes = ["O que eu tenho amanhã?", "Quanto gastei no mercado este mês?", "Qual o pediatra do Nicolas?", "Coloca leite na lista do mercado", "Ideia de post: achadinhos de cozinha"];
  el.innerHTML = chatEstado.msgs.length ? chatEstado.msgs.map(bolha).join("") + (chatEstado.enviando ? `<div class="msg ia"><div class="txt digitando"><i></i><i></i><i></i></div></div>` : "")
    : `<div class="chat-vazio"><h1 class="serif">Oi, Juliana 🧠</h1><p>Pergunte qualquer coisa do seu Segundo Cérebro, registre gastos, tarefas e ideias, ou mande uma foto.</p>
      <div class="sugestoes">${sugestoes.map((x) => `<button data-sug="${esc(x)}">${esc(x)}</button>`).join("")}</div></div>`;
  requestAnimationFrame(() => scrollTo(0, document.body.scrollHeight));
}
async function enviarChat(texto) {
  if (chatEstado.enviando) return;
  const img = chatEstado.imagem; chatEstado.imagem = null; atualizarAnexo();
  if (!texto && !img) return;
  chatEstado.imagensSessao ??= {};
  const imgId = img ? String(Date.now()) : undefined;
  if (img) chatEstado.imagensSessao[imgId] = img;
  const historico = chatEstado.msgs.slice(-12).map((m) => ({ papel: m.papel, texto: m.texto || (m.imagem ? "[foto]" : "") }));
  chatEstado.msgs.push({ papel: "user", texto, imagem: !!img, imgId });
  chatEstado.enviando = true; desenharMensagens();
  try {
    const r = await api("/chat", { texto, imagem: img, historico });
    chatEstado.msgs.push({ papel: "assistant", texto: r.resposta, propostas: r.propostas, fontes: r.fontes, imgId });
  } catch (e) { chatEstado.msgs.push({ papel: "assistant", texto: "⚠️ " + e.message }); }
  chatEstado.enviando = false; salvarChat(); desenharMensagens();
}
function reduzirImagem(arquivo) {
  return new Promise((ok, erro) => {
    const img = new Image(); const url = URL.createObjectURL(arquivo);
    img.onload = () => { const max = 1400, k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); ok(c.toDataURL("image/jpeg", 0.82)); };
    img.onerror = () => erro(new Error("Não consegui abrir a imagem.")); img.src = url;
  });
}
function atualizarAnexo() {
  const el = $("#chat-anexo"); if (!el) return;
  el.innerHTML = chatEstado.imagem ? `<img src="${chatEstado.imagem}" alt=""><button data-tirar-anexo aria-label="Remover foto">✕</button>` : "";
  el.classList.toggle("esconder", !chatEstado.imagem);
}
async function telaChat() {
  setTimeout(() => {
    desenharMensagens(); atualizarAnexo();
    const ta = $("#chat-txt"), env = () => { const t = ta.value.trim(); ta.value = ""; ta.style.height = "auto"; enviarChat(t); };
    $("#chat-env").onclick = env;
    ta.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !/iPhone|iPad|Android/.test(navigator.userAgent)) { e.preventDefault(); env(); } };
    ta.oninput = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 140) + "px"; };
    $("#chat-arq").onchange = async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (!f) return;
      try { chatEstado.imagem = await reduzirImagem(f); atualizarAnexo(); ta.focus(); } catch (er) { toast(er.message); } };
  }, 0);
  return `<header class="topo"><div><h1 class="serif">Chat</h1></div><div style="display:flex;gap:8px">
      <button class="icone-btn" data-acao="nova-conversa" aria-label="Nova conversa">${ICONE('<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>')}</button></div></header>
    <main class="chat-main"><div id="chat-msgs"></div></main>
    <div class="chat-barra"><div id="chat-anexo" class="esconder"></div>
      <div class="chat-linha"><label class="chat-mais" aria-label="Mandar foto">${ICONE('<path d="M12 5v14M5 12h14"/>')}<input id="chat-arq" type="file" accept="image/*" hidden></label>
      <textarea id="chat-txt" rows="1" placeholder="Pergunte ou registre algo…" enterkeyhint="send"></textarea>
      <button id="chat-env" class="chat-env" aria-label="Enviar">${ICONE('<path d="M12 19V5M5 12l7-7 7 7"/>', 'stroke-width="2.4"')}</button></div></div>`;
}


// ---------------- Telegram do pack ----------------
const PACK = "https://vqzittywsskczitgarnh.supabase.co/functions/v1/afiloop-pack";
async function pack(acao, corpo) {
  const r = await fetch(`${PACK}?acao=${acao}`, { method: corpo === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || "Algo deu errado.");
  return j;
}
function folhaTelegram() {
  folhaViva("📦 Telegram do pack", async (passo) => {
    const e = await pack("estado");
    const campo = (id, ph, tipo = "text", extra = "") => `<input id="${id}" type="${tipo}" placeholder="${ph}" ${extra} style="width:100%;border:0;background:var(--card);box-shadow:var(--sombra);border-radius:12px;padding:13px 14px;font-size:17px;margin-bottom:10px">`;
    if (!e.chaves) return `<div class="aviso">Falta salvar TELEGRAM_API_ID e TELEGRAM_API_HASH no Supabase (passo do my.telegram.org).</div>`;
    if (passo === "codigo") return `<p>Digite o código que chegou <b>no app do Telegram</b> (não por SMS).</p>${campo("tg-cod", "Código", "text", 'inputmode="numeric" autocomplete="one-time-code"')}<button class="btn" data-tg="codigo">Entrar</button>`;
    if (passo === "senha") return `<p>Sua conta tem <b>verificação em duas etapas</b>. Digite a senha do Telegram.</p>${campo("tg-senha", "Senha do Telegram", "password")}<button class="btn" data-tg="senha">Entrar</button>`;
    if (!e.conectado) return `<p style="color:var(--txt2);font-size:14px">A conexão serve só para ler o grupo do pack e enviar os vídeos editados para o seu canal "Acervo Afiloop". Você pode cortar o acesso quando quiser em Telegram → Configurações → Dispositivos.</p>
      ${campo("tg-tel", "+55 81 99999-8888", "tel")}<button class="btn" data-tg="inicio">Enviar código</button>`;
    if (!e.packs?.length || !e.acervo || passo === "escolher") {
      const gs = await pack("grupos");
      const marcados = new Set((e.packs ?? []).map((x) => x.id));
      const ops = (filtro) => gs.filter(filtro).map((g) => `<option value='${esc(JSON.stringify({ id: g.id, titulo: g.titulo }))}' ${e.acervo?.id === g.id ? "selected" : ""}>${esc(g.titulo)}${g.forum ? " (tópicos)" : ""}</option>`).join("");
      return `<p>✅ Telegram conectado. Agora escolha:</p>
        <div class="campo"><span>Grupos dos packs (marque todos)</span><div class="card acoes-lista">${gs.filter((g) => !g.dono).map((g) => `<label style="display:flex;gap:12px;align-items:center;padding:13px 16px;border-top:1px solid var(--linha)"><input type="checkbox" class="tg-pk" value='${esc(JSON.stringify({ id: g.id, titulo: g.titulo }))}' ${marcados.has(g.id) ? "checked" : ""} style="width:22px;height:22px;flex:none"><span>${esc(g.titulo)}${g.forum ? " <small style='color:var(--txt2)'>(tópicos)</small>" : ""}</span></label>`).join("") || `<div class="vazio">Nenhum grupo encontrado</div>`}</div></div>
        <label class="campo"><span>Canal do Acervo (privado, seu)</span><select id="tg-acervo"><option value="">Escolha…</option>${ops((g) => g.dono)}</select></label>
        <label class="campo"><span>Trazer do pack a partir de</span><select id="tg-desde"><option value="30">últimos 30 dias</option><option value="60">últimos 60 dias</option><option value="90">últimos 90 dias</option><option value="180">últimos 6 meses</option><option value="3650" selected>todo o histórico</option></select></label>
        <button class="btn" data-tg="escolher">Salvar</button>`;
    }
    const s = e.sync ?? {};
    return `<div class="card pad" style="line-height:1.8;font-size:15px">✅ Conectado<br>📦 Packs (${e.packs.length}): <b>${e.packs.map((x) => esc(x.titulo)).join(", ")}</b><br>🗄️ Acervo: <b>${esc(e.acervo.titulo)}</b><br>
      🔄 Última leitura: <b>${s.sincronizado_em ? new Date(s.sincronizado_em).toLocaleString("pt-BR", { timeZone: "America/Recife", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "ainda não"}</b><br>
      🆕 Novidades: <b>${e.novidades?.novos ?? 0}</b></div><div style="height:12px"></div>
      <button class="btn" data-tg="sync">Buscar novidades agora</button><div style="height:8px"></div>
      <button class="btn sec" data-tg="trocar">Trocar packs ou acervo</button>
      <button class="btn-link" style="--area:var(--perigo);margin-top:10px" data-tg="sair">Desconectar o Telegram</button>`;
  }, async (ev, redesenhar, f) => {
    const t = ev.target.closest("[data-tg]"); if (!t) return;
    t.disabled = true;
    try {
      const a = t.dataset.tg;
      if (a === "inicio") { await pack("login_inicio", { telefone: $("#tg-tel", f).value.replace(/[\s()-]/g, "") }); return redesenhar("codigo"); }
      if (a === "codigo") { const r = await pack("login_codigo", { codigo: $("#tg-cod", f).value }); if (r.precisa_senha) return redesenhar("senha"); toast(`Conectado como ${r.nome} ✓`); return redesenhar(); }
      if (a === "senha") { const r = await pack("login_senha", { senha: $("#tg-senha", f).value }); toast(`Conectado como ${r.nome} ✓`); return redesenhar(); }
      if (a === "escolher") {
        if (!$("#tg-acervo", f).value) { t.disabled = false; return toast("Escolha o canal do Acervo."); }
        const packs = [...f.querySelectorAll(".tg-pk:checked")].map((x) => JSON.parse(x.value));
        if (!packs.length) { t.disabled = false; return toast("Marque pelo menos um pack."); }
        await pack("escolher", { packs, acervo: JSON.parse($("#tg-acervo", f).value), desde_dias: Number($("#tg-desde", f).value) });
        toast("Salvo ✓"); return redesenhar();
      }
      if (a === "trocar") return redesenhar("escolher");
      if (a === "sync") { const r = await pack("sincronizar", {}); toast(`${r.novos} novidade(s)${r.pulados_4k ? ` · ${r.pulados_4k} cópia(s) 4K puladas` : ""}${r.terminou ? "" : " · continua sozinho"}`); return redesenhar(); }
      if (a === "sair") { if (!confirm("Desconectar o Telegram do app?")) { t.disabled = false; return; } await pack("desconectar", {}); toast("Desconectado"); return redesenhar(); }
    } catch (e) { toast(e.message); t.disabled = false; }
  });
}

// ---------------- notificações ----------------
async function ligarNotificacoes() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return toast("Abra pelo ícone da Tela de Início para ligar as notificações.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return toast("Notificações não permitidas. Ative em Ajustes do iPhone → Notificações.");
  const reg = await navigator.serviceWorker.ready;
  const est = await api("/estado");
  const chave = Uint8Array.from(atob(est.vapid.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - est.vapid.length % 4) % 4)), (c) => c.charCodeAt(0));
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chave });
  await api("/push/assinar", { assinatura: sub.toJSON() });
  await acao(() => api("/push/testar", {}), "Notificações ligadas ✓");
}

// ---------------- captura rápida ----------------
function abrirCaptura() {
  folha(`<h2>O que você quer registrar?</h2>
    <label class="campo"><textarea id="c-txt" placeholder="Fale ou digite: &quot;gastei 45 no mercado no nubank&quot;, &quot;pediatra do Nicolas quinta às 10h&quot;, &quot;ideia de post: 5 achadinhos para o quarto do bebê&quot;…"></textarea></label>
    <p style="color:var(--txt2);font-size:13px;margin:-4px 4px 12px">Para falar, toque no 🎤 do teclado do iPhone.</p>
    <button class="btn" id="c-ok" style="--area:var(--txt)">Continuar</button>
    <div class="chips" style="margin-top:14px;justify-content:center"><button class="chip" data-r="tarefa">✅ Tarefa</button><button class="chip" data-r="gasto">💸 Gasto</button>
    <button class="chip" data-r="meta">🎯 Meta</button><button class="chip" data-r="humor">😊 Diário</button></div>`, (f, fechar) => {
    setTimeout(() => $("#c-txt", f).focus(), 300);
    f.querySelector(".chips").onclick = (e) => {
      const r = e.target.closest("[data-r]")?.dataset.r; if (!r) return; fechar();
      setTimeout(() => ({ tarefa: () => folhaTarefa(), gasto: () => folhaGasto(), meta: folhaMeta, humor: () => { estado.aba = "eu"; history.replaceState(null, "", "#eu"); render(); } })[r](), 260);
    };
    $("#c-ok", f).onclick = async () => {
      const texto = $("#c-txt", f).value.trim(); if (!texto) return;
      $("#c-ok", f).disabled = true; $("#c-ok", f).textContent = "Entendendo…";
      try {
        const r = await api("/captura/interpretar", { texto });
        fechar();
        setTimeout(() => confirmarCaptura(r, texto), 260);
      } catch (e) { toast(e.message); $("#c-ok", f).disabled = false; $("#c-ok", f).textContent = "Continuar"; }
    };
  });
}
function confirmarCaptura(r, texto, onSalvo) {
  const c = r.campos ?? {};
  if (r.tipo === "lancamento") return folhaGasto({ ...c });
  if (r.tipo === "tarefa") return folhaTarefa({ ...c });
  if (r.tipo === "diario") {
    return folha(`<h2>Para o diário de hoje</h2><div class="card pad">${esc(c.observacoes ?? texto)}${c.humor ? `<div style="margin-top:8px;color:var(--txt2);font-size:14px">Humor do dia: <b style="color:var(--txt)">${esc(c.humor)}</b></div>` : ""}</div><div style="height:12px"></div>
      <button class="btn" id="d-ok" style="--area:var(--eu)">Salvar nas observações do dia</button>`, (f, fechar) => {
      $("#d-ok", f).onclick = async () => {
        const atual = estado.cache.dia?.data === hojeISO() ? estado.cache.dia.observacoes : "";
        await acao(() => api("/dia/salvar", { data: hojeISO(), observacoes: [atual, c.observacoes ?? texto].filter(Boolean).join(" · "), ...(c.humor ? { humor: c.humor } : {}), ...(c.gratidao ? { journal: { "🙏 Gratidão": c.gratidao } } : {}) }), "Salvo no diário ✓");
        fechar(); onSalvo?.(); if (estado.aba !== "chat") render();
      };
    });
  }
  if (r.tipo === "ideia_post") {
    return folha(`<h2>Ideia de post (Afiloop)</h2><label class="campo"><span>Ideia</span><input id="i-t" value="${esc(c.titulo ?? texto)}"></label>
      <label class="campo"><span>Nicho</span><select id="i-n"><option value="">Escolha…</option>${opcoes(["Fashion", "Beauty", "Casa", "Maternidade"], c.nicho)}</select></label>
      <button class="btn" id="i-ok" style="--area:var(--afiloop)">Salvar ideia</button>`, (f, fechar) => {
      $("#i-ok", f).onclick = async () => {
        if (!$("#i-n", f).value) { $("#i-n", f).classList.add("falta"); return toast("Escolha o nicho."); }
        await acao(() => api("/ideia/criar", { titulo: $("#i-t", f).value, nicho: $("#i-n", f).value }), "Ideia salva ✓"); fechar(); onSalvo?.();
      };
    });
  }
  folhaTarefa({ titulo: texto });
}

// ---------------- cliques ----------------
document.addEventListener("click", async (e) => {
  const t = e.target.closest("button, [data-ir], [data-item]");
  if (!t || !token) return;
  const app = $("#app");
  if (!app.contains(t)) return;
  const a = t.dataset.acao;
  if (t.dataset.ir) { estado.aba = t.dataset.ir; history.replaceState(null, "", "#" + estado.aba); return render(); }
  if (a === "ajustes") return folhaAjustes();
  if (a === "buscar") return folhaBusca();
  if (a === "nova-conversa") { if (chatEstado.msgs.length && !confirm("Começar uma conversa nova?")) return; chatEstado.msgs = []; salvarChat(); return desenharMensagens(); }
  if (t.dataset.sug) return enviarChat(t.dataset.sug);
  if (t.dataset.proposta) { const [mi, pi] = t.dataset.proposta.split(":").map(Number); return executarProposta(mi, pi); }
  if (t.hasAttribute("data-tirar-anexo")) { chatEstado.imagem = null; return atualizarAnexo(); }
  if (a === "falar") return abrirCaptura();
  if (a === "editar-inicio") return folhaEditarInicio();
  if (t.dataset.atalho) return abrirAtalho(t.dataset.atalho);
  if (a === "nova-tarefa") return folhaTarefa({ data: estado.aba === "agenda" ? (estado.agendaModo === "mes" ? estado.agendaDiaSel : estado.agendaRef) : hojeISO() });
  if (a === "novo-gasto") return folhaGasto();
  if (a === "nova-meta") return folhaMeta();
  if (a === "marcar") {
    const d = JSON.parse(t.closest("[data-item]").dataset.item);
    t.classList.toggle("on"); t.closest(".linha-item").classList.toggle("feito");
    if (d.o === "meta") await acao(() => api("/meta/atualizar", { caminho: d.c, subitem: { item: d.t.split(" · ")[0], feito: !d.f } }));
    else await acao(() => api("/tarefa/atualizar", { caminho: d.c, feito: !d.f }));
    return render();
  }
  if (t.closest("[data-item]") && !a) return folhaItem(JSON.parse(t.closest("[data-item]").dataset.item));
  if (a === "pagar") {
    t.classList.add("on");
    await acao(() => api("/conta/paga", { caminho: t.closest("[data-conta]").dataset.conta }), "Marcado como pago ✓"); return render();
  }
  if (t.dataset.modo) { estado.agendaModo = t.dataset.modo; return render(); }
  if (t.dataset.diasel) { estado.agendaDiaSel = t.dataset.diasel; if (!t.dataset.diasel.startsWith(estado.agendaRef.slice(0, 7))) estado.agendaRef = t.dataset.diasel; return render(); }
  if (t.dataset.nav) {
    if (t.dataset.nav === "hoje") estado.agendaRef = hojeISO();
    else { const n = Number(t.dataset.nav); estado.agendaRef = estado.agendaModo === "mes" ? somaMes(estado.agendaRef.slice(0, 7), n) + "-01" : somaDias(estado.agendaRef, n * (estado.agendaModo === "dia" ? 1 : 7)); }
    return render();
  }
  if (t.dataset.mes) { estado.finMes = somaMes(estado.finMes, Number(t.dataset.mes)); return render(); }
  if (t.dataset.eudia) { estado.euDia = somaDias(estado.euDia, Number(t.dataset.eudia)); if (estado.euDia > hojeISO()) estado.euDia = hojeISO(); return render(); }
  const dia = estado.aba === "eu" ? estado.euDia : hojeISO();
  if (t.dataset.humor) {
    t.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === t));
    await acao(() => api("/dia/salvar", { data: dia, humor: t.dataset.humor }), "Humor salvo ✓"); return;
  }
  if (t.dataset.escala) {
    t.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === t));
    await acao(() => api("/dia/salvar", { data: dia, [t.dataset.escala]: Number(t.dataset.v) })); return;
  }
  if (t.dataset.emocao !== undefined) {
    t.classList.toggle("on");
    const emocoes = [...app.querySelectorAll("[data-emocao].on")].map((b) => b.dataset.emocao);
    await acao(() => api("/dia/salvar", { data: dia, emocoes })); return;
  }
  if (t.dataset.habito) {
    const on = !t.classList.contains("on"); t.classList.toggle("on", on);
    await acao(() => api("/dia/salvar", { data: dia, habitos: { [t.dataset.habito]: on } })); return;
  }
  if (a === "journal") {
    const ta = app.querySelector(`textarea[data-journal="${CSS.escape(t.dataset.secao)}"]`);
    if (!ta.value.trim()) return;
    await acao(() => api("/dia/salvar", { data: dia, journal: { [t.dataset.secao]: ta.value } }), "Salvo ✓"); return render();
  }
  if (a === "obs") { await acao(() => api("/dia/salvar", { data: dia, observacoes: app.querySelector("[data-obs]").value }), "Salvo ✓"); return; }
  const meta = t.closest("[data-meta]")?.dataset.meta;
  if (meta && t.dataset.sub !== undefined) {
    t.classList.toggle("on");
    await acao(() => api("/meta/atualizar", { caminho: meta, subitem: { item: t.dataset.sub, feito: t.dataset.feito !== "1" } })); return render();
  }
  if (meta && a === "meta-concluir") { await acao(() => api("/meta/atualizar", { caminho: meta, status: "concluida" }), "Meta concluída 🎉"); return render(); }
  if (meta && a === "meta-valor") {
    const v = prompt("Valor atual:"); if (v === null) return;
    await acao(() => api("/meta/atualizar", { caminho: meta, valor_atual: Number(v.replace(",", ".")) }), "Atualizado ✓"); return render();
  }
  if (meta && a === "meta-sub") {
    return folha(`<h2>Nova etapa</h2><label class="campo"><span>Etapa</span><input id="s-t"></label><label class="campo"><span>Prazo (opcional)</span><input id="s-p" type="date"></label>
      <button class="btn" id="s-ok" style="--area:var(--metas)">Adicionar</button>`, (f, fechar) => {
      $("#s-ok", f).onclick = async () => {
        if (!$("#s-t", f).value.trim()) return;
        await acao(() => api("/meta/atualizar", { caminho: meta, novo_subitem: { texto: $("#s-t", f).value, prazo: $("#s-p", f).value || null } }), "Etapa adicionada ✓"); fechar(); render();
      };
    });
  }
});
document.addEventListener("click", (e) => { const a = e.target.closest("#app a[data-nota]"); if (a) { e.preventDefault(); abrirNota(a.dataset.nota); } });
// textarea do journal cresce sozinha
document.addEventListener("input", (e) => { if (e.target.matches(".jsecao textarea")) { e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; } });

// ---------------- início ----------------
aplicarTema();
montarAbas();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
window.addEventListener("hashchange", () => { const a = location.hash.replace("#", ""); if (ABAS.some((x) => x.id === a) && a !== estado.aba) { estado.aba = a; render(); } });
iniciar();
