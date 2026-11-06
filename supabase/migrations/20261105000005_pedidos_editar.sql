-- Pedidos podem "editar" notas pessoais existentes.
-- O servidor grava o hash da versão que a IA leu (base_hash); o plugin só aplica se a nota
-- ainda estiver igual a essa versão, e sempre guarda uma cópia antes em "05 - Sistema/Backups/".
alter table public.pedidos_vault add column if not exists base_hash text;
alter table public.pedidos_vault drop constraint if exists pedidos_vault_acao_check;
alter table public.pedidos_vault add constraint pedidos_vault_acao_check check (acao in ('criar', 'substituir', 'editar'));
