// Diagnóstico SOMENTE LEITURA do projeto Supabase. Não altera nada.
import { api, project, sql, keys } from "./sb.mjs";

const p = await project();
console.log("Projeto:", p.name, "| região:", p.region, "| status:", p.status);

const q = async (titulo, query) => {
  try { console.log(`\n# ${titulo}\n`, JSON.stringify(await sql(p.ref, query, true), null, 1)); }
  catch (e) { console.log(`\n# ${titulo}\n  ERRO: ${e.message}`); }
};
await q("Tabela memorias + RLS", `select relname, relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.memorias'::regclass`);
await q("Colunas", `select column_name, data_type, is_nullable from information_schema.columns where table_schema='public' and table_name='memorias' order by ordinal_position`);
await q("Políticas", `select policyname, cmd, roles, qual, with_check from pg_policies where schemaname='public' and tablename='memorias'`);
await q("Memórias por categoria (só contagem)", `select categoria, count(*) from public.memorias group by 1`);
await q("Registro de teste existe?", `select count(*) as qtd from public.memorias where categoria='teste' and titulo ilike '%Teste de conex%'`);
await q("Usuários (só contagem)", `select count(*) as usuarios from auth.users`);
await q("Função de busca", `select proname, prosecdef from pg_proc where proname='buscar_memorias'`);
await q("Grants na tabela", `select grantee, string_agg(privilege_type, ',') from information_schema.role_table_grants where table_schema='public' and table_name='memorias' group by 1`);

try {
  const fns = await api(`/projects/${p.ref}/functions`);
  console.log("\n# Edge Functions:", fns.map((f) => `${f.slug} (v${f.version}, verify_jwt=${f.verify_jwt}, ${f.status})`).join("; ") || "nenhuma");
} catch (e) { console.log("\n# Edge Functions: ERRO", e.message); }

try {
  const a = await api(`/projects/${p.ref}/config/auth`);
  const pick = Object.fromEntries(Object.entries(a).filter(([k]) =>
    /oauth_server|site_url|uri_allow_list|jwt_exp|disable_signup|external_email_enabled|mailer_autoconfirm|password_min/.test(k)));
  console.log("\n# Config Auth relevante:", JSON.stringify(pick, null, 1));
} catch (e) { console.log("\n# Config Auth: ERRO", e.message); }

try {
  const sk = await api(`/projects/${p.ref}/config/auth/signing-keys`);
  console.log("\n# Chaves de assinatura JWT:", JSON.stringify((sk.keys ?? sk).map?.((k) => ({ alg: k.algorithm, status: k.status })) ?? sk));
} catch (e) { console.log("\n# Chaves de assinatura JWT: ERRO", e.message); }

const k = await keys(p.ref);
console.log("\n# Chave pública (publishable/anon) disponível:", Boolean(k.publishable));
try {
  const r = await fetch(`${p.url}/.well-known/oauth-authorization-server/auth/v1`);
  const d = await r.json();
  console.log("\n# Descoberta OAuth:", r.status, JSON.stringify({ issuer: d.issuer, registration_endpoint: d.registration_endpoint, scopes: d.scopes_supported, pkce: d.code_challenge_methods_supported }));
} catch (e) { console.log("\n# Descoberta OAuth: ERRO", e.message); }
