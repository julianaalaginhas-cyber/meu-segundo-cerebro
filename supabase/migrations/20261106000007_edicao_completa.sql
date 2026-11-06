-- Edição completa pelo Claude/ChatGPT: editar (trechos, propriedades, acrescentar), atualizar tarefa,
-- mover e excluir (com confirmação). Nada existente é apagado ou alterado; o RLS continua valendo.

-- Dados estruturados do pedido (propriedades a mesclar, trechos a trocar, item de checklist...).
alter table public.pedidos_vault add column if not exists dados jsonb
  check (dados is null or length(dados::text) <= 60000);

-- Destino de um pedido "mover" (mesmas regras de caminho seguro, só .md).
alter table public.pedidos_vault add column if not exists destino text check (
  destino is null or (
    length(destino) between 4 and 300
    and destino !~ '(^/|\\|\.\./|/\.\.|^\.\.|//)'
    and destino ~ '\.md$' and destino !~ '(^|/)\.'
  )
);

alter table public.pedidos_vault drop constraint if exists pedidos_vault_acao_check;
alter table public.pedidos_vault add constraint pedidos_vault_acao_check
  check (acao in ('criar', 'substituir', 'editar', 'apagar', 'tarefa', 'mover'));

-- Evita alterações concorrentes: no máximo 1 alteração pendente por nota (e por destino de mudança).
create unique index if not exists pedidos_vault_um_pendente_idx on public.pedidos_vault (usuario_id, caminho)
  where aplicado_em is null and acao in ('editar', 'apagar', 'tarefa', 'mover');
create unique index if not exists pedidos_vault_destino_pendente_idx on public.pedidos_vault (usuario_id, destino)
  where aplicado_em is null and destino is not null;

-- Confirmações de exclusão: o primeiro pedido gera um código; só um segundo pedido com o código
-- (depois que a usuária confirmar na conversa) entra na fila. Expira em 15 minutos e vale uma vez.
create table if not exists public.confirmacoes_vault (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  caminho text not null check (length(caminho) between 4 and 300),
  base_hash text not null,
  codigo text not null check (codigo ~ '^[0-9]{6}$'),
  criado_em timestamptz not null default now(),
  expira_em timestamptz not null default now() + interval '15 minutes',
  usado_em timestamptz
);

create index if not exists confirmacoes_vault_usuario_idx on public.confirmacoes_vault (usuario_id, caminho);

alter table public.confirmacoes_vault enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='confirmacoes_vault' and policyname='Ler minhas confirmações') then
    create policy "Ler minhas confirmações" on public.confirmacoes_vault for select to authenticated
      using ((select auth.uid()) = usuario_id);
    create policy "Criar minhas confirmações" on public.confirmacoes_vault for insert to authenticated
      with check ((select auth.uid()) = usuario_id);
    create policy "Usar minhas confirmações" on public.confirmacoes_vault for update to authenticated
      using ((select auth.uid()) = usuario_id) with check ((select auth.uid()) = usuario_id);
  end if;
end $$;

revoke all on public.confirmacoes_vault from anon;
