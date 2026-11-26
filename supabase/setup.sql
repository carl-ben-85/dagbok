-- Hälsodagbok: tabeller och regler för synk.
-- Kör hela skriptet i Supabase: SQL Editor → New query → klistra in → Run.
-- Skriptet går att köra igen utan att något försvinner.
--
-- Datan lagras läsbart (JSON) och kan ses i Supabase under Table Editor.
-- Radsäkerheten gör att varje inloggad användare bara når sina egna rader.

-- Rensar bort tabeller från den tidigare, krypterade versionen av skriptet (om den har körts).
drop table if exists public.vault;
drop function if exists public.push_records(jsonb);
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'records' and column_name = 'payload') then
    drop table public.records;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'blobs' and column_name = 'payload') then
    drop table public.blobs;
  end if;
end $$;

-- En rad per användare som har börjat synka. Försvinner när all serverdata raderas,
-- så att andra telefoner märker det och slutar synka.
create table if not exists public.sync_state (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  started_at timestamptz not null default clock_timestamp()
);

-- Alla dagboksposter: dagar, mediciner, dosändringar, vid behov-intag, inställningar, foton (metadata).
create table if not exists public.records (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null,
  type text not null,
  date date,
  data jsonb,
  created_at bigint,
  updated_at bigint not null,
  deleted boolean not null default false,
  schema integer,
  synced_at timestamptz not null default clock_timestamp(),
  primary key (user_id, id)
);
create index if not exists records_user_synced_idx on public.records (user_id, synced_at);
create index if not exists records_user_type_date_idx on public.records (user_id, type, date);

-- Foton (JPEG, base64)
create table if not exists public.photos (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null,
  mime text not null default 'image/jpeg',
  data_base64 text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- Skickade aviseringar, högst en per dag
create table if not exists public.alert_log (
  user_id uuid not null references auth.users (id) on delete cascade,
  date date not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, date)
);

-- Radsäkerhet: varje inloggad användare når bara sina egna rader. Utloggade når ingenting.
alter table public.alert_log enable row level security;
alter table public.sync_state enable row level security;
alter table public.records enable row level security;
alter table public.photos enable row level security;

drop policy if exists "egna rader" on public.sync_state;
create policy "egna rader" on public.sync_state for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "egna rader" on public.records;
create policy "egna rader" on public.records for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "egna rader" on public.alert_log;
create policy "egna rader" on public.alert_log for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "egna rader" on public.photos;
create policy "egna rader" on public.photos for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.sync_state, public.records, public.photos, public.alert_log from anon;
grant select, delete on public.alert_log to authenticated;
grant select, insert, update, delete on public.sync_state, public.records, public.photos to authenticated;

-- Skickar poster. Senaste ändring vinner per post: en äldre version skriver aldrig över en nyare.
create or replace function public.push_records(rows jsonb)
returns integer
language sql
security invoker
set search_path = ''
as $$
  with input as (
    select
      r ->> 'id' as id,
      r ->> 'type' as type,
      nullif(r ->> 'date', '')::date as date,
      r -> 'data' as data,
      (r ->> 'created_at')::bigint as created_at,
      (r ->> 'updated_at')::bigint as updated_at,
      coalesce((r ->> 'deleted')::boolean, false) as deleted,
      (r ->> 'schema')::integer as schema
    from jsonb_array_elements(rows) as r
  ),
  written as (
    insert into public.records as t (user_id, id, type, date, data, created_at, updated_at, deleted, schema, synced_at)
    select auth.uid(), i.id, i.type, i.date, i.data, i.created_at, i.updated_at, i.deleted, i.schema, clock_timestamp()
    from input as i
    on conflict (user_id, id) do update
      set type = excluded.type,
          date = excluded.date,
          data = excluded.data,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted = excluded.deleted,
          schema = excluded.schema,
          synced_at = clock_timestamp()
      where excluded.updated_at > t.updated_at
    returning 1
  )
  select count(*)::integer from written;
$$;

-- Raderar allt den inloggade användaren har på servern.
create or replace function public.delete_my_data()
returns void
language sql
security invoker
set search_path = ''
as $$
  delete from public.photos where user_id = auth.uid();
  delete from public.alert_log where user_id = auth.uid();
  delete from public.records where user_id = auth.uid();
  delete from public.sync_state where user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- Avisering vid lågt mående. Ställs in i appen under Mer (sparas i inställningarna).
