-- Pedidos podem "apagar" notas pessoais existentes (só quando a usuária pedir).
-- Mesma trava do editar: o plugin só apaga se a nota ainda estiver na versão que a IA leu (base_hash),
-- guarda uma cópia em "05 - Sistema/Backups/" e manda o arquivo para a lixeira (recuperável).
alter table public.pedidos_vault drop constraint if exists pedidos_vault_acao_check;
alter table public.pedidos_vault add constraint pedidos_vault_acao_check check (acao in ('criar', 'substituir', 'editar', 'apagar'));
