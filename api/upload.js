// Serverless function Vercel: POST /api/upload
// Menerima foto (JPEG, base64) dari browser dan menyimpannya ke Supabase Storage (bucket "bukti").
// Mengembalikan { url } berupa alamat publik foto.
//
// Variabel lingkungan yang sama dengan laporan.js:
//   SUPABASE_URL, SUPABASE_SECRET_KEY

const crypto = require('crypto');

const MAX_BYTES = 3 * 1024 * 1024; // 3 MB setelah dikompres di browser

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Gunakan metode POST' });
  }
  try {
    const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL atau SUPABASE_SECRET_KEY belum terbaca di server');
    }

    const b = req.body || {};
    if (b.type !== 'image/jpeg' || typeof b.data !== 'string') {
      return res.status(400).json({ error: 'Hanya foto JPEG yang diterima' });
    }
    const buf = Buffer.from(b.data, 'base64');
    if (buf.length < 100 || buf.length > MAX_BYTES) {
      return res.status(400).json({ error: 'Ukuran foto tidak valid (maksimal 3 MB)' });
    }
    // Cek tanda file JPEG (FF D8 FF) agar bukan file lain yang menyamar
    if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) {
      return res.status(400).json({ error: 'File bukan JPEG yang valid' });
    }

    const d = new Date();
    const path = d.getUTCFullYear() + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + crypto.randomUUID() + '.jpg';

    const headers = { apikey: key, 'content-type': 'image/jpeg', 'cache-control': 'max-age=31536000' };
    if (key.startsWith('eyJ')) headers.authorization = 'Bearer ' + key; // kunci lama (service_role) berbentuk JWT

    const r = await fetch(url + '/storage/v1/object/bukti/' + path, { method: 'POST', headers, body: buf });
    if (!r.ok) throw new Error('Storage ' + r.status + ': ' + (await r.text()));

    return res.status(201).json({ url: url + '/storage/v1/object/public/bukti/' + path });
  } catch (e) {
    console.error(e);
    // detail ditampilkan untuk diagnosa; hapus bagian detail kalau sudah stabil
    return res.status(502).json({ error: 'Foto tidak dapat diunggah', detail: String((e && e.message) || e).slice(0, 300) });
  }
};