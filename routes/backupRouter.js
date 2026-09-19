// routes/backupRouter.js
// Router Backup & Restore Bertingkat (Admin, Moderator, User)

import express from 'express';
import { requireAuth, requireRole } from '../auth/authMiddleware.js';
import { getAllStoreData, restoreAllStoreData, getBackupSnapshotsList, getStore, getActiveStorageInfo } from '../lib/db.js';
import { logActivity } from '../utils/activityLogger.js';

const router = express.Router();

/**
 * 1. Full Database Export (Admin & Moderator)
 * Mengunduh seluruh data (RKA, SSH, User, Konfigurasi API, dan Log) dalam 1 berkas JSON
 */
router.get('/export-full', requireAuth, requireRole('admin', 'moderator'), async (req, res) => {
 try {
 const rawData = await getAllStoreData();

 // Jangan sertakan hash password user di export jika role adalah moderator
 const safeData = JSON.parse(JSON.stringify(rawData));
 if (req.user.role === 'moderator' && safeData.users_db?.users) {
 safeData.users_db.users = safeData.users_db.users.map(u => {
 const { password, ...rest } = u;
 return rest;
 });
 }

 const payload = {
 app: 'Sintra / Bapperida RKA AI',
 version: '2.0.0',
 exportedAt: new Date().toISOString(),
 exportedBy: {
 id: req.user.id,
 username: req.user.username,
 name: req.user.name,
 role: req.user.role
 },
 data: safeData
 };

 await logActivity({
 req,
 action: 'EXPORT_BACKUP',
 target: 'Full Database Backup',
 details: `Ekspor database penuh oleh ${req.user.role} (${req.user.username})`
 });

 res.setHeader('Content-Type', 'application/json');
 res.setHeader('Content-Disposition', `attachment; filename="sintra_backup_full_${new Date().toISOString().slice(0, 10)}.json"`);
 res.json(payload);
 } catch (err) {
 console.error('Export full error:', err);
 res.status(500).json({ error: 'Gagal membuat file backup: ' + err.message });
 }
});

/**
 * 2. User Data Export (Semua User & Moderator)
 * Mengunduh berkas RKA milik pengguna (atau seluruh RKA jika moderator/admin)
 * Payload memiliki wrapper `data` agar kompatibel dengan endpoint /restore
 * (sebelumnya wrapper ini tidak ada sehingga tombol "Upload Backup .html"
 * selalu gagal dengan error "Harus mengandung field data").
 */
router.get('/export-user', requireAuth, async (req, res) => {
 try {
 const mainDb = await getStore('main_db') || { rkis: [] };
 let rkis = mainDb.rkis || [];

 // Jika user biasa, ambil hanya dokumen miliknya
 const isUserRole = req.user.role === 'user';
 if (isUserRole) {
 rkis = rkis.filter(r => !r.userId || r.userId === req.user.id);
 }

 const payload = {
 app: 'Sintra / Bapperida RKA AI',
 type: 'user_rka_backup',
 exportedAt: new Date().toISOString(),
 exportedBy: {
 id: req.user.id,
 username: req.user.username,
 name: req.user.name,
 role: req.user.role
 },
 user: {
 id: req.user.id,
 username: req.user.username,
 name: req.user.name
 },
 totalDocuments: rkis.length,
 // Field langsung (dipakai oleh htmlBackupGenerator & kompatibilitas lama)
 rkis,
 // Wrapper `data` (dibutuhkan oleh endpoint /restore)
 data: {
 main_db: {
 rkis,
 ssh_databases: isUserRole ? [] : (mainDb.ssh_databases || [])
 }
 }
 };

 await logActivity({
 req,
 action: 'EXPORT_BACKUP',
 target: `User RKA (${rkis.length} Dokumen)`,
 details: `Ekspor data RKA oleh ${req.user.username}`
 });

 res.setHeader('Content-Type', 'application/json');
 res.setHeader('Content-Disposition', `attachment; filename="rka_user_${req.user.username}_${new Date().toISOString().slice(0, 10)}.json"`);
 res.json(payload);
 } catch (err) {
 console.error('Export user data error:', err);
 res.status(500).json({ error: 'Gagal mengekspor data RKA pengguna: ' + err.message });
 }
});

