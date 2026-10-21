-- LaporFasilitas: skema database (PostgreSQL / Supabase)
-- Jalankan sekali di Supabase: SQL Editor -> New query -> tempel -> Run

create table if not exists public.laporan (
  id           bigint generated always as identity primary key,
  kode_tiket   text unique not null,
  kategori     text not null,
  lokasi       text not null,
  deskripsi    text not null,
  urgensi      text not null check (urgensi in ('Rendah', 'Sedang', 'Tinggi')),
  status       text not null default 'Baru' check (status in ('Baru', 'Diproses', 'Selesai')),
  dibuat_pada  timestamptz not null default now()
);

create index if not exists laporan_status_idx on public.laporan (status);
create index if not exists laporan_dibuat_idx on public.laporan (dibuat_pada desc);

-- Keamanan: aktifkan Row Level Security tanpa policy.
-- Artinya tabel TIDAK bisa diakses langsung dari browser.
-- Data hanya bisa diakses lewat server (api/laporan.js) memakai secret key.
alter table public.laporan enable row level security;

-- (Opsional) data contoh agar dashboard tidak kosong
insert into public.laporan (kode_tiket, kategori, lokasi, deskripsi, urgensi, status) values
  ('LF-1042', 'Wi-Fi',     'Perpustakaan lantai 2', 'Wi-Fi sering putus saat jam sibuk',                'Sedang', 'Diproses'),
  ('LF-1038', 'Proyektor', 'Ruang 204',             'Proyektor tidak menyala sama sekali',              'Sedang', 'Baru'),
  ('LF-1031', 'Listrik',   'Lab Komputer 1',        'Stop kontak korsleting dan keluar percikan api',   'Tinggi', 'Selesai')
on conflict (kode_tiket) do nothing;

-- ---------------------------------------------------------------
-- Contoh query untuk latihan / demo ke dosen
-- ---------------------------------------------------------------
-- Semua laporan terbaru:
--   select * from laporan order by dibuat_pada desc;
-- Jumlah laporan per status:
--   select status, count(*) as jumlah from laporan group by status;
-- Laporan urgensi tinggi yang belum selesai:
--   select kode_tiket, kategori, lokasi from laporan
--   where urgensi = 'Tinggi' and status <> 'Selesai';
-- Kategori yang paling sering dilaporkan:
--   select kategori, count(*) as jumlah from laporan
--   group by kategori order by jumlah desc;