-- När en dag med Allmänt mående på eller under nivån sparas skickas en push-notis
-- via ntfy.sh, högst en gång per dag och bara för i dag eller i går.
-- ---------------------------------------------------------------------------

create extension if not exists pg_net;

create or replace function public.notify_low_wellbeing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg jsonb;
  v numeric;
  lim numeric;
  today date := (now() at time zone 'Europe/Stockholm')::date;
  sent integer;
begin
  if new.type <> 'day' or new.deleted or new.date is null then return new; end if;
  if new.date < today - 1 or new.date > today then return new; end if;
  v := nullif(new.data -> 'scales' ->> 'wellbeing', '')::numeric;
  if v is null then return new; end if;

  select r.data -> 'alert' into cfg
    from public.records as r
   where r.user_id = new.user_id and r.id = 'settings' and not r.deleted;
  if cfg is null or coalesce((cfg ->> 'enabled')::boolean, false) = false then return new; end if;
  if coalesce(cfg ->> 'topic', '') !~ '^[A-Za-z0-9_-]{8,64}$' then return new; end if;
  lim := coalesce((cfg ->> 'threshold')::numeric, 4);
  if v > lim then return new; end if;

  insert into public.alert_log (user_id, date) values (new.user_id, new.date) on conflict do nothing;
  get diagnostics sent = row_count;
  if sent = 0 then return new; end if;

  perform net.http_post(
    url := 'https://ntfy.sh/',
    body := jsonb_build_object(
      'topic', cfg ->> 'topic',
      'title', 'Dagbok: lågt mående',
      'message', format('Allmänt mående %s av 10 %s.', v, case when new.date = today then 'i dag' else 'i går' end),
      'priority', 4,
      'tags', jsonb_build_array('chart_with_downwards_trend')
    )
  );
  return new;
exception when others then
  -- En misslyckad notis får aldrig stoppa synken.
  return new;
end;
$$;

revoke all on function public.notify_low_wellbeing() from public, anon, authenticated;

drop trigger if exists notify_low_wellbeing on public.records;
create trigger notify_low_wellbeing
  after insert or update on public.records
  for each row execute function public.notify_low_wellbeing();

revoke all on function public.push_records(jsonb) from public, anon;
revoke all on function public.delete_my_data() from public, anon;
grant execute on function public.push_records(jsonb) to authenticated;
grant execute on function public.delete_my_data() to authenticated;

-- ---------------------------------------------------------------------------
-- Läsbara vyer. De ändrar inget i hur datan sparas, de visar den bara
-- uppdelad i kolumner. Öppna dem under Table Editor eller exportera till CSV.
-- Vyerna följer samma radsäkerhet som tabellerna (security_invoker).
-- ---------------------------------------------------------------------------

drop view if exists public.dagbok;
drop view if exists public.medicinhistorik;

-- Namn på skalor, besvär, kost och träningstyper. Hämtas från inställningarna i appen,
-- med appens standardnamn som reserv.
create or replace function public.dagbok_namn(p_user uuid, p_list text, p_key text)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    (select e ->> 'label'
       from public.records as r
       cross join lateral jsonb_array_elements(coalesce(r.data -> p_list, '[]'::jsonb)) as e
      where r.user_id = p_user and r.id = 'settings' and e ->> 'key' = p_key
      limit 1),
    (select d.label from (values
      ('scales', 'wellbeing', 'Allmänt mående'), ('scales', 'energy', 'Energi'), ('scales', 'weakness', 'Muskelsvaghet'),
      ('scales', 'pain', 'Muskel- och ledvärk'), ('scales', 'breath', 'Andfåddhet'), ('scales', 'cough', 'Hosta'), ('scales', 'stress', 'Stress'),
      ('flags', 'raynaud', 'Raynaud'), ('flags', 'skin', 'Hudbesvär på händerna'), ('flags', 'fever', 'Feber'),
      ('flags', 'infection', 'Infektionstecken'), ('flags', 'flare', 'Dålig period'),
      ('diet', 'gluten', 'Gluten'), ('diet', 'sugar', 'Socker'), ('diet', 'dairy', 'Mejeri'), ('diet', 'processed', 'Processad mat'),
      ('diet', 'redmeat', 'Rött kött'), ('diet', 'antiinfl', 'Antiinflammatorisk kost'),
      ('cardioTypes', 'walk', 'Promenad'), ('cardioTypes', 'cardio_other', 'Annat'), ('cardioTypes', 'run', 'Löpning'),
      ('cardioTypes', 'bike', 'Cykel'), ('cardioTypes', 'swim', 'Simning'),
      ('strengthTypes', 'strength', 'Styrka'), ('strengthTypes', 'mobility', 'Rörlighet'), ('strengthTypes', 'stretch', 'Stretch'),
      ('strengthTypes', 'yoga', 'Yoga'), ('strengthTypes', 'strength_other', 'Annat')
    ) as d (list, key, label) where d.list = p_list and d.key = p_key),
    p_key);
