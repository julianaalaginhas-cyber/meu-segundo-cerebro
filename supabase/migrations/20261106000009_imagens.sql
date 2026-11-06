-- Imagens no Vault (ex.: fotos das peças do Afiloop) pedidas pelo Claude/ChatGPT.
-- O servidor baixa e confere a imagem, guarda num bucket PRIVADO (cada usuária só na própria pasta),
-- e o plugin do computador principal grava o arquivo no Vault e apaga a cópia temporária.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vault-imagens', 'vault-imagens', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='vault-imagens: ler as minhas') then
    create policy "vault-imagens: ler as minhas" on storage.objects for select to authenticated
      using (bucket_id = 'vault-imagens' and (storage.foldername(name))[1] = (select auth.uid())::text);
    create policy "vault-imagens: enviar as minhas" on storage.objects for insert to authenticated
      with check (bucket_id = 'vault-imagens' and (storage.foldername(name))[1] = (select auth.uid())::text);
    create policy "vault-imagens: apagar as minhas" on storage.objects for delete to authenticated
      using (bucket_id = 'vault-imagens' and (storage.foldername(name))[1] = (select auth.uid())::text);
  end if;
end $$;

-- Pedidos "imagem": o caminho é o arquivo de imagem no Vault.
alter table public.pedidos_vault drop constraint if exists pedidos_vault_caminho_check;
alter table public.pedidos_vault add constraint pedidos_vault_caminho_check check (
  length(caminho) between 4 and 300
  and caminho !~ '(^/|\\|\.\./|/\.\.|^\.\.|//)'
  and (
    (caminho ~ '\.(md|base)$' and caminho !~ '(^|/)\.')
    or caminho ~ '^\.obsidian/snippets/[^/]+\.css$'
    or (acao = 'imagem' and caminho ~* '\.(png|jpe?g|webp|gif)$' and caminho !~ '(^|/)\.')
  )
);

alter table public.pedidos_vault drop constraint if exists pedidos_vault_acao_check;
alter table public.pedidos_vault add constraint pedidos_vault_acao_check
  check (acao in ('criar', 'substituir', 'editar', 'apagar', 'tarefa', 'mover', 'imagem'));
