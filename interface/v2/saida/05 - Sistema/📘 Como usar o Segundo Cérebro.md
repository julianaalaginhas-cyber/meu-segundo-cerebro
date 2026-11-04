# 📘 Como usar o Segundo Cérebro

## Telas
- Abra **🏠 Minha Central** (deixe nos Favoritos). Cada cartão abre uma área.
- As telas ficam melhores no **modo de leitura** (ícone de livro 📖 no topo da nota, ou `Ctrl+E` no Windows).
- Se aparecer "⚠️ O visual está desligado": Configurações → Aparência → Trechos CSS → ative **segundo-cerebro-dashboard**.

## Registrar algo rápido
- Crie uma nota nova (botão ✏️ / `Ctrl+N`). Com "Local padrão para novas notas" = `00 - Entrada`, tudo cai na Entrada.
- Para já sair organizado, use um modelo (Inserir modelo): Tarefa, Receita, Lançamento financeiro, Conta fixa ou assinatura, Equipamento ou manutenção.

## Propriedades que alimentam os painéis
- Datas sempre no formato `AAAA-MM-DD` (ex.: 2026-11-30).
- **Tarefa:** `tipo: tarefa`, `status: pendente` ou `feita`, `prazo`.
- **Vencimentos:** `proxima_manutencao`, `vencimento`, `proxima_dose`, `validade`, `proxima_cobranca`, `garantia_ate`.
- **Pessoa:** `tipo: pessoa`, `relacao`, `aniversario`.
- **Nicolas:** registros de saúde com `tipo: saude` e `pessoa: Nicolas` (evento: vacina, consulta ou exame).
- **Projeto:** `tipo: projeto`, `status`: ideia, planejamento, ativo, pausado ou concluído.
- **Privado:** `privado: true` impede a nota de ir para a nuvem e para as IAs.

## O que o Obsidian não faz sozinho
- Não envia notificações para o iPhone (os painéis só mostram as datas).
- Caixinhas `- [ ]` soltas em notas não aparecem nos painéis (use notas de tarefa).
