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
const SERVER_INFO = { name: "meu-segundo-cerebro", title: "Meu Segundo Cérebro", version: "0.3.3" };

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
  let claims: Record<string, unknown> | undefined;
  try {
    const { data, error } = await db.auth.getClaims(token);
    if (!error) claims = data?.claims as Record<string, unknown> | undefined;
  } catch {
    claims = undefined; // token malformado
  }
  const error = !claims;
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
    name: "buscar",
    title: "Buscar no Segundo Cérebro",
    description:
      "Pesquisa no Segundo Cérebro da usuária: notas do Obsidian (pessoas, documentos, família, " +
      "saúde, casa, trabalho jurídico, projetos, conhecimento, receitas) e memórias salvas. " +
      "Use SEMPRE antes de responder perguntas sobre a vida, pessoas, documentos ou dados dela. " +
      "Use palavras-chave curtas (ex.: 'Guy cpf', 'Nicolas vacina', 'máquina de lavar'). " +
      "Retorna id, tipo, título, caminho, propriedades (frontmatter) e um trecho. " +
      "Use 'ler' para o conteúdo completo.",
    inputSchema: {
      type: "object",
      properties: {
        consulta: { type: "string", description: "Palavras-chave. Vazio lista as mais recentes." },
        limite: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      required: ["consulta"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "ler",
    title: "Ler nota ou memória",
    description: "Retorna o conteúdo completo e as propriedades de uma nota/memória pelo id retornado em 'buscar'.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "id retornado por buscar (formato nota:<uuid> ou memoria:<uuid>)" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "datas",
    title: "Datas e prazos",
    description:
      "Lista datas registradas nas propriedades das notas (ex.: proxima_manutencao, proxima_dose, " +
      "vencimento, prazo, garantia_ate), incluindo as já vencidas. Use para perguntas como " +
      "'o que está para vencer?', 'quando é a próxima vacina?', 'faz quanto tempo da última manutenção?'. " +
      "dias_ate negativo = já passou.",
    inputSchema: {
      type: "object",
      properties: {
        dias_a_frente: { type: "integer", minimum: 0, maximum: 3650, default: 60 },
        dias_atras: { type: "integer", minimum: 0, maximum: 3650, default: 365 },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "salvar_memoria",
    title: "Salvar no Segundo Cérebro",
    description:
      "Registra uma informação nova. Ela aparece na pasta '00 - Entrada' do Obsidian da usuária. " +
      "Só use quando ela pedir explicitamente para salvar/registrar/anotar algo. " +
      "Inclua datas no formato AAAA-MM-DD no conteúdo quando houver.",
    inputSchema: {
      type: "object",
      properties: {
        titulo: { type: "string", maxLength: 300 },
        conteudo: { type: "string", maxLength: 20000 },
        categoria: { type: "string", maxLength: 100 },
        fonte: { type: "string", maxLength: 200, description: "claude ou chatgpt" },
      },
      required: ["titulo", "conteudo"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "criar_nota",
    title: "Criar nota no Obsidian",
    description:
      "Pede ao Obsidian da usuária para criar um arquivo NOVO no Vault (o plugin Ponte cria em até " +
      "alguns minutos, no computador principal). Nunca sobrescreve nem apaga: se o arquivo já existir, " +
      "nada acontece. Use caminhos dentro das pastas existentes (ex.: '01 - Vida/Pessoas/Guy.md'). " +
      "Aceita .md, .base e '.obsidian/snippets/<nome>.css'. Só use quando a usuária pedir para criar/organizar.",
    inputSchema: {
      type: "object",
      properties: {
        caminho: { type: "string", maxLength: 300, description: "Caminho relativo no Vault, com extensão" },
        conteudo: { type: "string", maxLength: 200000 },
      },
      required: ["caminho", "conteudo"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "editar_nota",
    title: "Editar nota no Obsidian",
    description:
      "Atualiza uma nota .md que JÁ EXISTE, sem criar outra. Fluxo: 'buscar' → 'ler' (pegue 'caminho' e 'versao') → " +
      "editar_nota. Prefira mudanças pequenas, que preservam todo o resto: 'propriedades' (mescla no frontmatter; " +
      "valor null remove a propriedade), 'trocar' (troca trechos exatos do texto) e 'acrescentar' (adiciona texto no " +
      "fim). Use 'conteudo' (arquivo inteiro, com frontmatter) só para reescrever a nota toda. " +
      "Ex.: 'a última manutenção da máquina de lavar foi 05/11/2026' → propriedades {ultima_manutencao: '2026-11-05'}. " +
      "Datas sempre AAAA-MM-DD. O plugin só aplica se a nota não mudou desde a leitura e guarda cópia em " +
      "'05 - Sistema/Backups/'. A alteração aparece no Obsidian em até ~2 min (computador principal ligado); " +
      "confira com 'ver_alteracoes'.",
    inputSchema: {
      type: "object",
      properties: {
        caminho: { type: "string", maxLength: 300, description: "Caminho da nota existente (campo 'caminho' de buscar/ler)" },
        versao: { type: "string", maxLength: 64, description: "Campo 'versao' devolvido por 'ler' (protege contra sobrescrever mudanças novas)" },
        propriedades: {
          type: "object", maxProperties: 40,
          description: "Propriedades a definir/alterar (texto, número, sim/não, lista de textos) ou null para remover",
          additionalProperties: { type: ["string", "number", "boolean", "array", "null"], items: { type: "string" } },
        },
        trocar: {
          type: "array", maxItems: 20,
          description: "Trocas de trechos do texto (sem o frontmatter). Cada 'de' precisa aparecer exatamente 1 vez.",
          items: {
            type: "object",
            properties: { de: { type: "string", minLength: 1, maxLength: 5000 }, para: { type: "string", maxLength: 20000 } },
            required: ["de", "para"], additionalProperties: false,
          },
        },
        acrescentar: { type: "string", maxLength: 20000, description: "Texto a adicionar no fim da nota" },
        conteudo: { type: "string", maxLength: 200000, description: "Arquivo completo novo (frontmatter + texto). Não combine com trocar/acrescentar." },
      },
      required: ["caminho"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "atualizar_tarefa",
    title: "Atualizar tarefa",
    description:
      "Marca como feita/reabre, ou muda prazo, data, prioridade e status de uma tarefa que JÁ EXISTE — nunca cria " +
      "outra. Serve para notas de tarefa (tipo: tarefa) e também para contas/lançamentos (tipo: lancamento; " +
      "concluida=true vira status 'pago'). Para um item de checklist dentro de uma nota ('- [ ] ...'), passe " +
      "'item' com um trecho do texto do item. Ex.: 'já paguei as funcionárias' → 'buscar' a tarefa/conta, depois " +
      "atualizar_tarefa {caminho, concluida: true}. Se houver mais de uma candidata, pergunte qual antes.",
    inputSchema: {
      type: "object",
      properties: {
        caminho: { type: "string", maxLength: 300, description: "Caminho da nota (campo 'caminho' de buscar/ler)" },
        versao: { type: "string", maxLength: 64, description: "Campo 'versao' devolvido por 'ler' (opcional)" },
        item: { type: "string", maxLength: 300, description: "Só para checklist: trecho do texto do item '- [ ]' a marcar/desmarcar" },
        concluida: { type: "boolean", description: "true = feita/paga; false = reabrir" },
        status: { type: "string", maxLength: 40, description: "Ex.: pendente, em andamento, feita, cancelada, pago" },
        prazo: { type: ["string", "null"], description: "AAAA-MM-DD (null remove)" },
        data: { type: ["string", "null"], description: "AAAA-MM-DD (null remove)" },
        prioridade: { type: ["string", "null"], enum: ["alta", "normal", "baixa", null] },
      },
      required: ["caminho"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "mover_nota",
    title: "Mover nota no Obsidian",
    description:
      "Move (ou renomeia) uma nota .md existente para outra pasta/nome. O Obsidian atualiza os links internos " +
      "([[...]]) que apontam para ela quando a opção 'Atualizar links internos automaticamente' está ligada. " +
      "Nunca sobrescreve: se o destino já existir, nada acontece. 'destino' pode ser uma pasta terminando em '/' " +
      "(mantém o nome) ou o caminho completo com .md.",
    inputSchema: {
      type: "object",
      properties: {
        caminho: { type: "string", maxLength: 300, description: "Caminho atual da nota" },
        destino: { type: "string", maxLength: 300, description: "Nova pasta ('04 - Projetos/Afiloop/') ou novo caminho completo (.md)" },
        versao: { type: "string", maxLength: 64, description: "Campo 'versao' devolvido por 'ler' (opcional)" },
      },
      required: ["caminho", "destino"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "excluir_nota",
    title: "Excluir nota (vai para a lixeira)",
    description:
      "Exclui uma nota .md existente em DUAS etapas. 1) Chame sem 'confirmacao': nada é apagado; você recebe um " +
      "código. 2) PERGUNTE à usuária, citando o título e o caminho da nota, se pode excluir. Só se ela disser " +
      "claramente que sim, chame de novo com 'confirmacao' = código. Nunca confirme por conta própria. " +
      "A nota vai para a lixeira e fica uma cópia em '05 - Sistema/Backups/' (dá para recuperar).",
    inputSchema: {
      type: "object",
      properties: {
        caminho: { type: "string", maxLength: 300, description: "Caminho da nota existente (campo 'caminho' de buscar/ler)" },
        versao: { type: "string", maxLength: 64, description: "Campo 'versao' devolvido por 'ler' (opcional)" },
        confirmacao: { type: "string", maxLength: 6, description: "Código da 1ª etapa, só depois do 'sim' da usuária" },
      },
      required: ["caminho"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "salvar_imagem",
    title: "Salvar imagem no Obsidian",
    description:
      "Guarda uma imagem (JPG, PNG, WEBP ou GIF, até 10 MB) como arquivo no Vault e, se pedido, liga a imagem a uma " +
      "nota (ex.: a foto de uma peça do Afiloop vai para a propriedade 'foto' da nota da peça, e aparece na vitrine). " +
      "Use 'arquivo' para uma imagem que a usuária enviou ou que foi gerada nesta conversa, ou 'url' para o link " +
      "https direto da imagem (ex.: foto do produto na loja (Shein, Shopee, Mercado Livre...)). Pasta padrão: '04 - Projetos/Afiloop/🖼️ Imagens'. " +
      "Nunca sobrescreve: se já existir um arquivo com o mesmo nome, salva com outro número. " +
      "Use só imagens que a usuária pediu para guardar.",
    inputSchema: {
      type: "object",
      properties: {
        arquivo: {
          type: "object", description: "Imagem enviada pela usuária ou gerada na conversa",
          properties: { download_url: { type: "string" }, file_id: { type: "string" } },
          required: ["download_url"],
        },
        url: { type: "string", maxLength: 2000, description: "Link https direto da imagem (se não usar 'arquivo')" },
        nome: { type: "string", maxLength: 100, description: "Nome do arquivo, sem extensão (ex.: 'Vestido midi verde - Shein 123456')" },
        pasta: { type: "string", maxLength: 200, description: "Pasta do Vault (padrão '04 - Projetos/Afiloop/🖼️ Imagens')" },
        nota: { type: "string", maxLength: 300, description: "Caminho da nota que vai mostrar a imagem (opcional)" },
        versao: { type: "string", maxLength: 64, description: "Campo 'versao' da nota, devolvido por 'ler' (opcional)" },
        propriedade: { type: "string", maxLength: 60, description: "Propriedade da nota que recebe a imagem (padrão 'foto')" },
      },
      additionalProperties: false,
    },
    _meta: { "openai/fileParams": ["arquivo"] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "ver_alteracoes",
    title: "Ver alterações pedidas",
    description:
      "Mostra as últimas alterações pedidas ao Obsidian (criar, editar, tarefa, mover, excluir) e o resultado de " +
      "cada uma: pendente (o computador principal ainda não aplicou), aplicada ou recusada (e por quê), e também os " +
      "pedidos que o servidor recusou antes de entrar na fila, com o motivo. Não mostra conteúdo das notas. Use para " +
      "confirmar se uma alteração já foi feita e, se algo falhar, diga à usuária o motivo exato (não diga só 'bloqueado').",
    inputSchema: {
      type: "object",
      properties: {
        caminho: { type: "string", maxLength: 300, description: "Filtra por uma nota (opcional)" },
        limite: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  // Compatibilidade com o formato "search/fetch" usado pelo ChatGPT.
  {
    name: "search",
    title: "Search (ChatGPT)",
    description: "Pesquisa o Segundo Cérebro da usuária (mesmo que 'buscar').",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "fetch",
    title: "Fetch (ChatGPT)",
    description: "Conteúdo completo de um resultado de 'search' pelo id (mesmo que 'ler').",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    annotations: READ_ONLY,
  },
];

class ToolError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
const itemUrl = (id: string) => `${RESOURCE_URL}#${id}`;
const dbErr = (e: { code?: string }) => new Error(`db:${e.code ?? "erro"}`);

async function buscar(auth: Auth, consulta: string, limite = 10) {
  const { data, error } = await auth.db.rpc("buscar_cerebro", { termo: consulta, limite });
  if (error) throw dbErr(error);
  return (data as Array<Record<string, unknown>>).map((r) => ({
    id: `${r.tipo}:${r.id}`, tipo: r.tipo, titulo: r.titulo, caminho: r.caminho ?? undefined,
    propriedades: r.propriedades, trecho: r.trecho, atualizado_em: r.atualizado_em,
  }));
}

async function ler(auth: Auth, rawId: string) {
  const [tipo, id] = rawId.includes(":") ? rawId.split(":", 2) : ["", rawId];
  if (!UUID_RE.test(id)) throw new ToolError("id inválido");
  if (tipo !== "memoria") {
    const { data, error } = await auth.db.from("notas")
      .select("id, caminho, titulo, conteudo, propriedades, modificado_em, hash").eq("id", id).maybeSingle();
    if (error) throw dbErr(error);
    if (data) {
      const { hash, ...resto } = data;
      return { ...resto, id: `nota:${data.id}`, tipo: "nota", versao: hash };
    }
    if (tipo === "nota") throw new ToolError("Nota não encontrada");
  }
  const { data, error } = await auth.db.from("memorias")
    .select("id, titulo, conteudo, categoria, fonte, criado_em").eq("id", id).maybeSingle();
  if (error) throw dbErr(error);
  if (!data) throw new ToolError("Não encontrado");
  return { ...data, id: `memoria:${data.id}`, tipo: "memoria" };
}

function caminhoSeguro(c: string): boolean {
  if (c.length < 4 || c.length > 300) return false;
  if (/(^\/|\\|\.\.\/|\/\.\.|^\.\.|\/\/|[<>:"|?*\x00-\x1f])/.test(c)) return false;
  if (/^\.obsidian\/snippets\/[^/]+\.css$/.test(c)) return true;
  return /\.(md|base)$/.test(c) && !/(^|\/)\./.test(c);
}

// ---------- edição de notas existentes ----------
// Pastas/notas que nenhuma IA altera, move ou exclui (configuração do plugin, histórico, modelos, backups).
const PASTAS_PROTEGIDAS = ["05 - Sistema/Backups/", "05 - Sistema/Modelos/"];
const NOTAS_PROTEGIDAS = [
  "05 - Sistema/⚙️ Configuração do Segundo Cérebro.md",
  "05 - Sistema/⚙️ Resultado da configuração.md",
  "05 - Sistema/📜 Histórico de alterações da IA.md",
];
const ACOES_DE_EDICAO = ["editar", "apagar", "tarefa", "mover"];
const ORIGENS: Record<string, string> = {
  "944323a9-269c-4468-bdf0-01ea7e4b9613": "ChatGPT",
  "94c90271-9a50-4a65-b4d4-b345fa8043f5": "Claude",
};
const nomeOrigem = (o: unknown) => {
  const s = String(o ?? "");
  return ORIGENS[s] ?? (s.startsWith("claude-code") ? "Claude Code" : s.startsWith("teste") ? "teste" : "outro app");
};

function caminhoNota(v: unknown): string {
  const c = (str(v, 300) ?? "").trim().replace(/^\/+/, "");
  if (!caminhoSeguro(c) || !c.endsWith(".md")) {
    throw new ToolError("Caminho inválido. Use o campo 'caminho' de buscar/ler (uma nota .md dentro do Vault).");
  }
  if (PASTAS_PROTEGIDAS.some((p) => c.startsWith(p)) || NOTAS_PROTEGIDAS.includes(c)) {
    throw new ToolError("Essa nota é protegida (configuração, histórico, modelos ou backups) e não pode ser alterada por aqui.");
  }
  return c;
}

type NotaEspelho = { titulo: string; hash: string; conteudo: string; propriedades: Record<string, unknown> };

async function notaAtual(auth: Auth, caminho: string, versao?: string): Promise<NotaEspelho> {
  const { data, error } = await auth.db.from("notas").select("titulo, hash, conteudo, propriedades").eq("caminho", caminho).maybeSingle();
  if (error) throw dbErr(error);
  if (!data) {
    throw new ToolError("Nota não encontrada (o caminho está errado, ela é privada ou ainda não sincronizou). Use 'buscar' para achar o caminho certo. Nada foi criado.");
  }
  if (versao && versao !== data.hash) {
    throw new ToolError("A nota mudou depois que você leu. Use 'ler' de novo e refaça a alteração. Nada foi alterado.");
  }
  return { ...data, propriedades: (data.propriedades ?? {}) as Record<string, unknown> } as NotaEspelho;
}

const PENDENTE_MSG = "Já existe uma alteração pendente para essa nota. Espere o Obsidian aplicar (veja 'ver_alteracoes') e tente de novo.";

async function semPendente(auth: Auth, ...caminhos: string[]) {
  for (const c of caminhos) {
    for (const col of ["caminho", "destino"]) {
      const { data, error } = await auth.db.from("pedidos_vault").select("id")
        .eq(col, c).is("aplicado_em", null).in("acao", ACOES_DE_EDICAO).limit(1);
      if (error) throw dbErr(error);
      if (data?.length) throw new ToolError(PENDENTE_MSG);
    }
  }
}

async function inserirPedido(auth: Auth, row: Record<string, unknown>) {
  const { data, error } = await auth.db.from("pedidos_vault")
    .insert({ usuario_id: auth.userId, origem: auth.clientId ?? "mcp", conteudo: "", ...row })
    .select("id, caminho").single();
  if (error) {
    if ((error as { code?: string }).code === "23505") throw new ToolError(PENDENTE_MSG);
    throw dbErr(error);
  }
  return data as { id: string; caminho: string };
}

const CHAVE_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_ \-]{0,59}$/u;
function validarPropriedades(v: unknown): Record<string, unknown> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new ToolError("'propriedades' precisa ser um objeto {nome: valor}.");
  const out: Record<string, unknown> = {};
  const entradas = Object.entries(v as Record<string, unknown>);
  if (entradas.length === 0) return undefined;
  if (entradas.length > 40) throw new ToolError("No máximo 40 propriedades por vez.");
  for (const [k, val] of entradas) {
    if (!CHAVE_RE.test(k) || k === "position") throw new ToolError(`Nome de propriedade inválido: "${k.slice(0, 60)}".`);
    if (val === null || typeof val === "boolean") out[k] = val;
    else if (typeof val === "number" && Number.isFinite(val)) out[k] = val;
    else if (typeof val === "string" && val.length <= 2000) out[k] = val;
    else if (Array.isArray(val) && val.length <= 50 && val.every((x) => typeof x === "string" && x.length <= 300)) out[k] = val;
    else throw new ToolError(`Valor inválido para "${k}": use texto, número, sim/não, lista de textos ou null.`);
  }
  return out;
}

function validarTrocas(v: unknown): Array<{ de: string; para: string }> | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > 20) throw new ToolError("'trocar' precisa ser uma lista (até 20) de {de, para}.");
  if (v.length === 0) return undefined;
  return v.map((t) => {
    const de = typeof t?.de === "string" ? t.de : "";
    const para = typeof t?.para === "string" ? t.para : "";
    if (!de || de.length > 5000 || para.length > 20000) throw new ToolError("Cada troca precisa de 'de' (1–5000 caracteres) e 'para'.");
    return { de, para };
  });
}

const contar = (texto: string, trecho: string) => texto.split(trecho).length - 1;

function dataValida(v: unknown, nome: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  const d = new Date(`${s}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new ToolError(`'${nome}' precisa estar no formato AAAA-MM-DD (ex.: 2026-11-05).`);
  }
  return s;
}

const hojeRecife = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Recife" }).format(new Date());

function codigoConfirmacao(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, "0");
}

// ---------- imagens ----------
const PASTA_IMAGENS = "04 - Projetos/Afiloop/🖼️ Imagens";
const MAX_IMAGEM = 10 * 1024 * 1024;

// Só links https públicos (nada de localhost, IP ou rede interna).
function urlImagemSegura(u: string): URL {
  let url: URL;
  try { url = new URL(u); } catch { throw new ToolError("Link da imagem inválido."); }
  const h = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || !h.includes(".") ||
      /^[\d.]+$/.test(h) || h.includes(":") || h === "localhost" || /\.(local|internal|localhost)$/.test(h)) {
    throw new ToolError("Use um link https público e direto da imagem.");
  }
  return url;
}

// Confere pelo conteúdo (não pelo nome) que é mesmo uma imagem permitida.
function tipoImagem(b: Uint8Array): { ext: string; mime: string } | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: "png", mime: "image/png" };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { ext: "gif", mime: "image/gif" };
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { ext: "webp", mime: "image/webp" };
  return null;
}

async function baixarImagem(origem: string, confiavel: boolean): Promise<Uint8Array> {
  const url = confiavel ? new URL(origem) : urlImagemSegura(origem);
  if (url.protocol !== "https:") throw new ToolError("A imagem precisa vir de um link https.");
  let r: Response;
  try {
    r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20000), headers: { Accept: "image/*" } });
  } catch { throw new ToolError("Não consegui baixar a imagem (o link não respondeu). Tente outro link ou envie o arquivo."); }
  if (!confiavel) urlImagemSegura(r.url || url.href); // o redirecionamento também precisa ser público
  if (!r.ok) throw new ToolError(`Não consegui baixar a imagem (o site respondeu ${r.status}).`);
  if (Number(r.headers.get("content-length") ?? 0) > MAX_IMAGEM) throw new ToolError("Imagem grande demais (máx. 10 MB).");
  const leitor = r.body?.getReader();
  if (!leitor) throw new ToolError("A imagem veio vazia.");
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.length;
    if (total > MAX_IMAGEM) { await leitor.cancel(); throw new ToolError("Imagem grande demais (máx. 10 MB)."); }
    partes.push(value);
  }
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const p of partes) { bytes.set(p, o); o += p.length; }
  return bytes;
}

const limparNome = (s: string) => s.replace(/[\\/:*?"<>|#^\[\]\x00-\x1f]/g, " ").replace(/\s+/g, " ").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 90);

function pastaSegura(v: unknown): string {
  const p = (str(v, 200) ?? PASTA_IMAGENS).trim().replace(/^\/+|\/+$/g, "") || PASTA_IMAGENS;
  if (/(\\|\.\.|\/\/|[<>:"|?*\x00-\x1f])/.test(p) || p.split("/").some((x) => x.startsWith(".")) ||
      PASTAS_PROTEGIDAS.some((x) => (p + "/").startsWith(x))) {
    throw new ToolError("Pasta não permitida para imagens.");
  }
  return p;
}

const TIPOS_TAREFA = ["tarefa", "compromisso", "lembrete"];
const TIPOS_CONTA = ["lancamento", "conta"];
const CHECKBOX_RE = /^\s*[-*+] \[[ xX]\] /;

function text(t: string, structured?: unknown) {
  return { content: [{ type: "text", text: t }], ...(structured ? { structuredContent: structured } : {}) };
}

async function callTool(auth: Auth, name: string, args: Record<string, unknown>) {
  switch (name) {
    case "buscar": {
      const limite = Math.min(Math.max(Number(args.limite ?? 10) || 10, 1), 50);
      const resultados = await buscar(auth, str(args.consulta, 500) ?? "", limite);
      return text(resultados.length ? JSON.stringify(resultados, null, 2) : "Nada encontrado para essa busca.", { resultados });
    }
    case "ler":
      return text(JSON.stringify(await ler(auth, String(args.id ?? "")), null, 2));
    case "datas": {
      const { data, error } = await auth.db.rpc("datas_do_cerebro", {
        dias_a_frente: Number(args.dias_a_frente ?? 60) || 60,
        dias_atras: Number(args.dias_atras ?? 365) || 365,
      });
      if (error) throw dbErr(error);
      const hoje = new Date().toISOString().slice(0, 10);
      return text(JSON.stringify({ hoje, datas: data }, null, 2), { hoje, datas: data });
    }
    case "salvar_memoria": {
      const titulo = str(args.titulo, 300)?.trim();
      const conteudo = str(args.conteudo, 20000)?.trim();
      if (!titulo || !conteudo) throw new ToolError("titulo e conteudo são obrigatórios");
      const { data, error } = await auth.db.from("memorias").insert({
        usuario_id: auth.userId, titulo, conteudo,
        categoria: str(args.categoria, 100) ?? null, fonte: str(args.fonte, 200) ?? "mcp",
      }).select("id, titulo, criado_em").single();
      if (error) throw dbErr(error);
      return text(`Salvo no Segundo Cérebro (vai aparecer em "00 - Entrada" no Obsidian): ${JSON.stringify(data)}`);
    }
    case "criar_nota": {
      const caminho = (str(args.caminho, 300) ?? "").trim().replace(/^\/+/, "");
      const conteudo = str(args.conteudo, 200000) ?? "";
      if (!caminhoSeguro(caminho)) {
        throw new ToolError("Caminho não permitido. Use um caminho relativo terminando em .md ou .base (ou .obsidian/snippets/x.css).");
      }
      const { data, error } = await auth.db.from("pedidos_vault")
        .insert({ usuario_id: auth.userId, caminho, conteudo, origem: auth.clientId ?? "mcp" })
        .select("id, caminho").single();
      if (error) throw dbErr(error);
      return text(`Pedido registrado. O Obsidian vai criar "${data.caminho}" na próxima sincronização do computador principal (se ainda não existir).`);
    }
    case "editar_nota": {
      const caminho = caminhoNota(args.caminho);
      const propriedades = validarPropriedades(args.propriedades);
      const trocar = validarTrocas(args.trocar);
      const acrescentar = typeof args.acrescentar === "string" && args.acrescentar.trim() ? args.acrescentar.slice(0, 20000) : undefined;
      const conteudo = typeof args.conteudo === "string" ? args.conteudo : undefined;
      if (conteudo !== undefined && conteudo.length > 200000) throw new ToolError("conteudo grande demais (máx. 200 mil caracteres).");
      if (conteudo !== undefined && !conteudo.trim()) throw new ToolError("conteudo vazio. Para excluir uma nota, use excluir_nota (com confirmação da usuária).");
      if (conteudo !== undefined && (trocar || acrescentar)) throw new ToolError("Use 'conteudo' (nota inteira) OU 'trocar'/'acrescentar', não os dois.");
      if (!propriedades && !trocar && !acrescentar && conteudo === undefined) throw new ToolError("Nada para alterar: informe propriedades, trocar, acrescentar ou conteudo.");
      const nota = await notaAtual(auth, caminho, str(args.versao, 64));
      for (const t of trocar ?? []) {
        const n = contar(nota.conteudo, t.de);
        if (n !== 1) throw new ToolError(`O trecho "${t.de.slice(0, 80)}" aparece ${n} vez(es) no texto da nota; precisa aparecer exatamente 1. Nada foi alterado.`);
      }
      await semPendente(auth, caminho);
      const dados = { ...(propriedades ? { propriedades } : {}), ...(trocar ? { trocar } : {}), ...(acrescentar ? { acrescentar } : {}) };
      const p = await inserirPedido(auth, { caminho, acao: "editar", conteudo: conteudo ?? "", base_hash: nota.hash, dados: Object.keys(dados).length ? dados : null });
      const partes = [
        conteudo !== undefined ? "nota inteira reescrita" : "",
        propriedades ? `propriedades: ${Object.entries(propriedades).map(([k, v]) => v === null ? `${k} (remover)` : `${k} = ${JSON.stringify(v)}`).join(", ")}` : "",
        trocar ? `${trocar.length} trecho(s) trocado(s)` : "",
        acrescentar ? "texto acrescentado no fim" : "",
      ].filter(Boolean).join("; ");
      return text(`Pedido de edição registrado para "${nota.titulo}" (${partes}). O Obsidian aplica em até ~2 minutos no computador principal, com cópia de segurança; se a nota mudar antes disso, nada é alterado. Confira com ver_alteracoes. pedido_id: ${p.id}`);
    }
    case "atualizar_tarefa": {
      const caminho = caminhoNota(args.caminho);
      const nota = await notaAtual(auth, caminho, str(args.versao, 64));
      const tipo = String(nota.propriedades.tipo ?? "");
      const item = str(args.item, 300)?.trim();
      const concluida = typeof args.concluida === "boolean" ? args.concluida : undefined;
      let dados: Record<string, unknown>;
      let resumo: string;
      if (item) {
        if (concluida === undefined) throw new ToolError("Para um item de checklist, informe concluida: true (marcar) ou false (desmarcar).");
        if (["status", "prazo", "data", "prioridade"].some((k) => args[k] !== undefined)) {
          throw new ToolError("Num item de checklist só dá para marcar/desmarcar. Para mudar prazo, use editar_nota.");
        }
        const alvo = item.toLowerCase();
        const linhas = nota.conteudo.split("\n").filter((l) => CHECKBOX_RE.test(l) && l.toLowerCase().includes(alvo));
        if (linhas.length !== 1) {
          throw new ToolError(linhas.length === 0
            ? `Nenhum item de checklist com "${item}" nessa nota. Nada foi criado.`
            : `${linhas.length} itens de checklist têm "${item}": ${linhas.slice(0, 5).map((l) => l.trim()).join(" | ")}. Use um trecho que identifique só um.`);
        }
        dados = { item, concluida };
        resumo = `item "${linhas[0].trim().replace(CHECKBOX_RE, "")}" ${concluida ? "marcado como feito" : "desmarcado"}`;
      } else {
        const ehConta = TIPOS_CONTA.includes(tipo);
        if (!ehConta && !TIPOS_TAREFA.includes(tipo) && !("status" in nota.propriedades) && !("feita" in nota.propriedades)) {
          throw new ToolError(`Essa nota não é uma tarefa (tipo: ${tipo || "sem tipo"}). Para um checklist dentro dela, passe 'item'; para outras mudanças, use editar_nota.`);
        }
        const patch: Record<string, unknown> = {};
        const hoje = hojeRecife();
        if (concluida === true) Object.assign(patch, ehConta ? { status: "pago", pago_em: hoje } : { status: "feita", feita: true, concluida_em: hoje });
        if (concluida === false) Object.assign(patch, ehConta ? { status: "pendente", pago_em: null } : { status: "pendente", feita: false, concluida_em: null });
        const status = str(args.status, 40)?.trim();
        if (status) patch.status = status;
        const prazo = dataValida(args.prazo, "prazo");
        const data = dataValida(args.data, "data");
        if (prazo !== undefined) patch.prazo = prazo;
        if (data !== undefined) patch.data = data;
        if (args.prioridade !== undefined) {
          if (args.prioridade !== null && !["alta", "normal", "baixa"].includes(String(args.prioridade))) throw new ToolError("prioridade: alta, normal ou baixa.");
          patch.prioridade = args.prioridade;
        }
        if (!Object.keys(patch).length) throw new ToolError("Nada para alterar: informe concluida, status, prazo, data ou prioridade.");
        dados = { propriedades: patch };
        resumo = Object.entries(patch).map(([k, v]) => v === null ? `${k} removido` : `${k} = ${JSON.stringify(v)}`).join(", ");
      }
      await semPendente(auth, caminho);
      const p = await inserirPedido(auth, { caminho, acao: "tarefa", base_hash: nota.hash, dados });
      return text(`Pedido registrado para "${nota.titulo}": ${resumo}. Nenhuma tarefa nova foi criada. O Obsidian aplica em até ~2 minutos (com cópia de segurança). pedido_id: ${p.id}`);
    }
    case "mover_nota": {
      const caminho = caminhoNota(args.caminho);
      let destino = (str(args.destino, 300) ?? "").trim().replace(/^\/+/, "");
      if (!destino) throw new ToolError("Informe o destino (pasta terminando em '/' ou caminho completo .md).");
      const nome = caminho.split("/").pop()!;
      if (destino.endsWith("/")) destino += nome;
      else if (!destino.endsWith(".md")) destino += "/" + nome;
      destino = caminhoNota(destino);
      if (destino === caminho) throw new ToolError("O destino é igual ao caminho atual.");
      const nota = await notaAtual(auth, caminho, str(args.versao, 64));
      const { data: existe, error: e1 } = await auth.db.from("notas").select("id").eq("caminho", destino).maybeSingle();
      if (e1) throw dbErr(e1);
      if (existe) throw new ToolError(`Já existe uma nota em "${destino}". Nada foi movido.`);
      await semPendente(auth, caminho, destino);
      const p = await inserirPedido(auth, { caminho, destino, acao: "mover", base_hash: nota.hash });
      return text(`Pedido registrado: mover "${nota.titulo}" de "${caminho}" para "${destino}". O Obsidian aplica em até ~2 minutos e atualiza os links internos (se a opção estiver ligada). pedido_id: ${p.id}`);
    }
    case "apagar_nota": // nome antigo, mantido por compatibilidade: agora também exige confirmação
    case "excluir_nota": {
      const caminho = caminhoNota(args.caminho);
      const nota = await notaAtual(auth, caminho, str(args.versao, 64));
      const conf = str(args.confirmacao, 6)?.trim();
      if (!conf) {
        await semPendente(auth, caminho);
        const codigo = codigoConfirmacao();
        const { error } = await auth.db.from("confirmacoes_vault").insert({ usuario_id: auth.userId, caminho, base_hash: nota.hash, codigo });
        if (error) throw dbErr(error);
        return text(
          `NADA FOI EXCLUÍDO AINDA. Pergunte à usuária, com estas palavras ou parecidas: "Posso mover a nota '${nota.titulo}' ` +
          `(${caminho}) para a lixeira? Fica uma cópia de segurança." Só se ela responder que SIM, chame excluir_nota de novo com ` +
          `caminho="${caminho}" e confirmacao="${codigo}". O código vale 15 minutos e uma única vez. Não confirme sem o sim dela.`,
        );
      }
      if (!/^\d{6}$/.test(conf)) throw new ToolError("Código de confirmação inválido.");
      const { data: c, error: e2 } = await auth.db.from("confirmacoes_vault").select("id, base_hash")
        .eq("caminho", caminho).eq("codigo", conf).is("usado_em", null).gt("expira_em", new Date().toISOString())
        .order("criado_em", { ascending: false }).limit(1).maybeSingle();
      if (e2) throw dbErr(e2);
      if (!c) throw new ToolError("Código inválido, já usado ou expirado. Comece de novo (sem 'confirmacao') e pergunte à usuária. Nada foi excluído.");
      if (c.base_hash !== nota.hash) throw new ToolError("A nota mudou depois do pedido de confirmação. Comece de novo e pergunte à usuária. Nada foi excluído.");
      const { data: usado, error: e3 } = await auth.db.from("confirmacoes_vault").update({ usado_em: new Date().toISOString() })
        .eq("id", c.id).is("usado_em", null).select("id");
      if (e3) throw dbErr(e3);
      if (!usado?.length) throw new ToolError("Esse código já foi usado. Nada foi excluído.");
      await semPendente(auth, caminho);
      const p = await inserirPedido(auth, { caminho, acao: "apagar", base_hash: nota.hash });
      return text(`Exclusão confirmada e registrada para "${nota.titulo}". Em até ~2 minutos o Obsidian guarda uma cópia em '05 - Sistema/Backups/' e manda a nota para a lixeira (dá para recuperar). pedido_id: ${p.id}`);
    }
    case "salvar_imagem": {
      const arquivo = args.arquivo && typeof args.arquivo === "object" ? args.arquivo as Record<string, unknown> : null;
      const origemArquivo = typeof arquivo?.download_url === "string" ? arquivo.download_url : "";
      const origemUrl = str(args.url, 2000)?.trim() ?? "";
      if (!origemArquivo && !origemUrl) throw new ToolError("Envie a imagem em 'arquivo' ou o link dela em 'url'.");
      const pasta = pastaSegura(args.pasta);
      let nota: string | undefined, notaHash: string | undefined, notaTitulo = "";
      const propriedade = (str(args.propriedade, 60) ?? "foto").trim() || "foto";
      if (!CHAVE_RE.test(propriedade)) throw new ToolError("Nome de propriedade inválido.");
      if (args.nota) {
        nota = caminhoNota(args.nota);
        const n = await notaAtual(auth, nota, str(args.versao, 64));
        notaHash = n.hash; notaTitulo = n.titulo;
        await semPendente(auth, nota);
      }
      // O arquivo enviado no ChatGPT vem por um link temporário do próprio ChatGPT; links informados
      // pela IA passam pela checagem de link público.
      const bytes = await baixarImagem(origemArquivo || origemUrl, Boolean(origemArquivo) && /^https:\/\//.test(origemArquivo));
      const tipo = tipoImagem(bytes);
      if (!tipo) throw new ToolError("O arquivo não é uma imagem JPG, PNG, WEBP ou GIF.");
      const nome = limparNome(str(args.nome, 100) ?? "") || limparNome(notaTitulo) || `Imagem ${hojeRecife()}`;
      const caminho = `${pasta}/${nome}.${tipo.ext}`;
      if (caminho.length > 300) throw new ToolError("Nome ou pasta longos demais.");
      const objeto = `${auth.userId}/${crypto.randomUUID()}.${tipo.ext}`;
      const { error: eUp } = await auth.db.storage.from("vault-imagens").upload(objeto, bytes, { contentType: tipo.mime, upsert: false });
      if (eUp) throw new Error(`storage:${(eUp as { statusCode?: string }).statusCode ?? "erro"}`);
      const p = await inserirPedido(auth, {
        caminho, acao: "imagem",
        dados: { objeto, tamanho: bytes.length, ...(nota ? { nota, nota_hash: notaHash, propriedade } : {}) },
      });
      return text(
        `Imagem conferida (${tipo.ext.toUpperCase()}, ${Math.round(bytes.length / 1024)} KB). Em até ~2 minutos o Obsidian ` +
        `salva em "${caminho}"` + (nota ? ` e coloca na propriedade '${propriedade}' de "${notaTitulo}"` : "") +
        `. Confira com ver_alteracoes. pedido_id: ${p.id}`,
      );
    }
    case "ver_alteracoes": {
      const limite = Math.min(Math.max(Number(args.limite ?? 10) || 10, 1), 50);
      const filtro = str(args.caminho, 300)?.trim().replace(/^\/+/, "");
      const campos = "id, acao, caminho, destino, origem, criado_em, aplicado_em, resultado";
      const consultas = filtro
        ? ["caminho", "destino"].map((col) => auth.db.from("pedidos_vault").select(campos).eq(col, filtro).order("criado_em", { ascending: false }).limit(limite))
        : [auth.db.from("pedidos_vault").select(campos).order("criado_em", { ascending: false }).limit(limite)];
      const linhas: Array<Record<string, unknown>> = [];
      for (const q of consultas) {
        const { data, error } = await q;
        if (error) throw dbErr(error);
        for (const r of data ?? []) if (!linhas.some((x) => x.id === r.id)) linhas.push(r);
      }
      linhas.sort((a, b) => String(b.criado_em).localeCompare(String(a.criado_em)));
      const alteracoes = linhas.slice(0, limite).map((r) => {
        const res = String(r.resultado ?? "");
        return {
          pedido_id: r.id, acao: r.acao, caminho: r.caminho, ...(r.destino ? { destino: r.destino } : {}),
          pedido_por: nomeOrigem(r.origem), pedido_em: r.criado_em,
          situacao: !r.aplicado_em ? "pendente (o computador principal ainda não aplicou)" : /^(recusado|erro)/.test(res) ? "recusada" : "aplicada",
          ...(r.aplicado_em ? { aplicado_em: r.aplicado_em, resultado: res } : {}),
        };
      });
      let rq = auth.db.from("recusas_mcp").select("ferramenta, caminho, motivo, origem, criado_em").order("criado_em", { ascending: false }).limit(limite);
      if (filtro) rq = rq.eq("caminho", filtro);
      const { data: rec, error: er } = await rq;
      if (er) throw dbErr(er);
      const recusadas_pelo_servidor = (rec ?? []).map((r) => ({ ferramenta: r.ferramenta, caminho: r.caminho, motivo: r.motivo, pedido_por: nomeOrigem(r.origem), em: r.criado_em }));
      const saida = { alteracoes, recusadas_pelo_servidor };
      return text(alteracoes.length || recusadas_pelo_servidor.length ? JSON.stringify(saida, null, 2) : "Nenhuma alteração encontrada.", saida);
    }
    case "search": {
      const rows = await buscar(auth, str(args.query, 500) ?? "", 10);
      return text(JSON.stringify({ results: rows.map((r) => ({ id: r.id, title: r.titulo, url: itemUrl(r.id) })) }));
    }
    case "fetch": {
      const m = await ler(auth, String(args.id ?? "")) as Record<string, unknown>;
      return text(JSON.stringify({
        id: m.id, title: m.titulo, text: m.conteudo, url: itemUrl(String(m.id)),
        metadata: m.tipo === "nota"
          ? { ...(m.propriedades as Record<string, unknown> ?? {}), caminho: m.caminho, versao: m.versao }
          : { categoria: m.categoria, fonte: m.fonte },
      }));
    }
    default:
      return null;
  }
}

// Guarda o motivo de uma alteração recusada (sem conteúdo da nota) para aparecer em ver_alteracoes.
const EDICAO_TOOLS = ["editar_nota", "atualizar_tarefa", "mover_nota", "excluir_nota", "apagar_nota", "salvar_imagem"];
async function registrarRecusa(auth: Auth, ferramenta: string, args: Record<string, unknown> | undefined, e: unknown) {
  try {
    const motivo = e instanceof ToolError ? e.message : `erro interno do servidor (${String((e as Error)?.message ?? "").slice(0, 60)})`;
    const c = args?.caminho ?? args?.nota;
    const caminho = typeof c === "string" ? c.slice(0, 300) : null;
    await auth.db.from("recusas_mcp").insert({ usuario_id: auth.userId, ferramenta, caminho, motivo: motivo.slice(0, 400), origem: auth.clientId ?? "mcp" });
  } catch { /* o registro nunca pode atrapalhar a resposta */ }
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
            "Este é o Segundo Cérebro pessoal da usuária (espelho do Obsidian dela). Para perguntas " +
            "sobre a vida, pessoas, casa, família, trabalho, documentos ou ideias dela, pesquise aqui " +
            "com 'buscar' (e 'datas' para prazos) " +
            "antes de responder, e cite o título da nota usada. " +
            "Para MUDAR algo que já existe, nunca crie nota nova: 'buscar' → 'ler' → editar_nota (propriedades/trocar/" +
            "acrescentar), atualizar_tarefa (feita, prazo, prioridade), mover_nota ou excluir_nota. Datas em AAAA-MM-DD. " +
            "excluir_nota sempre exige perguntar à usuária e receber um 'sim' claro antes da 2ª chamada. " +
            "As mudanças são aplicadas pelo Obsidian do computador principal em até ~2 minutos; confira com 'ver_alteracoes'. " +
            "Agenda (notas em '07 - Agenda', tipo tarefa, compromisso ou lembrete): dia em 'data'; horário em 'hora' e 'hora_fim' " +
            "no formato 14h30 (ou 'duracao_min'); com hora, o item aparece na semana por horário do Planejamento. " +
            "Jurídico ('02 - Trabalho/🗂️ Jurídico'): 4 divisões — '⛽ Postos', '💻 Cloone', '🏝️ Noronha' e '👤 Pessoal' —, cada uma com " +
            "'📄 Documentos/<Empresa>/' (ficha tipo empresa + documentos tipo contrato, societario, procuracao ou documento, com " +
            "'empresa' = link da ficha, 'vencimento' AAAA-MM-DD, 'status' vigente/encerrado, 'risco' Crítico/Alto/Médio/Baixo e, no " +
            "texto, resumo, principais informações, principais regras (cláusulas) e próximos passos) e '⚖️ Processos/' (uma nota por " +
            "processo, tipo processo, com empresa, numero, tribunal, vara, partes, status em andamento/suspenso/encerrado/arquivado, " +
            "fase, prazo = próximo prazo, e os andamentos no texto). Prazos contratuais (tipo prazo) em '⛽ Postos/⏳ Prazos', com a caixinha 'feita' (cumpriu → atualizar_tarefa concluida: true). Só registre o que está no " +
            "documento. O Obsidian cria sozinho uma tarefa de aviso antes de cada vencimento ou prazo de processo ('alerta_dias' muda a antecedência). " +
            "Financeiro: cada gasto é uma nota tipo lancamento em '06 - Financeiro/Lancamentos/' com natureza (despesa/receita), " +
            "valor, data (AAAA-MM-DD), mes_pagamento (AAAA-MM), status, categoria — UM destes valores exatos: mercado, farmácia, casa, " +
            "contas da casa, funcionárias, saúde, pets, filhos, transporte, alimentação fora, lazer, roupas e beleza, educação, assinaturas, " +
            "trabalho, outros — e forma_pagamento — UM destes: PIX/Dinheiro, Cartão XP, Cartão BTG, Cartão Nubank, Cartão Itaú, Cartão Guy " +
            "(se a usuária não disser, pergunte; não deduza). Compra parcelada: crie UMA nota com o valor TOTAL e 'parcelas' (número); " +
            "o Obsidian cria sozinho uma parcela por mês (não crie as parcelas você mesmo); 'primeira_parcela' (AAAA-MM) muda o mês da 1ª. " +
            "Filmes, séries, documentários e livros: uma nota por título (tipo: midia) em '03 - Conhecimento/🎬 Filmes, séries e livros/Títulos/', " +
            "com formato (Filme, Série, Documentário, Livro), status (quero assistir, assistindo, assistido, quero ler, lendo, lido, " +
            "abandonei), estrelas (1 a 5), ano_concluido, onde, indicado_por e capa (imagem via salvar_imagem na pasta " +
            "'03 - Conhecimento/🎬 Filmes, séries e livros/Capas', propriedade 'capa'). " +
            "Projeto Afiloop (afiliados de Shein, Shopee, Mercado Livre e outras lojas; a loja vai na propriedade 'loja'): notas em '04 - Projetos/Afiloop/' (posts, peças, looks, " +
            "grifes). Toda peça, look e post tem a propriedade 'nicho' com UM destes valores exatos: Fashion, Beauty, Casa " +
            "(casa, decoração e cozinha) ou Maternidade — sempre preencha. Fotos e vídeos de produto no Google Drive ficam em " +
            "'Afiloop/👗 Fashion', 'Afiloop/💄 Beauty', 'Afiloop/🏠 Casa, decoração e cozinha' ou 'Afiloop/🍼 Maternidade', " +
            "numa subpasta com o código do produto; o link da pasta vai na propriedade 'drive' da peça. Outras regras do " +
            "Afiloop: fotos das peças e imagens dos posts vão para o Vault com salvar_imagem (ligadas à propriedade 'foto' da nota); " +
            "leia a nota '🚀 Afiloop' antes de criar ou mudar posts e siga as regras dela: não inventar preço " +
            "nem característica, comparativos só de estética, nada publica sem aprovação da usuária.",
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
          if (EDICAO_TOOLS.includes(tool)) await registrarRecusa(auth, tool, msg.params?.arguments, e);
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
