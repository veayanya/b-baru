// routes/settingsRouter.js
// Pengaturan umum aplikasi yang bisa diubah Admin lewat Dashboard.
// Saat ini berisi: kontak admin (nomor WhatsApp) yang dipakai
// oleh Form Laporan untuk mengarahkan laporan user.

import express from 'express';
import { requireAuth, requireRole } from '../auth/authMiddleware.js';
import { getStore, setStore } from '../lib/db.js';
import { logActivity } from '../utils/activityLogger.js';

const router = express.Router();

const SETTINGS_KEY = 'admin_contact_settings';

const DEFAULT_CONTACT = {
  waNumber: ''   // format internasional tanpa "+", mis. 6281234567890
};

// Validasi ringan: nomor WA cuma boleh digit, 8–15 karakter (standar E.164 tanpa "+")
function isValidWaNumber(v) {
  return /^[0-9]{8,15}$/.test(v);
}

/**
 * GET /api/v1/settings/contact
 * Dibaca oleh SEMUA user yang sudah login (dipakai Form Laporan).
 * Tidak mengekspos data sensitif lain — hanya kontak admin untuk laporan.
 */
router.get('/contact', requireAuth, async (req, res) => {
  try {
    const saved = await getStore(SETTINGS_KEY);
    res.json({ waNumber: (saved && saved.waNumber) || DEFAULT_CONTACT.waNumber });
  } catch (err) {
    res.status(500).json({ error: 'Gagal memuat pengaturan kontak: ' + err.message });
  }
});

/**
 * PUT /api/v1/settings/contact
 * Hanya Admin yang boleh mengubah. Body: { waNumber }
 */
router.put('/contact', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { waNumber } = req.body || {};

    const cleanWa = String(waNumber || '').replace(/[^0-9]/g, '');

    if (cleanWa && !isValidWaNumber(cleanWa)) {
      return res.status(400).json({
        error: 'Nomor WhatsApp tidak valid. Gunakan format internasional tanpa "+" atau "0" di depan, contoh: 6281234567890.'
      });
    }

    const updated = { waNumber: cleanWa };
    await setStore(SETTINGS_KEY, updated);

    await logActivity({
      req,
      action: 'UPDATE_SETTINGS',
      target: 'Kontak Admin (WhatsApp)',
      details: `WA: ${cleanWa || '-'}`
    });

    res.json({ success: true, ...updated });
  } catch (err) {
    res.status(500).json({ error: 'Gagal menyimpan pengaturan kontak: ' + err.message });
  }
});

export default router;
