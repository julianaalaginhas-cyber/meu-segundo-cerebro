-- Pedidos podem "substituir" telas do sistema (o plugin faz backup antes e recusa notas pessoais).
alter table public.pedidos_vault add column if not exists acao text not null default 'criar';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'pedidos_vault_acao_check') then
    alter table public.pedidos_vault add constraint pedidos_vault_acao_check check (acao in ('criar', 'substituir'));
  end if;
end $$;
