-- Meu Segundo Cérebro — função de busca de memórias.
-- SECURITY INVOKER: roda com as permissões de quem chama, então o RLS
-- da tabela public.memorias continua valendo (cada usuária só vê as suas).
-- Não altera nem apaga nada da tabela existente.

create or replace function public.buscar_memorias(
  termo text,
  filtro_categoria text default null,
  limite int default 10
)
returns table (
  id uuid,
  titulo text,
  trecho text,
  categoria text,
  fonte text,
  criado_em timestamptz,
  relevancia real
)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select
      nullif(btrim(coalesce(termo, '')), '') as t
  ),
  q2 as (
    select
      t,
      -- padrão ILIKE com curingas escapados
      '%' || replace(replace(replace(t, '\', '\\'), '%', '\%'), '_', '\_') || '%' as padrao,
      -- busca por palavras (OU), com radicais em português
      case when t is null then null
           else nullif(replace(pg_catalog.plainto_tsquery('portuguese', t)::text, '&', '|'), '')
      end as tsq
    from q
  )
  select
    m.id,
    m.titulo,
    left(m.conteudo, 600) as trecho,
    m.categoria,
    m.fonte,
    m.criado_em,
    case when q2.tsq is null then 0
         else pg_catalog.ts_rank(
                pg_catalog.to_tsvector('portuguese', m.titulo || ' ' || m.conteudo),
                q2.tsq::pg_catalog.tsquery)
    end::real as relevancia
  from public.memorias m, q2
  where
    (q2.t is null
      or m.titulo ilike q2.padrao
      or m.conteudo ilike q2.padrao
      or (q2.tsq is not null and
          pg_catalog.to_tsvector('portuguese', m.titulo || ' ' || m.conteudo)
            @@ q2.tsq::pg_catalog.tsquery))
    and (filtro_categoria is null or m.categoria = filtro_categoria)
  order by relevancia desc, m.criado_em desc
  limit least(greatest(coalesce(limite, 10), 1), 50);
$$;

revoke all on function public.buscar_memorias(text, text, int) from public, anon;
grant execute on function public.buscar_memorias(text, text, int) to authenticated;
