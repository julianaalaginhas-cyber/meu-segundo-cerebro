-- Registro das alterações que o servidor recusou (ex.: trecho não encontrado, nota mudou), para a
-- usuária e as IAs entenderem o motivo com 'ver_alteracoes'. Só ferramenta, caminho e motivo; RLS ligado.
create table if not exists public.recusas_mcp (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  ferramenta text not null check (length(ferramenta) <= 60),
  caminho text check (caminho is null or length(caminho) <= 300),
  motivo text not null check (length(motivo) <= 400),
  origem text,
  criado_em timestamptz not null default now()
);

create index if not exists recusas_mcp_usuario_idx on public.recusas_mcp (usuario_id, criado_em desc);

alter table public.recusas_mcp enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='recusas_mcp' and policyname='Ler minhas recusas') then
    create policy "Ler minhas recusas" on public.recusas_mcp for select to authenticated
      using ((select auth.uid()) = usuario_id);
    create policy "Criar minhas recusas" on public.recusas_mcp for insert to authenticated
      with check ((select auth.uid()) = usuario_id);
  end if;
end $$;

revoke all on public.recusas_mcp from anon;
