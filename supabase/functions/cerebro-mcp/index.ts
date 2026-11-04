// Meu Segundo Cérebro — servidor MCP remoto (Supabase Edge Function).
//
// - Transporte: MCP "Streamable HTTP" sem estado (respostas JSON).
// - Autenticação: OAuth 2.1 do próprio Supabase (Authentication → OAuth Server).
//   Este servidor é o "recurso protegido": publica os metadados RFC 9728 e
//   exige um token Bearer válido em toda chamada MCP.
// - Autorização: as consultas usam o token da própria usuária, então o RLS
//   da tabela public.memorias decide o que pode ser lido/gravado.
//   NÃO usamos service_role aqui.
// - Logs: só método, ferramenta, status e duração. Nunca conteúdo ou tokens.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
function publicKey(): string {
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (anon) return anon;
  try { // projetos com as novas chaves "publishable"
    const keys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
    return String(keys.default ?? Object.values(keys)[0] ?? "");
  } catch { return ""; }
}
const SUPABASE_ANON_KEY = publicKey();
const FUNCTION_NAME = "cerebro-mcp";
const RESOURCE_URL = `${SUPABASE_URL}/functions/v1/${FUNCTION_NAME}`;
const PRM_URL = `${RESOURCE_URL}/.well-known/oauth-protected-resource`;
const AUTH_SERVER = `${SUPABASE_URL}/auth/v1`;

// Opcional: lista de client_ids OAuth permitidos (separados por vírgula).
// Se definida, só tokens emitidos para esses apps (ex.: Claude, ChatGPT) passam.
const ALLOWED_CLIENT_IDS = (Deno.env.get("ALLOWED_CLIENT_IDS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "meu-segundo-cerebro", title: "Meu Segundo Cérebro", version: "0.1.0" };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });
}

function unauthorized(error: "invalid_request" | "invalid_token", description: string) {
  return json(
    { error, error_description: description },
    401,
    {
      "WWW-Authenticate":
        `Bearer error="${error}", error_description="${description}", resource_metadata="${PRM_URL}"`,
    },
  );
}

function log(entry: Record<string, unknown>) {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...entry }));
}

// ---------- autenticação ----------

type Auth = { userId: string; clientId?: string; db: SupabaseClient };

