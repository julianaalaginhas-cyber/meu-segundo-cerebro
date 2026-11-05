// Recoloca na fila só os pedidos "substituir" de um arquivo de pedidos (ex.: interface/v3/pedidos.json).
import { readFileSync } from "node:fs";
import { project, sql } from "./sb.mjs";
const arquivo = process.argv[2] || "interface/v3/pedidos.json";
const so = process.argv.slice(3); // opcional: só estes caminhos
const peds = JSON.parse(readFileSync(arquivo, "utf8")).filter((x) => x.acao === "substituir" && !x.caminho.includes("Configuração") && (!so.length || so.includes(x.caminho)));
const p = await project();
const [u] = await sql(p.ref, "select count(*)::int as n, min(id::text) as id from auth.users", true);
if (u.n !== 1) throw new Error("Esperava exatamente 1 usuária.");
const lit = (s) => "$sc$" + s.replace(/\$sc\$/g, "") + "$sc$";
const r = await sql(p.ref, `insert into public.pedidos_vault (usuario_id, caminho, conteudo, acao, origem) values ${peds.map((x) => `('${u.id}', ${lit(x.caminho)}, ${lit(x.conteudo)}, 'substituir', 'claude-code:etapa1-reenvio')`).join(",")} returning caminho`);
r.forEach((x) => console.log(" substituir", x.caminho));
