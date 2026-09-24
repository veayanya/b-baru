// routes/dbPoolRouter.js
// Endpoint admin untuk memantau & mengendalikan Multi-Database Failover.
//
// Mount di server.js: app.use('/api/v1/db', dbPoolRouter);

import express from 'express';
import { requireAuth, requireRole } from '../auth/authMiddleware.js';
import {
 getPoolStatus,
 rotateToNextSlot,
 checkQuotaAndRotate,
 getMigrationHistory,
 measureUsage,
 formatBytes,
 getActiveSlotIndex,
 readSlotConfig,
 maskUrl,
 MAX_SLOTS,
 TARGET_STORAGE_MB,
 TARGET_STORAGE_BYTES
} from '../lib/dbPool.js';
import { getAllStoreData } from '../lib/db.js';
import { logActivity } from '../utils/activityLogger.js';

const router = express.Router();

/**
 * GET /api/v1/db/status
 * Ringkasan pool: slot aktif, pemakaian storage, ambang batas, riwayat event.
 * Query ?probe=1 untuk mengukur SEMUA slot (lebih lambat, beberapa detik).
 */
router.get('/status', requireAuth, requireRole('admin', 'moderator'), async (req, res) => {
 try {
 const probeAll = req.query.probe === '1' || req.query.probe === 'true';
 const status = await getPoolStatus({ probeAll });
 res.json(status);
 } catch (err) {
 res.status(500).json({ error: 'Gagal memuat status database pool: ' + err.message });
 }
});

/**
 * GET /api/v1/db/usage
 * Pemakaian storage database aktif saja (ringan, aman dipanggil berkala UI).
 */
router.get('/usage', requireAuth, requireRole('admin', 'moderator'), async (req, res) => {
 try {
 const configured = readSlotConfig();
 if (configured.length === 0) {
 return res.json({ mode: 'local_file_store', message: 'Tidak ada DATABASE_URL yang diset.' });
 }
 const index = getActiveSlotIndex();
 const usage = await measureUsage(index, { force: true });
 res.json({
 mode: 'neon_multi',
 activeSlot: index + 1,
 totalSlots: configured.length,
 maxSlots: MAX_SLOTS,
 usedBytes: usage.bytes,
 usedLabel: formatBytes(usage.bytes),
 quotaBytes: usage.quotaBytes,
 quotaLabel: formatBytes(usage.quotaBytes),
 targetStorageMb: TARGET_STORAGE_MB,
 targetStorageBytes: TARGET_STORAGE_BYTES,
 quotaScope: 'application_level',
 neonStorageLimit: 'not controlled by DB_QUOTA_BYTES; governed by Neon plan/API quota',
 usagePercent: Number((usage.ratio * 100).toFixed(1)),
 rowCount: usage.rowCount
 });
 } catch (err) {
 res.status(500).json({ error: 'Gagal mengukur pemakaian storage: ' + err.message });
 }
});

/**
 * GET /api/v1/db/storage-summary
 * Ringkasan penyimpanan storage (dalam MB/GB) untuk SEMUA user (bukan hanya
 * admin/moderator). Kapasitas total = jumlah slot terkonfigurasi × kuota per
 * slot (mis. 66 slot × 5 GB). Pemakaian = jumlah pemakaian nyata semua slot
 * (di-cache ±30 detik per slot supaya ringan dipanggil di halaman Beranda).
 * Sengaja tidak mengekspos detail koneksi/infrastruktur.
 */
