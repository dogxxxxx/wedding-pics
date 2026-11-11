-- ============================================================================
-- 婚禮相片牆 - Supabase 專案初始化腳本
-- 這份腳本「完全相同」，請在你建立的 4 個 Supabase 專案裡各自貼上執行一次。
-- 使用方式：進入專案的 Dashboard → SQL Editor → New query → 貼上全部內容 → Run
-- ============================================================================

-- 0. 確保有 gen_random_uuid() 可用
create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. 資料表：media（每一筆上傳紀錄）
-- ----------------------------------------------------------------------------
-- 不再有審核機制：上傳後直接公開（bucket / status 固定為 'approved'），管理員只負責刪除。
-- seq 是全站統一的上傳序號（由主要專案的 claim_upload_number 發號）。
create table if not exists media (
  id uuid primary key default gen_random_uuid(),
  bucket text not null default 'approved' check (bucket in ('pending', 'approved')),
  storage_path text not null,
  media_type text not null check (media_type in ('image', 'video')),
  size_bytes bigint not null,
  uploader_name text,
  caption text,
  status text not null default 'approved' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  seq bigint
);

-- 舊專案升級用（新建立的專案這幾行不會有任何效果）
alter table media add column if not exists seq bigint;
alter table media alter column bucket set default 'approved';
alter table media alter column status set default 'approved';

create index if not exists media_status_idx on media (status);
create index if not exists media_created_at_idx on media (created_at desc);
create index if not exists media_seq_idx on media (seq);

alter table media enable row level security;

-- 舊的審核用 policy，一律移除
drop policy if exists "anyone can insert pending media" on media;
drop policy if exists "authenticated can view all media" on media;
drop policy if exists "authenticated can update media" on media;

-- 任何人（含匿名訪客）都可以新增一筆直接公開的紀錄（上傳時使用）
drop policy if exists "anyone can insert media" on media;
create policy "anyone can insert media" on media
  for insert to anon, authenticated
  with check (status = 'approved' and bucket = 'approved');

-- 任何人都可以看到公開的紀錄（公開相簿使用）
drop policy if exists "anyone can view approved media" on media;
create policy "anyone can view approved media" on media
  for select to anon, authenticated
  using (status = 'approved');

-- 已登入的管理員可以刪除紀錄（移除照片）
drop policy if exists "authenticated can delete media" on media;
create policy "authenticated can delete media" on media
  for delete to authenticated
  using (true);

-- ----------------------------------------------------------------------------
-- 2. 資料表：project_settings（單一列，控制「是否開放上傳」與流量估算）
-- ----------------------------------------------------------------------------
create table if not exists project_settings (
  id int primary key default 1,
  uploads_enabled boolean not null default true,
  estimated_egress_bytes bigint not null default 0
);

insert into project_settings (id, uploads_enabled, estimated_egress_bytes)
values (1, true, 0)
on conflict (id) do nothing;

alter table project_settings enable row level security;

-- 任何人都可以讀取設定（上傳頁要知道是否開放、相簿頁要顯示用量）
drop policy if exists "anyone can view settings" on project_settings;
create policy "anyone can view settings" on project_settings
  for select to anon, authenticated
  using (true);

-- 已登入的管理員可以更新設定（開關上傳）
drop policy if exists "authenticated can update settings" on project_settings;
create policy "authenticated can update settings" on project_settings
  for update to authenticated
  using (true)
  with check (true);

-- ----------------------------------------------------------------------------
-- 3. 函式：track_egress（估算流量用，前端每次載入一張圖/影片就呼叫一次）
--    用 SECURITY DEFINER 讓匿名訪客也能執行，但單次呼叫的位元組數有上限，
--    避免有人惡意灌爆這個計數器。
-- ----------------------------------------------------------------------------
create or replace function public.track_egress(bytes bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if bytes is null or bytes < 0 or bytes > 200000000 then
    return; -- 忽略異常數值（單次上限 200MB）
  end if;

  update project_settings
  set estimated_egress_bytes = estimated_egress_bytes + bytes
  where id = 1;
end;
$$;

grant execute on function public.track_egress(bigint) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4. Storage bucket：approved（公開，上傳後直接顯示）
--    不再使用 pending bucket；舊專案裡殘留的 pending bucket 可以忽略或自行刪除。
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'approved', 'approved', true, 104857600,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif','video/mp4','video/quicktime','video/webm']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ----------------------------------------------------------------------------
-- 5. Storage RLS：approved 任何人可讀、可上傳（匿名訪客），只有管理員能刪除/更新
-- ----------------------------------------------------------------------------
-- 舊的 pending bucket policy，一律移除
drop policy if exists "anon can upload to pending" on storage.objects;
drop policy if exists "authenticated can manage pending" on storage.objects;

drop policy if exists "anon can upload to approved" on storage.objects;
create policy "anon can upload to approved" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'approved');

drop policy if exists "anyone can view approved objects" on storage.objects;
create policy "anyone can view approved objects" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'approved');