async function authenticate(req: Request): Promise<Auth | Response> {
  const header = req.headers.get("Authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return unauthorized("invalid_request", "Token de acesso ausente");
  const token = m[1].trim();

  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  // getClaims valida assinatura e expiração (JWKS para chaves assimétricas;
  // consulta o Auth do Supabase quando o projeto ainda usa chave simétrica).
  const { data, error } = await db.auth.getClaims(token);
  const claims = data?.claims as Record<string, unknown> | undefined;
  if (error || !claims?.sub) return unauthorized("invalid_token", "Token invalido ou expirado");
  if (claims.role !== "authenticated") return unauthorized("invalid_token", "Token sem papel autenticado");

  const clientId = typeof claims.client_id === "string" ? claims.client_id : undefined;
  if (ALLOWED_CLIENT_IDS.length > 0 && (!clientId || !ALLOWED_CLIENT_IDS.includes(clientId))) {
    return json({ error: "insufficient_scope", error_description: "Aplicativo nao autorizado" }, 403);
  }
  return { userId: String(claims.sub), clientId, db };
}

// ---------- ferramentas ----------

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

const TOOLS = [
  {
    name: "buscar_memorias",
    title: "Buscar memórias",
    description:
      "Pesquisa no Segundo Cérebro da usuária (memórias pessoais, casa, família, trabalho, " +
      "conhecimento, projetos). Use palavras-chave curtas em português. Retorna id, título, " +
      "trecho, categoria e fonte. Use ler_memoria para ver o conteúdo completo.",
    inputSchema: {
      type: "object",
      properties: {
        consulta: { type: "string", description: "Palavras-chave. Vazio lista as mais recentes." },
        categoria: { type: "string", description: "Filtrar por categoria (opcional)." },
        limite: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      required: ["consulta"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "ler_memoria",
    title: "Ler memória",
    description: "Retorna o conteúdo completo de uma memória pelo id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "id (uuid) da memória" } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "salvar_memoria",
    title: "Salvar memória",
    description:
      "Grava uma nova memória no Segundo Cérebro. Só use quando a usuária pedir " +
      "explicitamente para salvar/registrar algo.",
    inputSchema: {
      type: "object",
      properties: {
        titulo: { type: "string", maxLength: 300 },
        conteudo: { type: "string", maxLength: 20000 },
        categoria: { type: "string", maxLength: 100 },
        fonte: { type: "string", maxLength: 200, description: "Ex.: claude, chatgpt" },
      },
      required: ["titulo", "conteudo"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  // Compatibilidade com o formato "search/fetch" usado pelo ChatGPT.
  {
    name: "search",
    title: "Search (compatibilidade ChatGPT)",
    description: "Pesquisa memórias do Segundo Cérebro por palavras-chave (mesmo que buscar_memorias).",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "fetch",
    title: "Fetch (compatibilidade ChatGPT)",
    description: "Retorna o conteúdo completo de uma memória pelo id (mesmo que ler_memoria).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
];

class ToolError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
const memoriaUrl = (id: string) => `${RESOURCE_URL}#memoria/${id}`;

async function buscar(auth: Auth, consulta: string, categoria?: string, limite = 10) {
  const { data, error } = await auth.db.rpc("buscar_memorias", {
    termo: consulta,
    filtro_categoria: categoria ?? null,
    limite,
  });
  if (error) throw new Error(`db:${error.code ?? "erro"}`);
  return data as Array<Record<string, unknown>>;
}

async function ler(auth: Auth, id: string) {
  if (!UUID_RE.test(id)) throw new ToolError("id inválido");
  const { data, error } = await auth.db
    .from("memorias")
    .select("id, titulo, conteudo, categoria, fonte, criado_em")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`db:${error.code ?? "erro"}`);
  if (!data) throw new ToolError("Memória não encontrada");
  return data;
}

function text(t: string, structured?: unknown) {
  return { content: [{ type: "text", text: t }], ...(structured ? { structuredContent: structured } : {}) };
}

async function callTool(auth: Auth, name: string, args: Record<string, unknown>) {
  switch (name) {
    case "buscar_memorias": {
      const consulta = str(args.consulta, 500) ?? "";
      const limite = Math.min(Math.max(Number(args.limite ?? 10) || 10, 1), 50);
      const rows = await buscar(auth, consulta, str(args.categoria, 100), limite);
      const resultados = rows.map((r) => ({
        id: r.id, titulo: r.titulo, trecho: r.trecho, categoria: r.categoria,
        fonte: r.fonte, criado_em: r.criado_em,
      }));
      const msg = resultados.length
        ? JSON.stringify(resultados, null, 2)
        : "Nenhuma memória encontrada para essa busca.";
      return text(msg, { resultados });
    }
    case "ler_memoria":
      return text(JSON.stringify(await ler(auth, String(args.id ?? "")), null, 2));
    case "salvar_memoria": {
      const titulo = str(args.titulo, 300)?.trim();
      const conteudo = str(args.conteudo, 20000)?.trim();
      if (!titulo || !conteudo) throw new ToolError("titulo e conteudo são obrigatórios");
      const { data, error } = await auth.db
        .from("memorias")
        .insert({
          usuario_id: auth.userId,
          titulo,
          conteudo,
          categoria: str(args.categoria, 100) ?? null,
          fonte: str(args.fonte, 200) ?? "mcp",
        })
        .select("id, titulo, criado_em")
        .single();
      if (error) throw new Error(`db:${error.code ?? "erro"}`);
      return text(`Memória salva: ${JSON.stringify(data)}`);
    }
    case "search": {
      const rows = await buscar(auth, str(args.query, 500) ?? "", undefined, 10);
      const results = rows.map((r) => ({ id: r.id, title: r.titulo, url: memoriaUrl(String(r.id)) }));
      return text(JSON.stringify({ results }));
    }
    case "fetch": {
      const m = await ler(auth, String(args.id ?? ""));
      return text(JSON.stringify({
        id: m.id, title: m.titulo, text: m.conteudo, url: memoriaUrl(m.id),
        metadata: { categoria: m.categoria, fonte: m.fonte, criado_em: m.criado_em },
      }));
    }
    default:
      return null;
  }
}

// ---------- JSON-RPC / MCP ----------

type RpcReq = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });

async function handleRpc(auth: Auth, msg: RpcReq) {
  const started = Date.now();
  const isNotification = msg.id === undefined;
  let out: unknown = null;
  let status = "ok";
  let tool: string | undefined;

  try {
    switch (msg.method) {
      case "initialize": {
        const requested = msg.params?.protocolVersion;
        const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
        out = rpcResult(msg.id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "Este é o Segundo Cérebro pessoal da usuária. Para perguntas sobre a vida, casa, " +
            "família, trabalho, documentos ou ideias dela, pesquise aqui com buscar_memorias " +
            "antes de responder, e cite o título da memória usada.",
        });
        break;
      }
      case "ping":
        out = rpcResult(msg.id, {});
        break;
      case "tools/list":
        out = rpcResult(msg.id, { tools: TOOLS });
        break;
      case "tools/call": {
        tool = String(msg.params?.name ?? "");
        try {
          const res = await callTool(auth, tool, msg.params?.arguments ?? {});
          out = res ? rpcResult(msg.id, res) : rpcError(msg.id, -32602, `Ferramenta desconhecida: ${tool}`);
          if (!res) status = "unknown_tool";
        } catch (e) {
          status = e instanceof ToolError ? "tool_error" : "internal_error";
          const msgTxt = e instanceof ToolError ? e.message : "Erro interno ao consultar o Segundo Cérebro.";
          if (!(e instanceof ToolError)) log({ level: "error", tool, err: String((e as Error).message).slice(0, 80) });
          out = rpcResult(msg.id, { content: [{ type: "text", text: msgTxt }], isError: true });
        }
        break;
      }
      case "resources/list":
        out = rpcResult(msg.id, { resources: [] });
        break;
      case "prompts/list":
        out = rpcResult(msg.id, { prompts: [] });
        break;
      default:
        if (isNotification) break; // notifications/initialized etc.
        status = "method_not_found";
        out = rpcError(msg.id, -32601, `Método não suportado: ${msg.method}`);
    }
  } finally {
    log({ method: msg.method, tool, status, ms: Date.now() - started, user: auth.userId.slice(0, 8), client: auth.clientId?.slice(0, 8) });
  }
  return isNotification ? null : out;
}

// ---------- roteamento HTTP ----------

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // Metadados do recurso protegido (RFC 9728) — público, sem dados pessoais.
  if (path.endsWith("/.well-known/oauth-protected-resource")) {
    return json({
      resource: RESOURCE_URL,
      authorization_servers: [AUTH_SERVER],
      bearer_methods_supported: ["header"],
      scopes_supported: ["openid", "email", "profile"],
      resource_name: "Meu Segundo Cérebro",
    });
  }
  // Atalho para clientes que procuram metadados do servidor de autorização aqui.
  if (path.endsWith("/.well-known/oauth-authorization-server") || path.endsWith("/.well-known/openid-configuration")) {
    const r = await fetch(`${SUPABASE_URL}/.well-known/oauth-authorization-server/auth/v1`);
    return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json", ...CORS } });
  }

  if (!path.endsWith(`/${FUNCTION_NAME}`) && !path.endsWith(`/${FUNCTION_NAME}/mcp`)) {
    return json({ error: "not_found" }, 404);
  }

  // Toda chamada MCP exige autenticação (inclusive GET/DELETE).
  const auth = await authenticate(req);
  if (auth instanceof Response) {
    log({ http: req.method, status: auth.status });
    return auth;
  }

  if (req.method === "GET") return json({ error: "SSE não suportado; use POST" }, 405, { Allow: "POST" });
  if (req.method === "DELETE") return new Response(null, { status: 405, headers: { ...CORS, Allow: "POST" } });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(rpcError(null, -32700, "JSON inválido"), 400);
  }

  const batch = Array.isArray(body) ? body : [body];
  if (batch.length === 0 || batch.length > 20) return json(rpcError(null, -32600, "Requisição inválida"), 400);

  const results: unknown[] = [];
  for (const m of batch) {
    if (!m || typeof m !== "object" || (m as RpcReq).jsonrpc !== "2.0" || typeof (m as RpcReq).method !== "string") {
      // respostas de cliente (sem method) são ignoradas
      if (m && typeof m === "object" && "id" in m && !("method" in m)) continue;
      results.push(rpcError((m as RpcReq)?.id, -32600, "Requisição inválida"));
      continue;
    }
    const r = await handleRpc(auth, m as RpcReq);
    if (r) results.push(r);
  }

  if (results.length === 0) return new Response(null, { status: 202, headers: CORS });
  return json(Array.isArray(body) ? results : results[0]);
});
