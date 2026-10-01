-- YUマーケット Supabase スキーマ
-- Supabase の SQL Editor で上から順に実行する。

-- ========== テーブル ==========
create table profiles (
  id uuid primary key references auth.users on delete cascade,
  name text not null default '', faculty text not null default '', campus text not null default '',
  photo_url text,
  -- 問題のある利用者を止める。ダッシュボードで true にすると出品・申込・メッセージができなくなる。
  blocked boolean not null default false,
  created_at timestamptz not null default now()
);
create table listings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  category text, color text, condition text, period text, pickup text, campus text,
  description text not null default '', photo_url text,
  status text not null default 'open' check (status in ('open', 'reserved', 'done', 'cancelled')),
  created_at timestamptz not null default now()
);
create table applications (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listings(id) on delete cascade,
  applicant_id uuid not null references profiles(id) on delete cascade,
  date text, place text, message text,
  status text not null default '申込中' check (status in ('申込中', '取引中', '取引完了', '取消')),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
-- 取引中の当事者だけのやりとり。受け渡し完了・取消のときに消す。
create table messages (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  sender_id uuid not null references profiles(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);
-- 出品者の評価。受け取った人が、取引ごとに1回だけ付けられる。
create table ratings (
  id uuid primary key default gen_random_uuid(),
  application_id uuid references applications(id) on delete set null,
  rater_id uuid not null references profiles(id) on delete cascade,
  rated_id uuid not null references profiles(id) on delete cascade,
  good boolean not null,
  created_at timestamptz not null default now()
);
create unique index one_rating_per_application on ratings (application_id);

-- 通報。運営者がダッシュボードで確認する。通報時点の出品内容とやりとりのコピーも残す。
create table reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references profiles(id) on delete cascade,
  reported_id uuid not null references profiles(id) on delete cascade,
  listing_id uuid references listings(id) on delete set null,
  -- 取引についての通報。この取引ではメッセージを送れなくなる。
  application_id uuid references applications(id) on delete set null,
  listing_name text not null default '',
  listing_detail text not null default '',
  messages_snapshot text not null default '',
  reason text not null,
  note text not null default '',
  created_at timestamptz not null default now()
);
create index on listings (owner_id);
create index on applications (listing_id);
create index on applications (applicant_id);
create index on messages (application_id, created_at);
create index on reports (created_at desc);
create index on ratings (rated_id);
-- 同じ出品に同じ人が二重に申し込めない（取消後の再申込は可）
create unique index one_active_application
  on applications (listing_id, applicant_id)
  where status in ('申込中', '取引中');

-- ========== 利用停止の判定 ==========
create or replace function public.is_blocked() returns boolean
language sql security definer set search_path = '' stable as $$
  select coalesce((select blocked from public.profiles where id = (select auth.uid())), false);
$$;
revoke execute on function public.is_blocked() from public, anon;
grant execute on function public.is_blocked() to authenticated;

-- 自分の未完了の申込数（申込中＋取引中）。同時に申し込める数の上限に使う。
create or replace function public.active_application_count() returns integer
language sql security definer set search_path = '' stable as $$
  select count(*)::int from public.applications
  where applicant_id = (select auth.uid()) and status in ('申込中', '取引中');
$$;
revoke execute on function public.active_application_count() from public, anon;
grant execute on function public.active_application_count() to authenticated;

-- 通報された取引かどうか（reports は誰も読めないので関数で判定する）
create or replace function public.trade_reported(app_id uuid) returns boolean
language sql security definer set search_path = '' stable as $$
  select exists (select 1 from public.reports where application_id = app_id);
$$;
revoke execute on function public.trade_reported(uuid) from public, anon;
grant execute on function public.trade_reported(uuid) to authenticated;

-- ========== RLS ==========
alter table profiles enable row level security;
alter table listings enable row level security;
alter table applications enable row level security;
alter table messages enable row level security;
alter table reports enable row level security;
alter table ratings enable row level security;

create policy "read profiles" on profiles for select to authenticated using (true);
create policy "update own profile" on profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy "read listings" on listings for select to authenticated using (true);
create policy "own listings" on listings for all to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id and not public.is_blocked());

create policy "read my applications" on applications for select to authenticated
  using ((select auth.uid()) = applicant_id
      or (select auth.uid()) = (select owner_id from listings where id = listing_id));
-- status は '申込中' でしか作れない（承認を経ずに取引中の申込を作らせない）
create policy "apply" on applications for insert to authenticated
  with check ((select auth.uid()) = applicant_id
      and status = '申込中' and completed_at is null
      and not public.is_blocked()
      -- 同時に申し込めるのは3件まで（docs/app.js の MAX_ACTIVE_APPLICATIONS と揃える）
      and public.active_application_count() < 3
      and exists (select 1 from listings l
                  where l.id = listing_id and l.status = 'open'
                    and l.owner_id <> (select auth.uid())));
create policy "update my applications" on applications for update to authenticated
  using ((select auth.uid()) = applicant_id
      or (select auth.uid()) = (select owner_id from listings where id = listing_id))
  with check ((select auth.uid()) = applicant_id
      or (select auth.uid()) = (select owner_id from listings where id = listing_id));
-- クライアントから直接更新できる列は date, place のみ。status は RPC 経由のみ
revoke update on applications from anon, authenticated;
grant update (date, place) on applications to authenticated;

