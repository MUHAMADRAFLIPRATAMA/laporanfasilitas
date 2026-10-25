// Serverless function Vercel: POST /api/admin
// Memeriksa kata sandi pengelola (variabel ADMIN_PASSWORD di Vercel).
// Dipakai halaman admin.html untuk login.

const crypto = require('crypto');

function sha(v) {
  return crypto.createHash('sha256').update(String(v)).digest();
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Gunakan metode POST' });
  }
  const admin = process.env.ADMIN_PASSWORD;
  if (!admin) {
    return res.status(403).json({ error: 'ADMIN_PASSWORD belum diatur di server' });
  }
  const pw = String((req.body && req.body.password) || '');
  if (!crypto.timingSafeEqual(sha(pw), sha(admin))) {
    await new Promise((r) => setTimeout(r, 500)); // memperlambat tebak-tebakan kata sandi
    return res.status(401).json({ error: 'Kata sandi salah' });
  }
  return res.status(200).json({ ok: true });
};  