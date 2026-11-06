// Aplica a função SQL de busca e publica a Edge Function cerebro-mcp.
// Não apaga nada. Gera docs/config.js com dados PÚBLICOS (URL + chave publishable).
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { project, sql, keys, PLACEHOLDER } from "./sb.mjs";

const p = await project();
console.log("Projeto:", p.name, p.ref);

// Cada migração roda UMA vez: as já aplicadas ficam registradas em public.migracoes_cerebro
// (tabela só de controle, com RLS ligado e sem políticas: invisível para os apps).
const MIGRACOES = ["20261104000001_busca_memorias.sql", "20261104000002_notas_obsidian.sql", "20261104000003_pedidos_vault.sql",
  "20261104000004_pedidos_substituir.sql", "20261105000005_pedidos_editar.sql", "20261106000006_pedidos_apagar.sql",
  "20261106000007_edicao_completa.sql", "20261106000008_recusas_mcp.sql", "20261106000009_imagens.sql"];
// Já estavam aplicadas em produção antes de existir o registro.
const JA_APLICADAS = MIGRACOES.slice(0, 6);
await sql(p.ref, `create table if not exists public.migracoes_cerebro (nome text primary key, aplicado_em timestamptz not null default now());
  alter table public.migracoes_cerebro enable row level security;
  revoke all on public.migracoes_cerebro from anon, authenticated;
  insert into public.migracoes_cerebro (nome) select unnest(array[${JA_APLICADAS.map((m) => `'${m}'`).join(",")}])
    where not exists (select 1 from public.migracoes_cerebro) on conflict do nothing;`);
const feitas = new Set((await sql(p.ref, "select nome from public.migracoes_cerebro", true)).map((r) => r.nome));
for (const f of MIGRACOES) {
  if (feitas.has(f)) { console.log("· já aplicada:", f); continue; }
  const corpo = readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), "utf8");
  await sql(p.ref, `begin;\n${corpo}\ninsert into public.migracoes_cerebro (nome) values ('${f}');\ncommit;`);
  console.log("✔ SQL aplicado:", f, "(sem apagar nada; RLS preservado)");
}

execFileSync("npx", ["-y", "supabase@3.0.0", "functions", "deploy", "cerebro-mcp",
  "--project-ref", p.ref, "--no-verify-jwt", "--use-api", "--yes"],
  { stdio: "inherit", cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: process.env.SUPABASE_ACCESS_TOKEN || PLACEHOLDER } });
console.log("✔ Edge Function publicada:", `${p.url}/functions/v1/cerebro-mcp`);

const k = await keys(p.ref);
writeFileSync(new URL("../docs/config.js", import.meta.url),
  `// Dados públicos (a chave publishable é feita para ficar no navegador; o RLS protege os dados).\n` +
  `export default ${JSON.stringify({ supabaseUrl: p.url, supabaseKey: k.publishable }, null, 2)};\n`);
console.log("✔ docs/config.js gerado");

// Plugin do Obsidian já configurado com a URL e a chave PÚBLICA do projeto.
const { mkdirSync, copyFileSync } = await import("node:fs");
const dist = new URL("../obsidian-plugin/dist/", import.meta.url);
mkdirSync(dist, { recursive: true });
const main = readFileSync(new URL("../obsidian-plugin/main.js", import.meta.url), "utf8")
  .replace('supabaseUrl: "",', `supabaseUrl: ${JSON.stringify(p.url)},`)
  .replace('supabaseKey: "",', `supabaseKey: ${JSON.stringify(k.publishable)},`);
writeFileSync(new URL("main.js", dist), main);
copyFileSync(new URL("../obsidian-plugin/manifest.json", import.meta.url), new URL("manifest.json", dist));
console.log("✔ Plugin do Obsidian pronto em obsidian-plugin/dist/");
