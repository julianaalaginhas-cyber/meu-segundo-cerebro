// App Segundo Cérebro — API (Supabase Edge Function).
// Lê o espelho das notas (tabela `notas`) e escreve pela mesma fila da Ponte (`pedidos_vault`),
// através de uma fila própria (`app_mudancas`) que junta mudanças por nota e mostra tudo na hora.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from "npm:@simplewebauthn/server@13.1.1";
import webpush from "npm:web-push@3.6.7";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const ORIGEM = "app-segundo-cerebro";
const TZ = "America/Recife";
const PASTA_DIARIO = "01 - Vida/Rotina/Diário";
const PASTA_AGENDA = "07 - Agenda";
const PASTA_LANC = "06 - Financeiro/Lancamentos";
const PASTA_METAS = "01 - Vida/🎯 Metas";
const HUMORES = ["😄 Muito bem", "🙂 Bem", "😐 Normal", "😔 Para baixo", "😣 Difícil"];
const CATEGORIAS = ["mercado", "farmácia", "casa", "contas da casa", "funcionárias", "saúde", "pets", "filhos", "transporte",
  "alimentação fora", "lazer", "roupas e beleza", "educação", "assinaturas", "trabalho", "outros"];
const FORMAS = ["PIX/Dinheiro", "Cartão XP", "Cartão BTG", "Cartão Nubank", "Cartão Itaú", "Cartão Guy"];
const SECOES = ["🙏 Gratidão", "✨ Algo bom que aconteceu", "💭 Reflexão", "🎯 Intenção para amanhã"];
const TIPOS_AGENDA = ["tarefa", "compromisso", "lembrete"];
const FEITO = ["feita", "feito", "concluida", "concluída", "concluido", "concluído", "pago", "cancelada", "cancelado"];

class Erro extends Error { constructor(msg: string, public status = 400) { super(msg); } }

// ---------------- Afiloop: fila de aprovação ----------------
// Etapa na tela: "aprovar" = ideia nova ou edição pronta esperando a Juliana; "producao" = aprovada, o Claude está fazendo;
// "pronto" = aprovado para postar; "postado"; "descartada".
const etapaFila = (p: any) => p.status === "proposta" ? "aprovar"
  : p.status === "produzindo" ? ((p.arquivos?.length && !p.ajuste) ? "aprovar" : "producao")
  : p.status === "na_fila" ? "pronto" : p.status;

async function resumoFila() {
  try {
    const { data } = await db.from("afiloop_propostas").select("status, arquivos, ajuste").in("status", ["proposta", "produzindo"]);
    return { fila_para_aprovar: (data ?? []).filter((p: any) => etapaFila(p) === "aprovar").length, proximo_post: null };
  } catch { return { fila_para_aprovar: 0, proximo_post: null }; }
}
// ---------------- Afiloop › Biblioteca (galeria do pack) ----------------
const codPack = (t: string, id: number) => `PACK-${t}${String(id).padStart(4, "0")}`;
function linksDoItem(it: any): string[] {
  const ls = Array.isArray(it.links_afiliados) ? it.links_afiliados.map((l: any) => l?.afiliado).filter(Boolean) : [];
  if (!ls.length && it.link_afiliado) ls.push(it.link_afiliado);
  return ls;
}
function videoDoItem(it: any): string | null {
  for (const v of Object.values(it)) if (typeof v === "string" && /^https?:\/\/\S+\.(mp4|mov|webm|m4v)(\?|$)/i.test(v)) return v;
  return null;
}
function telegramDoItem(it: any): string | null {
  for (const v of Object.values(it)) if (typeof v === "string" && /^https:\/\/t\.me\//.test(v)) return v;
  const k = Object.keys(it);
  const chat = it[k.find((x) => /^(tg_)?(chat|grupo|canal|pack)(_id)?$/.test(x)) ?? ""];
  const msg = it[k.find((x) => /^(tg_)?(msg|mensagem|message)(_id)?$/.test(x)) ?? ""];
  if (chat && msg && /^-?\d+$/.test(String(chat)) && /^\d+$/.test(String(msg))) return `https://t.me/c/${String(chat).replace(/^-/, "").replace(/^100(?=\d{9,})/, "")}/${msg}`;
  return null;
}
function normPack(t: "V" | "C", it: any) {
  return {
    codigo: codPack(t, it.id), formato: t === "V" ? "video" : "carrossel", nicho: it.nicho ?? null, topico: it.topico ?? null, status: it.status,
    recebido_em: it.recebido_em, dur: it.duracao_s ?? null, legenda: String(it.legenda ?? "").slice(0, 400),
    imgs: t === "V" ? [it.miniatura_url].filter(Boolean) : (it.fotos ?? []).map((f: any) => f?.url).filter(Boolean),
    links: linksDoItem(it), video: videoDoItem(it), telegram: telegramDoItem(it),
  };
}
// O Telegram manda fotos e vídeo/link do mesmo produto em mensagens separadas: junta as que chegam em sequência (mesmo tópico, até 20 s) quando falta link a uma delas.
function agruparPack(itens: ReturnType<typeof normPack>[]) {
  const asc = [...itens].sort((a, b) => String(a.recebido_em).localeCompare(String(b.recebido_em)));
  const grupos: (typeof asc)[] = [];
  for (const it of asc) {
    const g = grupos[grupos.length - 1], ult = g?.[g.length - 1];
    const perto = ult && ult.topico === it.topico && Math.abs(Date.parse(it.recebido_em) - Date.parse(ult.recebido_em)) <= 20000;
    const semLink = g && (!g.some((x) => x.links.length) || !it.links.length);
    if (perto && semLink) g.push(it); else grupos.push([it]);
  }
  return grupos.map((g) => {
    const p = g.find((x) => x.formato === "video") ?? g[0];
    return {
      codigos: g.map((x) => x.codigo), principal: p.codigo, tem_video: g.some((x) => x.formato === "video"),
      fotos: g.filter((x) => x.formato === "carrossel").reduce((n, x) => n + x.imgs.length, 0),
      nicho: g.find((x) => x.nicho)?.nicho ?? null, topico: p.topico, dur: p.dur, recebido_em: g[g.length - 1].recebido_em,
      novo: g.some((x) => x.status === "novo"), legenda: g.map((x) => x.legenda).find(Boolean) ?? "",
      capa: p.imgs[0] ?? g.flatMap((x) => x.imgs)[0] ?? null, imgs: [...new Set(g.flatMap((x) => x.imgs))],
      links: [...new Set(g.flatMap((x) => x.links))], video: g.map((x) => x.video).find(Boolean) ?? null, telegram: g.map((x) => x.telegram).find(Boolean) ?? null,
    };
  });
}
async function bibliotecaPack(q: (k: string) => string | null) {
  const so = q("so") ?? "novos", nicho = q("nicho"), formato = q("formato") ?? "todos", antes = q("antes");
  const sel = new Set((await config<string[]>("afiloop_selecao")) ?? []);
  const lim = 90;
  const ids = (pre: string) => [...sel].filter((c) => c.startsWith(pre)).map((c) => Number(c.slice(pre.length))).filter(Boolean);
  const buscar = async (tabela: string) => {
    let b = db.from(tabela).select("*").neq("status", "descartado");
    if (tabela === "afiloop_videos") b = b.neq("status", "grande_demais");
    if (so === "selecionados") b = b.in("id", ids(tabela === "afiloop_videos" ? "PACK-V" : "PACK-C").concat([0]));
    else { if (so === "novos") b = b.eq("status", "novo"); if (antes) b = b.lt("recebido_em", antes); }
    const { data, error } = await b.order("recebido_em", { ascending: false }).limit(so === "selecionados" ? 300 : lim);
    if (error) throw new Erro(error.message, 500);
    return data ?? [];
  };
  const [vs, cs] = await Promise.all([buscar("afiloop_videos"), buscar("afiloop_carrosseis")]);
  const todos = [...vs.map((v: any) => normPack("V", v)), ...cs.map((c: any) => normPack("C", c))];
  let cards = agruparPack(todos).map((c) => ({ ...c, selecionado: c.codigos.some((x) => sel.has(x)) }))
    .sort((a, b) => String(b.recebido_em).localeCompare(String(a.recebido_em)));
  if (nicho) cards = cards.filter((c) => (nicho === "sem" ? !c.nicho : c.nicho === nicho));
  if (formato === "video") cards = cards.filter((c) => c.tem_video); else if (formato === "carrossel") cards = cards.filter((c) => !c.tem_video);
  const maisAntigo = todos.map((x) => x.recebido_em).sort()[0];
  return { cards, total_selecionados: sel.size, proximo: so !== "selecionados" && (vs.length === lim || cs.length === lim) ? maisAntigo : null };
}
async function estrelaPack(b: any) {
  const cods = (Array.isArray(b.codigos) ? b.codigos : []).map((x: unknown) => String(x).toUpperCase()).filter((x: string) => /^PACK-[VC]\d+$/.test(x));
  if (!cods.length) throw new Erro("Item inválido.");
  const sel = new Set((await config<string[]>("afiloop_selecao")) ?? []);
  for (const c of cods) b.marcar ? sel.add(c) : sel.delete(c);
  await setConfig("afiloop_selecao", [...sel]);
  return { selecionado: !!b.marcar, total_selecionados: sel.size };
}

async function filaAfiloop() {
  const { data: ps, error } = await db.from("afiloop_propostas")
    .select("id, tipo, itens, titulo, gancho, legenda, nicho, rede, observacoes, status, agendado_para, autoria, arquivos, ajuste, aprovado_em, postado_em, criado_em")
    .order("agendado_para", { ascending: true, nullsFirst: false }).order("id").limit(400);
  if (error) throw new Erro(error.message, 500);
  const cods = [...new Set((ps ?? []).flatMap((p: any) => p.itens ?? []))] as string[];
  const num = (pre: string) => cods.filter((c) => c.startsWith(pre)).map((c) => Number(c.slice(pre.length))).filter(Boolean);
  const [vs, cs, os] = await Promise.all([
    num("PACK-V").length ? db.from("afiloop_videos").select("id, miniatura_url, link_afiliado, duracao_s").in("id", num("PACK-V")).then((r) => r.data ?? []) : [],
    num("PACK-C").length ? db.from("afiloop_carrosseis").select("id, fotos, links_afiliados").in("id", num("PACK-C")).then((r) => r.data ?? []) : [],
    num("OFERTA-").length ? db.from("afiloop_ofertas").select("id, nome, preco, imagem_url, link_afiliado, preco_conferido_em").in("id", num("OFERTA-")).then((r) => r.data ?? []) : [],
  ]);
  const info: Record<string, any> = {};
  for (const v of vs as any[]) info[`PACK-V${String(v.id).padStart(4, "0")}`] = { img: v.miniatura_url, link: v.link_afiliado, seg: v.duracao_s };
  for (const c of cs as any[]) info[`PACK-C${String(c.id).padStart(4, "0")}`] = { img: c.fotos?.[0]?.url ?? null, link: c.links_afiliados?.[0]?.afiliado ?? null };
  for (const o of os as any[]) info[`OFERTA-${o.id}`] = { img: o.imagem_url, link: o.link_afiliado, nome: o.nome, preco: o.preco, conferido: o.preco_conferido_em };
  const itens = (ps ?? []).map((p: any) => ({
    ...p, etapa: etapaFila(p),
    detalhes: (p.itens ?? []).map((c: string) => ({ codigo: c, ...(info[c] ?? {}) })),
  }));
  const contagem: Record<string, number> = { aprovar: 0, producao: 0, pronto: 0, postado: 0, descartada: 0 };
  for (const i of itens) contagem[i.etapa] = (contagem[i.etapa] ?? 0) + 1;
  return { itens, contagem };
}

async function acaoFila(b: any) {
  const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).map(Number).filter((n: number) => Number.isInteger(n) && n > 0);
  if (!ids.length) throw new Erro("Escolha pelo menos um post.");
  const { data: ps } = await db.from("afiloop_propostas").select("id, status, arquivos, ajuste, observacoes").in("id", ids);
  const agora = new Date().toISOString();
  let feitos = 0;
  for (const p of ps ?? []) {
    let up: Record<string, unknown> | null = null;
    switch (b.acao) {
      case "aprovar": {
        const e = etapaFila(p);
        if (e === "aprovar") up = p.arquivos?.length ? { status: "na_fila", aprovado_em: agora } : { status: "produzindo", aprovado_em: agora };
        break;
      }
      case "ajuste": {
        const txt = String(b.texto ?? "").trim().slice(0, 1000);
        if (!txt) throw new Erro("Escreva o que quer mudar.");
        const hist = `[${hoje()}] ajuste pedido: ${txt}`;
        up = { status: "produzindo", ajuste: txt, observacoes: p.observacoes ? `${p.observacoes} | ${hist}` : hist };
        break;
      }
      case "descartar": if (p.status !== "postado") up = { status: "descartada" }; break;
      case "postado": if (p.status === "na_fila") up = { status: "postado", postado_em: agora }; break;
      case "voltar": up = { status: p.arquivos?.length ? "produzindo" : "proposta", aprovado_em: null, postado_em: null }; break;
      default: throw new Erro("ação desconhecida");
    }
    if (!up) continue;
    const { error } = await db.from("afiloop_propostas").update({ ...up, atualizado_em: agora }).eq("id", p.id);
    if (error) throw new Erro(error.message, 500);
    feitos++;
  }
  return { ok: true, feitos, ignorados: ids.length - feitos };
}

