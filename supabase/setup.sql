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
create table if not exists media (
  id uuid primary key default gen_random_uuid(),
  bucket text not null check (bucket in ('pending', 'approved')),
  storage_path text not null,
  media_type text not null check (media_type in ('image', 'video')),
  size_bytes bigint not null,
  uploader_name text,
  caption text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  approved_at timestamptz
);

create index if not exists media_status_idx on media (status);
create index if not exists media_created_at_idx on media (created_at desc);

alter table media enable row level security;

-- 任何人（含匿名訪客）都可以新增一筆「待審核」的紀錄（上傳時使用）
drop policy if exists "anyone can insert pending media" on media;
create policy "anyone can insert pending media" on media
  for insert to anon, authenticated
  with check (status = 'pending');

-- 任何人都可以看到「已通過審核」的紀錄（公開相簿使用）
drop policy if exists "anyone can view approved media" on media;
create policy "anyone can view approved media" on media
  for select to anon, authenticated
  using (status = 'approved');

-- 已登入的管理員可以看到全部紀錄（含待審核／已拒絕）
drop policy if exists "authenticated can view all media" on media;
create policy "authenticated can view all media" on media
  for select to authenticated
  using (true);

-- 已登入的管理員可以更新紀錄（通過／拒絕）
drop policy if exists "authenticated can update media" on media;
create policy "authenticated can update media" on media
  for update to authenticated
  using (true)
  with check (true);

-- 已登入的管理員可以刪除紀錄（拒絕時清除）
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
-- 4. Storage buckets：pending（私密）與 approved（公開）
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'pending', 'pending', false, 104857600,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif','video/mp4','video/quicktime','video/webm']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

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
-- 5. Storage RLS：pending 只能新增（匿名上傳），只有管理員能讀取/搬移/刪除
-- ----------------------------------------------------------------------------
drop policy if exists "anon can upload to pending" on storage.objects;
create policy "anon can upload to pending" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'pending');

drop policy if exists "authenticated can manage pending" on storage.objects;
create policy "authenticated can manage pending" on storage.objects
  for all to authenticated
  using (bucket_id = 'pending')
  with check (bucket_id = 'pending');

-- ----------------------------------------------------------------------------
-- 6. Storage RLS：approved 任何人可讀，只有管理員能寫入/刪除
-- ----------------------------------------------------------------------------
drop policy if exists "anyone can view approved objects" on storage.objects;
create policy "anyone can view approved objects" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'approved');

drop policy if exists "authenticated can manage approved" on storage.objects;
create policy "authenticated can manage approved" on storage.objects
  for all to authenticated
  using (bucket_id = 'approved')
  with check (bucket_id = 'approved');

-- ============================================================================
-- 完成後檢查：
--   select * from project_settings;           -- 應該有 1 筆 (uploads_enabled = true)
--   select * from storage.buckets;            -- 應該看到 pending / approved 兩筆
-- ============================================================================
