// Aplica a função SQL de busca e publica a Edge Function cerebro-mcp.
// Não apaga nada. Gera docs/config.js com dados PÚBLICOS (URL + chave publishable).
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { project, sql, keys, PLACEHOLDER } from "./sb.mjs";

const p = await project();
console.log("Projeto:", p.name, p.ref);

for (const f of ["20261104000001_busca_memorias.sql", "20261104000002_notas_obsidian.sql", "20261104000003_pedidos_vault.sql", "20261104000004_pedidos_substituir.sql", "20261105000005_pedidos_editar.sql"]) {
  await sql(p.ref, readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), "utf8"));
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
