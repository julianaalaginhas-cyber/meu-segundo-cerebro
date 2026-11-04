# Meu Segundo Cérebro — servidor MCP

Memória externa compartilhada entre Claude e ChatGPT, hospedada no Supabase (plano gratuito).

## Peças
| Peça | Onde | Função |
|---|---|---|
| `public.memorias` + RLS | Supabase (já existia) | Guarda as memórias; cada usuária só vê as suas |
| `buscar_memorias()` | `supabase/migrations/` | Busca por palavras (português), `security invoker` → RLS vale |
| `cerebro-mcp` | `supabase/functions/` | Servidor MCP remoto; exige token OAuth; sem `service_role` |
| Página de consentimento | `consentimento/` | Tela "Permitir acesso?" exigida pelo OAuth Server do Supabase |

## Ferramentas MCP
`buscar_memorias`, `ler_memoria`, `salvar_memoria`, e `search`/`fetch` (formato esperado pelo ChatGPT).

## Comandos (precisam de `SUPABASE_ACCESS_TOKEN` no ambiente)
```
NODE_USE_ENV_PROXY=1 node scripts/diagnostico.mjs   # só leitura
NODE_USE_ENV_PROXY=1 node scripts/implantar.mjs     # aplica SQL + publica função
NODE_USE_ENV_PROXY=1 node scripts/testar.mjs        # testes reais com dados fictícios
```

## Segurança
- Nenhum segredo no código. A chave "publishable" em `consentimento/config.js` é pública por design.
- Toda chamada MCP exige token Bearer válido (assinatura + expiração verificadas).
- Opcional: `ALLOWED_CLIENT_IDS` (segredo da função) restringe a apps OAuth específicos.
- Logs registram só método, ferramenta, status e duração.
