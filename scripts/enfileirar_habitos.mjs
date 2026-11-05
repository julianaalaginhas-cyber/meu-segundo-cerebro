// Fila dos hábitos: painéis Diário/Rotina, tela Hábitos, notas dos hábitos, modelo do dia e configuração v4
// (só diário + captura; favoritos e página inicial ficam como estão).
import { readFileSync } from "node:fs";
import { project, sql } from "./sb.mjs";
const peds = JSON.parse(readFileSync(new URL("../interface/v3/pedidos.json", import.meta.url), "utf8"));
const pega = (c) => { const x = peds.find((p) => p.caminho === c); if (!x) throw new Error("faltou " + c); return x; };
const lote = ["05 - Sistema/Painéis/Diário.base", "05 - Sistema/Painéis/Rotina.base", "01 - Vida/Rotina/🔁 Hábitos.md",
  "01 - Vida/Rotina/Hábitos/🏋️ Treinar.md", "01 - Vida/Rotina/Hábitos/🏃 Cardio.md", "01 - Vida/Rotina/Hábitos/🧴 Skincare.md",
  "05 - Sistema/Modelos/Modelo - Dia com hábitos.md"].map(pega);
const nota = pega("05 - Sistema/⚙️ Configuração do Segundo Cérebro.md").conteudo;
const cfg = JSON.parse(nota.split("```json\n")[1].split("\n```")[0]);
const novo = { versao: 4, pastas: [...cfg.pastas, "01 - Vida/Rotina/Hábitos"], diario: cfg.diario, captura: cfg.captura,
  organizar: { mover: [], lixeira: [{ caminho: "05 - Sistema/Modelos/Modelo - Dia.md", condicao: "sem_uso" }] },
  referencia: { favoritos: cfg.favoritos, inicio: cfg.inicio } };
lote.push({ caminho: "05 - Sistema/⚙️ Configuração do Segundo Cérebro.md", acao: "substituir",
  conteudo: nota.split("```json\n")[0] + "```json\n" + JSON.stringify(novo, null, 1) + "\n```\n" });
const p = await project();
const [u] = await sql(p.ref, "select count(*)::int as n, min(id::text) as id from auth.users", true);
if (u.n !== 1) throw new Error("Esperava exatamente 1 usuária.");
const lit = (s) => "$sc$" + s + "$sc$";
const r = await sql(p.ref, `insert into public.pedidos_vault (usuario_id, caminho, conteudo, acao, origem) values ${lote.map((x) => `('${u.id}', ${lit(x.caminho)}, ${lit(x.conteudo)}, '${x.acao}', 'claude-code:habitos')`).join(",")} returning acao, caminho`);
r.forEach((x) => console.log(` ${x.acao.padEnd(10)} ${x.caminho}`));
