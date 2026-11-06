// Testa as ferramentas de edição (editar_nota, atualizar_tarefa, mover_nota, excluir_nota, ver_alteracoes)
// contra o servidor publicado, SOMENTE com dados fictícios: cria 2 usuárias de teste temporárias,
// grava notas fictícias no espelho delas e apaga tudo no final (cascade).
// A chave secreta é usada só para criar/apagar as usuárias de teste e nunca é impressa.
import { createHash, randomBytes } from "node:crypto";
import { project, keys } from "./sb.mjs";

const CHATGPT = { id: "944323a9-269c-4468-bdf0-01ea7e4b9613", redirect: "https://chatgpt.com/connector/oauth/Ap5ThNutJV7N" };

const p = await project();
const MCP = `${p.url}/functions/v1/cerebro-mcp`;
const AUTH = `${p.url}/auth/v1`;
const REST = `${p.url}/rest/v1`;
const k = await keys(p.ref, true);

let ok = 0, falhas = 0;
const check = (nome, cond, extra = "") => {
  if (cond) { ok++; console.log(`  ✔ ${nome}`); } else { falhas++; console.log(`  ✘ ${nome} ${String(extra).slice(0, 300)}`); }
};
const rpc = async (token, method, params = {}) => {
  const r = await fetch(MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18",
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const t = await r.text(); let body; try { body = JSON.parse(t); } catch { body = t; }
  return { status: r.status, body };
};
const tool = async (token, name, args) => {
  const r = await rpc(token, "tools/call", { name, arguments: args });
  const res = r.body?.result ?? {};
  return { status: r.status, erro: Boolean(res.isError), texto: res.content?.[0]?.text ?? JSON.stringify(r.body) };
};
const admin = (path, opts = {}) => fetch(`${AUTH}${path}`, { ...opts,
  headers: { apikey: k.secret, Authorization: `Bearer ${k.secret}`, "Content-Type": "application/json", ...(opts.headers ?? {}) } });
const rest = (token, path, opts = {}) => fetch(`${REST}/${path}`, { ...opts,
  headers: { apikey: k.publishable, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers ?? {}) } });

const sufixo = randomBytes(4).toString("hex");
const criadas = [];
const usuariasCriadas = [];
async function usuaria(nome) {
  const email = `teste-edicao-${nome}-${sufixo}@example.com`;
  const password = randomBytes(18).toString("base64url");
  const r = await admin("/admin/users", { method: "POST", body: JSON.stringify({ email, password, email_confirm: true }) });
  const u = await r.json(); if (!r.ok) throw new Error("criar usuária de teste: " + r.status);
  criadas.push(u.id);
  const s = await fetch(`${AUTH}/token?grant_type=password`, { method: "POST",
    headers: { apikey: k.publishable, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) }).then((x) => x.json());
  // O servidor só aceita tokens dos apps autorizados: a usuária de teste faz o mesmo login OAuth (PKCE)
  // que o ChatGPT faz. O código é lido da resposta do consentimento; nada é enviado ao ChatGPT.
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authz = new URL(`${AUTH}/oauth/authorize`);
  Object.entries({ response_type: "code", client_id: CHATGPT.id, redirect_uri: CHATGPT.redirect, code_challenge: challenge,
    code_challenge_method: "S256", state: "teste", resource: MCP }).forEach(([a, b]) => authz.searchParams.set(a, b));
  const loc = (await fetch(authz, { redirect: "manual" })).headers.get("location") ?? "";
  const authorizationId = new URL(loc, p.url).searchParams.get("authorization_id");
  await fetch(`${AUTH}/oauth/authorizations/${authorizationId}`, { headers: { apikey: k.publishable, Authorization: `Bearer ${s.access_token}` } });
  const cons = await fetch(`${AUTH}/oauth/authorizations/${authorizationId}/consent`, { method: "POST",
    headers: { apikey: k.publishable, Authorization: `Bearer ${s.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "approve" }) }).then((x) => x.json());
  if (!cons.redirect_url) throw new Error("consentimento: " + JSON.stringify(cons).slice(0, 200) + " loc=" + loc.slice(0, 120));
  const code = new URL(cons.redirect_url).searchParams.get("code");
  const tok = await fetch(`${AUTH}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CHATGPT.redirect, client_id: CHATGPT.id, code_verifier: verifier }) }).then((x) => x.json());
  if (!tok.access_token) throw new Error("login OAuth de teste falhou");
  const U = { id: u.id, token: tok.access_token };
  usuariasCriadas.push(U);
  return U;
}
async function nota(U, caminho, conteudo, propriedades, hash) {
  const r = await rest(U.token, "notas", { method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ usuario_id: U.id, caminho, titulo: caminho.split("/").pop().replace(/\.md$/, ""), conteudo, propriedades, hash }) });
  const j = await r.json(); if (!r.ok) throw new Error("nota fictícia: " + JSON.stringify(j).slice(0, 200));
  return j[0];
}
const pedidos = async (U, caminho) => (await rest(U.token, `pedidos_vault?select=acao,caminho,destino,dados,base_hash,conteudo,aplicado_em&caminho=eq.${encodeURIComponent(caminho)}&order=criado_em`)).json();
// simula o plugin aplicando o pedido (para liberar a nota para o próximo teste)
const aplicar = (U, caminho) => rest(U.token, `pedidos_vault?caminho=eq.${encodeURIComponent(caminho)}&aplicado_em=is.null`,
  { method: "PATCH", body: JSON.stringify({ aplicado_em: new Date().toISOString(), resultado: "teste" }) });

