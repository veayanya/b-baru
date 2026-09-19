// utils/activityLogger.js
// Audit Trail & Activity Logger untuk Sintra / Bapperida AI
// Menyimpan log aktivitas ke database (key 'activity_logs' di tabel app_store / local_db)

import { getStore, setStore } from '../lib/db.js';
import { realtimeHub } from './realtimeHub.js';

const MAX_LOGS = 500; // Simpan hingga 500 log terakhir (dioptimasi dari 1000)

/**
 * Catat aktivitas pengguna
 * @param {Object} params
 * @param {Object} params.req - Express request object (untuk IP dan user info)
 * @param {Object} [params.user] - User object manual jika tidak dari req
 * @param {string} params.action - Tipe aksi (LOGIN, LOGOUT, UPLOAD_RKA, UPDATE_RKA, DELETE_RKA, EXPORT_BACKUP, RESTORE_BACKUP, UPDATE_USER, API_CONFIG_UPDATE)
 * @param {string} [params.target] - Target objek (misal: ID RKA, nama user, dsb.)
 * @param {string} [params.details] - Deskripsi detail aksi
 * @param {string} [params.status] - 'SUCCESS' | 'WARNING' | 'FAILED'
 */
export async function logActivity({ req, user, action, target = '-', details = '', status = 'SUCCESS' }) {
 try {
 const bodyUser = req?.body?.user || (req?.body?.username ? {
 id: req.body.userId || 'client',
 username: req.body.username,
 name: req.body.name || req.body.username,
 role: req.body.role || 'user'
 } : null);
 const actor = user || req?.user || bodyUser || { id: 'system', username: 'system', name: 'Sistem', role: 'system' };

 // Dapatkan IP address klien
 let ip = req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '127.0.0.1';
 if (typeof ip === 'string' && ip.includes(',')) {
 ip = ip.split(',')[0].trim();
 }
 if (ip === '::1' || ip === '::ffff:127.0.0.1') ip = '127.0.0.1';

 const newLog = {
 id: 'log-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
 timestamp: new Date().toISOString(),
 userId: actor.id || 'unknown',
 username: actor.username || 'unknown',
 name: actor.name || actor.username || 'Pengguna',
 role: actor.role || 'user',
 action: action.toUpperCase(),
 target: String(target || '-'),
 details: String(details || ''),
 status: status.toUpperCase(),
 ip: String(ip)
 };

 let logDb = await getStore('activity_logs');
 if (!logDb || !Array.isArray(logDb.logs)) {
 logDb = { logs: [] };
 }

 logDb.logs.unshift(newLog);

 // Batasi ukuran log agar tidak membengkak
 if (logDb.logs.length > MAX_LOGS) {
 logDb.logs = logDb.logs.slice(0, MAX_LOGS);
 }

 await setStore('activity_logs', logDb);

 // Broadcast ke klien admin & moderator secara realtime
 try {
 realtimeHub.broadcast('LOG_CREATED', newLog);
 } catch {}

 return newLog;
 } catch (err) {
 console.error('[ActivityLogger] Gagal mencatat log:', err.message);
 return null;
 }
}

/**
 * Ambil daftar log dengan filter dan pagination
 */
export async function getActivityLogs({ limit = 50, offset = 0, action, username, search, role, status } = {}) {
 try {
 const logDb = await getStore('activity_logs');
 let logs = (logDb && Array.isArray(logDb.logs)) ? [...logDb.logs] : [];

 // Filter berdasarkan role pembuat log
 if (role) {
 logs = logs.filter(l => l.role === role);
 }

 // Filter berdasarkan status (SUCCESS / FAILED)
 if (status && status !== 'ALL') {
 logs = logs.filter(l => (l.status || '').toUpperCase() === status.toUpperCase());
 }

 // Filter berdasarkan aksi
 if (action && action !== 'ALL') {
 logs = logs.filter(l => l.action === action);
 }

 // Filter berdasarkan username
 if (username) {
 logs = logs.filter(l => l.username.toLowerCase().includes(username.toLowerCase()));
 }

 // Pencarian global (kata kunci pada target, details, nama, username)
 if (search) {
 const q = search.toLowerCase();
 logs = logs.filter(l =>
 l.name.toLowerCase().includes(q) ||
 l.username.toLowerCase().includes(q) ||
 l.action.toLowerCase().includes(q) ||
 l.target.toLowerCase().includes(q) ||
 l.details.toLowerCase().includes(q) ||
 l.ip.includes(q)
 );
 }

 const total = logs.length;
 const paginated = logs.slice(offset, offset + limit);

 return {
 total,
 limit,
 offset,
 logs: paginated
 };
 } catch (err) {
 console.error('[ActivityLogger] Gagal mengambil log:', err.message);
 return { total: 0, limit, offset, logs: [] };
 }
}

/**
 * Hapus seluruh log (hanya Admin)
 */
export async function clearActivityLogs() {
 await setStore('activity_logs', { logs: [] });
 return true;
}
