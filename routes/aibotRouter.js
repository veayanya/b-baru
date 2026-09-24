// routes/aibotRouter.js
// Menu "AI Agen Chatbot RKA" (AIbot) — di-mount di /api/v1/aibot
//
//   GET  /health   — status layanan + model yang dipakai
//   POST /analyze  — Mode 1: Analis Evaluasi RKA          { rkaText, customInstruction }
//   POST /revise   — Mode 2: Eksekutor Revisi RKA         { rkaText, instruction }
//   POST /chat     — Mode 3: Konsultasi Regulasi          { history, message, mode }
//   POST /edit-analysis — Mode 4: Edit hasil analisis SROI { snapshot, instruction, scopes }
//                    (hanya mengusulkan patch; TIDAK menyimpan ke database)
//   POST /upload   — Ekstraksi teks dokumen (multipart, field "file")
//                    PDF, DOCX, XLSX, XLS, CSV, TXT, JSON (maks. 20 MB)
//
// Semua endpoint wajib login (cookie authToken atau header Bearer).

import express from 'express';
import multer from 'multer';
import path from 'path';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import * as xlsx from 'xlsx';
import { requireAuth } from '../auth/authMiddleware.js';
import { logActivity } from '../utils/activityLogger.js';
import {
  analyzeRKA,
  reviseRKA,
  chatBapperida,
  editAnalysisByInstruction,
  getAibotModel,
  isAibotConfigured
} from '../utils/aibotService.js';

const router = express.Router();

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_MESSAGE_CHARS = 8000;
const MAX_EDIT_INSTRUCTION_CHARS = 2000;

// File disimpan di memori (bukan disk) — disk Render bersifat ephemeral.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 }
});

router.use(requireAuth);

function sendError(res, err, fallbackMessage) {
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  console.error(`[AIbot] ${fallbackMessage}:`, err?.message || err);
  res.status(status).json({ success: false, error: err?.message || fallbackMessage });
}

// Sebagian versi busboy/multer menyerahkan nama file UTF-8 sebagai string
// latin1 (nama dengan aksara non-ASCII jadi rusak). Perbaiki hanya jika
// memang terindikasi salah-decode; nama yang sudah benar dibiarkan.
function fixFilenameEncoding(name) {
  const raw = String(name || '');
  if (/[^\u0000-\u00ff]/.test(raw)) return raw; // sudah berisi karakter di luar latin1
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? raw : decoded;
}

// ── Ekstraksi teks per format ─────────────────────────────────────────────

// Render halaman PDF: satu baris per koordinat Y, kolom tabel dipisah spasi,
// dan diberi penanda halaman.
function renderPdfPage(pageData) {
  return pageData
    .getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
    .then(content => {
      let text = '';
      let lastY = null;
      let lastEndX = 0;
      for (const item of content.items) {
        const y = item.transform[5];
        const x = item.transform[4];
        if (lastY === null) {
          text += item.str;
        } else if (y === lastY) {
          const needsSpace = x - lastEndX > 1 && !text.endsWith(' ') && !item.str.startsWith(' ');
          text += (needsSpace ? ' ' : '') + item.str;
        } else {
          text += '\n' + item.str;
        }
        lastY = y;
        lastEndX = x + (item.width || 0);
      }
      return `--- Halaman ${pageData.pageNumber} ---\n${text}`;
    });
}

async function extractPdf(buffer) {
  // pdf-parse (pdf.js 1.10) kadang gagal "bad XRef entry" pada percobaan
  // pertama untuk PDF yang tabel xref-nya tidak baku; percobaan ulang biasanya
  // berhasil lewat mode pemulihan internal pdf.js.
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const parsed = await pdfParse(buffer, { pagerender: renderPdfPage });
      return parsed.text || '';
    } catch (err) {
      lastErr = err;
      if (!/XRef/i.test(err?.message || String(err))) break;
    }
  }
  throw lastErr;
}

