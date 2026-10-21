// Serverless function Vercel: /api/laporan
//   GET    -> daftar laporan
//   POST   -> simpan laporan baru (kode tiket dibuat server)
//   PATCH  -> ubah status laporan (butuh kata sandi pengelola)
//
// Variabel lingkungan (Vercel -> Settings -> Environment Variables):
//   SUPABASE_URL         contoh: https://abcdxyz.supabase.co
//   SUPABASE_SECRET_KEY  secret key dari Supabase (JANGAN dimasukkan ke kode atau GitHub)
//   ADMIN_PASSWORD       kata sandi bebas, dipakai pengelola untuk mengubah status

const URGENSI = ['Rendah', 'Sedang', 'Tinggi'];
const STATUS = ['Baru', 'Diproses', 'Selesai'];

function config() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    const hilang = [!url && 'SUPABASE_URL', !key && 'SUPABASE_SECRET_KEY'].filter(Boolean).join(' dan ');
    // hanya NAMA variabel yang ditampilkan (bukan isinya), untuk diagnosa salah ketik
    const terbaca = Object.keys(process.env).filter((k) => /supa|admin|gemini|ai_/i.test(k)).join(', ') || '(tidak ada)';
    throw new Error('Yang belum terbaca: ' + hilang + '. Variabel terkait yang terbaca server: ' + terbaca + '. Cek nama, environment Production, lalu Redeploy.');
  }
  return {
    url,
    base: url + '/rest/v1/laporan',
    // Secret key dikirim lewat header apikey saja
    headers: { apikey: key, 'content-type': 'application/json' },
  };
}

function text(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function newCode() {
  return 'LF-' + (1000 + Math.floor(Math.random() * 9000));
}

module.exports = async (req, res) => {
  try {
    const { url, base, headers } = config();

    // ---------- GET: daftar laporan ----------
    if (req.method === 'GET') {
      const r = await fetch(base + '?select=*&order=dibuat_pada.desc&limit=200', { headers });
      if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + (await r.text()));
      return res.status(200).json(await r.json());
    }

    // ---------- POST: simpan laporan baru ----------
    if (req.method === 'POST') {
      const b = req.body || {};
      const row = {
        kategori: text(b.kategori, 40),
        lokasi: text(b.lokasi, 80),
        deskripsi: text(b.deskripsi, 200),
        urgensi: URGENSI.includes(b.urgensi) ? b.urgensi : 'Sedang',
      };
      // foto opsional: hanya alamat dari bucket "bukti" milik project ini yang diterima
      const fu = typeof b.foto_url === 'string' ? b.foto_url : '';
      if (fu && fu.length < 400 && fu.startsWith(url + '/storage/v1/object/public/bukti/')) row.foto_url = fu;
      if (!row.kategori || !row.lokasi || !row.deskripsi) {
        return res.status(400).json({ error: 'Kategori, lokasi, dan deskripsi wajib diisi' });
      }
      for (let i = 0; i < 6; i++) {
        const r = await fetch(base, {
          method: 'POST',
          headers: { ...headers, Prefer: 'return=representation' },
          body: JSON.stringify({ ...row, kode_tiket: newCode() }),
        });
        if (r.status === 409) continue; // kode tiket bentrok, coba kode lain
        if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + (await r.text()));
        const rows = await r.json();
        return res.status(201).json(rows[0]);
      }
      throw new Error('Gagal membuat kode tiket unik');
    }

    // ---------- PATCH: ubah status (khusus pengelola) ----------
    if (req.method === 'PATCH') {
      const admin = process.env.ADMIN_PASSWORD;
      if (!admin) return res.status(403).json({ error: 'ADMIN_PASSWORD belum diatur di server' });
      if (req.headers['x-admin-password'] !== admin) {
        return res.status(401).json({ error: 'Kata sandi salah' });
      }
      const b = req.body || {};
      if (!/^LF-\d{4}$/.test(b.kode_tiket || '') || !STATUS.includes(b.status)) {
        return res.status(400).json({ error: 'Data tidak valid' });
      }
      const r = await fetch(base + '?kode_tiket=eq.' + encodeURIComponent(b.kode_tiket), {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify({ status: b.status }),
      });
      if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + (await r.text()));
      const rows = await r.json();
      if (!rows.length) return res.status(404).json({ error: 'Tiket tidak ditemukan' });
      return res.status(200).json(rows[0]);
    }

    return res.status(405).json({ error: 'Metode tidak didukung' });
  } catch (e) {
    console.error(e);
    // detail ditampilkan untuk diagnosa; hapus bagian detail kalau sudah stabil
    return res.status(502).json({ error: 'Database tidak dapat dihubungi', detail: String((e && e.message) || e).slice(0, 300) });
  }
};