try {
  const A = await usuaria("a");
  const B = await usuaria("b");

  console.log("\n1) Ferramentas publicadas");
  const lista = await rpc(A.token, "tools/list");
  const nomes = (lista.body.result?.tools ?? []).map((t) => t.name);
  for (const n of ["buscar", "ler", "datas", "salvar_memoria", "criar_nota", "search", "fetch", "editar_nota", "atualizar_tarefa", "mover_nota", "excluir_nota", "ver_alteracoes"]) {
    check(`ferramenta ${n}`, nomes.includes(n), nomes.join(","));
  }
  check("sem token → 401", (await rpc(null, "tools/call", { name: "editar_nota", arguments: { caminho: "a.md" } })).status === 401);

  const MAQ = "01 - Vida/Casa/🧪 Máquina de lavar fictícia.md";
  const TAR = "01 - Vida/Casa/🧪 Pagar funcionárias fictícias.md";
  const CONTA = "06 - Financeiro/🧪 Conta de luz fictícia.md";
  const LST = "00 - Entrada/🧪 Checklist fictício.md";
  const DUP = "00 - Entrada/🧪 Nota duplicada fictícia.md";
  const nMaq = await nota(A, MAQ, "Garantia até março.", { tipo: "equipamento", ultima_manutencao: "2025-01-10" }, "h-maq-1");
  await nota(A, TAR, "Pagar.", { tipo: "tarefa", status: "pendente", prazo: "2026-11-10" }, "h-tar-1");
  await nota(A, CONTA, "Luz.", { tipo: "lancamento", status: "pendente" }, "h-conta-1");
  await nota(A, LST, "- [ ] Comprar ração\n- [ ] Pagar luz\n- [x] Ligar pro banco", { tipo: "teste" }, "h-lst-1");
  await nota(A, DUP, "duplicada", { tipo: "teste" }, "h-dup-1");

  console.log("\n2) ler devolve a versão; editar_nota");
  const lido = await tool(A.token, "ler", { id: `nota:${nMaq.id}` });
  check("ler traz 'versao'", JSON.parse(lido.texto).versao === "h-maq-1", lido.texto);
  let r = await tool(A.token, "editar_nota", { caminho: MAQ, versao: "h-maq-1", propriedades: { ultima_manutencao: "2026-11-05" } });
  check("editar propriedade registra pedido", !r.erro && /ultima_manutencao = "2026-11-05"/.test(r.texto), r.texto);
  let ps = await pedidos(A, MAQ);
  check("pedido 'editar' com só a propriedade (sem reescrever a nota)", ps.length === 1 && ps[0].acao === "editar" && ps[0].conteudo === "" && ps[0].dados?.propriedades?.ultima_manutencao === "2026-11-05" && ps[0].base_hash === "h-maq-1", JSON.stringify(ps));
  r = await tool(A.token, "editar_nota", { caminho: MAQ, propriedades: { marca: "X" } });
  check("2ª alteração simultânea na mesma nota é recusada", r.erro && /pendente/.test(r.texto), r.texto);
  await aplicar(A, MAQ);
  r = await tool(A.token, "editar_nota", { caminho: MAQ, versao: "versao-velha", propriedades: { marca: "X" } });
  check("versão antiga é recusada", r.erro && /mudou/.test(r.texto), r.texto);
  r = await tool(A.token, "editar_nota", { caminho: MAQ, trocar: [{ de: "abril", para: "maio" }] });
  check("trecho que não existe é recusado", r.erro && /0 vez/.test(r.texto), r.texto);
  r = await tool(A.token, "editar_nota", { caminho: "01 - Vida/Casa/🧪 Não existe.md", propriedades: { a: "b" } });
  check("nota inexistente: erro, nada criado", r.erro && /não encontrada/i.test(r.texto) && (await pedidos(A, "01 - Vida/Casa/🧪 Não existe.md")).length === 0, r.texto);
  for (const ruim of ["../fora.md", "/etc/passwd.md", ".obsidian/app.json", "05 - Sistema/⚙️ Configuração do Segundo Cérebro.md", "05 - Sistema/Backups/x.md", "a\\b.md", "nota.txt"]) {
    r = await tool(A.token, "editar_nota", { caminho: ruim, conteudo: "x" });
    check(`caminho recusado: ${ruim}`, r.erro, r.texto);
  }
  r = await tool(A.token, "editar_nota", { caminho: MAQ, propriedades: { "chave/ruim": 1 } });
  check("nome de propriedade inválido é recusado", r.erro, r.texto);
  r = await tool(B.token, "editar_nota", { caminho: MAQ, propriedades: { marca: "invasão" } });
  check("B não edita nota da A", r.erro && /não encontrada/i.test(r.texto), r.texto);

  console.log("\n3) atualizar_tarefa");
  r = await tool(A.token, "atualizar_tarefa", { caminho: TAR, concluida: true });
  ps = await pedidos(A, TAR);
  check("tarefa → feita (status, feita, concluida_em)", !r.erro && ps[0]?.acao === "tarefa" && ps[0].dados.propriedades.status === "feita" && ps[0].dados.propriedades.feita === true && /^\d{4}-\d{2}-\d{2}$/.test(ps[0].dados.propriedades.concluida_em), r.texto + JSON.stringify(ps));
  check("não criou tarefa nova", !/criar/.test(JSON.stringify(ps.map((x) => x.acao))));
  await aplicar(A, TAR);
  r = await tool(A.token, "atualizar_tarefa", { caminho: TAR, prazo: "2026-02-30" });
  check("data inválida é recusada", r.erro, r.texto);
  r = await tool(A.token, "atualizar_tarefa", { caminho: TAR, prazo: "2026-12-01", prioridade: "alta" });
  check("muda prazo e prioridade", !r.erro && /prazo = "2026-12-01"/.test(r.texto) && /prioridade = "alta"/.test(r.texto), r.texto);
  await aplicar(A, TAR);
  r = await tool(A.token, "atualizar_tarefa", { caminho: CONTA, concluida: true });
  ps = await pedidos(A, CONTA);
  check("conta → status pago", !r.erro && ps[0]?.dados?.propriedades?.status === "pago", r.texto);
  r = await tool(A.token, "atualizar_tarefa", { caminho: LST, item: "pagar luz", concluida: true });
  ps = await pedidos(A, LST);
  check("checklist: marca 1 item", !r.erro && ps[0]?.dados?.item === "pagar luz" && ps[0].dados.concluida === true, r.texto);
  await aplicar(A, LST);
  r = await tool(A.token, "atualizar_tarefa", { caminho: LST, item: "a", concluida: true });
  check("checklist ambíguo pede para escolher", r.erro && /itens/.test(r.texto), r.texto);
  r = await tool(A.token, "atualizar_tarefa", { caminho: MAQ, concluida: true });
  check("nota que não é tarefa é recusada", r.erro && /não é uma tarefa/.test(r.texto), r.texto);

  console.log("\n4) mover_nota");
  r = await tool(A.token, "mover_nota", { caminho: LST, destino: "04 - Projetos/Afiloop/" });
  ps = await pedidos(A, LST);
  check("mover para pasta mantém o nome", !r.erro && ps.at(-1)?.acao === "mover" && ps.at(-1).destino === "04 - Projetos/Afiloop/🧪 Checklist fictício.md", r.texto + JSON.stringify(ps.at(-1)));
  await aplicar(A, LST);
  r = await tool(A.token, "mover_nota", { caminho: DUP, destino: TAR });
  check("mover não sobrescreve nota existente", r.erro && /Já existe/.test(r.texto), r.texto);
  r = await tool(A.token, "mover_nota", { caminho: DUP, destino: "../../fora/" });
  check("mover para fora do Vault é recusado", r.erro, r.texto);

  console.log("\n5) excluir_nota (duas etapas)");
  r = await tool(A.token, "excluir_nota", { caminho: DUP });
  const codigo = r.texto.match(/confirmacao="(\d{6})"/)?.[1];
  check("1ª chamada não exclui e pede confirmação", !r.erro && /NADA FOI EXCLUÍDO/.test(r.texto) && codigo && (await pedidos(A, DUP)).length === 0, r.texto);
  r = await tool(A.token, "excluir_nota", { caminho: DUP, confirmacao: "000000" === codigo ? "111111" : "000000" });
  check("código errado é recusado", r.erro && (await pedidos(A, DUP)).length === 0, r.texto);
  r = await tool(B.token, "excluir_nota", { caminho: DUP, confirmacao: codigo });
  check("B não usa o código da A", r.erro, r.texto);
  r = await tool(A.token, "excluir_nota", { caminho: DUP, confirmacao: codigo });
  ps = await pedidos(A, DUP);
  check("2ª chamada com o código registra a exclusão", !r.erro && ps.length === 1 && ps[0].acao === "apagar", r.texto);
  await aplicar(A, DUP);
  r = await tool(A.token, "excluir_nota", { caminho: DUP, confirmacao: codigo });
  check("código não pode ser reutilizado", r.erro, r.texto);
  r = await tool(A.token, "apagar_nota", { caminho: TAR });
  check("nome antigo apagar_nota também exige confirmação", !r.erro && /NADA FOI EXCLUÍDO/.test(r.texto) && !(await pedidos(A, TAR)).some((x) => x.acao === "apagar"), r.texto);

  console.log("\n6) ver_alteracoes e compatibilidade");
  r = await tool(A.token, "ver_alteracoes", { limite: 20 });
  check("histórico lista as alterações sem conteúdo", !r.erro && /"acao": "mover"/.test(r.texto) && !/Garantia até/.test(r.texto), r.texto);
  check("recusas do servidor aparecem com o motivo", /recusadas_pelo_servidor/.test(r.texto) && /aparece 0 vez/.test(r.texto), r.texto.slice(-400));
  r = await tool(B.token, "ver_alteracoes", {});
  const vistoB = JSON.parse(r.texto.startsWith("{") ? r.texto : '{"alteracoes":[],"recusadas_pelo_servidor":[]}');
  console.log("    o que B vê:", JSON.stringify(vistoB).slice(0, 600));
  check("B não vê nenhuma alteração da A", vistoB.alteracoes.length === 0, r.texto);
  check("B só vê as próprias tentativas recusadas", vistoB.recusadas_pelo_servidor.every((x) => /não encontrada|inválido/i.test(x.motivo)), r.texto);
  r = await tool(A.token, "criar_nota", { caminho: "00 - Entrada/🧪 Nova fictícia.md", conteudo: "oi" });
  check("criar_nota continua funcionando", !r.erro && /Pedido registrado/.test(r.texto), r.texto);
  r = await tool(A.token, "buscar", { consulta: "Máquina de lavar fictícia" });
  check("buscar continua funcionando", !r.erro && /Máquina de lavar fictícia/.test(r.texto), r.texto);
  r = await tool(A.token, "fetch", { id: `nota:${nMaq.id}` });
  check("fetch (ChatGPT) traz caminho e versão", !r.erro && JSON.parse(r.texto).metadata?.versao === "h-maq-1", r.texto);

  console.log("\n8) salvar_imagem (imagem pública de teste, nota fictícia)");
  const IMGURL = "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png";
  const PECA = "04 - Projetos/Afiloop/👗 Peças/🧪 Vestido fictício.md";
  await nota(A, PECA, "Peça fictícia.", { tipo: "peca", loja: "Shein" }, "h-peca-1");
  r = await tool(A.token, "salvar_imagem", { url: IMGURL, nome: "🧪 Vestido fictício", nota: PECA });
  let pi = await (await rest(A.token, `pedidos_vault?select=acao,caminho,dados&acao=eq.imagem&order=criado_em`)).json();
  check("imagem por link: pedido criado e ligado à peça", !r.erro && pi.length === 1 && pi[0].caminho === "04 - Projetos/Afiloop/🖼️ Imagens/🧪 Vestido fictício.png" && pi[0].dados.nota === PECA && pi[0].dados.propriedade === "foto", r.texto + JSON.stringify(pi));
  const obj = pi[0]?.dados?.objeto ?? "";
  const baixa = (U) => fetch(`${p.url}/storage/v1/object/authenticated/vault-imagens/${obj}`, { headers: { apikey: k.publishable, Authorization: `Bearer ${U.token}` } });
  const ga = await baixa(A);
  check("a imagem guardada é da A e está na pasta dela", ga.ok && obj.startsWith(A.id + "/") && (await ga.arrayBuffer()).byteLength > 1000, String(ga.status));
  check("B não consegue baixar a imagem da A", !(await baixa(B)).ok);
  r = await tool(A.token, "salvar_imagem", { arquivo: { download_url: IMGURL, file_id: "file-teste" }, nome: "🧪 Arquivo enviado" });
  check("imagem enviada como arquivo (formato do ChatGPT)", !r.erro && /PNG/.test(r.texto), r.texto);
  for (const [desc, u] of [["http sem s", "http://www.google.com/x.png"], ["localhost", "https://localhost/x.png"], ["IP", "https://127.0.0.1/x.png"], ["rede interna", "https://servidor.internal/x.png"]]) {
    r = await tool(A.token, "salvar_imagem", { url: u });
    check(`link recusado: ${desc}`, r.erro, r.texto);
  }
  r = await tool(A.token, "salvar_imagem", { url: "https://www.example.com/" });
  check("página que não é imagem é recusada", r.erro && /não é uma imagem/.test(r.texto), r.texto);
  r = await tool(A.token, "salvar_imagem", { url: IMGURL, pasta: "05 - Sistema/Backups" });
  check("pasta protegida é recusada", r.erro, r.texto);
  r = await tool(A.token, "salvar_imagem", { url: IMGURL, pasta: "../fora" });
  check("pasta fora do Vault é recusada", r.erro, r.texto);
  r = await tool(B.token, "salvar_imagem", { url: IMGURL, nota: PECA });
  check("B não liga imagem na nota da A", r.erro && /não encontrada/i.test(r.texto), r.texto);
  const lista2 = await rpc(A.token, "tools/list");
  const t = (lista2.body.result?.tools ?? []).find((x) => x.name === "salvar_imagem");
  check("ChatGPT recebe o campo de arquivo (openai/fileParams)", JSON.stringify(t?._meta?.["openai/fileParams"]) === '["arquivo"]');
} catch (e) {
  falhas++; console.log("  ✘ erro inesperado:", e.message);
} finally {
  console.log("\n7) Limpeza");
  for (const U of usuariasCriadas) {
    const objs = await fetch(`${p.url}/storage/v1/object/list/vault-imagens`, { method: "POST",
      headers: { apikey: k.publishable, Authorization: `Bearer ${U.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prefix: U.id, limit: 100 }) }).then((x) => x.json()).catch(() => []);
    const nomes = (Array.isArray(objs) ? objs : []).map((o) => `${U.id}/${o.name}`);
    if (nomes.length) await fetch(`${p.url}/storage/v1/object/vault-imagens`, { method: "DELETE",
      headers: { apikey: k.publishable, Authorization: `Bearer ${U.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: nomes }) });
    console.log(`  imagens de teste apagadas: ${nomes.length}`);
  }
  for (const id of criadas) console.log("  usuária de teste removida:", (await admin(`/admin/users/${id}`, { method: "DELETE" })).ok);
}
console.log(`\nResultado: ${ok} ok, ${falhas} falha(s)`);
process.exit(falhas ? 1 : 0);
