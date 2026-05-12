-- Projeto Supabase: CRM Julia
-- Tabelas existentes usadas:
-- public.users, public.lojas, public.usuarios_atendentes,
-- public.historico_conversas, public.mensagens
--
-- O app usa uma sessao propria por token porque o projeto atual usa
-- public.users, nao Supabase Auth.

drop function if exists public.login_atendente(text, text);
drop function if exists public.lojas_do_atendente(text);
drop function if exists public.lojas_do_atendente(uuid);
drop function if exists public.historico_por_loja(text, uuid);
drop function if exists public.historico_por_loja(uuid, uuid);
drop function if exists public.mensagens_da_conversa(text, uuid, text);
drop function if exists public.mensagens_da_conversa(uuid, uuid, text);
drop function if exists public.criar_conversa_atendimento(text, uuid, text, text);
drop function if exists public.criar_conversa_atendimento(uuid, uuid, text, text);
drop function if exists public.enviar_mensagem_atendente(text, uuid, text, text);
drop function if exists public.enviar_mensagem_atendente(uuid, uuid, text, text);

create table if not exists public.atendimento_sessions (
  token uuid primary key default gen_random_uuid(),
  user_id text not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '12 hours')
);

create index if not exists idx_atendimento_sessions_user_expires
  on public.atendimento_sessions (user_id, expires_at desc);

alter table public.atendimento_sessions enable row level security;

create or replace function public.login_atendente(p_email text, p_password text)
returns table (
  session_token uuid,
  user_id text,
  name text,
  email text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.users%rowtype;
  v_token uuid;
begin
  select u.* into v_user
  from public.users u
  where lower(u.email) = lower(trim(p_email))
    and u.password = p_password
    and exists (
      select 1
      from public.usuarios_atendentes ua
      where ua.user_id = u.id
    )
  limit 1;

  if v_user.id is null then
    return;
  end if;

  insert into public.atendimento_sessions (user_id)
  values (v_user.id)
  returning token into v_token;

  return query select v_token, v_user.id, v_user.name, v_user.email;
end;
$$;

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
  select l.id, l.nome, l.cnpj, l.id_externo_loja, ua.id as atendente_id
  from public.atendimento_sessions s
  join public.usuarios_atendentes ua on ua.user_id = s.user_id
  join public.lojas l on l.id = ua.loja_id
  where s.token = p_session_token
    and s.expires_at > now()
  order by l.nome;
$$;

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
  ultima_mensagem timestamptz,
  total_mensagens bigint
)
language sql
security definer
set search_path = public
as $$
  with chats_liberados as (
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
    from public.atendimento_sessions s
    join public.usuarios_atendentes ua
      on ua.user_id = s.user_id
    join public.lojas l
      on l.id = ua.loja_id
    join public.historico_conversas c
      on c.loja_id = l.id
    where s.token = p_session_token
      and s.expires_at > now()
      and l.id = p_loja_id
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
    um.conteudo as ultimo_conteudo,
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
  criado_em timestamptz
)
language sql
security definer
set search_path = public
as $$
  select m.id, m.chat_id, m.loja_id, m.remetente_tipo, m.conteudo, m.criado_em
  from public.atendimento_sessions s
  join public.usuarios_atendentes ua
    on ua.user_id = s.user_id
  join public.lojas l
    on l.id = ua.loja_id
  join public.mensagens m
    on m.chat_id = p_chat_id
   and m.loja_id = l.id
  where s.token = p_session_token
    and s.expires_at > now()
    and l.id = p_loja_id
  order by m.criado_em asc nulls last;
$$;

create or replace function public.criar_conversa_atendimento(
  p_session_token uuid,
  p_loja_id uuid,
  p_nomecliente text,
  p_telefone text default null
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
  ultima_mensagem timestamptz,
  total_mensagens bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_atendente_id uuid;
  v_chat_id text;
  v_conversa_id uuid;
begin
  select ua.id into v_atendente_id
  from public.atendimento_sessions s
  join public.usuarios_atendentes ua
    on ua.user_id = s.user_id
   and ua.loja_id = p_loja_id
  where s.token = p_session_token
    and s.expires_at > now()
  limit 1;

  if v_atendente_id is null then
    raise exception 'Sessao invalida ou usuario sem acesso a esta loja';
  end if;

  v_chat_id := floor(extract(epoch from clock_timestamp()) * 1000)::bigint::text;

  insert into public.historico_conversas (
    chat_id,
    loja_id,
    user_id,
    nomecliente,
    telefone,
    status_ativo
  )
  values (
    v_chat_id,
    p_loja_id,
    v_atendente_id,
    nullif(trim(p_nomecliente), ''),
    nullif(trim(coalesce(p_telefone, '')), ''),
    true
  )
  returning historico_conversas.id into v_conversa_id;

  return query
  select
    hc.id,
    hc.chat_id,
    hc.loja_id,
    hc.user_id,
    hc.data_fim,
    hc.status_ativo,
    hc.data_inicio,
    hc.nomecliente,
    hc.telefone,
    hc.resumo,
    null::timestamptz as ultima_mensagem,
    0::bigint as total_mensagens
  from public.historico_conversas hc
  where hc.id = v_conversa_id;
end;
$$;

create or replace function public.enviar_mensagem_atendente(
  p_session_token uuid,
  p_loja_id uuid,
  p_chat_id text,
  p_conteudo text
)
returns table (
  id uuid,
  chat_id text,
  loja_id uuid,
  remetente_tipo text,
  conteudo text,
  criado_em timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message_id uuid;
begin
  if not exists (
    select 1
    from public.atendimento_sessions s
    join public.usuarios_atendentes ua
      on ua.user_id = s.user_id
     and ua.loja_id = p_loja_id
    where s.token = p_session_token
      and s.expires_at > now()
  ) then
    raise exception 'Sessao invalida ou usuario sem acesso a esta loja';
  end if;

  if not exists (
    select 1
    from public.historico_conversas hc
    where hc.chat_id = p_chat_id
      and hc.loja_id = p_loja_id
  ) then
    raise exception 'Conversa nao encontrada nesta loja';
  end if;

  insert into public.mensagens (chat_id, loja_id, remetente_tipo, conteudo)
  values (p_chat_id, p_loja_id, 'atendente', nullif(trim(p_conteudo), ''))
  returning mensagens.id into v_message_id;

  return query
  select m.id, m.chat_id, m.loja_id, m.remetente_tipo, m.conteudo, m.criado_em
  from public.mensagens m
  where m.id = v_message_id;
end;
$$;

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
begin
  if not exists (
    select 1
    from public.atendimento_sessions s
    join public.usuarios_atendentes ua
      on ua.user_id = s.user_id
     and ua.loja_id = p_loja_id
    where s.token = p_session_token
      and s.expires_at > now()
  ) then
    raise exception 'Sessao invalida ou usuario sem acesso a esta loja';
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

grant execute on function public.login_atendente(text, text) to anon, authenticated;
grant execute on function public.lojas_do_atendente(uuid) to anon, authenticated;
grant execute on function public.historico_por_loja(uuid, uuid) to anon, authenticated;
grant execute on function public.mensagens_da_conversa(uuid, uuid, text) to anon, authenticated;
grant execute on function public.criar_conversa_atendimento(uuid, uuid, text, text) to anon, authenticated;
grant execute on function public.enviar_mensagem_atendente(uuid, uuid, text, text) to anon, authenticated;
grant execute on function public.finalizar_conversa_atendimento(uuid, uuid, text) to anon, authenticated;
