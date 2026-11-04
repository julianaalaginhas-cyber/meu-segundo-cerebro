// Coloca os arquivos de interface/vault na fila pedidos_vault da (única) usuária do projeto.
// O plugin Ponte cria cada arquivo SOMENTE se ele ainda não existir no Vault.
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { project, sql } from "./sb.mjs";
const raiz = new URL("../interface/vault/", import.meta.url).pathname;
const lista = []; const andar = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? andar(p) : lista.push(p); } }; andar(raiz);
const p = await project();
const [u] = await sql(p.ref, "select count(*)::int as n, min(id::text) as id from auth.users", true);
if (u.n !== 1) throw new Error("Esperava exatamente 1 usuária no projeto.");
const lit = (s) => "$sc$" + s.replace(/\$sc\$/g, "") + "$sc$";
const valores = lista.map((f) => `('${u.id}', ${lit(relative(raiz, f))}, ${lit(readFileSync(f, "utf8"))}, 'claude-code:interface-v1')`).join(",\n");
const r = await sql(p.ref, `insert into public.pedidos_vault (usuario_id, caminho, conteudo, origem) values ${valores} returning caminho`);
console.log(`${r.length} arquivos na fila:`); r.forEach((x) => console.log(" -", x.caminho));