async function extractDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  if (result.messages?.length) console.log('[AIbot] Peringatan mammoth:', result.messages);
  return result.value || '';
}

function extractSpreadsheet(buffer, ext) {
  // .xlsx adalah arsip ZIP ("PK"); tolak file teks biasa yang hanya diberi
  // ekstensi .xlsx agar tidak dianggap berhasil dengan isi sampah.
  if (ext === '.xlsx' && !(buffer.length > 3 && buffer[0] === 0x50 && buffer[1] === 0x4b)) {
    throw new Error('Berkas bukan format .xlsx yang valid');
  }
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  return workbook.SheetNames
    .map(name => `--- LEMBAR WORKBOOK: ${name} ---\n${xlsx.utils.sheet_to_csv(workbook.Sheets[name])}`)
    .join('\n\n');
}

const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.xlsx', '.xls', '.csv', '.txt', '.json'];

async function extractText(buffer, ext) {
  switch (ext) {
    case '.pdf':
      return extractPdf(buffer);
    case '.docx':
      return extractDocx(buffer);
    case '.xlsx':
    case '.xls':
      return extractSpreadsheet(buffer, ext);
    default:
      // .csv / .txt / .json dibaca apa adanya. CSV sengaja TIDAK lewat parser
      // spreadsheet: kode rekening seperti "5.1.02.01" akan diubah menjadi
      // tanggal ("5/1/02") oleh auto-format sel.
      return buffer.toString('utf-8').replace(/^\uFEFF/, '');
  }
}

// ── Endpoint ──────────────────────────────────────────────────────────────

router.get('/health', (req, res) => {
  res.json({
    status: 'online',
    system: 'BAPPERIDA RKA Budget Analysis System (AIbot)',
    model: getAibotModel(),
    aiConfigured: isAibotConfigured(),
    timestamp: new Date().toISOString()
  });
});

// Mode 1 — Analis Evaluasi RKA
router.post('/analyze', async (req, res) => {
  try {
    const { rkaText, customInstruction } = req.body || {};
    if (typeof rkaText !== 'string' || !rkaText.trim()) {
      return res.status(400).json({ success: false, error: 'Dokumen / Teks RKA tidak boleh kosong' });
    }

    const result = await analyzeRKA(rkaText, typeof customInstruction === 'string' ? customInstruction : '');

    await logActivity({
      req,
      action: 'AIBOT_ANALYZE',
      target: 'AI Agen Chatbot RKA',
      details: `Evaluasi RKA via AIbot (${rkaText.length} karakter, model ${result.model})`
    });

    res.json(result);
  } catch (err) {
    sendError(res, err, 'Gagal menganalisis RKA');
  }
});

// Mode 2 — Eksekutor Revisi RKA
router.post('/revise', async (req, res) => {
  try {
    const { rkaText, instruction } = req.body || {};
    if (typeof rkaText !== 'string' || !rkaText.trim()) {
      return res.status(400).json({ success: false, error: 'Data RKA tidak boleh kosong' });
    }

    const result = await reviseRKA(rkaText, typeof instruction === 'string' ? instruction : '');

    await logActivity({
      req,
      action: 'AIBOT_REVISE',
      target: 'AI Agen Chatbot RKA',
      details: `Revisi RKA via AIbot (${rkaText.length} karakter, model ${result.model})`
    });

    res.json(result);
  } catch (err) {
    sendError(res, err, 'Gagal merevisi RKA');
  }
});

// Mode 3 — Konsultasi Regulasi (chat)
router.post('/chat', async (req, res) => {
  try {
    const { history, message, mode } = req.body || {};
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ success: false, error: 'Pesan tidak boleh kosong' });
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({
        success: false,
        error: `Pesan terlalu panjang (maksimal ${MAX_MESSAGE_CHARS} karakter)`
      });
    }

    const result = await chatBapperida(
      Array.isArray(history) ? history : [],
      message.trim(),
      typeof mode === 'string' && mode.trim() ? mode.trim() : 'Konsultasi Perencanaan BAPPERIDA'
    );
    res.json(result);
  } catch (err) {
    sendError(res, err, 'Gagal memproses pesan chat');
  }
});

