-- Meu Segundo Cérebro — cópia pesquisável das notas do Obsidian.
-- O Vault continua sendo a FONTE DA VERDADE. Esta tabela é um índice na nuvem,
-- mantido pelo plugin "Ponte Segundo Cérebro" (cria, atualiza e apaga em espelho).
-- Nada aqui altera ou apaga dados existentes.

create table if not exists public.notas (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  caminho text not null,                       -- ex.: "01 - Vida/Casa/Máquina de lavar.md"
  titulo text not null,
  conteudo text not null default '',
  propriedades jsonb not null default '{}'::jsonb,  -- frontmatter (tipo, area, datas...)
  hash text not null,                          -- detecta mudanças (sincronização incremental)
  modificado_em timestamptz,                   -- data de modificação no Obsidian
  sincronizado_em timestamptz not null default now(),
  busca tsvector generated always as (
    to_tsvector('portuguese', coalesce(titulo, '') || ' ' || coalesce(conteudo, ''))
  ) stored,
  unique (usuario_id, caminho)
);

create index if not exists notas_busca_idx on public.notas using gin (busca);
create index if not exists notas_props_idx on public.notas using gin (propriedades);

alter table public.notas enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='notas' and policyname='Ler minhas notas') then
    create policy "Ler minhas notas" on public.notas for select to authenticated
      using ((select auth.uid()) = usuario_id);
    create policy "Criar minhas notas" on public.notas for insert to authenticated
      with check ((select auth.uid()) = usuario_id);
    create policy "Atualizar minhas notas" on public.notas for update to authenticated
      using ((select auth.uid()) = usuario_id) with check ((select auth.uid()) = usuario_id);
    create policy "Excluir minhas notas" on public.notas for delete to authenticated
      using ((select auth.uid()) = usuario_id);
  end if;
end $$;

revoke all on public.notas from anon;

-- Memórias criadas pelo Claude/ChatGPT são trazidas para o Obsidian (pasta 00 - Entrada).
-- Esta coluna marca quando isso aconteceu, para não duplicar.
alter table public.memorias add column if not exists importado_em timestamptz;

-- Busca única em notas + memórias ainda não importadas. RLS vale (security invoker).
create or replace function public.buscar_cerebro(termo text, limite int default 10)
returns table (
  tipo text, id uuid, titulo text, caminho text, trecho text,
  propriedades jsonb, atualizado_em timestamptz, relevancia real
)
language sql stable security invoker set search_path = ''
as $$
  with q as (
    select nullif(btrim(coalesce(termo, '')), '') as t
  ), q2 as (
    select t,
      '%' || replace(replace(replace(t, '\', '\\'), '%', '\%'), '_', '\_') || '%' as padrao,
      case when t is null then null
           else nullif(replace(pg_catalog.plainto_tsquery('portuguese', t)::text, '&', '|'), '')::pg_catalog.tsquery
      end as tsq
    from q
  ), todos as (
    select 'nota'::text as tipo, n.id, n.titulo, n.caminho, n.conteudo, n.propriedades,
           coalesce(n.modificado_em, n.sincronizado_em) as atualizado_em, n.busca
    from public.notas n
    union all
    select 'memoria', m.id, m.titulo, null, m.conteudo,
           jsonb_strip_nulls(jsonb_build_object('categoria', m.categoria, 'fonte', m.fonte)),
           m.criado_em, pg_catalog.to_tsvector('portuguese', m.titulo || ' ' || m.conteudo)
    from public.memorias m
    where m.importado_em is null
  )
  select x.tipo, x.id, x.titulo, x.caminho, left(x.conteudo, 800), x.propriedades, x.atualizado_em,
         (case when q2.tsq is null then 0 else pg_catalog.ts_rank(x.busca, q2.tsq) end
          + case when q2.t is not null and x.titulo ilike q2.padrao then 1 else 0 end)::real
  from todos x, q2
  where q2.t is null
     or x.titulo ilike q2.padrao
     or x.conteudo ilike q2.padrao
     or x.propriedades::text ilike q2.padrao
     or (q2.tsq is not null and x.busca @@ q2.tsq)
  order by 8 desc, x.atualizado_em desc nulls last
  limit least(greatest(coalesce(limite, 10), 1), 50);
$$;

-- Converte texto em data sem dar erro (datas inválidas viram null).
create or replace function public._data_segura(v text)
returns date language plpgsql immutable set search_path = '' as $$
begin
  if v !~ '^\d{4}-\d{2}-\d{2}' then return null; end if;
  return left(v, 10)::date;
exception when others then return null;
end $$;

-- Datas das propriedades das notas (ex.: proxima_manutencao, proxima_dose, vencimento)
-- dentro de uma janela, incluindo as atrasadas.
create or replace function public.datas_do_cerebro(dias_a_frente int default 60, dias_atras int default 365)
returns table (titulo text, caminho text, propriedade text, data date, dias_ate int, propriedades jsonb)
language sql stable security invoker set search_path = ''
as $$
  select n.titulo, n.caminho, p.key, d.data, (d.data - current_date), n.propriedades
  from public.notas n
  cross join lateral jsonb_each_text(n.propriedades) p
  cross join lateral (select public._data_segura(p.value) as data) d
  where d.data is not null
    and d.data between current_date - least(greatest(coalesce(dias_atras, 365), 0), 3650)
                   and current_date + least(greatest(coalesce(dias_a_frente, 60), 0), 3650)
  order by d.data;
$$;

revoke all on function public.buscar_cerebro(text, int) from public, anon;
revoke all on function public.datas_do_cerebro(int, int) from public, anon;
grant execute on function public.buscar_cerebro(text, int) to authenticated;
grant execute on function public.datas_do_cerebro(int, int) to authenticated;
