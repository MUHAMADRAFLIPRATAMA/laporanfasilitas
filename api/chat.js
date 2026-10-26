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

async function callClaude(messages, info) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY belum terbaca di server (cek nama variabel dan Redeploy)');
  }
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      signal: ctrl.signal,
      body: JSON.stringify({ model, max_tokens: 400, system: SYSTEM, messages }),
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Claude terlalu lama menjawab (lebih dari 20 detik)');
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) throw new Error('Claude API ' + r.status + ' (model ' + model + '): ' + (await r.text()));
  const d = await r.json();
  if (info) info.model = model;
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

let autoModel = null; // model cadangan yang terbukti jalan
let autoUntil = 0;    // sampai kapan model cadangan dipakai (ms sejak epoch)
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

// Urutan cadangan: Flash-Lite stabil, Flash stabil, lalu versi preview
function rankModels(names) {
  const ok = names.filter((n) => /^gemini/.test(n) && /flash/.test(n) && !/tts|image|live|embed|audio|native|robotics|computer|thinking|learnlm/i.test(n));
  const stable = ok.filter((n) => !/preview|exp/i.test(n));
  const pre = ok.filter((n) => /preview|exp/i.test(n));
  const lite = (arr) => arr.filter((n) => /flash-lite/.test(n));
  const plain = (arr) => arr.filter((n) => !/flash-lite/.test(n));
  return [...lite(stable), ...plain(stable), ...lite(pre), ...plain(pre)];
}

async function callGemini(messages, info) {
  const base = { maxOutputTokens: 600, responseMimeType: 'application/json' };
  const TMO = Number(process.env.GEMINI_TIMEOUT_MS) || 10000; // batas waktu per model

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

  async function tryModel(model) {
    const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TMO);
    let r;
    let text = '';
    try {
      for (let i = goodIdx[model] || 0; i < variants.length; i++) {
        r = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
          signal: ctrl.signal,
          body: makeBody(variants[i]),
        });
        if (r.ok) { goodIdx[model] = i; break; }
        text = await r.text();
        if (r.status !== 400) break;
      }
      return { ok: r.ok, status: r.status, text, r };
    } catch (e) {
      if (e && e.name === 'AbortError') return { ok: false, status: 'timeout', text: 'tidak menjawab dalam ' + Math.round(TMO / 1000) + ' detik' };
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  const now = Date.now();
  let model;
  if (autoModel && now < autoUntil) {
    model = autoModel;
  } else if (process.env.GEMINI_MODEL) {
    model = process.env.GEMINI_MODEL;
  } else {
    // Belum ada pilihan: ambil model Flash-Lite/Flash yang tersedia di akun ini (cenderung lebih cepat dan tidak sibuk)
    const avail = await listModels(AbortSignal.timeout(8000)).catch(() => null);
    const best = avail && rankModels(avail)[0];
    model = best || 'gemini-flash-latest';
    if (best) { autoModel = best; autoUntil = now + 3600000; }
  }
  let out = await tryModel(model);
  const tried = [model + ': ' + out.status];
  let names = null;

  // Model gagal/sibuk (400, 404, 429, 5xx, atau lambat): coba model cadangan yang tersedia di akun ini
  const retryable = (o) => !o.ok && (o.status === 'timeout' || [400, 404, 429, 500, 502, 503, 504].includes(o.status));
  if (retryable(out)) {
    const firstStatus = out.status;
    names = await listModels(AbortSignal.timeout(8000)).catch(() => null);
    const alts = rankModels(names || []).filter((n) => n !== model).slice(0, 2);
    for (const alt of alts) {
      const o2 = await tryModel(alt);
      tried.push(alt + ': ' + o2.status);
      if (o2.ok) {
        // 400/404: model utama memang tidak cocok (pakai cadangan 24 jam); lainnya: sibuk sementara (5 menit)
        autoModel = alt;
        autoUntil = now + (firstStatus === 400 || firstStatus === 404 ? 86400000 : 300000);
        model = alt;
        out = o2;
        break;
      }
    }
  }

  if (!out.ok) {
    throw new Error(
      'Gemini API ' + out.status + ' (model ' + model + '). Dicoba: ' + tried.join(', ') + '.' +
      (names ? ' Model tersedia: ' + names.slice(0, 8).join(', ') + '.' : '') +
      ' Respons: ' + String(out.text).replace(/\s+/g, ' ')
    );
  }

  const d = await out.r.json();
  if (info) {
    info.model = model;
    info.think = d.usageMetadata && d.usageMetadata.thoughtsTokenCount;
  }
  const parts = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
  return parts.map((p) => p.text || '').join('');
}

// ---------- Alat uji kecepatan model (khusus pengelola) ----------
// Buka: /api/chat?cek=KATA_SANDI_PENGELOLA  -> daftar model Flash beserta waktu jawabnya
async function benchOne(model) {
  const t0 = Date.now();
  const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  const cfgs = [{ thinkingConfig: { thinkingLevel: 'minimal' } }, { thinkingConfig: { thinkingBudget: 0 } }, {}];
  let last = '';
  for (const extra of cfgs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        signal: ctrl.signal,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Balas dengan satu kata: siap' }] }],
          generationConfig: { maxOutputTokens: 30, ...extra },
        }),
      });
      if (r.ok) {
        const d = await r.json();
        return {
          model,
          status: 200,
          detik: Number(((Date.now() - t0) / 1000).toFixed(1)),
          pengaturan: extra.thinkingConfig ? JSON.stringify(extra.thinkingConfig) : 'bawaan',
          pikir: (d.usageMetadata && d.usageMetadata.thoughtsTokenCount) || 0,
        };
      }
      last = r.status;
      if (r.status !== 400) break;
    } catch (e) {
      last = e && e.name === 'AbortError' ? 'timeout 30 detik' : String((e && e.message) || e);
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  return { model, status: last, detik: Number(((Date.now() - t0) / 1000).toFixed(1)) };
}

async function benchAll() {
  const names = await listModels();
  const flash = names.filter((n) => /^gemini/.test(n) && /flash/.test(n) && !/tts|image|live|embed|audio|native|robotics|computer|thinking|learnlm/i.test(n));
  const score = (n) => (/flash-lite/.test(n) ? 0 : 2) + (/preview|exp/i.test(n) ? 1 : 0);
  const pick = flash.sort((a, b) => score(a) - score(b)).slice(0, 6);
  if (!pick.includes('gemini-flash-latest')) pick.push('gemini-flash-latest');
  const hasil = await Promise.all(pick.map(benchOne));
  hasil.sort((a, b) => (a.status === 200 ? 0 : 1) - (b.status === 200 ? 0 : 1) || a.detik - b.detik);
  return hasil;
}

module.exports = async (req, res) => {
  // Alat uji kecepatan: GET /api/chat?cek=KATA_SANDI_PENGELOLA
  if (req.method === 'GET' && req.query && req.query.cek !== undefined) {
    const admin = process.env.ADMIN_PASSWORD;
    if (!admin || req.query.cek !== admin) return res.status(401).json({ error: 'Kata sandi salah atau ADMIN_PASSWORD belum diatur' });
    try {
      const hasil = await benchAll();
      return res.status(200).json({
        catatan: 'Pilih model dengan status 200 dan detik terkecil, lalu isi variabel GEMINI_MODEL di Vercel dengan nama modelnya.',
        hasil,
      });
    } catch (e) {
      return res.status(502).json({ error: 'Uji gagal', detail: String((e && e.message) || e).slice(0, 300) });
    }
  }
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
     else text = await callClaude(messages, info);
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