// Utilitários para a API de gerenciamento do Supabase.
// O token vem do cofre do ambiente (injetado pelo proxy em api.supabase.com) ou,
// se existir, da variável SUPABASE_ACCESS_TOKEN. Nunca imprime segredos.
export const PROJECT_NAME = process.env.SUPABASE_PROJECT_NAME ?? "meu-segundo-cerebro";
// Sem token local, enviamos um marcador no formato aceito pelo CLI; o proxy troca pelo token real.
export const PLACEHOLDER = "sbp_" + "0".repeat(40);
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN || PLACEHOLDER;
const API = "https://api.supabase.com/v1";

export async function api(path, { method = "GET", body } = {}) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const txt = await r.text();
  let data; try { data = JSON.parse(txt); } catch { data = txt; }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${typeof data === "string" ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`);
  return data;
}

export async function project() {
  const ref = process.env.SUPABASE_PROJECT_REF;
  const list = await api("/projects");
  const p = ref ? list.find((x) => x.id === ref || x.ref === ref) : list.find((x) => x.name === PROJECT_NAME);
  if (!p) throw new Error(`Projeto "${PROJECT_NAME}" não encontrado. Projetos visíveis: ${list.map((x) => x.name).join(", ")}`);
  return { ref: p.ref ?? p.id, name: p.name, region: p.region, status: p.status, url: `https://${p.ref ?? p.id}.supabase.co` };
}

export const sql = (ref, query, read_only = false) =>
  api(`/projects/${ref}/database/query`, { method: "POST", body: { query, read_only } });

export async function keys(ref, reveal = false) {
  const ks = await api(`/projects/${ref}/api-keys?reveal=${reveal}`);
  const pub = ks.find((k) => k.type === "publishable") ?? ks.find((k) => k.name === "anon");
  const sec = ks.find((k) => k.type === "secret" && k.api_key) ?? ks.find((k) => k.name === "service_role");
  return { publishable: pub?.api_key, secret: reveal ? sec?.api_key : undefined };
}