-- メッセージは当事者だけが読める
create policy "read my messages" on messages for select to authenticated
  using (exists (select 1 from applications ap join listings l on l.id = ap.listing_id
                 where ap.id = application_id
                   and ((select auth.uid()) = ap.applicant_id or (select auth.uid()) = l.owner_id)));
-- 取引中のあいだだけ、当事者が自分の名前で送れる
create policy "send message" on messages for insert to authenticated
  with check ((select auth.uid()) = sender_id
    and not public.is_blocked()
    and not public.trade_reported(application_id)
    and exists (select 1 from applications ap join listings l on l.id = ap.listing_id
                where ap.id = application_id and ap.status = '取引中'
                  and ((select auth.uid()) = ap.applicant_id or (select auth.uid()) = l.owner_id)));
-- 送ったあとの書き換え・削除はさせない（完了・取消のときに関数側で消す）
revoke update, delete on messages from anon, authenticated;

-- 通報は送れるだけ。自分の名前でだけ送れ、自分自身は通報できない
create policy "send report" on reports for insert to authenticated
  with check ((select auth.uid()) = reporter_id
    and reported_id <> (select auth.uid()));
-- select ポリシーを作らないので、アプリからは誰も読めない（ダッシュボードで確認する）
revoke update, delete on reports from anon, authenticated;

-- 評価は自分が付けたものだけ読める（合計は rating_summary() で取る）
create policy "read own ratings" on ratings for select to authenticated
  using ((select auth.uid()) = rater_id);
-- 取引完了した申込者が、その出品者を1回だけ評価できる
create policy "rate after done" on ratings for insert to authenticated
  with check ((select auth.uid()) = rater_id
    and rated_id <> (select auth.uid())
    and not public.is_blocked()
    and exists (select 1 from applications ap join listings l on l.id = ap.listing_id
                where ap.id = application_id
                  and ap.status = '取引完了'
                  and ap.applicant_id = (select auth.uid())
                  and l.owner_id = rated_id));
revoke update, delete on ratings from anon, authenticated;

-- ========== 登録時: ドメイン制限 + profiles 自動作成 ==========
create or replace function public.on_auth_user_created() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(new.email, '') !~* '@yamaguchi-u\.ac\.jp$' then
    raise exception 'university email only';
  end if;
  insert into public.profiles (id) values (new.id);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.on_auth_user_created();

-- ========== 評価の合計（誰が付けたかは返さない） ==========
create or replace function public.rating_summary(user_id uuid)
returns json language sql security definer set search_path = '' stable as $$
  select json_build_object(
    'good', count(*) filter (where good),
    'total', count(*)
  ) from public.ratings where rated_id = user_id;
$$;
revoke execute on function public.rating_summary(uuid) from public, anon;
grant execute on function public.rating_summary(uuid) to authenticated;

-- ========== RPC: 承認（出品者のみ） ==========
create or replace function public.approve_application(app_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare lid uuid; oid uuid;
begin
  select ap.listing_id, l.owner_id into lid, oid
  from public.applications ap join public.listings l on l.id = ap.listing_id
  where ap.id = app_id and ap.status = '申込中' and l.status = 'open';
  if not found or oid <> (select auth.uid()) then raise exception 'not allowed'; end if;
  update public.applications set status = '取引中' where id = app_id;
  update public.applications set status = '取消'
    where listing_id = lid and id <> app_id and status = '申込中';
  update public.listings set status = 'reserved' where id = lid;
end $$;

-- ========== RPC: 受け渡し完了（出品者のみ） ==========
create or replace function public.complete_application(app_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare lid uuid; oid uuid;
begin
  select ap.listing_id, l.owner_id into lid, oid
  from public.applications ap join public.listings l on l.id = ap.listing_id
  where ap.id = app_id and ap.status = '取引中';
  if not found or oid <> (select auth.uid()) then raise exception 'not allowed'; end if;
  update public.applications set status = '取引完了', completed_at = now() where id = app_id;
  update public.listings set status = 'done' where id = lid;
  delete from public.messages where application_id = app_id;
end $$;

-- ========== RPC: 取消（当事者のどちらか） ==========
create or replace function public.cancel_application(app_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare lid uuid; oid uuid; aid uuid; st text; me uuid := (select auth.uid());
begin
  select ap.listing_id, l.owner_id, ap.applicant_id, ap.status into lid, oid, aid, st
  from public.applications ap join public.listings l on l.id = ap.listing_id
  where ap.id = app_id;
  if not found or st not in ('申込中', '取引中') or (me <> oid and me <> aid) then
    raise exception 'not allowed';
  end if;
  update public.applications set status = '取消' where id = app_id;
  if st = '取引中' then
    update public.listings set status = 'open' where id = lid;
  end if;
  delete from public.messages where application_id = app_id;
end $$;

revoke execute on function public.approve_application(uuid) from public, anon;
revoke execute on function public.complete_application(uuid) from public, anon;
revoke execute on function public.cancel_application(uuid) from public, anon;
grant execute on function public.approve_application(uuid) to authenticated;
grant execute on function public.complete_application(uuid) to authenticated;
grant execute on function public.cancel_application(uuid) to authenticated;

-- ========== Storage: 写真 ==========
insert into storage.buckets (id, name, public) values ('photos', 'photos', true);
create policy "photos read" on storage.objects for select using (bucket_id = 'photos');
create policy "photos upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text);
-- 出品を取り消すと行ごと削除するので、写真も消せるようにする
create policy "photos delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text);
