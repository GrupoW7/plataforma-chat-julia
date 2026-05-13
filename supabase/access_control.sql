-- Controle de acesso do Julia CRM.
-- Mantem o login proprio em public.users e adiciona niveis:
-- master por email predefinido, gestor por funcao, atendente por funcao.

alter table public.users
  add column if not exists funcao text not null default 'atendente';

alter table public.mensagens
  add column if not exists media_url text,
  add column if not exists media_type text,
  add column if not exists media_name text;

alter table public.mensagens
  drop constraint if exists mensagens_media_type_check;

alter table public.mensagens
  add constraint mensagens_media_type_check
  check (media_type is null or media_type in ('image', 'video', 'file'));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-attachments',
  'chat-attachments',
  true,
  52428800,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'text/plain',
    'application/zip'
  ]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "chat attachments public read" on storage.objects;
create policy "chat attachments public read"
on storage.objects for select
to anon, authenticated
using (bucket_id = 'chat-attachments');

drop policy if exists "chat attachments public upload" on storage.objects;
create policy "chat attachments public upload"
on storage.objects for insert
to anon, authenticated
with check (bucket_id = 'chat-attachments');

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_funcao_check'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_funcao_check
      check (funcao in ('gestor', 'atendente'));
  end if;
end;
$$;

create unique index if not exists users_email_unique_lower
  on public.users (lower(email));

create table if not exists public.empresas (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  cnpj text unique,
  razaosocial text,
  created_at timestamptz not null default now()
);

alter table public.empresas enable row level security;

alter table public.lojas
  add column if not exists empresa_id uuid references public.empresas(id) on delete set null;

create index if not exists idx_lojas_empresa_id
  on public.lojas (empresa_id);

create table if not exists public.usuarios_master_emails (
  email text primary key,
  created_at timestamptz not null default now()
);

alter table public.usuarios_master_emails enable row level security;

insert into public.usuarios_master_emails (email)
values ('dev@hellojulia.com.br')
on conflict (email) do nothing;

create table if not exists public.usuarios_gestores_lojas (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.users(id) on delete cascade,
  loja_id uuid not null references public.lojas(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, loja_id)
);

alter table public.usuarios_gestores_lojas enable row level security;

create table if not exists public.usuarios_gestores_empresas (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.users(id) on delete cascade,
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, empresa_id)
);

alter table public.usuarios_gestores_empresas enable row level security;

create index if not exists idx_usuarios_gestores_empresas_user
  on public.usuarios_gestores_empresas (user_id);

create index if not exists idx_usuarios_gestores_empresas_empresa
  on public.usuarios_gestores_empresas (empresa_id);

create index if not exists idx_usuarios_gestores_lojas_user
  on public.usuarios_gestores_lojas (user_id);

create index if not exists idx_usuarios_gestores_lojas_loja
  on public.usuarios_gestores_lojas (loja_id);

create index if not exists idx_historico_conversas_loja_id
  on public.historico_conversas (loja_id);

create index if not exists idx_historico_conversas_user_id
  on public.historico_conversas (user_id);

create index if not exists idx_mensagens_loja_chat_criado
  on public.mensagens (loja_id, chat_id, criado_em);

create index if not exists idx_usuarios_atendentes_loja_id
  on public.usuarios_atendentes (loja_id);

create index if not exists idx_usuarios_atendentes_user_id
  on public.usuarios_atendentes (user_id);

create or replace function public.crm_user_role(p_user_id text)
returns text
language sql
security definer
set search_path = public
as $$
  select case
    when exists (
      select 1
      from public.users u
      join public.usuarios_master_emails me
        on lower(me.email) = lower(u.email)
      where u.id = p_user_id
    ) then 'master'
    else coalesce((select u.funcao from public.users u where u.id = p_user_id), 'atendente')
  end;
$$;

create or replace function public.crm_session_user_id(p_session_token uuid)
returns text
language sql
security definer
set search_path = public
as $$
  select s.user_id
  from public.atendimento_sessions s
  where s.token = p_session_token
    and s.expires_at > now()
  limit 1;
$$;

