// Coloca na fila as telas da v2 (interface/v2/pedidos.json), com a ação de cada uma.
import { readFileSync } from "node:fs";
import { project, sql } from "./sb.mjs";
const peds = JSON.parse(readFileSync(new URL("../interface/v2/pedidos.json", import.meta.url), "utf8"));
const p = await project();
const [u] = await sql(p.ref, "select count(*)::int as n, min(id::text) as id from auth.users", true);
if (u.n !== 1) throw new Error("Esperava exatamente 1 usuária.");
const lit = (s) => "$sc$" + s.replace(/\$sc\$/g, "") + "$sc$";
const valores = peds.map((x) => `('${u.id}', ${lit(x.caminho)}, ${lit(x.conteudo)}, '${x.acao}', 'claude-code:interface-v2')`).join(",\n");
const r = await sql(p.ref, `insert into public.pedidos_vault (usuario_id, caminho, conteudo, acao, origem) values ${valores} returning acao, caminho`);
r.forEach((x) => console.log(` ${x.acao.padEnd(10)} ${x.caminho}`));