async function editarFila(b: any) {
  const id = Number(b.id); if (!id) throw new Erro("post inválido");
  const up: Record<string, unknown> = { atualizado_em: new Date().toISOString() };
  for (const k of ["titulo", "gancho", "legenda"]) if (typeof b[k] === "string") up[k] = b[k].trim().slice(0, 4000) || null;
  if (typeof b.rede === "string") {
    if (!["instagram", "tiktok", "instagram+tiktok"].includes(b.rede)) throw new Erro("rede inválida");
    up.rede = b.rede;
  }
  if (b.dia !== undefined) {
    if (!b.dia) up.agendado_para = null;
    else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.dia) || (b.hora && !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.hora))) throw new Erro("data ou hora inválida");
      up.agendado_para = `${b.dia}T${b.hora || "11:30"}:00-03:00`;
    }
  }
  if (up.titulo === null) throw new Erro("O título não pode ficar vazio.");
  const { error } = await db.from("afiloop_propostas").update(up).eq("id", id);
  if (error) throw new Erro(error.message, 500);
  return { ok: true };
}

// ---------------- utilidades de data (fuso de Recife) ----------------
const hoje = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
function agoraRecife() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { data: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour) % 24, minuto: Number(p.minute), semana: p.weekday };
}
const somaDias = (d: string, n: number) => {
  const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10);
};
const dataOk = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.slice(0, 10)) ? v.slice(0, 10) : null;
function horaOk(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const m = String(v).trim().match(/^(\d{1,2})\s*(?:h|:)\s*(\d{2})?/i);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2] ?? 0);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}
const horaObsidian = (hhmm: string) => hhmm.replace(":", "h"); // formato 14h30, como o Planejamento usa

// ---------------- segurança ----------------
async function sha256(t: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const deB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function hashPin(pin: string, sal: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode(sal), iterations: 150000, hash: "SHA-256" }, k, 256);
  return b64url(new Uint8Array(bits));
}

async function config<T = unknown>(chave: string): Promise<T | null> {
  const { data } = await db.from("app_config").select("valor").eq("chave", chave).maybeSingle();
  return (data?.valor ?? null) as T | null;
}
async function setConfig(chave: string, valor: unknown) {
  const { error } = await db.from("app_config").upsert({ chave, valor, atualizado_em: new Date().toISOString() });
  if (error) throw new Erro(error.message, 500);
}

async function novaSessao(metodo: string) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const expira = new Date(Date.now() + 180 * 86400 * 1000).toISOString(); // aparelho lembrado por 6 meses
  await db.from("app_sessoes").insert({ token_hash: await sha256(token), expira_em: expira, metodo });
  await db.from("app_sessoes").delete().lt("expira_em", new Date().toISOString());
  return { token, expira_em: expira };
}
async function exigirSessao(req: Request) {
  const t = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!t) throw new Erro("sessão expirada", 401);
  const { data } = await db.from("app_sessoes").select("expira_em").eq("token_hash", await sha256(t)).maybeSingle();
  if (!data || new Date(data.expira_em) < new Date()) throw new Erro("sessão expirada", 401);
}