create or replace function public.crm_user_can_access_store(
  p_user_id text,
  p_loja_id uuid
)
returns boolean
language sql
security definer
set search_path = public
as $$
  select case
    when public.crm_user_role(p_user_id) = 'master' then true
    when public.crm_user_role(p_user_id) = 'gestor' then exists (
      select 1
      from public.usuarios_gestores_lojas ugl
      where ugl.user_id = p_user_id
        and ugl.loja_id = p_loja_id
    ) or exists (
      select 1
      from public.lojas l
      join public.usuarios_gestores_empresas uge
        on uge.empresa_id = l.empresa_id
      where l.id = p_loja_id
        and uge.user_id = p_user_id
    )
    else exists (
      select 1
      from public.usuarios_atendentes ua
      where ua.user_id = p_user_id
        and ua.loja_id = p_loja_id
    )
  end;
$$;

create or replace function public.perfil_atendimento(p_session_token uuid)
returns table (
  user_id text,
  name text,
  email text,
  funcao text,
  is_master boolean
)
language sql
security definer
set search_path = public
as $$
  select
    u.id,
    u.name,
    u.email,
    public.crm_user_role(u.id) as funcao,
    public.crm_user_role(u.id) = 'master' as is_master
  from public.atendimento_sessions s
  join public.users u on u.id = s.user_id
  where s.token = p_session_token
    and s.expires_at > now()
  limit 1;
$$;

