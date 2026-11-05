// Fila da organização: telas atualizadas no ENDEREÇO ANTIGO (o plugin aplica pedidos antes de mover)
// + nova configuração (versão com "organizar"). Uso: node scripts/enfileirar_organizacao.mjs [--simular]
import { readFileSync, writeFileSync } from "node:fs";
const peds = JSON.parse(readFileSync(new URL("../interface/v3/pedidos.json", import.meta.url), "utf8"));
const cfgTxt = peds.find((x) => x.caminho.includes("Configuração")).conteudo;
const cfg = JSON.parse(cfgTxt.split("```json\n")[1].split("\n```")[0]);
const antigo = Object.fromEntries(cfg.organizar.mover.map((m) => [m.para, m.de]));
const QUAIS = ["🏠 Minha Central.md", "01 - Vida/🏡 Minha Vida.md", "01 - Vida/Casa/🛒 Casa e Compras.md", "01 - Vida/📁 Documentos.md",
  "05 - Sistema/Painéis/Diário.base", "05 - Sistema/⚙️ Configuração do Segundo Cérebro.md"];
const lote = QUAIS.map((c) => { const x = peds.find((p) => p.caminho === c); if (!x) throw new Error("faltou " + c);
  return { caminho: antigo[c] || c, acao: "substituir", conteudo: x.conteudo }; });
writeFileSync(new URL("../interface/v3/lote-organizacao.json", import.meta.url), JSON.stringify(lote, null, 1));
if (process.argv.includes("--simular")) { lote.forEach((x) => console.log(" substituir", x.caminho)); process.exit(0); }
const { project, sql } = await import("./sb.mjs");
const p = await project();
const [u] = await sql(p.ref, "select count(*)::int as n, min(id::text) as id from auth.users", true);
if (u.n !== 1) throw new Error("Esperava exatamente 1 usuária.");
const lit = (s) => "$sc$" + s.replace(/\$sc\$/g, "") + "$sc$";
const r = await sql(p.ref, `insert into public.pedidos_vault (usuario_id, caminho, conteudo, acao, origem) values ${lote.map((x) => `('${u.id}', ${lit(x.caminho)}, ${lit(x.conteudo)}, 'substituir', 'claude-code:organizacao')`).join(",")} returning caminho`);
r.forEach((x) => console.log(" substituir", x.caminho));
