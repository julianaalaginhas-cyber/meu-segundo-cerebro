-- Meu Segundo Cérebro — fila de arquivos que o Claude/ChatGPT pedem para criar no Vault.
-- O plugin "Ponte" (no dispositivo principal) lê esta fila e cria os arquivos.
-- Regras aplicadas no plugin E aqui: só cria arquivos novos (nunca sobrescreve nem apaga),
-- só caminhos relativos seguros, só .md / .base / .obsidian/snippets/*.css.

create table if not exists public.pedidos_vault (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  caminho text not null check (
    length(caminho) between 4 and 300
    and caminho !~ '(^/|\\|\.\./|/\.\.|^\.\.|//)'
    and (
      (caminho ~ '\.(md|base)$' and caminho !~ '(^|/)\.')
      or caminho ~ '^\.obsidian/snippets/[^/]+\.css$'
    )
  ),
  conteudo text not null check (length(conteudo) <= 200000),
  origem text,
  criado_em timestamptz not null default now(),
  aplicado_em timestamptz,
  resultado text
);

create index if not exists pedidos_vault_pendentes_idx on public.pedidos_vault (usuario_id) where aplicado_em is null;

alter table public.pedidos_vault enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='pedidos_vault' and policyname='Ler meus pedidos') then
    create policy "Ler meus pedidos" on public.pedidos_vault for select to authenticated
      using ((select auth.uid()) = usuario_id);
    create policy "Criar meus pedidos" on public.pedidos_vault for insert to authenticated
      with check ((select auth.uid()) = usuario_id);
    create policy "Atualizar meus pedidos" on public.pedidos_vault for update to authenticated
      using ((select auth.uid()) = usuario_id) with check ((select auth.uid()) = usuario_id);
  end if;
end $$;

revoke all on public.pedidos_vault from anon;
