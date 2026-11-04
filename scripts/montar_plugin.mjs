// Monta obsidian-plugin/dist (main.js com URL + chave PÚBLICA) sem tocar no Supabase.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
const cfg = readFileSync(new URL("../docs/config.js", import.meta.url), "utf8");
const url = cfg.match(/"supabaseUrl":\s*"([^"]+)"/)[1], key = cfg.match(/"supabaseKey":\s*"([^"]+)"/)[1];
const dist = new URL("../obsidian-plugin/dist/", import.meta.url); mkdirSync(dist, { recursive: true });
writeFileSync(new URL("main.js", dist), readFileSync(new URL("../obsidian-plugin/main.js", import.meta.url), "utf8")
  .replace('supabaseUrl: "",', `supabaseUrl: ${JSON.stringify(url)},`).replace('supabaseKey: "",', `supabaseKey: ${JSON.stringify(key)},`));
copyFileSync(new URL("../obsidian-plugin/manifest.json", import.meta.url), new URL("manifest.json", dist));
console.log("✔ plugin montado em obsidian-plugin/dist (Supabase não foi tocado)");
