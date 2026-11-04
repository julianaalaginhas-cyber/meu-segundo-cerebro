// Aplica a função SQL de busca e publica a Edge Function cerebro-mcp.
// Não apaga nada. Gera consentimento/config.js com dados PÚBLICOS (URL + chave publishable).
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { project, sql, keys } from "./sb.mjs";

const p = await project();
console.log("Projeto:", p.name, p.ref);

const mig = readFileSync(new URL("../supabase/migrations/20261104000001_busca_memorias.sql", import.meta.url), "utf8");
await sql(p.ref, mig);
console.log("✔ Função SQL buscar_memorias aplicada (security invoker, RLS preservado)");

execFileSync("npx", ["-y", "supabase@3.0.0", "functions", "deploy", "cerebro-mcp",
  "--project-ref", p.ref, "--no-verify-jwt", "--use-api"],
  { stdio: "inherit", cwd: new URL("..", import.meta.url).pathname });
console.log("✔ Edge Function publicada:", `${p.url}/functions/v1/cerebro-mcp`);

const k = await keys(p.ref);
writeFileSync(new URL("../consentimento/config.js", import.meta.url),
  `// Dados públicos (a chave publishable é feita para ficar no navegador; o RLS protege os dados).\n` +
  `export default ${JSON.stringify({ supabaseUrl: p.url, supabaseKey: k.publishable }, null, 2)};\n`);
console.log("✔ consentimento/config.js gerado");
