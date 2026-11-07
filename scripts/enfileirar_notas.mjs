// Enfileira notas novas (acao "criar": nunca sobrescreve) a partir de um JSON fora do repositório.
// Uso: node scripts/enfileirar_notas.mjs <arquivo.json> <origem>
// O JSON é uma lista [{ caminho, conteudo }]. Os dados pessoais ficam só no arquivo, não aqui.
import { readFileSync } from "node:fs";
import { project, sql } from "./sb.mjs";

const [arquivo, origem = "claude-code:notas"] = process.argv.slice(2);
if (!arquivo) throw new Error("Informe o arquivo JSON.");
const lote = JSON.parse(readFileSync(arquivo, "utf8"));
for (const n of lote) {
  if (!/\.(md|base)$/.test(n.caminho ?? "") || n.caminho.includes("..") || n.caminho.startsWith("/")) throw new Error("Caminho inválido: " + n.caminho);
  if (n.conteudo.includes("$sc$")) throw new Error("Conteúdo com delimitador reservado: " + n.caminho);
}
const p = await project();
const [u] = await sql(p.ref, "select count(*)::int as n, min(id::text) as id from auth.users", true);
if (u.n !== 1) throw new Error("Esperava exatamente 1 usuária.");
const lit = (s) => "$sc$" + s + "$sc$";
const r = await sql(p.ref, `insert into public.pedidos_vault (usuario_id, caminho, conteudo, acao, origem) values ${lote
  .map((x) => `('${u.id}', ${lit(x.caminho)}, ${lit(x.conteudo)}, 'criar', ${lit(origem)})`).join(",")} returning caminho`);
console.log(`${r.length} notas na fila:`);
r.forEach((x) => console.log("  " + x.caminho));