router.get('/storage-summary', requireAuth, async (req, res) => {
  try {
    const configured = readSlotConfig();
    const totalSlots = configured.length;
    const quotaBytes = TARGET_STORAGE_BYTES * Math.max(totalSlots, 1);

    if (totalSlots === 0) {
      return res.json({
        label: 'Penyimpanan Storage',
        usedBytes: 0,
        usedLabel: '0 MB',
        quotaBytes,
        quotaLabel: formatBytes(quotaBytes),
        usagePercent: 0,
        description: 'Kapasitas penyimpanan bersama untuk seluruh pengguna'
      });
    }

    // Ukur pemakaian semua slot secara paralel (dibatasi & pakai cache ~30s
    // di dalam measureUsage agar tidak membebani saat banyak user buka Beranda).
    const CONCURRENCY = Math.min(50, Math.max(1, Number(process.env.DB_PROBE_CONCURRENCY || 40)));
    let usedBytes = 0;
    for (let start = 0; start < totalSlots; start += CONCURRENCY) {
      const batchIndexes = Array.from(
        { length: Math.min(CONCURRENCY, totalSlots - start) },
        (_, i) => start + i
      );
      const results = await Promise.all(
        batchIndexes.map((index) => measureUsage(index).catch(() => ({ bytes: 0 })))
      );
      usedBytes += results.reduce((sum, r) => sum + (r.bytes || 0), 0);
    }

    res.json({
      label: 'Penyimpanan Storage',
      usedBytes,
      usedLabel: formatBytes(usedBytes),
      quotaBytes,
      quotaLabel: formatBytes(quotaBytes),
      usagePercent: Number(((usedBytes / quotaBytes) * 100).toFixed(1)),
      description: 'Kapasitas penyimpanan bersama untuk seluruh pengguna'
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal memuat ringkasan penyimpanan: ' + err.message });
  }
});

/**
 * POST /api/v1/db/check
 * Jalankan pengecekan kuota sekarang juga. Bila sudah melewati ambang batas,
 * failover otomatis akan langsung dijalankan.
 */
router.post('/check', requireAuth, requireRole('admin'), async (req, res) => {
 try {
 const result = await checkQuotaAndRotate();
 if (result.rotated) {
 await logActivity({
 req,
 action: 'DB_FAILOVER',
 target: `Slot ${result.record.fromSlot} → Slot ${result.record.toSlot}`,
 details: `Failover otomatis (pengecekan manual): ${result.record.reason}`
 });
 }
 res.json({ success: true, ...result });
 } catch (err) {
 res.status(500).json({ error: 'Pengecekan kuota gagal: ' + err.message });
 }
});

/**
 * POST /api/v1/db/failover
 * Pindah database secara manual (cadangkan → salin → verifikasi → aktifkan).
 * Body opsional: { targetSlot: 3, reason: "Perawatan terjadwal" }
 */
router.post('/failover', requireAuth, requireRole('admin'), async (req, res) => {
 try {
 const { targetSlot, reason } = req.body || {};
 const targetIndex = Number.isInteger(targetSlot) ? targetSlot - 1 : null;

 if (targetIndex !== null && (targetIndex < 0 || targetIndex >= MAX_SLOTS)) {
 return res.status(400).json({ error: `targetSlot harus antara 1 dan ${MAX_SLOTS}.` });
 }

 const record = await rotateToNextSlot(reason || `Manual oleh ${req.user.username}`, targetIndex);

 await logActivity({
 req,
 action: 'DB_FAILOVER',
 target: `Slot ${record.fromSlot} (${record.fromHost}) → Slot ${record.toSlot} (${record.toHost})`,
 details: `Migrasi manual ${record.keys} key dalam ${record.durationMs} ms. Alasan: ${record.reason}`
 });

 res.json({
 success: true,
 message: `Database berhasil dipindah ke slot ${record.toSlot} (${record.toHost}).`,
 record
 });
 } catch (err) {
 await logActivity({
 req,
 action: 'DB_FAILOVER',
 target: 'Gagal',
 details: err.message,
 status: 'FAILED'
 }).catch(() => {});
 res.status(500).json({ error: 'Failover gagal: ' + err.message });
 }
});

/**
 * GET /api/v1/db/history
 * Riwayat migrasi antar database (50 terakhir).
 */
router.get('/history', requireAuth, requireRole('admin', 'moderator'), async (req, res) => {
 try {
 const records = await getMigrationHistory();
 res.json({ total: records.length, records });
 } catch (err) {
 res.status(500).json({ error: 'Gagal memuat riwayat migrasi: ' + err.message });
 }
});

/**
 * GET /api/v1/db/slots
 * Daftar slot yang terdaftar di ENV (password disamarkan).
 */
router.get('/slots', requireAuth, requireRole('admin'), (req, res) => {
 try {
 const configured = readSlotConfig();
 res.json({
 total: configured.length,
 maxSlots: MAX_SLOTS,
 slots: configured.map((item, i) => ({
 slot: i + 1,
 label: i === 0 ? 'Primary' : `Backup-${i}`,
 connection: maskUrl(item.url),
 envVar: item.envVar
 }))
 });
 } catch (err) {
 res.status(500).json({ error: 'Gagal memuat slots: ' + err.message });
 }
});

/**
 * GET /api/v1/db/dry-run
 * Simulasi: hitung berapa key & ukuran payload yang akan dipindah,
 * tanpa menyentuh database tujuan.
 */
router.get('/dry-run', requireAuth, requireRole('admin'), async (req, res) => {
 try {
 const dump = await getAllStoreData();
 const payload = JSON.stringify(dump);
 res.json({
 keys: Object.keys(dump),
 totalKeys: Object.keys(dump).length,
 payloadBytes: Buffer.byteLength(payload),
 payloadLabel: formatBytes(Buffer.byteLength(payload))
 });
 } catch (err) {
 res.status(500).json({ error: 'Dry-run gagal: ' + err.message });
 }
});

export default router;