$$;

-- Dos för en medicin ett visst datum (senaste insättning eller dosändring fram till dagen).
create or replace function public.dagbok_dos(p_user uuid, p_med text, p_date date)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select case when c.data ->> 'action' = 'stop' then null
              else nullif(trim(concat(c.data ->> 'dose', ' ', m.data ->> 'unit')), '') end
    from public.records as c
    left join public.records as m on m.user_id = c.user_id and m.id = p_med
   where c.user_id = p_user and c.type = 'medchange' and not c.deleted
     and c.data ->> 'medId' = p_med and c.date <= p_date
   order by c.date desc, c.created_at desc
   limit 1;
$$;

-- En rad per dag
create view public.dagbok with (security_invoker = true) as
select
  d.date as datum,
  (d.data -> 'scales' ->> 'wellbeing')::numeric as allmänt_mående,
  (d.data -> 'scales' ->> 'energy')::numeric as energi,
  (d.data -> 'scales' ->> 'weakness')::numeric as muskelsvaghet,
  (d.data -> 'scales' ->> 'pain')::numeric as muskel_och_ledvärk,
  (d.data -> 'scales' ->> 'breath')::numeric as andfåddhet,
  (d.data -> 'scales' ->> 'cough')::numeric as hosta,
  (d.data -> 'scales' ->> 'stress')::numeric as stress,
  (select string_agg(public.dagbok_namn(d.user_id, 'scales', s.key) || ': ' || s.value, ', ' order by s.key)
     from jsonb_each_text(coalesce(d.data -> 'scales', '{}'::jsonb)) as s
    where s.key not in ('wellbeing', 'energy', 'weakness', 'pain', 'breath', 'cough', 'stress')) as övriga_skalor,
  case d.data ->> 'stiffness'
    when 'none' then 'Ingen' when 'lt30' then 'Under 30 min'
    when '30to60' then '30–60 min' when 'gt60' then 'Över 60 min' end as morgonstelhet,
  (d.data -> 'sleep' ->> 'hours')::numeric as sömn_timmar,
  (d.data -> 'sleep' ->> 'quality')::integer as sömnkvalitet,
  (d.data ->> 'rest')::boolean as vila,
  case when d.data -> 'cardio' -> 'types' ? 'none' then 'Ingen'
       else (select string_agg(public.dagbok_namn(d.user_id, 'cardioTypes', t), ', ')
               from jsonb_array_elements_text(coalesce(d.data -> 'cardio' -> 'types', '[]'::jsonb)) as t) end as kondition,
  case when d.data -> 'cardio' -> 'types' ? 'none' then null else (d.data -> 'cardio' ->> 'minutes')::numeric end as kondition_min,
  case d.data -> 'cardio' ->> 'intensity' when 'light' then 'Lätt' when 'medium' then 'Medel' when 'hard' then 'Hård' end as kondition_ansträngning,
  case when d.data -> 'strength' -> 'types' ? 'none' then 'Ingen'
       else (select string_agg(public.dagbok_namn(d.user_id, 'strengthTypes', t), ', ')
               from jsonb_array_elements_text(coalesce(d.data -> 'strength' -> 'types', '[]'::jsonb)) as t) end as styrka_och_rörlighet,
  case when d.data -> 'strength' -> 'types' ? 'none' then null else (d.data -> 'strength' ->> 'minutes')::numeric end as styrka_min,
  case d.data -> 'strength' ->> 'intensity' when 'light' then 'Lätt' when 'medium' then 'Medel' when 'hard' then 'Hård' end as styrka_ansträngning,
  (d.data ->> 'alcohol')::numeric as alkohol_glas,
  (select string_agg(public.dagbok_namn(d.user_id, 'diet', k.key), ', ' order by k.key)
     from jsonb_each_text(coalesce(d.data -> 'diet', '{}'::jsonb)) as k where k.value = 'true') as kost,
  (select string_agg(public.dagbok_namn(d.user_id, 'flags', k.key), ', ' order by k.key)
     from jsonb_each_text(coalesce(d.data -> 'flags', '{}'::jsonb)) as k where k.value = 'true') as besvär,
  coalesce((d.data -> 'flags' ->> 'flare')::boolean, false) as dålig_period,
  (select string_agg(concat_ws(' ', coalesce(m.data ->> 'name', 'Borttagen medicin'),
                               public.dagbok_dos(d.user_id, split_part(k.key, '@', 1), d.date),
                               case when split_part(k.key, '@', 2) not in ('', 'dag') then 'kl. ' || split_part(k.key, '@', 2) end), ', ' order by k.key)
     from jsonb_each_text(coalesce(d.data -> 'taken', '{}'::jsonb)) as k
     left join public.records as m on m.user_id = d.user_id and m.id = split_part(k.key, '@', 1)
    where k.value = 'true') as tagna_mediciner,
  (select string_agg(concat_ws(' ', coalesce(m.data ->> 'name', 'Borttagen medicin'),
                               nullif(trim(concat(p.data ->> 'dose', ' ', m.data ->> 'unit')), ''),
                               case when coalesce(p.data ->> 'time', '') <> '' then 'kl. ' || (p.data ->> 'time') end), ', ' order by p.data ->> 'time')
     from public.records as p
     left join public.records as m on m.user_id = p.user_id and m.id = p.data ->> 'medId'
    where p.user_id = d.user_id and p.type = 'prn' and p.date = d.date and not p.deleted) as vid_behov,
  jsonb_array_length(coalesce(d.data -> 'photos', '[]'::jsonb)) as antal_foton,
  d.data ->> 'note' as anteckning,
  to_timestamp(d.updated_at / 1000.0) as senast_ändrad
