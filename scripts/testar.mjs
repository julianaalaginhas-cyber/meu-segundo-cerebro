// Testes reais, ponta a ponta, contra o projeto na nuvem.
// Usa SOMENTE dados fictícios: cria 2 usuárias de teste temporárias e 1 app OAuth
// de teste, e apaga tudo no final (as memórias de teste somem junto, via cascade).
// A chave secreta é lida da API em memória, usada só para criar/apagar esses
// itens de teste, e nunca é impressa nem gravada.
import { createHash, randomBytes } from "node:crypto";
import { project, keys } from "./sb.mjs";

const p = await project();
const MCP = `${p.url}/functions/v1/cerebro-mcp`;
const AUTH = `${p.url}/auth/v1`;
const k = await keys(p.ref, true);
if (!k.publishable || !k.secret) throw new Error("Não consegui obter as chaves do projeto pela API.");

let ok = 0, falhas = 0;
const check = (nome, cond, extra = "") => {
  if (cond) { ok++; console.log(`  ✔ ${nome}`); } else { falhas++; console.log(`  ✘ ${nome} ${extra}`); }
};

const rpc = async (token, method, params = {}, id = 1) => {
  const r = await fetch(MCP, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const txt = await r.text();
  let body; try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: r.status, www: r.headers.get("www-authenticate"), body };
};
const admin = (path, opts = {}) => fetch(`${AUTH}${path}`, {
  ...opts,
  headers: { apikey: k.secret, Authorization: `Bearer ${k.secret}`, "Content-Type": "application/json", ...(opts.headers ?? {}) },
});

const sufixo = randomBytes(4).toString("hex");
const criados = { users: [], client: null };

