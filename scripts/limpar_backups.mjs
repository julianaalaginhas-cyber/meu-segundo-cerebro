// Lixeira (recuperável) dos backups antigos: mantém o backup mais recente de cada tela
// e o backup de configuração mais recente. Aplica-se pela nota de configuração (nova versão),
// sem reaplicar favoritos/QuickAdd/Homepage (essas seções ficam guardadas como referência).
import { readFileSync } from "node:fs";
import { project, sql } from "./sb.mjs";
const p = await project();
const r = await sql(p.ref, `select caminho, resultado, aplicado_em from public.pedidos_vault where resultado like 'substituído (backup em%' order by aplicado_em`, true);
const porArquivo = {};
for (const x of r) (porArquivo[x.caminho] ||= []).push(x.resultado.match(/backup em (.*)\)$/)[1]);
const apagar = Object.values(porArquivo).flatMap((l) => l.slice(0, -1));
const cfgAntigas = ["2026-11-05 11h14 configuração"];
const nomesCfg = ["config-daily-notes.json", "config-bookmarks.json", "config-plugins ∕ quickadd ∕ data.json", "config-plugins ∕ homepage ∕ data.json"];
for (const pasta of cfgAntigas) for (const n of nomesCfg) apagar.push(`05 - Sistema/Backups/${pasta}/${n}`);
const peds = JSON.parse(readFileSync(new URL("../interface/v3/pedidos.json", import.meta.url), "utf8"));
const nota = peds.find((x) => x.caminho.includes("Configuração")).conteudo;
const cfg = JSON.parse(nota.split("```json\n")[1].split("\n```")[0]);
const { favoritos, inicio, diario, captura, organizar, ...resto } = cfg;
const novo = { ...resto, versao: 3, referencia: { favoritos, inicio, diario, captura },
  organizar: { mover: [], lixeira: [
    ...apagar.map((c) => ({ caminho: c, condicao: "sem_uso" })),
    ...["Planejamento", "Entrada", "Vida"].map((b) => ({ caminho: `05 - Sistema/Painéis/${b}.base`, condicao: "sem_uso" })),
  ] } };
const conteudo = nota.split("```json\n")[0] + "```json\n" + JSON.stringify(novo, null, 1) + "\n```\n";
const [u] = await sql(p.ref, "select count(*)::int as n, min(id::text) as id from auth.users", true);
if (u.n !== 1) throw new Error("Esperava exatamente 1 usuária.");
const lit = (s) => "$sc$" + s + "$sc$";
await sql(p.ref, `insert into public.pedidos_vault (usuario_id, caminho, conteudo, acao, origem) values ('${u.id}', ${lit("05 - Sistema/⚙️ Configuração do Segundo Cérebro.md")}, ${lit(conteudo)}, 'substituir', 'claude-code:limpeza')`);
console.log(`na fila: ${apagar.length} backups antigos + 3 painéis sem uso (versão ${novo.versao} da configuração)`);
apagar.forEach((c) => console.log("  🗑️", c.replace("05 - Sistema/Backups/", "")));
