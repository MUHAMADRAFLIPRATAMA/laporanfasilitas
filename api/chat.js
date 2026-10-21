// Serverless function Vercel: POST /api/chat
// Kunci API disimpan di Environment Variables Vercel, tidak pernah dikirim ke browser.
//
// Variabel yang dipakai:
//   AI_PROVIDER        "anthropic" (default), "gemini", atau "huggingface"
//   GEMINI_API_KEY     wajib jika provider = gemini
//   GEMINI_THINKING_BUDGET opsional, isi 0 untuk mempercepat (jika model mendukung)
//   GEMINI_MODEL       opsional, default gemini-flash-latest (alias model Flash terbaru)
//   ANTHROPIC_API_KEY  wajib jika provider = anthropic
//   ANTHROPIC_MODEL    opsional, default claude-haiku-5-5
//   HF_TOKEN           wajib jika provider = huggingface
//   HF_MODEL           wajib jika provider = huggingface (nama model di Hugging Face)

const SYSTEM = `Kamu adalah chatbot LaporFasilitas, asisten untuk mahasiswa yang melaporkan kerusakan fasilitas kampus.

Tugasmu mengumpulkan tiga hal:
1. kategori fasilitas: AC, Proyektor, Wi-Fi, Listrik, Air & toilet, Furnitur, atau Lainnya
2. lokasi: gedung atau ruangan
3. deskripsi masalah

Gunakan bahasa Indonesia yang santai, singkat, dan ramah. Tanyakan satu hal yang masih kurang dalam satu giliran. Jangan menanyakan hal yang sudah diketahui.

Setelah ketiganya jelas, tentukan urgensi:
- Tinggi: ada bahaya keselamatan (korsleting, percikan api, bocor besar, banjir) atau fasilitas mati total sehingga perkuliahan terganggu
- Sedang: mengganggu tetapi masih ada alternatif
- Rendah: masalah ringan atau kosmetik

Balas HANYA dengan JSON, tanpa teks lain dan tanpa blok kode.
Jika data belum lengkap: {"reply":"...","laporan":null}
Jika data sudah lengkap: {"reply":"...","laporan":{"kategori":"...","lokasi":"...","deskripsi":"...","urgensi":"Rendah|Sedang|Tinggi"}}
Saat data lengkap, isi reply dengan konfirmasi singkat bahwa laporan dicatat. Jangan membuat kode tiket sendiri, kode dibuat oleh sistem.
Jika pesan tidak berkaitan dengan fasilitas kampus, arahkan kembali dengan sopan.`;

const URGENSI = ['Rendah', 'Sedang', 'Tinggi'];

function cleanMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = messages.slice(-12).map((m) => ({
    role: m && m.role === 'assistant' ? 'assistant' : 'user',
    content: String((m && m.content) || '').slice(0, 500),
  })).filter((m) => m.content.trim());
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

function parseReply(text) {
  const match = text.match(/\{[\s\S]*\}/);
  try {
    const j = JSON.parse(match ? match[0] : text);
    const reply = typeof j.reply === 'string' && j.reply.trim() ? j.reply.trim() : 'Maaf, bisa diulangi?';
    let laporan = null;
    const l = j.laporan;
    if (l && l.kategori && l.lokasi && l.deskripsi) {
      laporan = {
        kategori: String(l.kategori).slice(0, 40),
        lokasi: String(l.lokasi).slice(0, 80),
        deskripsi: String(l.deskripsi).slice(0, 200),
        urgensi: URGENSI.includes(l.urgensi) ? l.urgensi : 'Sedang',
      };
    }
    return { reply, laporan };
  } catch (e) {
    return { reply: text.trim() || 'Maaf, bisa diulangi?', laporan: null };
  }
}

async function callClaude(messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
      max_tokens: 400,
      system: SYSTEM,
      messages,
    }),
  });
  if (!r.ok) throw new Error('Claude API ' + r.status + ': ' + (await r.text()));
  const d = await r.json();
  return d.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function callHuggingFace(messages) {
  const r = await fetch('https://router.huggingface.co/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + process.env.HF_TOKEN,
    },
    body: JSON.stringify({
      model: process.env.HF_MODEL,
      max_tokens: 400,
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
    }),
  });
  if (!r.ok) throw new Error('Hugging Face API ' + r.status + ': ' + (await r.text()));
  const d = await r.json();
  return d.choices[0].message.content;
}

async function callGemini(messages) {
  const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  const genCfg = { maxOutputTokens: 600, responseMimeType: 'application/json' };
  // Opsional: GEMINI_THINKING_BUDGET=0 untuk mematikan proses "berpikir" (lebih cepat) di model yang mendukung
  if (process.env.GEMINI_THINKING_BUDGET !== undefined && process.env.GEMINI_THINKING_BUDGET !== '') {
    genCfg.thinkingConfig = { thinkingBudget: Number(process.env.GEMINI_THINKING_BUDGET) };
  }
  const r = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        generationConfig: genCfg,
      }),
    }
  );
  if (!r.ok) throw new Error('Gemini API ' + r.status + ': ' + (await r.text()));
  const d = await r.json();
  const parts = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
  return parts.map((p) => p.text || '').join('');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Gunakan metode POST' });
  }
  const messages = cleanMessages(req.body && req.body.messages);
  if (!messages.length) {
    return res.status(400).json({ error: 'Pesan kosong' });
  }
  try {
    const provider = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
    const t0 = Date.now();
    let text;
    if (provider === 'gemini' && !process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY belum terbaca di server (cek nama variabel dan Redeploy)');
    if (provider === 'gemini') text = await callGemini(messages);
    else if (provider === 'huggingface') text = await callHuggingFace(messages);
    else text = await callClaude(messages);
    const out = parseReply(text);
    out.ms = Date.now() - t0; // lama waktu panggilan ke AI (milidetik)
    return res.status(200).json(out);
  } catch (e) {
    console.error(e);
    // detail ditampilkan untuk diagnosa; hapus baris detail ini kalau sudah berhasil dan mau dirilis
    return res.status(502).json({ error: 'AI tidak dapat dihubungi', detail: String((e && e.message) || e).slice(0, 300) });
  }
};