drop policy if exists "authenticated can manage approved" on storage.objects;
create policy "authenticated can manage approved" on storage.objects
  for all to authenticated
  using (bucket_id = 'approved')
  with check (bucket_id = 'approved');

-- ----------------------------------------------------------------------------
-- 6. 抽獎：全站上傳序號與中獎號碼
--    只有「主要專案」（projects.json 裡 priority 最小的那一個）會真正使用這些表與函式，
--    但為了「4 個專案貼同一份腳本」的簡單，其他專案也會建立（不會被使用）。
--    表本身不開放匿名存取，訪客只能透過 claim_upload_number() 取得「自己的序號」與「是否中獎」，
--    看不到中獎號碼清單。
-- ----------------------------------------------------------------------------
create table if not exists upload_claims (
  upload_id uuid primary key,          -- 前端產生，同一個檔案重試時結果不變（冪等）
  seq bigint not null unique,          -- 全站上傳序號，從 1 開始、不跳號
  device_token text not null,
  uploader_name text,
  won_slot bigint,                     -- 這次上傳讓哪個中獎號碼生效（沒中獎為 null）
  created_at timestamptz not null default now()
);

create table if not exists winning_numbers (
  seq bigint primary key,              -- 預先設定的中獎號碼
  label text,                          -- 備註，例如「頭獎」
  awarded_upload_id uuid,              -- 實際中獎的那次上傳（null = 還沒有人領走）
  awarded_seq bigint,                  -- 實際中獎的上傳序號（可能比 seq 大：順延）
  device_token text,
  winner_name text,
  awarded_at timestamptz
);

-- 同一個裝置只能中一次獎
create unique index if not exists winning_numbers_device_token_uniq
  on winning_numbers (device_token) where device_token is not null;

alter table upload_claims enable row level security;
alter table winning_numbers enable row level security;

drop policy if exists "authenticated can view claims" on upload_claims;
create policy "authenticated can view claims" on upload_claims
  for select to authenticated
  using (true);

drop policy if exists "authenticated can manage winning numbers" on winning_numbers;
create policy "authenticated can manage winning numbers" on winning_numbers
  for all to authenticated
  using (true)
  with check (true);

-- 取得上傳序號並判斷是否中獎。
-- 規則：中獎號碼 N 在「序號 >= N」的第一個「尚未中過獎的裝置」上傳時生效。
--       若第 N 張剛好是已中過獎的人上傳的，名額會順延給之後第一位符合資格的上傳者。
create or replace function public.claim_upload_number(p_upload_id uuid, p_token text, p_name text)
returns table (out_seq bigint, out_is_winner boolean, out_slot_seq bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim upload_claims%rowtype;
  v_slot bigint;
begin
  if p_upload_id is null or p_token is null or length(p_token) < 8 or length(p_token) > 100 then
    raise exception 'invalid arguments';
  end if;

  -- 序列化所有取號請求，確保序號連續且判斷不會有競爭
  perform pg_advisory_xact_lock(727001);

  select * into v_claim from upload_claims where upload_id = p_upload_id;
  if found then
    return query select v_claim.seq, v_claim.won_slot is not null, v_claim.won_slot;
    return;
  end if;

  insert into upload_claims (upload_id, seq, device_token, uploader_name)
  values (
    p_upload_id,
    (select coalesce(max(c.seq), 0) + 1 from upload_claims c),
    p_token,
    left(trim(coalesce(p_name, '')), 50)
  )
  returning * into v_claim;

  if not exists (select 1 from winning_numbers w where w.device_token = p_token) then
    select w.seq into v_slot
    from winning_numbers w
    where w.awarded_upload_id is null and w.seq <= v_claim.seq
    order by w.seq
    limit 1;

    if v_slot is not null then
      update winning_numbers
      set awarded_upload_id = v_claim.upload_id,
          awarded_seq = v_claim.seq,
          device_token = p_token,
          winner_name = v_claim.uploader_name,
          awarded_at = now()
      where seq = v_slot;

      update upload_claims set won_slot = v_slot where upload_id = v_claim.upload_id;
      v_claim.won_slot := v_slot;
    end if;
  end if;

  return query select v_claim.seq, v_claim.won_slot is not null, v_claim.won_slot;
end;
$$;

revoke all on function public.claim_upload_number(uuid, text, text) from public;
grant execute on function public.claim_upload_number(uuid, text, text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- （選用）從舊的審核版本升級時，把還沒審核的檔案直接轉成公開。
-- 需要的話，把下面兩行前面的 -- 拿掉再執行一次。
-- ----------------------------------------------------------------------------
-- update storage.objects set bucket_id = 'approved' where bucket_id = 'pending';
-- update media set bucket = 'approved', status = 'approved', approved_at = coalesce(approved_at, now()) where status = 'pending';

-- ============================================================================
-- 完成後檢查：
--   select * from project_settings;           -- 應該有 1 筆 (uploads_enabled = true)
--   select * from storage.buckets;            -- 應該看到 approved
--   select * from winning_numbers;            -- 一開始是空的，之後在管理後台設定
-- ============================================================================
