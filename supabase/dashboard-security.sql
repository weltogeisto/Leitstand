-- Single-operator dashboard authentication. No public API role receives access.
create table if not exists dashboard_auth (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  secret_encrypted text,
  session_epoch text not null default '0',
  last_counter bigint not null default -1,
  recovery_hashes text[] not null default '{}',
  pending_secret text,
  pending_id text,
  pending_expires timestamptz,
  updated_at timestamptz not null default now(),
  check (not enabled or secret_encrypted is not null)
);
insert into dashboard_auth(id) values (true) on conflict do nothing;
alter table dashboard_auth enable row level security;

create table if not exists dashboard_login_limits (
  bucket text primary key,
  attempts integer not null check (attempts between 1 and 6),
  expires_at timestamptz not null
);
create index if not exists dashboard_login_limits_expiry_idx on dashboard_login_limits(expires_at);
alter table dashboard_login_limits enable row level security;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'leitstand_runtime') then
    grant select, insert, update, delete on dashboard_auth, dashboard_login_limits to leitstand_runtime;
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'dashboard_auth' and policyname = 'dashboard_runtime') then
      create policy dashboard_runtime on dashboard_auth to leitstand_runtime using (true) with check (true);
    end if;
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'dashboard_login_limits' and policyname = 'dashboard_runtime') then
      create policy dashboard_runtime on dashboard_login_limits to leitstand_runtime using (true) with check (true);
    end if;
  end if;
end $$;