function rp(req: Request) {
  const origem = req.headers.get("origin") ?? "";
  const permitidas = (Deno.env.get("APP_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!permitidas.includes(origem)) throw new Erro("origem não permitida", 403);
  return { origin: origem, rpID: new URL(origem).hostname };
}

async function guardarDesafio(desafio: string, tipo: string) {
  await db.from("app_desafios").delete().lt("criado_em", new Date(Date.now() - 10 * 60 * 1000).toISOString());
  await db.from("app_desafios").insert({ desafio, tipo });
}
async function usarDesafio(desafio: string, tipo: string) {
  const { data } = await db.from("app_desafios").delete().eq("desafio", desafio).eq("tipo", tipo).select("desafio");
  if (!data?.length) throw new Erro("pedido de login expirado; tente de novo", 400);
}
const desafioDaResposta = (resp: { response?: { clientDataJSON?: string } }) =>
  JSON.parse(new TextDecoder().decode(deB64url(resp?.response?.clientDataJSON ?? ""))).challenge as string;

async function pinBloqueado() {
  const f = (await config<{ n: number; ate?: string }>("pin_falhas")) ?? { n: 0 };
  if (f.ate && new Date(f.ate) > new Date()) throw new Erro("Muitas tentativas. Espere 15 minutos.", 429);
  return f;
}

// ---------------- notas (espelho + mudanças do app ainda não aplicadas) ----------------
type Nota = { caminho: string; titulo: string; conteudo: string; propriedades: Record<string, any>; hash?: string; pendente?: boolean };
type Mudanca = { id: number; caminho: string; acao: "criar" | "editar"; conteudo: string | null; dados: Ops; status: string; pedido_id: string | null; resultado: string | null; atualizado_em: string };
type Ops = {
  propriedades?: Record<string, unknown>;
  journal?: Record<string, string[]>;   // seção -> linhas novas
  emocao?: string;                       // "- Emoção predominante: ..."
  observacoes?: string;                  // "- Observações: ..."
  checklist?: { item: string; feito: boolean }[];
  acrescentar?: string[];
  remover?: string[];
  _base?: string;                        // hash da nota quando o pedido foi enviado
  _tentativas?: number;
};

async function lerNotas(filtro: (q: any) => any): Promise<Nota[]> {
  const todas: Nota[] = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await filtro(db.from("notas").select("caminho, titulo, conteudo, propriedades, hash")).range(de, de + 999);
    if (error) throw new Erro(error.message, 500);
    todas.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return todas;
}

async function mudancasAbertas(): Promise<Mudanca[]> {
  const { data } = await db.from("app_mudancas").select("*")
    .or(`status.in.(aguardando,enviado),and(status.eq.aplicado,atualizado_em.gt.${new Date(Date.now() - 6 * 3600e3).toISOString()})`)
    .order("id");
  return (data ?? []) as Mudanca[];
}

// aplica as operações sobre o texto/propriedades de uma nota (para mostrar e para montar o pedido)
function aplicarOps(nota: Nota, ops: Ops): Nota {
  const n: Nota = { ...nota, propriedades: { ...nota.propriedades }, conteudo: nota.conteudo };
  Object.assign(n.propriedades, ops.propriedades ?? {});
  for (const [k, v] of Object.entries(n.propriedades)) if (v === null) delete n.propriedades[k];
  n.conteudo = aplicarTexto(n.conteudo, ops).texto;
  return n;
}
function aplicarTexto(texto: string, ops: Ops): { texto: string; trocas: { de: string; para: string }[]; acrescentar: string } {
  let t = texto;
  const trocas: { de: string; para: string }[] = [];
  const trocar = (de: string, para: string) => {
    if (t.split(de).length - 1 !== 1) return false;
    t = t.replace(de, para); trocas.push({ de, para }); return true;
  };
  let extra = "";
  const linha = (rotulo: string, valor?: string) => {
    if (valor === undefined) return;
    const m = t.match(new RegExp(`^- ${rotulo}:.*$`, "m"));
    if (m) trocar(m[0], `- ${rotulo}: ${valor}`.trimEnd());
    else extra += `\n- ${rotulo}: ${valor}`;
  };
  linha("Emoção predominante", ops.emocao);
  linha("Observações", ops.observacoes);
  for (const [secao, linhas] of Object.entries(ops.journal ?? {})) {
    if (!linhas.length) continue;
    const bloco = linhas.map((l) => `- ${l.replace(/\n+/g, " ").trim()}`).join("\n");
    const cab = `## ${secao}`;
    const idx = t.indexOf(cab);
    if (idx >= 0 && t.split(cab).length === 2) {
      // insere no fim da seção (antes do próximo "## " ou no fim do texto)
      const ini = idx + cab.length;
      const prox = t.indexOf("\n## ", ini);
      const fim = prox >= 0 ? prox : t.length;
      const corpo = t.slice(ini, fim);
      const novoCorpo = corpo.replace(/\s*$/, "") + "\n" + bloco + (prox >= 0 ? "\n" : "\n");
      trocar(cab + corpo, cab + novoCorpo);
    } else {
      extra += `\n\n${cab}\n${bloco}`;
    }
  }
  for (const c of ops.checklist ?? []) {
    const linhas = t.split("\n").filter((l) => /^\s*[-*] \[[ xX]\] /.test(l) && l.includes(c.item));
    if (linhas.length === 1) trocar(linhas[0], linhas[0].replace(/\[[ xX]\]/, c.feito ? "[x]" : "[ ]"));
  }
  for (const r of ops.remover ?? []) {
    const linhas = t.split("\n").filter((l) => /^\s*[-*] \[[ xX]\] /.test(l) && l.includes(r));
    if (linhas.length === 1) trocar(linhas[0] + "\n", "") || trocar("\n" + linhas[0], "");
  }
  for (const a of ops.acrescentar ?? []) extra += `\n${a}`;
  return { texto: t + extra, trocas, acrescentar: extra.replace(/^\n+/, "") };
}

function juntarOps(a: Ops, b: Ops): Ops {
  const r: Ops = { ...a };
  if (b.propriedades) r.propriedades = { ...(a.propriedades ?? {}), ...b.propriedades };
  if (b.journal) {
    r.journal = { ...(a.journal ?? {}) };
    for (const [k, v] of Object.entries(b.journal)) r.journal[k] = [...(r.journal[k] ?? []), ...v];
  }
  if (b.emocao !== undefined) r.emocao = b.emocao;
  if (b.observacoes !== undefined) r.observacoes = b.observacoes;
  if (b.checklist) r.checklist = [...(a.checklist ?? []).filter((x) => !b.checklist!.some((y) => y.item === x.item)), ...b.checklist];
  if (b.acrescentar) r.acrescentar = [...(a.acrescentar ?? []), ...b.acrescentar];
  if (b.remover) r.remover = [...(a.remover ?? []), ...b.remover];
  return r;
}

// visão combinada: espelho + mudanças do app ainda não refletidas
async function notasComMudancas(filtro: (q: any) => any, prefixos: string[]): Promise<Nota[]> {
  const [espelho, muds] = await Promise.all([lerNotas(filtro), mudancasAbertas()]);
  const mapa = new Map(espelho.map((n) => [n.caminho, n]));
  for (const m of muds) {
    if (!prefixos.some((p) => m.caminho.startsWith(p))) continue;
    const atual = mapa.get(m.caminho);
    if (m.status === "aplicado") {
      // já aplicado no Obsidian: só sobrepõe se o espelho ainda não sincronizou
      if (!atual) { if (m.acao === "criar") mapa.set(m.caminho, { ...notaDeCriacao(m), pendente: true }); continue; }
      if (m.dados._base && atual.hash === m.dados._base) mapa.set(m.caminho, { ...aplicarOps(atual, m.dados), pendente: true });
      continue;
    }
    if (atual) mapa.set(m.caminho, { ...aplicarOps(atual, m.dados), pendente: true });
    else if (m.acao === "criar") mapa.set(m.caminho, { ...notaDeCriacao(m), pendente: true });
  }
  return [...mapa.values()];
}
function notaDeCriacao(m: Mudanca): Nota {
  const { props, corpo } = separarFrontmatter(m.conteudo ?? "");
  const base: Nota = { caminho: m.caminho, titulo: m.caminho.split("/").pop()!.replace(/\.md$/, ""), conteudo: corpo, propriedades: props };
  return aplicarOps(base, m.dados);
}

// ---------------- frontmatter ----------------
function yamlValor(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.length ? "\n" + v.map((x) => `  - ${yamlValor(x)}`).join("\n") : "[]";
  const s = String(v);
  return /^[\w\-./ À-ÿ]+$/.test(s) && !/^(true|false|null|yes|no|\d[\d\-:.]*)$/i.test(s) ? s : JSON.stringify(s);
}
const montarNota = (props: Record<string, unknown>, corpo: string) =>
  `---\n${Object.entries(props).map(([k, v]) => `${k}:${(() => { const y = yamlValor(v); return y.startsWith("\n") ? y : y ? " " + y : ""; })()}`).join("\n")}\n---\n${corpo}`;
function separarFrontmatter(txt: string): { props: Record<string, any>; corpo: string } {
  const m = txt.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { props: {}, corpo: txt };
  const props: Record<string, any> = {};
  let chaveLista = "";
  for (const l of m[1].split("\n")) {
    const li = l.match(/^\s+-\s+(.*)$/);
    if (li && chaveLista) { (props[chaveLista] ??= []).push(desyaml(li[1])); continue; }
    const kv = l.match(/^([^:]+):\s*(.*)$/);
    if (kv) { chaveLista = kv[1].trim(); props[chaveLista] = kv[2] === "" ? null : desyaml(kv[2]); if (kv[2] === "") chaveLista = kv[1].trim(); }
  }
  return { props, corpo: m[2] };
}
function desyaml(s: string): unknown {
  s = s.trim();
  if (s === "true") return true; if (s === "false") return false; if (s === "[]") return [];
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('"')) { try { return JSON.parse(s); } catch { /* */ } }
  return s;
}
const limparNome = (s: string) => s.replace(/[\\/:*?"<>|#^\[\]\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

// ---------------- fila do app -> Ponte ----------------
async function registrar(caminho: string, acao: "criar" | "editar", ops: Ops, conteudo?: string) {
  const { data: abertas } = await db.from("app_mudancas").select("*").eq("caminho", caminho).eq("status", "aguardando").order("id").limit(1);
  const a = abertas?.[0] as Mudanca | undefined;
  if (a) {
    await db.from("app_mudancas").update({ dados: juntarOps(a.dados, ops), atualizado_em: new Date().toISOString() }).eq("id", a.id);
  } else {
    await db.from("app_mudancas").insert({ caminho, acao, dados: ops, conteudo: conteudo ?? null });
  }
  await enviarFila().catch((e) => console.error("fila", e));
}

const PEDIDO_EDICAO = ["editar", "apagar", "tarefa", "mover"];
async function enviarFila() {
  // 1) acompanha os já enviados
  const { data: enviados } = await db.from("app_mudancas").select("*").eq("status", "enviado");
  for (const m of (enviados ?? []) as Mudanca[]) {
    const { data: p } = await db.from("pedidos_vault").select("aplicado_em, resultado").eq("id", m.pedido_id).maybeSingle();
    if (!p) { await db.from("app_mudancas").update({ status: "aguardando", atualizado_em: new Date().toISOString() }).eq("id", m.id); continue; }
    if (!p.aplicado_em) continue;
    const r = String(p.resultado ?? "");
    if (/^(criado|editado)/.test(r)) {
      await db.from("app_mudancas").update({ status: "aplicado", resultado: r, atualizado_em: new Date().toISOString() }).eq("id", m.id);
    } else if (/já existia/.test(r)) {
      // a nota já existia (ex.: Obsidian criou a nota do dia): reenviar como edição
      await db.from("app_mudancas").update({ acao: "editar", status: "aguardando", resultado: r, atualizado_em: new Date().toISOString() }).eq("id", m.id);
    } else {
      const t = (m.dados._tentativas ?? 0) + 1;
      await db.from("app_mudancas").update({
        status: t >= 3 ? "erro" : "aguardando", resultado: r, dados: { ...m.dados, _tentativas: t }, atualizado_em: new Date().toISOString(),
      }).eq("id", m.id);
    }
  }
  // 2) envia os que estão aguardando (uma de cada vez por nota)
  const { data: aguard } = await db.from("app_mudancas").select("*").eq("status", "aguardando").order("id");
  const vistos = new Set<string>();
  for (const m of (aguard ?? []) as Mudanca[]) {
    if (vistos.has(m.caminho)) continue;
    vistos.add(m.caminho);
    const { data: emVoo } = await db.from("app_mudancas").select("id").eq("caminho", m.caminho).eq("status", "enviado").limit(1);
    if (emVoo?.length) continue;
    const { data: pend } = await db.from("pedidos_vault").select("id").eq("caminho", m.caminho).is("aplicado_em", null).in("acao", PEDIDO_EDICAO).limit(1);
    if (pend?.length) continue;
    const { data: nota } = await db.from("notas").select("caminho, titulo, conteudo, propriedades, hash").eq("caminho", m.caminho).maybeSingle();
    let pedido: Record<string, unknown>;
    if (m.acao === "criar" && !nota) {
      const { props, corpo } = separarFrontmatter(m.conteudo ?? "");
      const n = aplicarOps({ caminho: m.caminho, titulo: "", conteudo: corpo, propriedades: props }, m.dados);
      pedido = { acao: "criar", conteudo: montarNota(n.propriedades, n.conteudo) };
    } else {
      if (!nota) continue; // criação ainda não sincronizou: espera
      const { trocas, acrescentar } = aplicarTexto(nota.conteudo, m.dados);
      const dados: Record<string, unknown> = {};
      if (m.dados.propriedades && Object.keys(m.dados.propriedades).length) dados.propriedades = m.dados.propriedades;
      if (trocas.length) dados.trocar = trocas.slice(0, 20);
      if (acrescentar.trim()) dados.acrescentar = acrescentar;
      if (m.acao === "criar") { // nota já existia: aplica as propriedades da criação também
        const { props } = separarFrontmatter(m.conteudo ?? "");
        const novas = Object.fromEntries(Object.entries(props).filter(([k, v]) => v !== null && (nota.propriedades ?? {})[k] == null));
        dados.propriedades = { ...novas, ...(dados.propriedades as object ?? {}) };
      }
      if (!Object.keys(dados).length) { await db.from("app_mudancas").update({ status: "aplicado", resultado: "nada a mudar" }).eq("id", m.id); continue; }
      pedido = { acao: "editar", conteudo: "", base_hash: nota.hash, dados };
    }
    const usuario = await usuarioId();
    const { data: ins, error } = await db.from("pedidos_vault").insert({ usuario_id: usuario, caminho: m.caminho, origem: ORIGEM, ...pedido }).select("id").single();
    if (error) { console.error("pedido", error.message); continue; }
    await db.from("app_mudancas").update({
      status: "enviado", pedido_id: ins.id, acao: pedido.acao, dados: { ...m.dados, _base: nota?.hash }, atualizado_em: new Date().toISOString(),
    }).eq("id", m.id);
  }
}
let _uid: string | null = null;
async function usuarioId() {
  if (_uid) return _uid;
  const { data } = await db.from("notas").select("usuario_id").limit(1).single();
  return (_uid = data!.usuario_id as string);
}

// ---------------- leitura: agenda ----------------
type Item = {
  caminho: string; titulo: string; tipo: string; dia: string | null; hora: string | null; hora_fim: string | null;
  area: string | null; prioridade: string | null; feito: boolean; status: string | null; pessoa: string | null; origem: string; pendente?: boolean;
};
function itemAgenda(n: Nota): Item | null {
  const p = n.propriedades;
  const tipo = String(p.tipo ?? "");
  const ehAgenda = n.caminho.startsWith(PASTA_AGENDA + "/") || TIPOS_AGENDA.includes(tipo);
  const ehPrazo = tipo === "prazo";
  if (!ehAgenda && !ehPrazo) return null;
  if (/📅 Planejamento/.test(n.caminho) || tipo === "painel") return null;
  const dia = dataOk(p.data) ?? dataOk(p.prazo) ?? dataOk(p.vencimento);
  const status = p.status == null ? null : String(p.status);
  const feito = p.feita === true || p.feito === true || (status !== null && FEITO.includes(status.toLowerCase()));
  return {
    caminho: n.caminho, titulo: n.titulo.replace(/ - \d{4}-\d{2}-\d{2}$/, ""), tipo: ehPrazo ? "prazo" : tipo || "tarefa", dia,
    hora: horaOk(p.hora ?? p.horario), hora_fim: horaOk(p.hora_fim), area: (p.area ?? p.categoria ?? (ehPrazo ? "trabalho" : null)) as string | null,
    prioridade: (p.prioridade ?? null) as string | null, feito, status, pessoa: (p.pessoa ?? null) as string | null,
    origem: ehPrazo ? "prazo" : "agenda", pendente: n.pendente,
  };
}
function subitensMetas(metas: Nota[]): Item[] {
  const out: Item[] = [];
  for (const m of metas) for (const s of parseSubitens(m.conteudo)) {
    if (!s.prazo) continue;
    out.push({ caminho: m.caminho, titulo: `${s.texto} · ${m.titulo}`, tipo: "meta", dia: s.prazo, hora: null, hora_fim: null,
      area: "metas", prioridade: null, feito: s.feito, status: null, pessoa: null, origem: "meta", pendente: m.pendente });
  }
  return out;
}
async function agenda(de: string, ate: string) {
  const notas = await notasComMudancas(
    (q) => q.or(`caminho.like.${PASTA_AGENDA}/%,propriedades->>tipo.in.(tarefa,compromisso,lembrete,prazo,meta)`),
    [PASTA_AGENDA + "/", PASTA_METAS + "/"],
  );
  const itens = notas.map(itemAgenda).filter(Boolean) as Item[];
  itens.push(...subitensMetas(notas.filter((n) => n.propriedades.tipo === "meta")));
  const h = hoje();
  const noPeriodo = itens.filter((i) => i.dia && i.dia >= de && i.dia <= ate)
    .sort((a, b) => (a.dia! + (a.hora ?? "99")).localeCompare(b.dia! + (b.hora ?? "99")));
  const atrasadas = itens.filter((i) => !i.feito && i.dia && i.dia < h && i.origem !== "prazo")
    .sort((a, b) => a.dia!.localeCompare(b.dia!));
  const semData = itens.filter((i) => !i.feito && !i.dia && i.origem === "agenda");
  return { de, ate, hoje: h, itens: noPeriodo, atrasadas, sem_data: semData };
}

// ---------------- leitura: financeiro ----------------
const mesDe = (p: Record<string, any>) =>
  (p.mes_fatura ?? p.mes_pagamento ?? p.competencia ?? (dataOk(p.data) ?? "").slice(0, 7)) as string;
async function financeiro(mes: string) {
  const notas = await notasComMudancas((q) => q.or(`caminho.like.06 - Financeiro/%,propriedades->>tipo.in.(lancamento,conta)`), ["06 - Financeiro/"]);
  const lanc = notas.filter((n) => n.propriedades.tipo === "lancamento" && !(Number(n.propriedades.parcelas) > 1));
  const doMes = lanc.filter((n) => mesDe(n.propriedades) === mes);
  const soma = (arr: Nota[]) => arr.reduce((s, n) => s + (Number(n.propriedades.valor) || 0), 0);
  const despesas = doMes.filter((n) => n.propriedades.natureza !== "receita");
  const receitas = doMes.filter((n) => n.propriedades.natureza === "receita");
  const agrupa = (arr: Nota[], k: string) => {
    const m: Record<string, number> = {};
    for (const n of arr) { const c = String(n.propriedades[k] ?? "sem informação"); m[c] = (m[c] ?? 0) + (Number(n.propriedades.valor) || 0); }
    return Object.entries(m).map(([nome, total]) => ({ nome, total: Math.round(total * 100) / 100 })).sort((a, b) => b.total - a.total);
  };
  const h = hoje();
  const limite = somaDias(h, 15);
  const contas = notas.filter((n) => {
    const p = n.propriedades;
    const v = dataOk(p.vencimento) ?? dataOk(p.proxima_cobranca);
    const st = String(p.status ?? "").toLowerCase();
    return v && v <= limite && v >= somaDias(h, -30) && !["pago", "paga", "pago_informado", "faturado", "cancelado", "feita"].includes(st);
  }).map((n) => ({
    caminho: n.caminho, titulo: n.titulo, valor: Number(n.propriedades.valor) || null,
    vencimento: dataOk(n.propriedades.vencimento) ?? dataOk(n.propriedades.proxima_cobranca), forma: n.propriedades.forma_pagamento ?? null, pendente: n.pendente,
  })).sort((a, b) => a.vencimento!.localeCompare(b.vencimento!));
  return {
    mes, total_despesas: Math.round(soma(despesas) * 100) / 100, total_receitas: Math.round(soma(receitas) * 100) / 100,
    por_cartao: agrupa(despesas, "forma_pagamento"), por_categoria: agrupa(despesas, "categoria"), contas,
    lancamentos: doMes.sort((a, b) => String(b.propriedades.data ?? "").localeCompare(String(a.propriedades.data ?? ""))).slice(0, 60).map((n) => ({
      caminho: n.caminho, titulo: n.titulo, valor: Number(n.propriedades.valor) || 0, data: n.propriedades.data, natureza: n.propriedades.natureza,
      categoria: n.propriedades.categoria, forma: n.propriedades.forma_pagamento, status: n.propriedades.status, pendente: n.pendente,
    })),
    comissoes_afiloop: receitas.filter((n) => /afiloop|comiss/i.test(`${n.titulo} ${n.propriedades.categoria ?? ""} ${n.propriedades.origem ?? ""}`))
      .reduce((s, n) => s + (Number(n.propriedades.valor) || 0), 0),
    categorias: CATEGORIAS, formas: FORMAS,
  };
}

// ---------------- leitura: diário, hábitos, metas ----------------
function parseDia(n: Nota | undefined, data: string) {
  const p = n?.propriedades ?? {};
  const t = n?.conteudo ?? "";
  const secoes: Record<string, string[]> = {};
  for (const s of SECOES) {
    const i = t.indexOf(`## ${s}`);
    if (i < 0) { secoes[s] = []; continue; }
    const ini = i + s.length + 3, prox = t.indexOf("\n## ", ini);
    secoes[s] = t.slice(ini, prox >= 0 ? prox : t.length).split("\n").map((l) => l.replace(/^\s*[-*]\s?/, "").trim()).filter(Boolean);
  }
  const emo = t.match(/^- Emoção predominante:(.*)$/m)?.[1]?.trim() ?? "";
  const obs = t.match(/^- Observações:(.*)$/m)?.[1]?.trim() ?? "";
  return {
    data, existe: !!n, pendente: !!n?.pendente, caminho: `${PASTA_DIARIO}/${data}.md`,
    humor: p.humor ?? null, sono: p.sono ?? null, energia: p.energia ?? null,
    emocoes: emo ? emo.split(/\s*,\s*/).filter(Boolean) : [], observacoes: obs,
    habitos: Object.fromEntries(Object.entries(p).filter(([, v]) => typeof v === "boolean")), journal: secoes,
  };
}
async function dia(data: string) {
  const ini = somaDias(data, -6);
  const notas = await notasComMudancas((q) => q.or(`caminho.like.${PASTA_DIARIO}/%,propriedades->>tipo.eq.habito`), [PASTA_DIARIO + "/"]);
  const doDia = notas.find((n) => n.caminho === `${PASTA_DIARIO}/${data}.md`);
  const habitos = notas.filter((n) => n.propriedades.tipo === "habito" && n.propriedades.ativo !== false).map((n) => {
    const prop = String(n.propriedades.propriedade);
    const semana = notas.filter((d) => {
      const m = d.caminho.match(/Diário\/(\d{4}-\d{2}-\d{2})\.md$/); return m && m[1] >= ini && m[1] <= data && d.propriedades[prop] === true;
    }).length;
    return { propriedade: prop, titulo: n.titulo, meta_semana: Number(n.propriedades.meta_semana) || 7, feitos_semana: semana };
  });
  return { ...parseDia(doDia, data), habitos_lista: habitos, humores: HUMORES, secoes: SECOES };
}
async function humorMes(mes: string) {
  const notas = await notasComMudancas((q) => q.like("caminho", `${PASTA_DIARIO}/${mes}-%`), [`${PASTA_DIARIO}/${mes}-`]);
  return notas.map((n) => {
    const d = n.caminho.match(/(\d{4}-\d{2}-\d{2})\.md$/)?.[1];
    const h = n.propriedades.humor ? 5 - HUMORES.indexOf(String(n.propriedades.humor)) : null;
    return { data: d, humor: h && h <= 5 ? h : null, sono: Number(n.propriedades.sono) || null, energia: Number(n.propriedades.energia) || null };
  }).filter((x) => x.data).sort((a, b) => a.data!.localeCompare(b.data!));
}

function parseSubitens(t: string) {
  return t.split("\n").filter((l) => /^\s*[-*] \[[ xX]\] /.test(l)).map((l) => {
    const feito = /\[[xX]\]/.test(l);
    const prazo = l.match(/📅\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
    const texto = l.replace(/^\s*[-*] \[[ xX]\]\s*/, "").replace(/📅\s*\d{4}-\d{2}-\d{2}/, "").trim();
    return { texto, prazo, feito };
  });
}
async function metas() {
  const notas = await notasComMudancas((q) => q.or(`caminho.like.${PASTA_METAS}/%,propriedades->>tipo.eq.meta`), [PASTA_METAS + "/"]);
  const ms = notas.filter((n) => n.propriedades.tipo === "meta");
  // metas automáticas: comissão do mês (Shopee e outras) — por enquanto receitas marcadas como Afiloop
  return ms.map((n) => {
    const p = n.propriedades;
    const sub = parseSubitens(n.conteudo);
    const alvo = Number(p.valor_alvo) || null, atual = Number(p.valor_atual) || 0;
    const progresso = p.formato === "numero" && alvo ? Math.min(1, atual / alvo) : sub.length ? sub.filter((s) => s.feito).length / sub.length : (p.status === "concluida" ? 1 : 0);
    return {
      caminho: n.caminho, titulo: n.titulo, area: p.area ?? null, prazo: dataOk(p.prazo), status: p.status ?? "ativa", formato: p.formato ?? "projeto",
      valor_atual: atual, valor_alvo: alvo, unidade: p.unidade ?? null, progresso, subitens: sub, pendente: n.pendente,
    };
  }).sort((a, b) => (a.status === "concluida" ? 1 : 0) - (b.status === "concluida" ? 1 : 0) || String(a.prazo ?? "9").localeCompare(String(b.prazo ?? "9")));
}


async function habitosPeriodo(de: string, ate: string) {
  const notas = await notasComMudancas((q) => q.or(`caminho.like.${PASTA_DIARIO}/%,propriedades->>tipo.eq.habito`), [PASTA_DIARIO + "/"]);
  const habitos = notas.filter((n) => n.propriedades.tipo === "habito" && n.propriedades.ativo !== false).map((n) => ({
    propriedade: String(n.propriedades.propriedade), titulo: n.titulo, meta_semana: Number(n.propriedades.meta_semana) || 7,
  }));
  const dias: Record<string, Record<string, boolean>> = {};
  for (const n of notas) {
    const d = n.caminho.match(/Diário\/(\d{4}-\d{2}-\d{2})\.md$/)?.[1];
    if (!d || d < de || d > ate) continue;
    dias[d] = Object.fromEntries(habitos.map((h) => [h.propriedade, n.propriedades[h.propriedade] === true]));
  }
  return { de, ate, hoje: hoje(), habitos, dias };
}

// ---------------- hoje ----------------
async function sincronizacao() {
  const { data: u } = await db.from("notas").select("sincronizado_em").order("sincronizado_em", { ascending: false }).limit(1).single();
  const { count } = await db.from("pedidos_vault").select("id", { count: "exact", head: true }).is("aplicado_em", null);
  const { count: app } = await db.from("app_mudancas").select("id", { count: "exact", head: true }).in("status", ["aguardando", "enviado"]);
  const { data: ult } = await db.from("pedidos_vault").select("aplicado_em").not("aplicado_em", "is", null).order("aplicado_em", { ascending: false }).limit(1).maybeSingle();
  return { ultima_sincronizacao: u?.sincronizado_em ?? null, ultima_aplicacao: ult?.aplicado_em ?? null, pendentes_ponte: count ?? 0, pendentes_app: app ?? 0 };
}
async function telaHoje() {
  const h = hoje();
  const [ag, fin, d, sync, ofertas] = await Promise.all([
    agenda(h, h), financeiro(h.slice(0, 7)), dia(h), sincronizacao(),
    db.from("afiloop_ofertas").select("id, nome, preco, comissao_pct, link_afiliado, imagem_url, nicho").eq("status", "nova")
      .order("comissao_valor", { ascending: false }).limit(3).then((r) => r.data ?? []),
  ]);
  return {
    hoje: h, agenda: ag.itens, atrasadas: ag.atrasadas.slice(0, 10), total_atrasadas: ag.atrasadas.length,
    financeiro: { contas: fin.contas.filter((c) => c.vencimento! <= somaDias(h, 3)) },
    afiloop: await resumoFila(),
    diario: { humor: d.humor, preenchido: !!(d.humor || Object.values(d.journal).some((x) => x.length)) },
    sincronizacao: sync,
  };
}

// ---------------- escrita ----------------
async function salvarDia(b: any) {
  const data = dataOk(b.data) ?? hoje();
  const caminho = `${PASTA_DIARIO}/${data}.md`;
  const ops: Ops = {};
  const props: Record<string, unknown> = {};
  if (b.humor !== undefined) { if (b.humor !== null && !HUMORES.includes(b.humor)) throw new Erro("humor inválido"); props.humor = b.humor; }
  for (const k of ["sono", "energia"]) if (b[k] !== undefined) {
    const v = b[k] === null ? null : Number(b[k]);
    if (v !== null && !(v >= 1 && v <= 5)) throw new Erro(`${k}: 1 a 5`); props[k] = v;
  }
  for (const [k, v] of Object.entries(b.habitos ?? {})) if (/^[\p{L}_]{1,30}$/u.test(k)) props[k] = !!v;
  if (Object.keys(props).length) ops.propriedades = props;
  if (Array.isArray(b.emocoes)) ops.emocao = b.emocoes.map((x: string) => String(x).slice(0, 30)).join(", ");
  if (typeof b.observacoes === "string") ops.observacoes = b.observacoes.slice(0, 1000).replace(/\n+/g, " ");
  if (b.journal && typeof b.journal === "object") {
    ops.journal = {};
    for (const [s, t] of Object.entries(b.journal)) if (SECOES.includes(s) && typeof t === "string" && t.trim()) ops.journal[s] = [t.trim().slice(0, 3000)];
  }
  const { data: existe } = await db.from("notas").select("caminho").eq("caminho", caminho).maybeSingle();
  const { data: criacao } = await db.from("app_mudancas").select("id").eq("caminho", caminho).eq("acao", "criar").in("status", ["aguardando", "enviado"]).limit(1);
  if (!existe && !criacao?.length) {
    const corpo = `## 😊 Como estou\n- Emoção predominante:\n- Observações:\n\n## 🙏 Gratidão\n\n## ✨ Algo bom que aconteceu\n\n## 💭 Reflexão\n\n## 🎯 Intenção para amanhã\n`;
    await registrar(caminho, "criar", ops, montarNota({ tipo: "dia", humor: null, sono: null, energia: null, treino: false, cardio: false, skincare: false }, corpo));
  } else await registrar(caminho, "editar", ops);
  return dia(data);
}

async function atualizarTarefa(b: any) {
  const caminho = String(b.caminho ?? "");
  if (!caminho.endsWith(".md")) throw new Erro("caminho inválido");
  const { data: n } = await db.from("notas").select("propriedades").eq("caminho", caminho).maybeSingle();
  const p: Record<string, unknown> = {};
  const tipo = String(n?.propriedades?.tipo ?? "");
  if (b.feito === true) Object.assign(p, tipo === "prazo" ? { feita: true } : { status: "feita", feita: true, concluida_em: hoje() });
  if (b.feito === false) Object.assign(p, tipo === "prazo" ? { feita: false } : { status: "pendente", feita: false, concluida_em: null });
  if (b.data !== undefined) { const d = dataOk(b.data); if (!d) throw new Erro("data inválida"); p.data = d; if (n?.propriedades?.prazo) p.prazo = d; }
  if (b.prioridade !== undefined) { if (!["alta", "normal", "baixa"].includes(b.prioridade)) throw new Erro("prioridade inválida"); p.prioridade = b.prioridade; }
  if (!Object.keys(p).length) throw new Erro("nada para mudar");
  await registrar(caminho, "editar", { propriedades: p });
  return { ok: true };
}

async function criarTarefa(b: any) {
  const titulo = limparNome(String(b.titulo ?? ""));
  if (!titulo) throw new Erro("título obrigatório");
  const data = b.data ? dataOk(b.data) : null;
  const hora = horaOk(b.hora), fim = horaOk(b.hora_fim);
  const props: Record<string, unknown> = {
    tipo: hora ? "compromisso" : "tarefa", area: b.area ? String(b.area).slice(0, 30) : "vida", status: "pendente", feita: false,
    prioridade: ["alta", "normal", "baixa"].includes(b.prioridade) ? b.prioridade : "normal",
  };
  if (data) { props.data = data; props.prazo = data; }
  if (hora) { props.hora = horaObsidian(hora); props.fuso = TZ; }
  if (fim) props.hora_fim = horaObsidian(fim);
  props.criado = hoje(); props.fonte = "app";
  const caminho = `${PASTA_AGENDA}/${titulo}${data ? " - " + data : ""}.md`;
  await registrar(caminho, "criar", {}, montarNota(props, `# ${titulo}\n${b.notas ? "\n" + String(b.notas).slice(0, 2000) + "\n" : ""}`));
  return { ok: true, caminho };
}

async function criarLancamento(b: any) {
  const valor = Number(String(b.valor ?? "").replace(",", "."));
  if (!(valor > 0)) throw new Erro("valor inválido");
  if (!CATEGORIAS.includes(b.categoria)) throw new Erro("escolha a categoria");
  if (!FORMAS.includes(b.forma_pagamento)) throw new Erro("escolha a forma de pagamento");
  const natureza = b.natureza === "receita" ? "receita" : "despesa";
  const data = dataOk(b.data) ?? hoje();
  const desc = limparNome(String(b.descricao ?? b.categoria)) || b.categoria;
  const cartao = b.forma_pagamento.startsWith("Cartão");
  const mesPag = /^\d{4}-\d{2}$/.test(b.mes_pagamento ?? "") ? b.mes_pagamento : data.slice(0, 7);
  const props: Record<string, unknown> = {
    tipo: "lancamento", area: "financeiro", natureza, valor: Math.round(valor * 100) / 100, data, mes_pagamento: mesPag,
    status: cartao ? "faturado" : "pago", categoria: b.categoria, forma_pagamento: b.forma_pagamento, fonte: "app",
  };
  if (cartao) props.mes_fatura = mesPag;
  const parcelas = Number(b.parcelas) || 1;
  if (parcelas > 1) { props.parcelas = Math.min(parcelas, 48); if (b.primeira_parcela) props.primeira_parcela = b.primeira_parcela; }
  const { count } = await db.from("notas").select("caminho", { count: "exact", head: true }).like("caminho", `${PASTA_LANC}/${data} - %`);
  const n = String((count ?? 0) + 1 + Math.floor(Math.random() * 0)).padStart(2, "0");
  const caminho = `${PASTA_LANC}/${data} - ${n} - ${desc}.md`;
  await registrar(caminho, "criar", {}, montarNota(props, `# ${desc}\n${b.notas ? "\n" + String(b.notas).slice(0, 2000) + "\n" : ""}`));
  return { ok: true, caminho };
}

async function contaPaga(b: any) {
  const caminho = String(b.caminho ?? "");
  if (!caminho.endsWith(".md")) throw new Erro("caminho inválido");
  await registrar(caminho, "editar", { propriedades: { status: "pago", pago_em: hoje() } });
  return { ok: true };
}

async function criarMeta(b: any) {
  const titulo = limparNome(String(b.titulo ?? ""));
  if (!titulo) throw new Erro("título obrigatório");
  const formato = ["numero", "habito", "projeto"].includes(b.formato) ? b.formato : "projeto";
  const props: Record<string, unknown> = { tipo: "meta", area: b.area ? String(b.area).slice(0, 30) : "pessoal", status: "ativa", formato, criado: hoje() };
  const prazo = dataOk(b.prazo); if (prazo) props.prazo = prazo;
  if (formato === "numero") { props.valor_alvo = Number(b.valor_alvo) || 0; props.valor_atual = Number(b.valor_atual) || 0; if (b.unidade) props.unidade = String(b.unidade).slice(0, 20); }
  const subs = (Array.isArray(b.subitens) ? b.subitens : []).slice(0, 30).map((s: any) =>
    `- [ ] ${String(s.texto ?? "").replace(/\n/g, " ").slice(0, 200)}${dataOk(s.prazo) ? " 📅 " + dataOk(s.prazo) : ""}`);
  const corpo = `# 🎯 ${titulo}\n${b.descricao ? "\n" + String(b.descricao).slice(0, 2000) + "\n" : ""}\n## Etapas\n${subs.join("\n")}\n`;
  const caminho = `${PASTA_METAS}/${titulo}.md`;
  await registrar(caminho, "criar", {}, montarNota(props, corpo));
  return { ok: true, caminho };
}
async function atualizarMeta(b: any) {
  const caminho = String(b.caminho ?? "");
  if (!caminho.startsWith(PASTA_METAS + "/")) throw new Erro("meta inválida");
  const ops: Ops = {};
  const p: Record<string, unknown> = {};
  if (b.valor_atual !== undefined) p.valor_atual = Number(b.valor_atual) || 0;
  if (b.status && ["ativa", "pausada", "concluida"].includes(b.status)) p.status = b.status;
  if (b.prazo !== undefined) p.prazo = dataOk(b.prazo);
  if (Object.keys(p).length) ops.propriedades = p;
  if (b.subitem && typeof b.subitem.item === "string") ops.checklist = [{ item: b.subitem.item, feito: !!b.subitem.feito }];
  if (b.novo_subitem?.texto) ops.acrescentar = [`- [ ] ${String(b.novo_subitem.texto).replace(/\n/g, " ").slice(0, 200)}${dataOk(b.novo_subitem.prazo) ? " 📅 " + dataOk(b.novo_subitem.prazo) : ""}`];
  if (!Object.keys(ops).length) throw new Erro("nada para mudar");
  await registrar(caminho, "editar", ops);
  return { ok: true };
}

// ---------------- captura rápida ----------------
const DIAS_SEMANA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const PALAVRAS_CAT: [RegExp, string][] = [
  [/mercado|supermercado|feira|hortifruti|padaria/i, "mercado"], [/farm[aá]cia|rem[eé]dio|drogaria/i, "farmácia"],
  [/luz|[aá]gua|internet|g[aá]s|condom[ií]nio|aluguel|energia/i, "contas da casa"], [/bab[aá]|diarista|faxina|funcion[aá]ri/i, "funcionárias"],
  [/m[eé]dico|consulta|exame|dentista|psic[oó]log|terapia/i, "saúde"], [/pet|ra[cç][aã]o|veterin/i, "pets"],
  [/fralda|nicolas|beb[eê]|filho|escola/i, "filhos"], [/uber|99|gasolina|combust[ií]vel|estacionamento|t[aá]xi/i, "transporte"],
  [/restaurante|ifood|lanche|almo[cç]o|jantar|caf[eé]|delivery/i, "alimentação fora"], [/cinema|show|viagem|passeio/i, "lazer"],
  [/roupa|sal[aã]o|cabelo|unha|maquiagem|cosm[eé]tico|skincare/i, "roupas e beleza"], [/curso|livro|aula/i, "educação"],
  [/assinatura|netflix|spotify|prime|icloud/i, "assinaturas"], [/casa|m[oó]vel|decora/i, "casa"],
];
function dataDoTexto(t: string): string | null {
  const h = hoje();
  if (/depois de amanh[aã]/i.test(t)) return somaDias(h, 2);
  if (/amanh[aã]/i.test(t)) return somaDias(h, 1);
  if (/\bhoje\b/i.test(t)) return h;
  const dm = t.match(/\b(?:dia\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (dm) { const ano = dm[3] ? (dm[3].length === 2 ? "20" + dm[3] : dm[3]) : h.slice(0, 4); return `${ano}-${dm[2].padStart(2, "0")}-${dm[1].padStart(2, "0")}`; }
  const d1 = t.match(/\bdia\s+(\d{1,2})\b/i);
  if (d1) { let d = `${h.slice(0, 7)}-${d1[1].padStart(2, "0")}`; if (d < h) { const x = new Date(`${h.slice(0, 7)}-01T12:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1); d = `${x.toISOString().slice(0, 7)}-${d1[1].padStart(2, "0")}`; } return d; }
  for (let i = 0; i < 7; i++) if (new RegExp(`\\b${DIAS_SEMANA[i]}`, "i").test(t)) {
    const hoj = new Date(`${h}T12:00:00Z`).getUTCDay(); let dif = (i - hoj + 7) % 7; if (dif === 0) dif = 7; return somaDias(h, dif);
  }
  return null;
}
function interpretarRegras(texto: string) {
  const t = texto.trim();
  const valor = t.match(/(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)\s*(?:reais|real|conto|r\$)?/i);
  const temDinheiro = /gastei|paguei|comprei|r\$|reais|\bconto/i.test(t) && valor;
  if (temDinheiro) {
    const forma = /nubank|roxinho/i.test(t) ? "Cartão Nubank" : /\bxp\b/i.test(t) ? "Cartão XP" : /btg/i.test(t) ? "Cartão BTG"
      : /ita[uú]/i.test(t) ? "Cartão Itaú" : /\bguy\b/i.test(t) ? "Cartão Guy" : /pix|dinheiro|esp[eé]cie/i.test(t) ? "PIX/Dinheiro" : null;
    const cat = PALAVRAS_CAT.find(([re]) => re.test(t))?.[1] ?? null;
    const parc = t.match(/(\d{1,2})\s*x\b|em\s+(\d{1,2})\s+vezes/i);
    return { tipo: "lancamento", campos: {
      valor: Number(valor![1].replace(",", ".")), categoria: cat, forma_pagamento: forma, data: dataDoTexto(t) ?? hoje(),
      descricao: t.replace(valor![0], " ").replace(/gastei|paguei|comprei|r\$\s*\d+([.,]\d+)?|\d+([.,]\d+)?\s*(reais|real|conto)/gi, "").replace(/\b(no|na|com|de|em|cart[aã]o|nubank|xp|btg|ita[uú]|pix)\b/gi, " ").replace(/\s+/g, " ").trim().slice(0, 60),
      parcelas: parc ? Number(parc[1] ?? parc[2]) : 1, natureza: /recebi|entrou|ganhei/i.test(t) ? "receita" : "despesa",
    }, faltando: [!cat && "categoria", !forma && "forma_pagamento"].filter(Boolean) };
  }
  if (/^ideia|ideia de post|post sobre/i.test(t)) {
    const nicho = /beb[eê]|maternidade|m[aã]e/i.test(t) ? "Maternidade" : /maquiagem|skincare|beleza|batom/i.test(t) ? "Beauty"
      : /cozinha|casa|decora|quarto/i.test(t) ? "Casa" : /look|roupa|vestido|moda|blazer/i.test(t) ? "Fashion" : null;
    return { tipo: "ideia_post", campos: { titulo: t.replace(/^ideia( de post)?:?\s*/i, "").slice(0, 80), nicho }, faltando: nicho ? [] : ["nicho"] };
  }
  if (/^(hoje )?(estou|me sinto|t[oô]|to)\b/i.test(t)) {
    return { tipo: "diario", campos: { observacoes: t }, faltando: [] };
  }
  const data = dataDoTexto(t);
  const hora = t.match(/(?:às|as|\b)(\d{1,2})(?:h|:)(\d{2})?\b/i);
  const titulo = t.replace(/\s*(?:às|as)\s+\d{1,2}(?:h|:)\d{0,2}\s*/gi, " ").replace(/\b(amanh[aã]|hoje|depois de amanh[aã]|dia \d{1,2}(\/\d{1,2})?|(?:na |no )?(domingo|segunda|terça|quarta|quinta|sexta|sábado)(-feira)?|às? \d{1,2}(h|:)\d{0,2})\b/gi, "").replace(/\s+/g, " ").trim();
  return { tipo: "tarefa", campos: { titulo: titulo.charAt(0).toUpperCase() + titulo.slice(1), data, hora: hora ? `${hora[1].padStart(2, "0")}:${hora[2] ?? "00"}` : null, prioridade: "normal" }, faltando: [] };
}
async function interpretar(texto: string) {
  const chave = Deno.env.get("OPENAI_API_KEY");
  if (!chave) return { ...interpretarRegras(texto), via: "regras" };
  const sistema = `Você transforma uma frase em português num registro do Segundo Cérebro. Hoje é ${hoje()} (fuso America/Recife).
Responda só JSON: {"tipo": "lancamento"|"tarefa"|"ideia_post"|"diario", "campos": {...}, "faltando": [...]}
- lancamento: valor (número), natureza (despesa|receita), categoria (uma de ${CATEGORIAS.join(", ")}), forma_pagamento (uma de ${FORMAS.join(", ")}), data (AAAA-MM-DD), descricao, parcelas (número). Se faltar categoria ou forma de pagamento, deixe null e coloque em "faltando". Nunca adivinhe a forma de pagamento.
- tarefa: titulo, data (AAAA-MM-DD ou null), hora (HH:MM ou null), prioridade (alta|normal|baixa), area.
- ideia_post: titulo, nicho (Fashion|Beauty|Casa|Maternidade ou null se não der para saber; então em "faltando").
- diario: observacoes (texto), humor (um de ${HUMORES.join(", ")} ou null).`;
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${chave}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini", temperature: 0, response_format: { type: "json_object" },
        messages: [{ role: "system", content: sistema }, { role: "user", content: texto.slice(0, 1000) }] }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    return { ...JSON.parse(j.choices[0].message.content), via: "ia" };
  } catch { return { ...interpretarRegras(texto), via: "regras" }; }
}
async function criarIdeiaPost(b: any) {
  const titulo = limparNome(String(b.titulo ?? ""));
  const nicho = ["Fashion", "Beauty", "Casa", "Maternidade"].includes(b.nicho) ? b.nicho : null;
  if (!titulo) throw new Erro("título obrigatório");
  if (!nicho) throw new Erro("escolha o nicho");
  const props = { tipo: "post", nicho, formato: null, status: "💡 ideia", data: null, hora: null, gancho: null, legenda_pronta: false, postado: false, fonte: "app" };
  await registrar(`04 - Projetos/Afiloop/📱 Posts/${titulo}.md`, "criar", {}, montarNota(props, `## Ideia\n${String(b.titulo).slice(0, 2000)}\n`));
  return { ok: true };
}


// ---------------- central: listas, wishlist, saúde, jurídico, mídia ----------------
const PASTA_COMPRAS = "01 - Vida/Casa/Compras";
const WISHLIST = `${PASTA_COMPRAS}/Wishlist.md`;
function itensLista(t: string) {
  return t.split("\n").filter((l) => /^\s*[-*] \[[ xX]\] /.test(l)).map((l) => {
    const texto = l.replace(/^\s*[-*] \[[ xX]\]\s*/, "").trim();
    const partes = texto.split(" · ").map((x) => x.trim());
    const link = partes.find((x) => /^https?:\/\//.test(x)) ?? null;
    const preco = partes.find((x) => /^R\$/.test(x)) ?? null;
    const prioridade = partes.find((x) => /^(alta|média|media|baixa)$/i.test(x)) ?? null;
    return { linha: texto, nome: partes[0], feito: /\[[xX]\]/.test(l), link, preco, prioridade };
  });
}
async function listas() {
  const notas = await notasComMudancas((q) => q.like("caminho", `${PASTA_COMPRAS}/%`), [PASTA_COMPRAS + "/"]);
  const out = notas.filter((n) => n.propriedades.tipo === "lista_compras").map((n) => ({
    caminho: n.caminho, titulo: n.titulo, lista: n.propriedades.lista, pendente: n.pendente, itens: itensLista(n.conteudo),
  }));
  if (!out.some((l) => l.caminho === WISHLIST)) out.push({ caminho: WISHLIST, titulo: "Wishlist", lista: "wishlist", pendente: false, itens: [] });
  const ordem = ["supermercado", "farmácia", "casa", "pessoal", "pets", "outros", "wishlist"];
  return out.sort((a, b) => ordem.indexOf(String(a.lista)) - ordem.indexOf(String(b.lista)));
}
async function itemLista(b: any) {
  const caminho = String(b.caminho ?? "");
  if (!caminho.startsWith(PASTA_COMPRAS + "/") || !caminho.endsWith(".md")) throw new Erro("lista inválida");
  const ops: Ops = {};
  if (b.novo) {
    const partes = [String(b.novo).replace(/\n/g, " ").replace(/ · /g, " - ").trim().slice(0, 150)];
    if (b.preco) partes.push(`R$ ${String(b.preco).replace(/^R\$\s*/, "").slice(0, 15)}`);
    if (b.prioridade && ["alta", "média", "baixa"].includes(b.prioridade)) partes.push(b.prioridade);
    if (b.link && /^https?:\/\//.test(b.link)) partes.push(String(b.link).slice(0, 400));
    ops.acrescentar = [`- [ ] ${partes.join(" · ")}`];
  }
  if (b.item && typeof b.feito === "boolean") ops.checklist = [{ item: String(b.item), feito: b.feito }];
  if (b.remover) ops.remover = [String(b.remover)];
  if (!Object.keys(ops).length) throw new Erro("nada para mudar");
  const { data: existe } = await db.from("notas").select("caminho").eq("caminho", caminho).maybeSingle();
  const { data: criando } = await db.from("app_mudancas").select("id").eq("caminho", caminho).eq("acao", "criar").in("status", ["aguardando", "enviado"]).limit(1);
  if (!existe && !criando?.length && caminho === WISHLIST) {
    await registrar(caminho, "criar", ops, montarNota({ tipo: "lista_compras", lista: "wishlist" }, "# 🎁 Wishlist\n\n"));
  } else await registrar(caminho, "editar", ops);
  return listas();
}
async function saude(pessoa: string) {
  const nome = ["Juliana", "Nicolas", "Guy"].includes(pessoa) ? pessoa : "Juliana";
  const notas = await notasComMudancas((q) => q.or(`propriedades->>tipo.in.(saude,exame),caminho.like.01 - Vida/Saúde/%,caminho.like.01 - Vida/Documentos/${nome}/%`), []);
  const daPessoa = notas.filter((n) => String(n.propriedades.pessoa ?? "").includes(nome) || (nome !== "Juliana" && n.caminho.includes(`/${nome}/`)) ||
    (nome === "Juliana" && !n.propriedades.pessoa && n.caminho.startsWith("01 - Vida/Saúde/")));
  const h = hoje();
  const ag = await agenda(somaDias(h, -1), somaDias(h, 120));
  const proximos = ag.itens.filter((i) => !i.feito && (i.area === "saude" || /vacina|consulta|exame|pediatra|m[eé]dic|dentista/i.test(i.titulo)) &&
    (nome === "Juliana" ? !/nicolas|guy/i.test(i.titulo) && (!i.pessoa || i.pessoa === "Juliana") : i.pessoa === nome || new RegExp(nome, "i").test(i.titulo)));
  const registros = daPessoa.map((n) => ({ caminho: n.caminho, titulo: n.titulo, tipo: n.propriedades.tipo ?? null, data: dataOk(n.propriedades.data) }))
    .sort((a, b) => String(b.data ?? "0").localeCompare(String(a.data ?? "0")));
  return { pessoa: nome, proximos, registros };
}
async function juridico() {
  const notas = await lerNotas((q) => q.or("propriedades->>tipo.in.(prazo,processo,contrato)"));
  const h = hoje();
  const prazos = notas.filter((n) => n.propriedades.tipo === "prazo").map((n) => ({
    caminho: n.caminho, titulo: n.titulo.replace(/^⏳\s*/, ""), vencimento: dataOk(n.propriedades.vencimento), quando: n.propriedades.quando ?? null,
    feito: n.propriedades.feita === true, status: n.propriedades.status ?? null, instrumento: n.propriedades.instrumento ?? null,
  })).filter((p) => !p.feito).sort((a, b) => String(a.vencimento ?? "9999").localeCompare(String(b.vencimento ?? "9999")));
  const processos = notas.filter((n) => n.propriedades.tipo === "processo").map((n) => ({
    caminho: n.caminho, titulo: n.titulo, status: n.propriedades.status ?? null, fase: n.propriedades.fase ?? null, prazo: dataOk(n.propriedades.prazo),
    empresa: String(n.propriedades.empresa ?? "").replace(/^.*\|/, "").replace(/[\[\]]/g, ""),
  })).sort((a, b) => String(a.prazo ?? "9999").localeCompare(String(b.prazo ?? "9999")));
  const contratos = notas.filter((n) => n.propriedades.tipo === "contrato" && dataOk(n.propriedades.vencimento) && dataOk(n.propriedades.vencimento)! >= h)
    .map((n) => ({ caminho: n.caminho, titulo: n.titulo.replace(/^📄\s*/, ""), vencimento: dataOk(n.propriedades.vencimento), risco: n.propriedades.risco ?? null }))
    .sort((a, b) => a.vencimento!.localeCompare(b.vencimento!)).slice(0, 25);
  return { hoje: h, prazos, processos, contratos };
}
async function midia() {
  const notas = await notasComMudancas((q) => q.eq("propriedades->>tipo", "midia"), ["03 - Conhecimento/"]);
  return notas.filter((n) => n.propriedades.tipo === "midia").map((n) => ({
    caminho: n.caminho, titulo: n.titulo, status: n.propriedades.status ?? "quero assistir", formato: n.propriedades.formato ?? null,
    estrelas: n.propriedades.estrelas ?? null, onde: n.propriedades.onde ?? null, pendente: n.pendente,
  })).sort((a, b) => a.titulo.localeCompare(b.titulo, "pt"));
}
async function atualizarMidia(b: any) {
  const caminho = String(b.caminho ?? "");
  if (!caminho.startsWith("03 - Conhecimento/")) throw new Erro("título inválido");
  const p: Record<string, unknown> = {};
  const STATUS = ["quero assistir", "assistindo", "assistido", "quero ler", "lendo", "lido", "abandonei"];
  if (b.status) { if (!STATUS.includes(b.status)) throw new Erro("status inválido"); p.status = b.status; if (["assistido", "lido"].includes(b.status)) p.ano_concluido = Number(hoje().slice(0, 4)); }
  if (b.estrelas !== undefined) p.estrelas = b.estrelas === null ? null : Math.max(1, Math.min(5, Number(b.estrelas)));
  if (!Object.keys(p).length) throw new Erro("nada para mudar");
  await registrar(caminho, "editar", { propriedades: p });
  return { ok: true };
}


// ---------------- chat com o Segundo Cérebro ----------------
const LISTAS = ["supermercado", "farmácia", "casa", "pessoal", "pets", "outros", "wishlist"];
const FERRAMENTAS = [
  { type: "function", function: { name: "buscar_notas", description: "Busca nas notas do Obsidian da Juliana (documentos, saúde, pessoas, jurídico, cursos, projetos...). Use palavras-chave curtas.", parameters: { type: "object", properties: { consulta: { type: "string" } }, required: ["consulta"] } } },
  { type: "function", function: { name: "ler_nota", description: "Lê o texto completo de uma nota pelo caminho retornado em buscar_notas.", parameters: { type: "object", properties: { caminho: { type: "string" } }, required: ["caminho"] } } },
  { type: "function", function: { name: "agenda", description: "Lista compromissos e tarefas entre duas datas (AAAA-MM-DD), mais as atrasadas.", parameters: { type: "object", properties: { de: { type: "string" }, ate: { type: "string" } }, required: ["de", "ate"] } } },
  { type: "function", function: { name: "financeiro_mes", description: "Totais de gastos do mês (AAAA-MM) por categoria e por cartão, e contas a pagar.", parameters: { type: "object", properties: { mes: { type: "string" } }, required: ["mes"] } } },
  { type: "function", function: { name: "propor_registro", description: "Propõe um registro para a Juliana revisar e confirmar no app (nada é salvo sem ela). Use uma chamada por registro.", parameters: { type: "object", properties: {
    tipo: { type: "string", enum: ["lancamento", "tarefa", "ideia_post", "diario", "meta", "item_lista", "salvar_imagem"] },
    campos: { type: "object", description: "Preencha só os campos do tipo escolhido.", properties: {
      valor: { type: "number" }, natureza: { type: "string", enum: ["despesa", "receita"] },
      categoria: { type: ["string", "null"], description: `lancamento: ${CATEGORIAS.join(" | ")}` },
      forma_pagamento: { type: ["string", "null"], description: `lancamento: ${FORMAS.join(" | ")}. Null se ela não disse. Nunca adivinhe.` },
      data: { type: "string", description: "AAAA-MM-DD" }, descricao: { type: "string" }, parcelas: { type: "number" },
      titulo: { type: "string", description: "tarefa, ideia_post ou meta" }, hora: { type: "string", description: "HH:MM" },
      prioridade: { type: "string", enum: ["alta", "normal", "baixa"] }, area: { type: "string" },
      nicho: { type: ["string", "null"], description: "Fashion | Beauty | Casa | Maternidade" },
      observacoes: { type: "string" }, humor: { type: ["string", "null"], description: HUMORES.join(" | ") }, gratidao: { type: "string" },
      prazo: { type: "string", description: "AAAA-MM-DD" },
      lista: { type: "string", enum: LISTAS }, item: { type: "string" }, preco: { type: "string" }, link: { type: "string" },
      nome: { type: "string", description: "salvar_imagem: nome curto" }, pasta: { type: "string", description: 'salvar_imagem: pasta do Obsidian (padrão "00 - Entrada")' },
    } },
  }, required: ["tipo", "campos"] } } },
];
async function chat(b: any) {
  const chave = Deno.env.get("OPENAI_API_KEY");
  if (!chave) throw new Erro("A IA não está configurada.");
  const historico = (Array.isArray(b.historico) ? b.historico : []).slice(-12)
    .filter((m: any) => ["user", "assistant"].includes(m.papel) && typeof m.texto === "string")
    .map((m: any) => ({ role: m.papel, content: m.texto.slice(0, 4000) }));
  const texto = String(b.texto ?? "").slice(0, 4000);
  const imagem = typeof b.imagem === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(b.imagem) && b.imagem.length < 6_000_000 ? b.imagem : null;
  if (!texto && !imagem) throw new Erro("Escreva uma mensagem.");
  const agora = agoraRecife();
  const sistema = `Você é o Segundo Cérebro da Juliana, dentro do app dela. Responda em português do Brasil, curto, caloroso e direto (no máximo 6 linhas, sem títulos).
Hoje é ${agora.data} (${agora.semana}), ${String(agora.hora).padStart(2, "0")}:${String(agora.minuto).padStart(2, "0")} em Recife.
- Para perguntas sobre a vida dela, documentos, saúde, pessoas, trabalho: use buscar_notas (e ler_nota se precisar) e responda SÓ com o que achou. Se não achar, diga que não encontrou. Nunca invente números, datas ou documentos.
- Para agenda use a ferramenta agenda ("essa semana" = de hoje até 6 dias depois; "amanhã" = o dia seguinte); para gastos use financeiro_mes.
- Quando ela pedir para anotar, lembrar, lançar, comprar, registrar ou mandar uma foto que deva ser guardada: use propor_registro (uma chamada por item, com os campos preenchidos) e diga que preparou para ela conferir em "Revisar e salvar". Nunca diga "anotei", "coloquei" ou "salvei".
- Gasto sem forma de pagamento ou categoria: proponha com null e pergunte. Pessoas da família: Nicolas (filho, bebê), Guy (marido).
- Foto de comprovante/nota fiscal: proponha o lancamento e também salvar_imagem. Foto de produto: proponha item_lista (wishlist) ou ideia_post, conforme o pedido.`;
  const msgs: any[] = [{ role: "system", content: sistema }, ...historico,
    { role: "user", content: imagem ? [{ type: "text", text: texto || "O que você vê nesta imagem? Sugira o que registrar." }, { type: "image_url", image_url: { url: imagem, detail: "low" } }] : texto }];
  const propostas: any[] = [];
  const fontes = new Map<string, string>();
  for (let volta = 0; volta < 6; volta++) {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${chave}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(40000),
      body: JSON.stringify({ model: Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini", temperature: 0.2, messages: msgs, tools: FERRAMENTAS }),
    });
    const j = await r.json();
    if (!r.ok) throw new Erro("A IA não respondeu agora. Tente de novo.", 502);
    const m = j.choices[0].message;
    msgs.push(m);
    if (!m.tool_calls?.length) {
      return { resposta: m.content ?? "", propostas, fontes: [...fontes].map(([caminho, titulo]) => ({ caminho, titulo })) };
    }
    for (const c of m.tool_calls) {
      let a: any = {}; try { a = JSON.parse(c.function.arguments || "{}"); } catch { /* */ }
      let saida: unknown;
      try {
        if (c.function.name === "buscar_notas") {
          const { data } = await db.rpc("buscar_cerebro", { termo: String(a.consulta ?? "").slice(0, 200), limite: 6 });
          saida = (data ?? []).filter((x: any) => x.caminho && !x.caminho.startsWith("05 - Sistema/")).map((x: any) => ({ titulo: x.titulo, caminho: x.caminho, trecho: String(x.trecho ?? "").slice(0, 700), propriedades: x.propriedades }));
        } else if (c.function.name === "ler_nota") {
          const { data } = await db.from("notas").select("titulo, caminho, conteudo, propriedades").eq("caminho", String(a.caminho ?? "")).maybeSingle();
          if (data) { fontes.set(data.caminho, data.titulo); saida = { ...data, conteudo: String(data.conteudo).slice(0, 6000) }; } else saida = { erro: "nota não encontrada" };
        } else if (c.function.name === "agenda") {
          const de = dataOk(a.de) ?? agora.data, ate = dataOk(a.ate) ?? de;
          const ag = await agenda(de, ate);
          saida = { itens: ag.itens.map((i) => ({ titulo: i.titulo, dia: i.dia, hora: i.hora, feito: i.feito, pessoa: i.pessoa, area: i.area })), atrasadas: ag.atrasadas.length };
        } else if (c.function.name === "financeiro_mes") {
          const f = await financeiro(/^\d{4}-\d{2}$/.test(a.mes ?? "") ? a.mes : agora.data.slice(0, 7));
          saida = { mes: f.mes, total_despesas: f.total_despesas, total_receitas: f.total_receitas, por_categoria: f.por_categoria, por_cartao: f.por_cartao, contas: f.contas };
        } else if (c.function.name === "propor_registro") {
          const { tipo, campos, ...resto } = a;
          const cs = campos && Object.keys(campos).length ? campos : resto;
          const limpos = Object.fromEntries(Object.entries(cs ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== "" && String(v).toLowerCase() !== "null"));
          if (propostas.length < 8) propostas.push({ tipo: String(tipo), campos: limpos });
          saida = { ok: true, aviso: "Proposta mostrada para a Juliana confirmar. Ainda NÃO foi salva." };
        } else saida = { erro: "ferramenta desconhecida" };
      } catch (e) { saida = { erro: String((e as Error).message ?? e) }; }
      // notas encontradas na busca também viram fontes quando a resposta citar
      if (c.function.name === "buscar_notas" && Array.isArray(saida)) for (const x of (saida as any[]).slice(0, 2)) fontes.set(x.caminho, x.titulo);
      msgs.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(saida).slice(0, 12000) });
    }
  }
  return { resposta: "Precisei de mais tempo do que o normal. Pode reformular a pergunta?", propostas, fontes: [] };
}
async function salvarImagem(b: any) {
  const m = String(b.imagem ?? "").match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
  if (!m) throw new Erro("imagem inválida");
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  if (bytes.length > 10 * 1024 * 1024) throw new Erro("Imagem grande demais (máx. 10 MB).");
  const ext = m[1] === "jpeg" ? "jpg" : m[1];
  let pasta = String(b.pasta ?? "00 - Entrada").trim().replace(/^\/+|\/+$/g, "") || "00 - Entrada";
  if (/(\\|\.\.|\/\/|[<>:"|?*\x00-\x1f])/.test(pasta) || pasta.startsWith("05 - Sistema") || pasta.split("/").some((x) => x.startsWith("."))) pasta = "00 - Entrada";
  const nome = limparNome(String(b.nome ?? "")) || `Imagem ${hoje()}`;
  const usuario = await usuarioId();
  const objeto = `${usuario}/${crypto.randomUUID()}.${ext}`;
  const { error } = await db.storage.from("vault-imagens").upload(objeto, bytes, { contentType: `image/${m[1]}`, upsert: false });
  if (error) throw new Erro("Não consegui guardar a imagem.", 500);
  const caminho = `${pasta}/${nome}.${ext}`;
  const { error: e2 } = await db.from("pedidos_vault").insert({ usuario_id: usuario, caminho, acao: "imagem", conteudo: "", origem: ORIGEM, dados: { objeto, tamanho: bytes.length } });
  if (e2) throw new Erro(e2.message, 500);
  return { ok: true, caminho };
}

// ---------------- notificações ----------------
function configurarPush() {
  webpush.setVapidDetails("mailto:app@segundo-cerebro.invalid", Deno.env.get("APP_VAPID_PUBLIC")!, Deno.env.get("APP_VAPID_PRIVATE")!);
}
async function enviarPush(titulo: string, corpo: string, url = "/", tag?: string) {
  configurarPush();
  const { data: subs } = await db.from("app_push").select("endpoint, assinatura, falhas");
  let ok = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification(s.assinatura, JSON.stringify({ titulo, corpo, url, tag }), { TTL: 3600 });
      ok++;
    } catch (e: any) {
      const st = e?.statusCode;
      if (st === 404 || st === 410 || (s.falhas ?? 0) >= 5) await db.from("app_push").delete().eq("endpoint", s.endpoint);
      else await db.from("app_push").update({ falhas: (s.falhas ?? 0) + 1 }).eq("endpoint", s.endpoint);
    }
  }
  return ok;
}
async function umaVez(chave: string, fn: () => Promise<unknown>) {
  const { error } = await db.from("app_notificacoes").insert({ chave });
  if (error) return false; // já enviada
  await fn();
  return true;
}
const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const minutos = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

async function rodarNotificacoes() {
  await enviarFila().catch((e) => console.error(e));
  const { count } = await db.from("app_push").select("endpoint", { count: "exact", head: true });
  if (!count) return { enviadas: 0, motivo: "nenhum aparelho" };
  const agora = agoraRecife();
  const min = agora.hora * 60 + agora.minuto;
  const d = agora.data;
  const feitas: string[] = [];
  const janela = (alvo: number, dur = 60) => min >= alvo && min < alvo + dur;

  // 1) resumo da manhã às 7h (+ avisos e prazos)
  if (janela(7 * 60, 120)) {
    await umaVez(`resumo:${d}`, async () => {
      const t = await telaHoje();
      const comp = t.agenda.filter((i: Item) => !i.feito);
      const contas = t.financeiro.contas;
      const partes = [
        comp.length ? `${comp.length} na agenda${comp[0] ? ` (${comp[0].hora ? comp[0].hora + " " : ""}${comp[0].titulo})` : ""}` : "agenda livre",
        t.total_atrasadas ? `${t.total_atrasadas} atrasada(s)` : "",
        contas.length ? `${contas.length} conta(s) vencendo` : "",
        t.afiloop.ofertas.length ? `${t.afiloop.ofertas.length} oferta(s) em destaque` : "",
      ].filter(Boolean);
      await enviarPush("☀️ Bom dia, Juliana", partes.join(" · "), "/#hoje", "resumo");
      feitas.push("resumo");
    });
  }
  // 2) compromissos com hora: 30 min antes
  const ag = await agenda(d, d);
  for (const i of ag.itens) {
    if (i.feito || !i.hora) continue;
    const ini = minutos(i.hora);
    if (min >= ini - 30 && min < ini) {
      await umaVez(`comp:${i.caminho}:${d}`, () => enviarPush(`⏰ ${i.hora} · ${i.titulo}`, `Começa em ${ini - min} min`, "/#agenda", "comp"));
      feitas.push("comp");
    }
  }
  // 3) tarefas do dia ainda abertas, fim da tarde (17h30)
  if (janela(17 * 60 + 30)) {
    const abertas = ag.itens.filter((i) => !i.feito && !i.hora && i.origem !== "prazo");
    if (abertas.length) await umaVez(`tarde:${d}`, () => enviarPush("✅ Tarefas de hoje em aberto", abertas.slice(0, 4).map((i) => i.titulo).join(" · "), "/#agenda", "tarde"));
  }
  // 4) contas: no dia anterior ao vencimento (9h)
  if (janela(9 * 60)) {
    const fin = await financeiro(d.slice(0, 7));
    for (const c of fin.contas.filter((c) => c.vencimento === somaDias(d, 1))) {
      await umaVez(`conta:${c.caminho}:${c.vencimento}`, () => enviarPush("💳 Conta vence amanhã", `${c.titulo}${c.valor ? " · " + brl(c.valor) : ""}`, "/#financeiro", "conta"));
    }
  }
  // 7) diário às 21h30, só se ainda não preenchido
  if (janela(21 * 60 + 30)) {
    const di = await dia(d);
    const preenchido = di.humor || Object.values(di.journal).some((x) => x.length);
    if (!preenchido) await umaVez(`diario:${d}`, () => enviarPush("📔 Como foi o seu dia?", "Registre o humor e escreva um pouquinho no journal.", "/#eu", "diario"));
  }
  // 10) novidades no pack do Telegram (de 8h às 21h)
  const nov = await config<{ novos: number; desde?: string }>("tg_pack_novidades");
  if (nov?.novos && nov.desde && min >= 8 * 60 && min <= 21 * 60) {
    await umaVez(`pack:${nov.desde.slice(0, 13)}`, () => enviarPush("📦 Novidades no pack", `${nov.novos} vídeo(s) ou carrossel(éis) novo(s), com os links já trocados pelos seus.`, "/#afiloop", "pack"));
  }
  // 9) sincronização parada há mais de 12 h com coisas na fila
  const s = await sincronizacao();
  const parado = s.ultima_aplicacao && Date.now() - new Date(s.ultima_aplicacao).getTime() > 12 * 3600e3;
  if (parado && (s.pendentes_ponte > 0 || s.pendentes_app > 0) && janela(10 * 60, 600)) {
    await umaVez(`sync:${d}`, () => enviarPush("⏳ Obsidian sem sincronizar", "Abra o Obsidian no computador principal para aplicar as mudanças da fila.", "/#hoje", "sync"));
  }
  await db.from("app_notificacoes").delete().lt("enviado_em", new Date(Date.now() - 40 * 86400e3).toISOString());
  return { enviadas: feitas.length, agora };
}

// ---------------- roteamento ----------------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-app-cron",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const rota = url.pathname.replace(/^.*\/app-api/, "") || "/";
  try {
    const b = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const q = (k: string) => url.searchParams.get(k);

    // ---- tarefas agendadas (pg_cron) ----
    if (rota === "/cron") {
      if (req.headers.get("x-app-cron") !== Deno.env.get("APP_CRON_SECRET")) throw new Erro("não autorizado", 401);
      return json(await rodarNotificacoes());
    }

    // ---- acesso ----
    if (rota === "/estado") {
      const { count } = await db.from("app_passkeys").select("id", { count: "exact", head: true });
      return json({ configurado: (count ?? 0) > 0 || !!(await config("pin")), tem_passkey: (count ?? 0) > 0, vapid: Deno.env.get("APP_VAPID_PUBLIC") });
    }
    if (rota === "/setup/opcoes") {
      if (!b.codigo || b.codigo !== Deno.env.get("APP_SETUP_CODE")) throw new Erro("Código de primeiro acesso incorreto.", 403);
      if (await config("setup_usado")) throw new Erro("O primeiro acesso já foi feito. Entre com Face ID ou PIN.", 403);
      const { rpID } = rp(req);
      const op = await generateRegistrationOptions({
        rpName: "Segundo Cérebro", rpID, userName: "juliana", userDisplayName: "Juliana", attestationType: "none",
        authenticatorSelection: { residentKey: "preferred", userVerification: "required", authenticatorAttachment: "platform" },
      });
      await guardarDesafio(op.challenge, "registro");
      return json(op);
    }
    if (rota === "/setup/concluir") {
      if (!b.codigo || b.codigo !== Deno.env.get("APP_SETUP_CODE")) throw new Erro("Código de primeiro acesso incorreto.", 403);
      if (await config("setup_usado")) throw new Erro("O primeiro acesso já foi feito.", 403);
      if (!/^\d{4,6}$/.test(String(b.pin ?? ""))) throw new Erro("O PIN precisa ter de 4 a 6 números.");
      const { origin, rpID } = rp(req);
      if (b.resposta) {
        const desafio = desafioDaResposta(b.resposta);
        await usarDesafio(desafio, "registro");
        const v = await verifyRegistrationResponse({ response: b.resposta, expectedChallenge: desafio, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
        if (!v.verified || !v.registrationInfo) throw new Erro("Não consegui confirmar o Face ID.");
        const c = v.registrationInfo.credential;
        await db.from("app_passkeys").insert({ id: c.id, chave_publica: b64url(c.publicKey), contador: c.counter, transports: c.transports ?? null });
      }
      const sal = b64url(crypto.getRandomValues(new Uint8Array(16)));
      await setConfig("pin", { sal, hash: await hashPin(String(b.pin), sal) });
      await setConfig("setup_usado", true);
      return json(await novaSessao(b.resposta ? "passkey" : "pin"));
    }
    if (rota === "/login/opcoes") {
      const { rpID } = rp(req);
      const { data: chaves } = await db.from("app_passkeys").select("id, transports");
      const op = await generateAuthenticationOptions({ rpID, userVerification: "required", allowCredentials: (chaves ?? []).map((c) => ({ id: c.id, transports: c.transports ?? undefined })) });
      await guardarDesafio(op.challenge, "login");
      return json(op);
    }
    if (rota === "/login/passkey") {
      const { origin, rpID } = rp(req);
      const desafio = desafioDaResposta(b.resposta);
      await usarDesafio(desafio, "login");
      const { data: c } = await db.from("app_passkeys").select("*").eq("id", b.resposta?.id).maybeSingle();
      if (!c) throw new Erro("Face ID não reconhecido neste app.", 401);
      const v = await verifyAuthenticationResponse({
        response: b.resposta, expectedChallenge: desafio, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: c.id, publicKey: deB64url(c.chave_publica), counter: Number(c.contador), transports: c.transports ?? undefined },
      });
      if (!v.verified) throw new Erro("Face ID não confirmado.", 401);
      await db.from("app_passkeys").update({ contador: v.authenticationInfo.newCounter, usado_em: new Date().toISOString() }).eq("id", c.id);
      return json(await novaSessao("passkey"));
    }
    if (rota === "/login/pin") {
      const f = await pinBloqueado();
      const pin = await config<{ sal: string; hash: string }>("pin");
      if (!pin) throw new Erro("PIN não configurado.", 400);
      if ((await hashPin(String(b.pin ?? ""), pin.sal)) !== pin.hash) {
        const n = (f.n ?? 0) + 1;
        await setConfig("pin_falhas", n >= 5 ? { n: 0, ate: new Date(Date.now() + 15 * 60e3).toISOString() } : { n });
        throw new Erro(n >= 5 ? "PIN incorreto. Bloqueado por 15 minutos." : "PIN incorreto.", 401);
      }
      await setConfig("pin_falhas", { n: 0 });
      return json(await novaSessao("pin"));
    }

    // ---- daqui para baixo, só com sessão ----
    await exigirSessao(req);
    switch (rota) {
      case "/hoje": return json(await telaHoje());
      case "/agenda": {
        const de = dataOk(q("de")) ?? hoje();
        return json(await agenda(de, dataOk(q("ate")) ?? somaDias(de, 6)));
      }
      case "/financeiro": return json(await financeiro(/^\d{4}-\d{2}$/.test(q("mes") ?? "") ? q("mes")! : hoje().slice(0, 7)));
      case "/dia": return json(await dia(dataOk(q("data")) ?? hoje()));
      case "/humor-mes": return json(await humorMes(/^\d{4}-\d{2}$/.test(q("mes") ?? "") ? q("mes")! : hoje().slice(0, 7)));
      case "/metas": return json(await metas());
      case "/habitos": {
        const de = dataOk(q("de")) ?? somaDias(hoje(), -34);
        return json(await habitosPeriodo(de, dataOk(q("ate")) ?? hoje()));
      }
      case "/sync": return json(await sincronizacao());
      case "/buscar": {
        const termo = (q("q") ?? "").slice(0, 200);
        const { data, error } = await db.rpc("buscar_cerebro", { termo, limite: 40 });
        if (error) throw new Erro(error.message, 500);
        return json((data ?? []).filter((r: any) => r.caminho && !r.caminho.startsWith("05 - Sistema/")).map((r: any) => ({
          caminho: r.caminho, titulo: r.titulo, trecho: String(r.trecho ?? "").replace(/^---[\s\S]*?---/, "").replace(/[#>*`\[\]]/g, "").slice(0, 160), tipo: r.propriedades?.tipo ?? null,
        })));
      }
      case "/perguntar": {
        const pergunta = String(b.pergunta ?? "").trim().slice(0, 500);
        if (!pergunta) throw new Erro("Escreva a pergunta.");
        const chave = Deno.env.get("OPENAI_API_KEY");
        if (!chave) throw new Erro("A IA não está configurada.");
        // 1) a IA tira as palavras-chave; 2) busca nas notas; 3) responde só com o que achou
        const ia = async (msgs: unknown[], formato?: object) => {
          const r = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST", headers: { Authorization: `Bearer ${chave}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(25000),
            body: JSON.stringify({ model: Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini", temperature: 0, messages: msgs, ...(formato ? { response_format: formato } : {}) }),
          });
          const j = await r.json();
          if (!r.ok) throw new Erro("A IA não respondeu agora. Tente de novo.", 502);
          return j.choices[0].message.content as string;
        };
        const kw = JSON.parse(await ia([{ role: "system", content: 'Extraia de 1 a 3 buscas curtas (2-4 palavras, em português, sem acentos opcionais) para achar a resposta em notas pessoais. Responda JSON {"buscas":[...]}' },
          { role: "user", content: pergunta }], { type: "json_object" })).buscas as string[];
        const vistos = new Map<string, any>();
        for (const termo of [...(kw ?? []).slice(0, 3), pergunta]) {
          const { data } = await db.rpc("buscar_cerebro", { termo, limite: 6 });
          for (const r of data ?? []) if (r.caminho && !r.caminho.startsWith("05 - Sistema/") && !vistos.has(r.caminho)) vistos.set(r.caminho, r);
        }
        const caminhos = [...vistos.keys()].slice(0, 8);
        if (!caminhos.length) return json({ resposta: "Não achei nada sobre isso nas suas notas.", fontes: [] });
        const { data: notas } = await db.from("notas").select("caminho, titulo, conteudo, propriedades").in("caminho", caminhos);
        const contexto = (notas ?? []).map((n: any, i: number) => `[${i + 1}] ${n.titulo} (${n.caminho})\nPropriedades: ${JSON.stringify(n.propriedades)}\n${String(n.conteudo).slice(0, 3500)}`).join("\n\n---\n\n");
        const resp = JSON.parse(await ia([
          { role: "system", content: `Você é o Segundo Cérebro da Juliana. Responda em português, curto e direto, usando SÓ as notas abaixo. Se a resposta não estiver nas notas, diga que não encontrou. Nunca invente números ou datas. Hoje é ${hoje()}. Responda JSON {"resposta": "...", "fontes": [números das notas usadas]}.\n\nNOTAS:\n${contexto}` },
          { role: "user", content: pergunta }], { type: "json_object" }));
        const fontes = (resp.fontes ?? []).map((i: number) => notas?.[i - 1]).filter(Boolean).map((n: any) => ({ caminho: n.caminho, titulo: n.titulo }));
        return json({ resposta: resp.resposta, fontes });
      }
      case "/pasta": {
        const pref = (q("p") ?? "").replace(/^\/+|\/+$/g, "");
        const notas = await lerNotas((qq) => pref ? qq.like("caminho", `${pref}/%`) : qq);
        const subpastas = new Map<string, number>(); const arquivos: any[] = [];
        for (const n of notas) {
          if (n.caminho.startsWith("05 - Sistema/")) continue;
          const resto = pref ? n.caminho.slice(pref.length + 1) : n.caminho;
          const partes = resto.split("/");
          if (partes.length > 1) subpastas.set(partes[0], (subpastas.get(partes[0]) ?? 0) + 1);
          else arquivos.push({ caminho: n.caminho, titulo: n.titulo, tipo: n.propriedades?.tipo ?? null });
        }
        return json({ pasta: pref, subpastas: [...subpastas].map(([nome, total]) => ({ nome, total })).sort((a, b) => a.nome.localeCompare(b.nome, "pt")),
          notas: arquivos.sort((a, b) => a.titulo.localeCompare(b.titulo, "pt")) });
      }
      case "/nota": {
        const cam = q("c") ?? "";
        const t = q("t");
        let { data } = await db.from("notas").select("caminho, titulo, conteudo, propriedades, modificado_em").eq("caminho", cam).maybeSingle();
        if (!data && t) ({ data } = await db.from("notas").select("caminho, titulo, conteudo, propriedades, modificado_em").eq("titulo", t).limit(1).maybeSingle());
        if (!data) throw new Erro("Nota não encontrada (pode ser privada ou ainda não sincronizou).", 404);
        return json(data);
      }
      case "/chat": return json(await chat(b));
      case "/imagem/salvar": return json(await salvarImagem(b));
      case "/listas": return json(await listas());
      case "/lista/item": return json(await itemLista(b));
      case "/saude": return json(await saude(q("p") ?? "Juliana"));
      case "/juridico": return json(await juridico());
      case "/midia": return json(await midia());
      case "/midia/atualizar": return json(await atualizarMidia(b));
      case "/afiloop/ofertas": {
        const { data } = await db.from("afiloop_ofertas").select("id, nome, preco, comissao_pct, comissao_valor, vendas, nota, link_afiliado, imagem_url, nicho, preco_conferido_em, status")
          .neq("status", "descartada").order("comissao_valor", { ascending: false }).limit(40);
        return json(data ?? []);
      }
      case "/afiloop/biblioteca": return json(await bibliotecaPack(q));
      case "/afiloop/biblioteca/estrela": return json(await estrelaPack(b));
      case "/afiloop/fila": return json(await filaAfiloop());
      case "/afiloop/fila/acao": return json(await acaoFila(b));
      case "/afiloop/fila/editar": return json(await editarFila(b));
      case "/dia/salvar": return json(await salvarDia(b));
      case "/tarefa/atualizar": return json(await atualizarTarefa(b));
      case "/tarefa/criar": return json(await criarTarefa(b));
      case "/lancamento/criar": return json(await criarLancamento(b));
      case "/conta/paga": return json(await contaPaga(b));
      case "/meta/criar": return json(await criarMeta(b));
      case "/meta/atualizar": return json(await atualizarMeta(b));
      case "/ideia/criar": return json(await criarIdeiaPost(b));
      case "/captura/interpretar": return json(await interpretar(String(b.texto ?? "")));
      case "/push/assinar": {
        if (!b.assinatura?.endpoint) throw new Erro("assinatura inválida");
        await db.from("app_push").upsert({ endpoint: b.assinatura.endpoint, assinatura: b.assinatura, falhas: 0 });
        return json({ ok: true });
      }
      case "/push/testar": return json({ enviadas: await enviarPush("🔔 Notificações ligadas", "É assim que o Segundo Cérebro vai te avisar.", "/#hoje", "teste") });
      case "/sair": {
        const t = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
        await db.from("app_sessoes").delete().eq("token_hash", await sha256(t));
        return json({ ok: true });
      }
    }
    throw new Erro("rota não encontrada", 404);
  } catch (e) {
    const st = e instanceof Erro ? e.status : 500;
    if (st === 500) console.error(e);
    return json({ erro: e instanceof Erro ? e.message : "Erro inesperado. Tente de novo." }, st);
  }
});
