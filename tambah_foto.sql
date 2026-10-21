-- LaporFasilitas: tambahan untuk fitur foto bukti
-- Jalankan sekali di Supabase: SQL Editor -> New query -> tempel -> Run
-- Aman dijalankan ulang.

-- 1. Kolom alamat foto di tabel laporan
alter table public.laporan add column if not exists foto_url text;

-- 2. Bucket penyimpanan foto bernama "bukti" (publik agar foto bisa ditampilkan di dashboard)
--    Batas 3 MB per file dan hanya JPEG.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bukti', 'bukti', true, 3145728, array['image/jpeg'])
on conflict (id) do update
  set public = true,
      file_size_limit = 3145728,
      allowed_mime_types = array['image/jpeg'];

-- 3. Muat ulang daftar tabel agar kolom baru langsung terbaca
notify pgrst, 'reload schema';

-- Cek hasilnya:
--   select id, name, public from storage.buckets;
--   select kode_tiket, foto_url from laporan;