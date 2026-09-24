/**
 * laporanRouter.js
 * Route: POST /api/v1/laporan/kirim
 *
 * Tidak butuh package tambahan — pakai Node.js built-in 'https' untuk kirim email
 * via Gmail API (OAuth2-free) atau pakai SMTP langsung via net/tls built-in.
 *
 * TAPI cara paling mudah tanpa dependency: kirim via Gmail SMTP pakai
 * Node.js built-in 'net' + 'tls'. Namun itu kompleks.
 *
 * Solusi TERBAIK tanpa package: gunakan fetch() ke Resend API (gratis 100 email/hari)
 * atau Brevo (Sendinblue) — keduanya cukup fetch() biasa, tidak butuh npm install.
 *
 * Di server.js:
 *   import laporanRouter from './routes/laporanRouter.js';
 *   app.use('/api/v1/laporan', laporanRouter);
 *
 * Di .env tambahkan:
 *   EMAIL_PROVIDER=resend          # atau 'brevo'
 *   RESEND_API_KEY=re_xxxxxxxxxxxx # dari resend.com (gratis)
 *   EMAIL_FROM=noreply@yourdomain.com
 */

import express from 'express';
import { requireAuth, requireRole } from '../auth/authMiddleware.js';
import { getStore, setStore } from '../lib/db.js';
import { logActivity } from '../utils/activityLogger.js';

const router = express.Router();
const REPORTS_KEY = 'laporan_masuk';

router.get('/list', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const reports = (await getStore(REPORTS_KEY)) || [];
    return res.json({ reports: reports.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
  } catch (err) {
    console.error('[LaporanRouter] Gagal memuat laporan:', err.message);
    return res.status(500).json({ error: 'Gagal memuat laporan: ' + err.message });
  }
});

router.post('/kirim', requireAuth, async (req, res) => {
  try {
    const { judul, kategori, nama, email, noHp, kontak, deskripsi, images = [] } = req.body;

    if (!judul?.trim())    return res.status(400).json({ error: 'Judul laporan wajib diisi.' });
    if (!nama?.trim())     return res.status(400).json({ error: 'Nama pelapor wajib diisi.' });
    if (!email?.trim() && !noHp?.trim() && !kontak?.trim()) {
      return res.status(400).json({ error: 'Isi minimal salah satu: Email atau No. WhatsApp pelapor.' });
    }
    if (!deskripsi?.trim()) return res.status(400).json({ error: 'Deskripsi laporan wajib diisi.' });

    const settings = (await getStore('admin_contact_settings')) || {};
    const adminWa = settings.waNumber?.trim();
    const validImages = (images || []).filter(img => img?.data && img?.name);
    const waktu = new Date().toISOString();

    const report = {
      id: `laporan-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      judul: judul.trim(),
      kategori: kategori || 'Lainnya',
      nama: nama.trim(),
      email: (email || '').trim(),
      noHp: (noHp || '').trim(),
      // 'kontak' dipertahankan untuk kompatibilitas mundur (laporan lama sebelum field dipisah)
      kontak: (kontak || email || noHp || '').trim(),
      deskripsi: deskripsi.trim(),
      images: validImages.map(img => ({
        name: img.name,
        type: img.type || 'image/png',
        data: img.data,
        createdAt: new Date().toISOString()
      })),
      createdAt: waktu,
      status: 'baru',
      source: 'app'
    };

    const reports = (await getStore(REPORTS_KEY)) || [];
    reports.unshift(report);
    await setStore(REPORTS_KEY, reports);

    await logActivity({
      req,
      action: 'KIRIM_LAPORAN',
      target: 'Aplikasi Laporan',
      details: `Judul: "${report.judul}" | Kategori: ${report.kategori} | Pelapor: ${report.nama} | Lampiran: ${report.images.length} gambar`,
    });

    return res.json({
      success: true,
      adminWa: adminWa || null,
      message: `Laporan berhasil dikirim ke aplikasi admin${report.images.length > 0 ? ` beserta ${report.images.length} gambar` : ''}.`,
    });
  } catch (err) {
    console.error('[LaporanRouter] Gagal kirim laporan ke aplikasi:', err.message);
    return res.status(500).json({ error: 'Gagal mengirim laporan: ' + err.message });
  }
});

router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const reports = (await getStore(REPORTS_KEY)) || [];
    const target = reports.find(r => r.id === id);

    if (!target) {
      return res.status(404).json({ error: 'Laporan tidak ditemukan (mungkin sudah dihapus sebelumnya).' });
    }

    const remaining = reports.filter(r => r.id !== id);
    await setStore(REPORTS_KEY, remaining);

    await logActivity({
      req,
      action: 'HAPUS_LAPORAN',
      target: 'Laporan Masuk',
      details: `Judul: "${target.judul}" | Pelapor: ${target.nama}`,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('[LaporanRouter] Gagal menghapus laporan:', err.message);
    return res.status(500).json({ error: 'Gagal menghapus laporan: ' + err.message });
  }
});

export default router;