// Mode 4 — Edit Hasil Analisis SROI dengan AI
// Mengembalikan patch usulan AI. Penyimpanan sebagai versi baru dilakukan
// klien lewat POST /api/v1/rkis/:id/versions setelah pengguna menyetujui.
router.post('/edit-analysis', async (req, res) => {
  try {
    const { snapshot, instruction, scopes } = req.body || {};

    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return res.status(400).json({ success: false, error: 'Data analisis tidak boleh kosong' });
    }
    if (typeof instruction !== 'string' || !instruction.trim()) {
      return res.status(400).json({ success: false, error: 'Instruksi untuk AI tidak boleh kosong' });
    }
    if (instruction.length > MAX_EDIT_INSTRUCTION_CHARS) {
      return res.status(400).json({
        success: false,
        error: `Instruksi terlalu panjang (maksimal ${MAX_EDIT_INSTRUCTION_CHARS} karakter)`
      });
    }

    const result = await editAnalysisByInstruction(
      snapshot,
      instruction.trim(),
      Array.isArray(scopes) ? scopes.filter(s => typeof s === 'string') : []
    );

    await logActivity({
      req,
      action: 'AIBOT_EDIT_ANALYSIS',
      target: String(req.body?.rkaId || snapshot?.subKegiatan || 'Hasil Analisis SROI'),
      details: `Usulan edit AI pada hasil analisis (${Object.keys(result.patch).length} bagian berubah, model ${result.model})`
    });

    res.json(result);
  } catch (err) {
    sendError(res, err, 'Gagal memproses edit analisis dengan AI');
  }
});

// Ekstraksi teks dokumen RKA
router.post(
  '/upload',
  (req, res, next) => {
    upload.single('file')(req, res, err => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          success: false,
          error: `Ukuran file melebihi batas ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`
        });
      }
      return res.status(400).json({ success: false, error: 'Gagal menerima file: ' + err.message });
    });
  },
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, error: 'File tidak ditemukan' });
      }

      const originalName = fixFilenameEncoding(req.file.originalname);
      const ext = path.extname(originalName).toLowerCase();

      if (ext === '.doc') {
        return res.status(415).json({
          success: false,
          error: 'Format .doc (Word lama) tidak didukung. Simpan ulang sebagai .docx lalu unggah kembali.'
        });
      }
      if (!SUPPORTED_EXTENSIONS.includes(ext)) {
        return res.status(415).json({
          success: false,
          error: `Format ${ext || 'tanpa ekstensi'} tidak didukung. Gunakan: ${SUPPORTED_EXTENSIONS.join(', ')}`
        });
      }

      let extractedText;
      try {
        extractedText = await extractText(req.file.buffer, ext);
      } catch (parseErr) {
        console.error('[AIbot] Gagal parsing file:', parseErr?.message || parseErr);
        return res.status(422).json({
          success: false,
          error: 'Gagal membaca isi file. Pastikan file tidak rusak atau terproteksi password.'
        });
      }

      if (!extractedText || !extractedText.trim()) {
        return res.status(422).json({
          success: false,
          error: 'Dokumen kosong atau tidak dapat dibaca (mungkin hasil scan tanpa teks). Pastikan file tidak terproteksi password.'
        });
      }

      await logActivity({
        req,
        action: 'AIBOT_UPLOAD',
        target: originalName,
        details: `Ekstraksi dokumen ${ext.slice(1).toUpperCase()} via AIbot (${req.file.size} bytes)`
      });

      res.json({
        success: true,
        filename: originalName,
        fileType: ext.slice(1).toUpperCase(),
        extractedText: extractedText.trim()
      });
    } catch (err) {
      sendError(res, err, 'Gagal memproses file');
    }
  }
);

export default router;