drop function if exists public.login_atendente(text, text);
create or replace function public.login_atendente(p_email text, p_password text)
returns table (
  session_token uuid,
  user_id text,
  name text,
  email text,
  funcao text,
  is_master boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.users%rowtype;
  v_token uuid;
  v_role text;
begin
  select u.* into v_user
  from public.users u
  where lower(u.email) = lower(trim(p_email))
    and u.password = p_password
  limit 1;

  if v_user.id is null then
    return;
  end if;

  v_role := public.crm_user_role(v_user.id);

  if v_role = 'atendente' and not exists (
    select 1
    from public.usuarios_atendentes ua
    where ua.user_id = v_user.id
  ) then
    return;
  end if;

  if v_role = 'gestor' and not exists (
    select 1
    from public.usuarios_gestores_lojas ugl
    where ugl.user_id = v_user.id
  ) then
    return;
  end if;

  insert into public.atendimento_sessions (user_id)
  values (v_user.id)
  returning token into v_token;

  return query
  select
    v_token,
    v_user.id,
    v_user.name,
    v_user.email,
    v_role,
    v_role = 'master';
end;
$$;

drop function if exists public.lojas_do_atendente(uuid);
create or replace function public.lojas_do_atendente(p_session_token uuid)
returns table (
  id uuid,
  nome text,
  cnpj text,
  id_externo_loja text,
  atendente_id uuid
)
language sql
security definer
set search_path = public
as $$
  select distinct
    l.id,
    l.nome,
    l.cnpj,
    l.id_externo_loja,
    ua.id as atendente_id
  from public.atendimento_sessions s
  join public.lojas l
    on public.crm_user_can_access_store(s.user_id, l.id)
  left join public.usuarios_atendentes ua
    on ua.user_id = s.user_id
   and ua.loja_id = l.id
  where s.token = p_session_token
    and s.expires_at > now()
  order by l.nome;
$$;

drop function if exists public.historico_por_loja(uuid, uuid);
create or replace function public.historico_por_loja(
  p_session_token uuid,
  p_loja_id uuid
)
returns table (
  id uuid,
  chat_id text,
  loja_id uuid,
  user_id uuid,
  data_fim timestamptz,
  status_ativo boolean,
  data_inicio timestamptz,
  nomecliente text,
  telefone text,
  resumo text,
  ultimo_conteudo text,
  ultimo_media_type text,
  ultima_mensagem timestamptz,
  total_mensagens bigint
)
language sql
security definer
set search_path = public
as $$
  with sessao as (
    select s.user_id
    from public.atendimento_sessions s
    where s.token = p_session_token
      and s.expires_at > now()
      and public.crm_user_can_access_store(s.user_id, p_loja_id)
  ),
  chats_liberados as (
    select
      c.id,
      c.chat_id,
      c.loja_id,
      c.user_id,
      c.data_fim,
      c.status_ativo,
      c.data_inicio,
      c.nomecliente,
      c.telefone,
      c.resumo
    from sessao s
    join public.historico_conversas c
      on c.loja_id = p_loja_id
  ),
  mensagens_por_chat as (
    select
      ck.chat_id,
      ck.loja_id,
      count(m.id) as total_mensagens,
      max(m.criado_em) as ultima_mensagem
    from (
      select distinct chat_id, loja_id
      from chats_liberados
    ) ck
    left join public.mensagens m
      on m.chat_id = ck.chat_id
     and m.loja_id = ck.loja_id
    group by ck.chat_id, ck.loja_id
  ),
  ultima_mensagem as (
    select distinct on (m.chat_id, m.loja_id)
      m.chat_id,
      m.loja_id,
      m.conteudo,
      m.media_type,
      m.criado_em
    from public.mensagens m
    join (
      select distinct chat_id, loja_id
      from chats_liberados
    ) ck
      on ck.chat_id = m.chat_id
     and ck.loja_id = m.loja_id
    order by m.chat_id, m.loja_id, m.criado_em desc nulls last
  ),
  historico_unico as (
    select distinct on (cl.chat_id, cl.loja_id)
      cl.*
    from chats_liberados cl
    order by cl.chat_id, cl.loja_id, cl.data_inicio desc nulls last
  )
  select
    hu.id,
    hu.chat_id,
    hu.loja_id,
    hu.user_id,
    hu.data_fim,
    hu.status_ativo,
    hu.data_inicio,
    hu.nomecliente,
    hu.telefone,
    hu.resumo,
    coalesce(
      um.conteudo,
      case
        when um.media_type = 'image' then 'Imagem'
        when um.media_type = 'video' then 'Vídeo'
        when um.media_type = 'file' then 'Arquivo'
      end
    ) as ultimo_conteudo,
    um.media_type as ultimo_media_type,
    mp.ultima_mensagem,
    coalesce(mp.total_mensagens, 0) as total_mensagens
  from historico_unico hu
  left join mensagens_por_chat mp
    on mp.chat_id = hu.chat_id
   and mp.loja_id = hu.loja_id
  left join ultima_mensagem um
    on um.chat_id = hu.chat_id
   and um.loja_id = hu.loja_id
  order by coalesce(mp.ultima_mensagem, hu.data_inicio) desc nulls last;
$$;

drop function if exists public.mensagens_da_conversa(uuid, uuid, text);
create or replace function public.mensagens_da_conversa(
  p_session_token uuid,
  p_loja_id uuid,
  p_chat_id text
)
returns table (
  id uuid,
  chat_id text,
  loja_id uuid,
  remetente_tipo text,
  conteudo text,
  media_url text,
  media_type text,
  media_name text,
  criado_em timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    m.id,
    m.chat_id,
    m.loja_id,
    m.remetente_tipo,
    m.conteudo,
    m.media_url,
    m.media_type,
    m.media_name,
    m.criado_em
  from public.atendimento_sessions s
  join public.mensagens m
    on m.chat_id = p_chat_id
   and m.loja_id = p_loja_id
  where s.token = p_session_token
    and s.expires_at > now()
    and public.crm_user_can_access_store(s.user_id, p_loja_id)
  order by m.criado_em asc nulls last;
$$;

drop function if exists public.enviar_mensagem_atendente(uuid, uuid, text, text);
drop function if exists public.enviar_mensagem_atendente(uuid, uuid, text, text, text, text, text);
create or replace function public.enviar_mensagem_atendente(
  p_session_token uuid,
  p_loja_id uuid,
  p_chat_id text,
  p_conteudo text,
  p_media_url text default null,
  p_media_type text default null,
  p_media_name text default null
)
returns table (
  id uuid,
  chat_id text,
  loja_id uuid,
  remetente_tipo text,
  conteudo text,
  media_url text,
  media_type text,
  media_name text,
  criado_em timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id text;
  v_message_id uuid;
begin
  v_user_id := public.crm_session_user_id(p_session_token);

  if v_user_id is null or not public.crm_user_can_access_store(v_user_id, p_loja_id) then
    raise exception 'Sessão inválida ou usuário sem acesso a esta loja';
  end if;

  if not exists (
    select 1
    from public.historico_conversas hc
    where hc.chat_id = p_chat_id
      and hc.loja_id = p_loja_id
  ) then
    raise exception 'Conversa não encontrada nesta loja';
  end if;

  if p_media_type is not null and p_media_type not in ('image', 'video', 'file') then
    raise exception 'Tipo de mídia inválido';
  end if;

  insert into public.mensagens (
    chat_id,
    loja_id,
    remetente_tipo,
    conteudo,
    media_url,
    media_type,
    media_name
  )
  values (
    p_chat_id,
    p_loja_id,
    'atendente',
    nullif(trim(p_conteudo), ''),
    nullif(trim(coalesce(p_media_url, '')), ''),
    p_media_type,
    nullif(trim(coalesce(p_media_name, '')), '')
  )
  returning mensagens.id into v_message_id;

  return query
  select
    m.id,
    m.chat_id,
    m.loja_id,
    m.remetente_tipo,
    m.conteudo,
    m.media_url,
    m.media_type,
    m.media_name,
    m.criado_em
  from public.mensagens m
  where m.id = v_message_id;
end;
$$;

drop function if exists public.finalizar_conversa_atendimento(uuid, uuid, text);
create or replace function public.finalizar_conversa_atendimento(
  p_session_token uuid,
  p_loja_id uuid,
  p_chat_id text
)
returns table (
  id uuid,
  chat_id text,
  loja_id uuid,
  data_fim timestamptz,
  status_ativo boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id text;
begin
  v_user_id := public.crm_session_user_id(p_session_token);

  if v_user_id is null or not public.crm_user_can_access_store(v_user_id, p_loja_id) then
    raise exception 'Sessão inválida ou usuário sem acesso a esta loja';
  end if;

  return query
  update public.historico_conversas hc
  set
    data_fim = now(),
    status_ativo = false
  where hc.chat_id = p_chat_id
    and hc.loja_id = p_loja_id
  returning hc.id, hc.chat_id, hc.loja_id, hc.data_fim, hc.status_ativo;
end;
$$;

drop function if exists public.admin_listar_lojas(uuid);
drop function if exists public.admin_listar_empresas(uuid);
drop function if exists public.admin_salvar_empresa(uuid, uuid, text, text, text);
drop function if exists public.admin_salvar_loja(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text);
drop function if exists public.admin_salvar_loja(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text);
drop function if exists public.admin_listar_usuarios(uuid);
drop function if exists public.admin_salvar_usuario(uuid, text, text, text, text, text, uuid[], uuid[]);
drop function if exists public.admin_salvar_usuario(uuid, text, text, text, text, text, uuid[], uuid[], uuid[]);

create or replace function public.admin_listar_lojas(p_session_token uuid)
returns table (
  id uuid,
  empresa_id uuid,
  empresa_nome text,
  nome text,
  cnpj text,
  id_externo_loja text,
  ie text,
  cep text,
  logradouro text,
  numero text,
  complemento text,
  bairro text,
  cidade text,
  uf text,
  razaosocial text
)
language sql
security definer
set search_path = public
as $$
  select
    l.id,
    l.empresa_id,
    e.nome as empresa_nome,
    l.nome,
    l.cnpj,
    l.id_externo_loja,
    l.ie,
    l.cep,
    l.logradouro,
    l.numero,
    l.complemento,
    l.bairro,
    l.cidade,
    l.uf,
    l.razaosocial
  from public.atendimento_sessions s
  join public.lojas l
    on public.crm_user_can_access_store(s.user_id, l.id)
  left join public.empresas e
    on e.id = l.empresa_id
  where s.token = p_session_token
    and s.expires_at > now()
    and public.crm_user_role(s.user_id) in ('master', 'gestor')
  order by l.nome;
$$;

create or replace function public.admin_listar_empresas(p_session_token uuid)
returns table (
  id uuid,
  nome text,
  cnpj text,
  razaosocial text
)
language sql
security definer
set search_path = public
as $$
  select distinct e.id, e.nome, e.cnpj, e.razaosocial
  from public.atendimento_sessions s
  join public.empresas e
    on public.crm_user_role(s.user_id) = 'master'
    or exists (
      select 1
      from public.usuarios_gestores_empresas uge
      where uge.user_id = s.user_id
        and uge.empresa_id = e.id
    )
  where s.token = p_session_token
    and s.expires_at > now()
    and public.crm_user_role(s.user_id) in ('master', 'gestor')
  order by e.nome;
$$;

create or replace function public.admin_salvar_empresa(
  p_session_token uuid,
  p_empresa_id uuid,
  p_nome text,
  p_cnpj text,
  p_razaosocial text
)
returns table (
  id uuid,
  nome text,
  cnpj text,
  razaosocial text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin_id text;
  v_empresa_id uuid;
begin
  v_admin_id := public.crm_session_user_id(p_session_token);

  if v_admin_id is null or public.crm_user_role(v_admin_id) <> 'master' then
    raise exception 'Somente master pode gerenciar empresas';
  end if;

  if nullif(trim(coalesce(p_nome, '')), '') is null then
    raise exception 'Informe o nome da empresa';
  end if;

  if p_empresa_id is null then
    insert into public.empresas (nome, cnpj, razaosocial)
    values (
      nullif(trim(p_nome), ''),
      nullif(trim(coalesce(p_cnpj, '')), ''),
      nullif(trim(coalesce(p_razaosocial, '')), '')
    )
    returning empresas.id into v_empresa_id;
  else
    update public.empresas e
    set
      nome = nullif(trim(p_nome), ''),
      cnpj = nullif(trim(coalesce(p_cnpj, '')), ''),
      razaosocial = nullif(trim(coalesce(p_razaosocial, '')), '')
    where e.id = p_empresa_id
    returning e.id into v_empresa_id;
  end if;

  return query
  select e.id, e.nome, e.cnpj, e.razaosocial
  from public.empresas e
  where e.id = v_empresa_id;
end;
$$;

create or replace function public.admin_salvar_loja(
  p_session_token uuid,
  p_loja_id uuid,
  p_empresa_id uuid,
  p_nome text,
  p_cnpj text,
  p_id_externo_loja text,
  p_ie text,
  p_cep text,
  p_logradouro text,
  p_numero text,
  p_complemento text,
  p_bairro text,
  p_cidade text,
  p_uf text,
  p_razaosocial text
)
returns table (
  id uuid,
  empresa_id uuid,
  empresa_nome text,
  nome text,
  cnpj text,
  id_externo_loja text,
  ie text,
  cep text,
  logradouro text,
  numero text,
  complemento text,
  bairro text,
  cidade text,
  uf text,
  razaosocial text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin_id text;
  v_admin_role text;
  v_loja_id uuid;
begin
  v_admin_id := public.crm_session_user_id(p_session_token);
  v_admin_role := public.crm_user_role(v_admin_id);

  if v_admin_id is null or v_admin_role not in ('master', 'gestor') then
    raise exception 'Usuário sem permissão administrativa';
  end if;

  if nullif(trim(coalesce(p_nome, '')), '') is null then
    raise exception 'Informe o nome da loja';
  end if;

  if p_empresa_id is null then
    raise exception 'Selecione a empresa pai da loja';
  end if;

  if v_admin_role = 'gestor' and not exists (
    select 1
    from public.usuarios_gestores_empresas uge
    where uge.user_id = v_admin_id
      and uge.empresa_id = p_empresa_id
  ) then
    raise exception 'Empresa indisponível para gestão';
  end if;

  if p_loja_id is not null then
    if not public.crm_user_can_access_store(v_admin_id, p_loja_id) then
      raise exception 'Loja indisponível para gestão';
    end if;

    update public.lojas l
    set
      nome = nullif(trim(p_nome), ''),
      empresa_id = p_empresa_id,
      cnpj = nullif(trim(coalesce(p_cnpj, '')), ''),
      id_externo_loja = nullif(trim(coalesce(p_id_externo_loja, '')), ''),
      ie = nullif(trim(coalesce(p_ie, '')), ''),
      cep = nullif(trim(coalesce(p_cep, '')), ''),
      logradouro = nullif(trim(coalesce(p_logradouro, '')), ''),
      numero = nullif(trim(coalesce(p_numero, '')), ''),
      complemento = nullif(trim(coalesce(p_complemento, '')), ''),
      bairro = nullif(trim(coalesce(p_bairro, '')), ''),
      cidade = nullif(trim(coalesce(p_cidade, '')), ''),
      uf = upper(nullif(trim(coalesce(p_uf, '')), '')),
      razaosocial = nullif(trim(coalesce(p_razaosocial, '')), '')
    where l.id = p_loja_id
    returning l.id into v_loja_id;
  else
    insert into public.lojas (
      nome,
      empresa_id,
      cnpj,
      id_externo_loja,
      ie,
      cep,
      logradouro,
      numero,
      complemento,
      bairro,
      cidade,
      uf,
      razaosocial
    )
    values (
      nullif(trim(p_nome), ''),
      p_empresa_id,
      nullif(trim(coalesce(p_cnpj, '')), ''),
      nullif(trim(coalesce(p_id_externo_loja, '')), ''),
      nullif(trim(coalesce(p_ie, '')), ''),
      nullif(trim(coalesce(p_cep, '')), ''),
      nullif(trim(coalesce(p_logradouro, '')), ''),
      nullif(trim(coalesce(p_numero, '')), ''),
      nullif(trim(coalesce(p_complemento, '')), ''),
      nullif(trim(coalesce(p_bairro, '')), ''),
      nullif(trim(coalesce(p_cidade, '')), ''),
      upper(nullif(trim(coalesce(p_uf, '')), '')),
      nullif(trim(coalesce(p_razaosocial, '')), '')
    )
    returning lojas.id into v_loja_id;

    if v_admin_role = 'gestor' then
      insert into public.usuarios_gestores_lojas (user_id, loja_id)
      values (v_admin_id, v_loja_id)
      on conflict (user_id, loja_id) do nothing;
    end if;
  end if;

  return query
  select
    l.id,
    l.empresa_id,
    e.nome as empresa_nome,
    l.nome,
    l.cnpj,
    l.id_externo_loja,
    l.ie,
    l.cep,
    l.logradouro,
    l.numero,
    l.complemento,
    l.bairro,
    l.cidade,
    l.uf,
    l.razaosocial
  from public.lojas l
  left join public.empresas e
    on e.id = l.empresa_id
  where l.id = v_loja_id;
end;
$$;

create or replace function public.admin_listar_usuarios(p_session_token uuid)
returns table (
  id text,
  name text,
  email text,
  funcao text,
  is_master boolean,
  gestor_empresa_ids uuid[],
  gestor_loja_ids uuid[],
  atendente_loja_ids uuid[]
)
language sql
security definer
set search_path = public
as $$
  with sessao as (
    select s.user_id, public.crm_user_role(s.user_id) as role
    from public.atendimento_sessions s
    where s.token = p_session_token
      and s.expires_at > now()
      and public.crm_user_role(s.user_id) in ('master', 'gestor')
  ),
  lojas_admin as (
    select l.id
    from sessao s
    join public.lojas l
      on public.crm_user_can_access_store(s.user_id, l.id)
  )
  select
    u.id,
    u.name,
    u.email,
    public.crm_user_role(u.id) as funcao,
    public.crm_user_role(u.id) = 'master' as is_master,
    coalesce(
      array_agg(distinct uge.empresa_id) filter (where uge.empresa_id is not null),
      array[]::uuid[]
    ) as gestor_empresa_ids,
    coalesce(
      array_agg(distinct ugl.loja_id) filter (where ugl.loja_id is not null),
      array[]::uuid[]
    ) as gestor_loja_ids,
    coalesce(
      array_agg(distinct ua.loja_id) filter (where ua.loja_id is not null),
      array[]::uuid[]
    ) as atendente_loja_ids
  from sessao s
  join public.users u
    on s.role = 'master'
    or exists (
      select 1
      from public.usuarios_gestores_lojas ugl_scope
      join lojas_admin la on la.id = ugl_scope.loja_id
      where ugl_scope.user_id = u.id
    )
    or exists (
      select 1
      from public.usuarios_atendentes ua_scope
      join lojas_admin la on la.id = ua_scope.loja_id
      where ua_scope.user_id = u.id
    )
  left join public.usuarios_gestores_lojas ugl
    on ugl.user_id = u.id
   and exists (select 1 from lojas_admin la where la.id = ugl.loja_id)
  left join public.usuarios_gestores_empresas uge
    on uge.user_id = u.id
   and (
     s.role = 'master'
     or exists (
       select 1
       from public.usuarios_gestores_empresas uge_scope
       where uge_scope.user_id = s.user_id
         and uge_scope.empresa_id = uge.empresa_id
     )
   )
  left join public.usuarios_atendentes ua
    on ua.user_id = u.id
   and exists (select 1 from lojas_admin la where la.id = ua.loja_id)
  group by u.id, u.name, u.email
  order by u.name nulls last, u.email;
$$;

create or replace function public.admin_salvar_usuario(
  p_session_token uuid,
  p_user_id text,
  p_name text,
  p_email text,
  p_password text,
  p_funcao text,
  p_gestor_loja_ids uuid[] default array[]::uuid[],
  p_gestor_empresa_ids uuid[] default array[]::uuid[],
  p_atendente_loja_ids uuid[] default array[]::uuid[]
)
returns table (
  id text,
  name text,
  email text,
  funcao text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin_id text;
  v_admin_role text;
  v_user_id text;
  v_funcao text;
  v_allowed_store_ids uuid[];
  v_allowed_empresa_ids uuid[];
  v_store_id uuid;
  v_empresa_id uuid;
begin
  v_admin_id := public.crm_session_user_id(p_session_token);
  v_admin_role := public.crm_user_role(v_admin_id);

  if v_admin_id is null or v_admin_role not in ('master', 'gestor') then
    raise exception 'Usuário sem permissão administrativa';
  end if;

  v_funcao := case
    when p_funcao = 'gestor' then 'gestor'
    else 'atendente'
  end;

  select coalesce(array_agg(l.id), array[]::uuid[])
  into v_allowed_store_ids
  from public.lojas l
  where public.crm_user_can_access_store(v_admin_id, l.id);

  foreach v_store_id in array coalesce(p_gestor_loja_ids, array[]::uuid[]) loop
    if not v_store_id = any(v_allowed_store_ids) then
      raise exception 'Loja indisponível para gestão';
    end if;
  end loop;

  select coalesce(array_agg(e.id), array[]::uuid[])
  into v_allowed_empresa_ids
  from public.empresas e
  where v_admin_role = 'master'
     or exists (
       select 1
       from public.usuarios_gestores_empresas uge
       where uge.user_id = v_admin_id
         and uge.empresa_id = e.id
     );

  foreach v_empresa_id in array coalesce(p_gestor_empresa_ids, array[]::uuid[]) loop
    if not v_empresa_id = any(v_allowed_empresa_ids) then
      raise exception 'Empresa indisponível para gestão';
    end if;
  end loop;

  foreach v_store_id in array coalesce(p_atendente_loja_ids, array[]::uuid[]) loop
    if not v_store_id = any(v_allowed_store_ids) then
      raise exception 'Loja indisponível para atendimento';
    end if;
  end loop;

  if nullif(trim(coalesce(p_user_id, '')), '') is null then
    v_user_id := gen_random_uuid()::text;

    insert into public.users (id, name, email, password, funcao, "updatedAt")
    values (
      v_user_id,
      nullif(trim(p_name), ''),
      lower(trim(p_email)),
      coalesce(nullif(trim(coalesce(p_password, '')), ''), 'acesso123'),
      v_funcao,
      now()
    );
  else
    v_user_id := p_user_id;

    if not exists (select 1 from public.users u where u.id = v_user_id) then
      raise exception 'Usuário não encontrado';
    end if;

    update public.users u
    set
      name = nullif(trim(p_name), ''),
      email = lower(trim(p_email)),
      password = case
        when nullif(trim(coalesce(p_password, '')), '') is null then u.password
        else p_password
      end,
      funcao = v_funcao,
      "updatedAt" = now()
    where u.id = v_user_id;
  end if;

  delete from public.usuarios_gestores_lojas ugl
  where ugl.user_id = v_user_id
    and ugl.loja_id = any(v_allowed_store_ids);

  delete from public.usuarios_gestores_empresas uge
  where uge.user_id = v_user_id
    and uge.empresa_id = any(v_allowed_empresa_ids);

  delete from public.usuarios_atendentes ua
  where ua.user_id = v_user_id
    and ua.loja_id = any(v_allowed_store_ids);

  foreach v_store_id in array coalesce(p_gestor_loja_ids, array[]::uuid[]) loop
    insert into public.usuarios_gestores_lojas (user_id, loja_id)
    values (v_user_id, v_store_id)
    on conflict (user_id, loja_id) do nothing;
  end loop;

  foreach v_empresa_id in array coalesce(p_gestor_empresa_ids, array[]::uuid[]) loop
    insert into public.usuarios_gestores_empresas (user_id, empresa_id)
    values (v_user_id, v_empresa_id)
    on conflict (user_id, empresa_id) do nothing;
  end loop;

  foreach v_store_id in array coalesce(p_atendente_loja_ids, array[]::uuid[]) loop
    insert into public.usuarios_atendentes (user_id, loja_id)
    values (v_user_id, v_store_id)
    on conflict do nothing;
  end loop;

  return query
  select u.id, u.name, u.email, public.crm_user_role(u.id)
  from public.users u
  where u.id = v_user_id;
end;
$$;

create or replace function public.alterar_senha_atendimento(
  p_session_token uuid,
  p_senha_atual text,
  p_nova_senha text
)
returns table (
  success boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id text;
begin
  v_user_id := public.crm_session_user_id(p_session_token);

  if v_user_id is null then
    raise exception 'Sessão inválida';
  end if;

  if nullif(trim(coalesce(p_nova_senha, '')), '') is null or length(p_nova_senha) < 6 then
    raise exception 'A nova senha deve ter pelo menos 6 caracteres';
  end if;

  update public.users u
  set
    password = p_nova_senha,
    "updatedAt" = now()
  where u.id = v_user_id
    and u.password = p_senha_atual;

  if not found then
    raise exception 'Senha atual inválida';
  end if;

  return query select true;
end;
$$;

grant execute on function public.crm_user_role(text) to anon, authenticated;
grant execute on function public.crm_session_user_id(uuid) to anon, authenticated;
grant execute on function public.crm_user_can_access_store(text, uuid) to anon, authenticated;
grant execute on function public.perfil_atendimento(uuid) to anon, authenticated;
grant execute on function public.login_atendente(text, text) to anon, authenticated;
grant execute on function public.lojas_do_atendente(uuid) to anon, authenticated;
grant execute on function public.historico_por_loja(uuid, uuid) to anon, authenticated;
grant execute on function public.mensagens_da_conversa(uuid, uuid, text) to anon, authenticated;
grant execute on function public.enviar_mensagem_atendente(uuid, uuid, text, text, text, text, text) to anon, authenticated;
grant execute on function public.finalizar_conversa_atendimento(uuid, uuid, text) to anon, authenticated;
grant execute on function public.admin_listar_lojas(uuid) to anon, authenticated;
grant execute on function public.admin_listar_empresas(uuid) to anon, authenticated;
grant execute on function public.admin_listar_usuarios(uuid) to anon, authenticated;
grant execute on function public.admin_salvar_empresa(uuid, uuid, text, text, text) to anon, authenticated;
grant execute on function public.admin_salvar_loja(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.admin_salvar_usuario(uuid, text, text, text, text, text, uuid[], uuid[], uuid[]) to anon, authenticated;
grant execute on function public.alterar_senha_atendimento(uuid, text, text) to anon, authenticated;