from public.records as d
where d.type = 'day' and not d.deleted and d.data is not null
order by d.date desc;

-- En rad per insättning, dosändring, utsättning och vid behov-intag
create view public.medicinhistorik with (security_invoker = true) as
select *
from (
  select
    c.date as datum,
    null::text as tid,
    coalesce(m.data ->> 'name', 'Borttagen medicin') as medicin,
    case when m.data ->> 'kind' = 'prn' then 'Vid behov' else 'Fast' end as typ,
    case c.data ->> 'action' when 'start' then 'Insatt' when 'change' then 'Dosändring' when 'stop' then 'Utsatt' else c.data ->> 'action' end as händelse,
    nullif(c.data ->> 'dose', '') as dos,
    m.data ->> 'unit' as enhet,
    nullif(c.data ->> 'note', '') as kommentar
  from public.records as c
  left join public.records as m on m.user_id = c.user_id and m.id = c.data ->> 'medId'
  where c.type = 'medchange' and not c.deleted
  union all
  select
    p.date,
    nullif(p.data ->> 'time', ''),
    coalesce(m.data ->> 'name', 'Borttagen medicin'),
    'Vid behov',
    'Taget',
    nullif(p.data ->> 'dose', ''),
    m.data ->> 'unit',
    nullif(p.data ->> 'note', '')
  from public.records as p
  left join public.records as m on m.user_id = p.user_id and m.id = p.data ->> 'medId'
  where p.type = 'prn' and not p.deleted
) as h
order by datum desc, tid desc nulls last;

revoke all on public.dagbok, public.medicinhistorik from anon;
grant select on public.dagbok, public.medicinhistorik to authenticated;
revoke all on function public.dagbok_namn(uuid, text, text) from public, anon;
revoke all on function public.dagbok_dos(uuid, text, date) from public, anon;
grant execute on function public.dagbok_namn(uuid, text, text) to authenticated;
grant execute on function public.dagbok_dos(uuid, text, date) to authenticated;
