# Meu Segundo Cérebro — servidor MCP

Memória externa compartilhada entre Claude e ChatGPT, hospedada no Supabase (plano gratuito).

## Como funciona
```
Obsidian (Windows/iPhone)  ──plugin "Ponte"──▶  Supabase (notas + memorias, RLS)  ◀──MCP──  Claude / ChatGPT
   fonte da verdade        ◀── 00 - Entrada ──   (o que as IAs salvam volta para o Vault)
```
- O Vault é a fonte da verdade. A nuvem guarda uma cópia pesquisável, atualizada a cada alteração.
- Funciona com o computador desligado (Supabase na nuvem) e no iPhone (app do Claude/ChatGPT).
- Notas com `privado: true` e pastas excluídas nunca saem do Vault.

## Peças
| Peça | Onde | Função |
|---|---|---|
| `public.memorias` + RLS | Supabase (já existia) | Guarda as memórias; cada usuária só vê as suas |
| `buscar_memorias()` | `supabase/migrations/` | Busca por palavras (português), `security invoker` → RLS vale |
| `cerebro-mcp` | `supabase/functions/` | Servidor MCP remoto; exige token OAuth; sem `service_role` |
| `notas` + `buscar_cerebro()` + `datas_do_cerebro()` | `supabase/migrations/` | Espelho do Vault, busca única e prazos |
| Plugin "Ponte Segundo Cérebro" | `obsidian-plugin/` | Envia notas, apaga/renomeia em espelho, traz memórias para a Entrada |
| Página de consentimento | `docs/` (GitHub Pages) | Tela "Permitir acesso?" exigida pelo OAuth Server do Supabase |

## Plugin Ponte: agenda e avisos
- Bloco ` ```agenda-semana``` ` (opções `inicio`, `fim`, `dias`, `pasta`): semana por horário com as notas `tipo: tarefa/compromisso/lembrete` (`data`, `hora`, `hora_fim` ou `duracao_min`) e os vencimentos do dia. Clique num horário vazio cria um compromisso; arrastar muda dia e hora.
- Avisos de vencimento (só no dispositivo principal, ao abrir e a cada 6 h): notas `tipo: contrato/societario/procuracao/documento/prazo/licenca/certidao` (ou com `alerta_dias`) com `vencimento`/`validade` geram UMA tarefa ⏰ em `07 - Agenda` dentro da antecedência (padrão 90/60/60/60/30/60/30 dias). `alerta: false` desliga. Comando: "Verificar vencimentos agora".

## Ferramentas MCP
`buscar`, `ler`, `datas`, `salvar_memoria`, `criar_nota`, `editar_nota`, `atualizar_tarefa`, `mover_nota`, `excluir_nota` (2 etapas, com confirmação) , `salvar_imagem` (fotos no Vault, bucket privado) e `ver_alteracoes` — com trava de versão, backup, lixeira e histórico, e `search`/`fetch` (formato esperado pelo ChatGPT).

## Comandos (precisam de `SUPABASE_ACCESS_TOKEN` no ambiente)
```
NODE_USE_ENV_PROXY=1 node scripts/diagnostico.mjs   # só leitura
NODE_USE_ENV_PROXY=1 node scripts/implantar.mjs     # aplica SQL + publica função
NODE_USE_ENV_PROXY=1 node scripts/testar.mjs        # testes reais com dados fictícios
```

## Segurança
- Nenhum segredo no código. A chave "publishable" em `docs/config.js` é pública por design.
- Toda chamada MCP exige token Bearer válido (assinatura + expiração verificadas).
- Opcional: `ALLOWED_CLIENT_IDS` (segredo da função) restringe a apps OAuth específicos.
- Logs registram só método, ferramenta, status e duração.