async function criarUsuaria(nome) {
  const email = `teste-${nome}-${sufixo}@example.com`;
  const password = randomBytes(18).toString("base64url");
  const r = await admin("/admin/users", { method: "POST", body: JSON.stringify({ email, password, email_confirm: true }) });
  const u = await r.json();
  if (!r.ok) throw new Error(`criar usuária de teste: ${r.status} ${JSON.stringify(u).slice(0, 200)}`);
  criados.users.push(u.id);
  const s = await fetch(`${AUTH}/token?grant_type=password`, {
    method: "POST", headers: { apikey: k.publishable, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  }).then((x) => x.json());
  if (!s.access_token) throw new Error("login da usuária de teste falhou");
  return { id: u.id, email, token: s.access_token };
}

try {
  console.log("\n1) Descoberta pública (sem dados pessoais)");
  const prm = await fetch(`${MCP}/.well-known/oauth-protected-resource`).then((r) => r.json());
  check("metadados do recurso apontam para o Auth do Supabase", prm.authorization_servers?.[0] === AUTH, JSON.stringify(prm));
  const as = await fetch(`${p.url}/.well-known/oauth-authorization-server/auth/v1`);
  check("servidor OAuth do Supabase responde à descoberta", as.ok, String(as.status));

  console.log("\n2) Acesso NÃO autenticado é bloqueado");
  const semToken = await rpc(null, "tools/list");
  check("sem token → 401", semToken.status === 401, String(semToken.status));
  check("401 indica onde autenticar (WWW-Authenticate)", /resource_metadata=/.test(semToken.www ?? ""));
  const lixo = await rpc("abc.def.ghi", "tools/call", { name: "buscar", arguments: { consulta: "girafa" } });
  check("token falso → 401", lixo.status === 401, String(lixo.status));
  const anonKey = await rpc(k.publishable, "tools/list");
  check("chave pública sozinha não dá acesso → 401", anonKey.status === 401, String(anonKey.status));

  console.log("\n3) Acesso autenticado + isolamento entre usuárias (dados fictícios)");
  const A = await criarUsuaria("a");
  const B = await criarUsuaria("b");
  const init = await rpc(A.token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "teste", version: "1" } });
  check("initialize funciona com token válido", init.status === 200 && init.body.result?.serverInfo?.name === "meu-segundo-cerebro", JSON.stringify(init.body).slice(0, 200));
  const lista = await rpc(A.token, "tools/list");
  check("lista de ferramentas", lista.body.result?.tools?.some((t) => t.name === "buscar"));
  const salvar = await rpc(B.token, "tools/call", { name: "salvar_memoria", arguments: { titulo: "Segredo da B", conteudo: "O pinguim fictício da B se chama Zacarias.", categoria: "teste", fonte: "teste_automatico" } });
  check("B consegue salvar memória própria", salvar.body.result && !salvar.body.result.isError, JSON.stringify(salvar.body).slice(0, 200));
  const bVe = await rpc(B.token, "tools/call", { name: "buscar", arguments: { consulta: "pinguim" } });
  check("B encontra a própria memória", /Zacarias/.test(JSON.stringify(bVe.body)));
  const aVe = await rpc(A.token, "tools/call", { name: "buscar", arguments: { consulta: "pinguim Zacarias" } });
  check("A NÃO vê a memória da B", aVe.body.result && !/Zacarias/.test(JSON.stringify(aVe.body)), JSON.stringify(aVe.body).slice(0, 200));
  // nota sincronizada (como o plugin do Obsidian faz) — dados fictícios
  const nota = await fetch(`${p.url}/rest/v1/notas?on_conflict=usuario_id,caminho`, { method: "POST",
    headers: { apikey: k.publishable, Authorization: `Bearer ${A.token}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ usuario_id: A.id, caminho: "01 - Vida/Pessoas/Fulano Teste.md", titulo: "Fulano Teste", conteudo: "Pessoa fictícia de teste.",
      propriedades: { tipo: "pessoa", cpf: "000.000.000-00", proxima_consulta: new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10) }, hash: "teste" }]) });
  check("A sincroniza uma nota (como o plugin)", nota.ok, String(nota.status));
  const cpf = await rpc(A.token, "tools/call", { name: "buscar", arguments: { consulta: "Fulano cpf" } });
  check("A encontra o CPF fictício na nota", /000\.000\.000-00/.test(JSON.stringify(cpf.body)));
  const datas = await rpc(A.token, "tools/call", { name: "datas", arguments: { dias_a_frente: 30 } });
  check("ferramenta de datas acha a próxima consulta", /proxima_consulta/.test(JSON.stringify(datas.body)), JSON.stringify(datas.body).slice(0, 200));
  const bCpf = await rpc(B.token, "tools/call", { name: "buscar", arguments: { consulta: "Fulano cpf" } });
  check("B NÃO vê a nota da A", !/000\.000\.000-00/.test(JSON.stringify(bCpf.body)));
  const aAurora = await rpc(A.token, "tools/call", { name: "buscar", arguments: { consulta: "girafa" } });
  check("A NÃO vê a memória da Aurora (que é da dona do cérebro)", !/Aurora/.test(JSON.stringify(aAurora.body)));

  console.log("\n4) Fluxo OAuth completo (como o Claude/ChatGPT fazem), com app de teste");
  const redirect = "http://localhost:53682/callback";
  const cr = await admin("/admin/oauth/clients", { method: "POST", body: JSON.stringify({ client_name: `Teste automático ${sufixo}`, redirect_uris: [redirect], token_endpoint_auth_method: "none" }) });
  const client = await cr.json();
  check("app OAuth de teste criado", cr.ok && client.client_id, JSON.stringify(client).slice(0, 200));
  criados.client = client.client_id;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(8).toString("hex");
  const authz = new URL(`${AUTH}/oauth/authorize`);
  Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state, resource: MCP }).forEach(([a, b]) => authz.searchParams.set(a, b));
  const r1 = await fetch(authz, { redirect: "manual" });
  const loc = r1.headers.get("location") ?? "";
  const authorizationId = loc ? new URL(loc, p.url).searchParams.get("authorization_id") : null;
  check("authorize redireciona para a página de consentimento", Boolean(authorizationId), `${r1.status} ${loc.slice(0, 120)}`);
  if (authorizationId) {
    console.log("    página de consentimento configurada:", new URL(loc, p.url).origin + new URL(loc, p.url).pathname);
    const det = await fetch(`${AUTH}/oauth/authorizations/${authorizationId}`, { headers: { apikey: k.publishable, Authorization: `Bearer ${A.token}` } }).then((r) => r.json());
    check("detalhes da autorização legíveis pela usuária logada", det.client?.client_id === client.client_id || det.authorization_id === authorizationId, JSON.stringify(det).slice(0, 200));
    const cons = await fetch(`${AUTH}/oauth/authorizations/${authorizationId}/consent`, { method: "POST", headers: { apikey: k.publishable, Authorization: `Bearer ${A.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve" }) }).then((r) => r.json());
    const back = cons.redirect_url ? new URL(cons.redirect_url) : null;
    check("consentimento devolve código + state", back?.searchParams.get("code") && back.searchParams.get("state") === state, JSON.stringify(cons).slice(0, 200));
    const tok = await fetch(`${AUTH}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: back?.searchParams.get("code") ?? "", redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier }) }).then((r) => r.json());
    check("troca do código por token (PKCE)", Boolean(tok.access_token), JSON.stringify(tok).slice(0, 200));
    check("token de renovação emitido (evita relogar toda hora)", Boolean(tok.refresh_token));
    const viaOAuth = await rpc(tok.access_token, "tools/call", { name: "buscar", arguments: { consulta: "" } });
    check("token OAuth acessa o MCP", viaOAuth.status === 200 && viaOAuth.body.result && !viaOAuth.body.result.isError, JSON.stringify(viaOAuth.body).slice(0, 200));
    const tokB = await rpc(tok.access_token, "tools/call", { name: "buscar", arguments: { consulta: "Zacarias" } });
    check("token OAuth da A continua isolado da B", !/Zacarias/.test(JSON.stringify(tokB.body)));
  }
} catch (e) {
  falhas++;
  console.log("  ✘ erro inesperado:", e.message);
} finally {
  console.log("\n5) Limpeza dos dados de teste");
  if (criados.client) {
    const r = await admin(`/admin/oauth/clients/${criados.client}`, { method: "DELETE" });
    console.log(`  app OAuth de teste removido: ${r.ok}`);
  }
  for (const id of criados.users) {
    const r = await admin(`/admin/users/${id}`, { method: "DELETE" });
    console.log(`  usuária de teste removida: ${r.ok}`);
  }
}
console.log(`\nResultado: ${ok} ok, ${falhas} falha(s)`);
process.exit(falhas ? 1 : 0);