/**
 * 3. Restore Database
 * - Admin & Moderator: restore penuh (seluruh main_db), butuh field `data`.
 * - User biasa: merge hanya dokumen RKA miliknya sendiri ke dalam DB yang ada.
 * (Sebelumnya endpoint ini dikunci requireRole('admin','moderator') sehingga
 * tombol "Upload Backup .html" milik user biasa di halaman Arsip Dokumen
 * selalu gagal dengan 403 sebelum sempat memeriksa isi berkas.)
 */
router.post('/restore', requireAuth, async (req, res) => {
 try {
 const backupPayload = req.body;
 const isAdminOrMod = req.user.role === 'admin' || req.user.role === 'moderator';

 if (isAdminOrMod) {
 if (!backupPayload || !backupPayload.data) {
 return res.status(400).json({ error: 'Format berkas backup tidak valid. Harus mengandung field "data".' });
 }
 await restoreAllStoreData(backupPayload.data);
 } else {
 // User biasa: hanya boleh merge RKA miliknya sendiri
 const incomingRkis = backupPayload?.rkis
 || backupPayload?.data?.main_db?.rkis
 || [];

 if (!Array.isArray(incomingRkis) || incomingRkis.length === 0) {
 return res.status(400).json({ error: 'Tidak ada dokumen RKA ditemukan dalam berkas backup.' });
 }

 const userRkis = incomingRkis.filter(r => !r.userId || r.userId === req.user.id);
 if (userRkis.length === 0) {
 return res.status(403).json({ error: 'Berkas backup tidak mengandung dokumen RKA milik akun Anda.' });
 }

 const mainDb = await getStore('main_db') || { rkis: [], ssh_databases: [] };
 const existingRkis = mainDb.rkis || [];
 const idMap = new Map(existingRkis.map(r => [r.id, r]));
 for (const rki of userRkis) {
 idMap.set(rki.id, { ...rki, userId: req.user.id }); // pastikan kepemilikan tetap benar
 }
 mainDb.rkis = Array.from(idMap.values());
 await restoreAllStoreData({ main_db: mainDb });
 }

 await logActivity({
 req,
 action: 'RESTORE_BACKUP',
 target: isAdminOrMod ? 'Database Restored (Full)' : 'RKA Restored (User Merge)',
 details: `Pemulihan dari berkas backup tanggal ${backupPayload?.exportedAt || 'tidak diketahui'} oleh ${req.user.username}`
 });

 res.json({
 success: true,
 message: isAdminOrMod
 ? 'Database berhasil dipulihkan dari file backup.'
 : 'Dokumen RKA Anda berhasil dipulihkan dan digabungkan ke dalam arsip.',
 restoredAt: new Date().toISOString()
 });
 } catch (err) {
 console.error('Restore error:', err);
 res.status(500).json({ error: 'Gagal memulihkan database: ' + err.message });
 }
});

/**
 * 4. Backup Stats & Snapshots List
 */
router.get('/stats', requireAuth, requireRole('admin', 'moderator'), async (req, res) => {
 try {
 const mainDb = await getStore('main_db') || { rkis: [], ssh_databases: [] };
 const usersDb = await getStore('users_db') || { users: [] };
 const logsDb = await getStore('activity_logs') || { logs: [] };
 const snapshots = getBackupSnapshotsList();
 const storage = await getActiveStorageInfo();

 res.json({
 totalRki: mainDb.rkis?.length || 0,
 totalUsers: usersDb.users?.length || 0,
 totalLogs: logsDb.logs?.length || 0,
 totalSnapshots: snapshots.length,
 snapshots: snapshots.slice(0, 10),
 storageType: storage.type,
 storage // { slot, usedLabel, quotaLabel, usagePercent }
 });
 } catch (err) {
 res.status(500).json({ error: 'Gagal memuat status backup: ' + err.message });
 }
});

export default router;
