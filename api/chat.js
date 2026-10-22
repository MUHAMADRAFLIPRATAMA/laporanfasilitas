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

let autoModel = null; // model yang terbukti jalan (disimpan selama server hidup)
const goodIdx = {};   // variasi pengaturan yang terbukti diterima, per model

async function listModels(signal) {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', {
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY },
    signal,
  });
  if (!r.ok) throw new Error('ListModels ' + r.status);
  const d = await r.json();
  return (d.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name).replace(/^models\//, ''));
}

function pickModel(names) {
  const ok = names.filter((n) => /^gemini/.test(n) && !/tts|image|live|embed|audio|native|robotics|computer|thinking|learnlm/i.test(n));
  const stable = ok.filter((n) => !/preview|exp/i.test(n));
  return (
    stable.find((n) => /flash-lite/.test(n)) ||
    stable.find((n) => /flash/.test(n)) ||
    ok.find((n) => /flash-lite/.test(n)) ||
    ok.find((n) => /flash/.test(n)) ||
    ok[0] ||
    null
  );
}

async function callGemini(messages, info) {
  const base = { maxOutputTokens: 600, responseMimeType: 'application/json' };

  // Urutan percobaan: kalau Gemini menolak (400) karena ada opsi yang tidak didukung model,
  // coba lagi dengan opsi yang lebih sederhana.
  // Percobaan pertama meminta proses berpikir seminimal mungkin (model Gemini 3: thinkingLevel),
  // lalu thinkingBudget 0 (model Gemini 2.5), lalu tanpa pengaturan berpikir sama sekali.
  const variants = [];
  const tb = process.env.GEMINI_THINKING_BUDGET;
  if (tb !== undefined && tb !== '') variants.push({ ...base, thinkingConfig: { thinkingBudget: Number(tb) } });
  variants.push({ ...base, thinkingConfig: { thinkingLevel: process.env.GEMINI_THINKING_LEVEL || 'minimal' } });
  variants.push({ ...base, thinkingConfig: { thinkingBudget: 0 } });
  variants.push(base);
  variants.push({ maxOutputTokens: 600 });

  const makeBody = (cfg) => JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    generationConfig: cfg,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);

  async function tryModel(model) {
    const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
    let r;
    let text = '';
    for (let i = goodIdx[model] || 0; i < variants.length; i++) {
      r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        signal: ctrl.signal,
        body: makeBody(variants[i]),
      });
      if (r.ok) { goodIdx[model] = i; break; }
      if (r.status !== 400) break;
      text = await r.text();
    }
    if (!r.ok && !r.bodyUsed) text = await r.text();
    return { r, text };
  }

  try {
    let model = autoModel || process.env.GEMINI_MODEL || 'gemini-flash-latest';
    let names = null;
    let out = await tryModel(model);

    // Model ditolak (400/404): cari model lain yang tersedia di akun ini lalu coba otomatis
    if (!out.r.ok && (out.r.status === 400 || out.r.status === 404)) {
      names = await listModels(ctrl.signal).catch(() => null);
      const alt = names && pickModel(names);
      if (alt && alt !== model) {
        const out2 = await tryModel(alt);
        if (out2.r.ok) {
          autoModel = alt;
          model = alt;
          out = out2;
        } else {
          out.text += ' | model ' + alt + ' juga gagal: ' + out2.r.status;
        }
      }
    }

    if (!out.r.ok) {
      throw new Error(
        'Gemini API ' + out.r.status + ' (model ' + model + ').' +
        (names ? ' Model tersedia: ' + names.slice(0, 8).join(', ') + '.' : '') +
        ' Respons: ' + out.text.replace(/\s+/g, ' ')
      );
    }

    const d = await out.r.json();
    if (info) {
      info.model = model;
      info.think = d.usageMetadata && d.usageMetadata.thoughtsTokenCount;
    }
    const parts = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
    return parts.map((p) => p.text || '').join('');
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Gemini terlalu lama menjawab (lebih dari 25 detik)');
    throw e;
  } finally {
    clearTimeout(timer);
  }
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
    const info = {};
    let text;
    if (provider === 'gemini' && !process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY belum terbaca di server (cek nama variabel dan Redeploy)');
    if (provider === 'gemini') text = await callGemini(messages, info);
    else if (provider === 'huggingface') text = await callHuggingFace(messages);
    else text = await callClaude(messages);
    const out = parseReply(text);
    out.ms = Date.now() - t0; // lama waktu panggilan ke AI (milidetik)
    out.model = info.model;
    out.think = info.think;
    return res.status(200).json(out);
  } catch (e) {
    console.error(e);
    // detail ditampilkan untuk diagnosa; hapus baris detail ini kalau sudah berhasil dan mau dirilis
    return res.status(502).json({ error: 'AI tidak dapat dihubungi', detail: String((e && e.message) || e).slice(0, 300) });
  }
};