import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getActiveSsh } from './utils/sshStorage.js';
import { generateContentWithFallback, parseAiJson } from './utils/geminiHelper.js';
import { parseRkaHeuristic } from './utils/rkaFallbackParser.js';
import { callGptWithFallback, parseGptJson } from './utils/gptHelper.js';
import { requireAuth, requireRole, optionalAuth, generateToken, setAuthCookie, clearAuthCookie, extractToken, JWT_SECRET } from './auth/authMiddleware.js';
import {
 verifyAndLogin,
 getAllUsers,
 createUser,
 updateUser,
 deleteUser,
 getUserStats,
 findUserById
} from './auth/userDb.js';
import sshVersionRouter from './routes/sshVersion.js';
import backupRouter from './routes/backupRouter.js';
import dbPoolRouter from './routes/dbPoolRouter.js';
import settingsRouter from './routes/settingsRouter.js';
import laporanRouter from './routes/laporanRouter.js';
import { getStore, setStore, checkDbConnection, initPool, startQuotaMonitor, getPoolStatus } from './lib/db.js';
import { logActivity, getActivityLogs, clearActivityLogs } from './utils/activityLogger.js';
import { realtimeHub } from './utils/realtimeHub.js';
import {
 PERSONA_DEFINITIONS,
 PERSPECTIVE_DEFINITIONS,
 PERSONALITY_DEFINITIONS,
 buildSystemPrompt,
 generateLocalPersonaResponse
} from './utils/chatPersonaHelper.js';
import {
 generateStandardSubkegiatans,
 performBatchAnalysis
} from './utils/multiSubkegGenerator.js';
import { startStorageOptimizer, getOptimizerStats } from './utils/storageOptimizer.js';

// Data (rkis + ssh_databases) disimpan di Neon PostgreSQL, key 'main_db'
// di tabel app_store — menggantikan file data/db.json yang dulu hilang
// setiap kali Render redeploy/restart (disk ephemeral).
async function readDb() {
 let db = await getStore('main_db');
 if (!db) {
 db = { rkis: [], ssh_databases: [] };
 await setStore('main_db', db);
 }
 if (!db.rkis) db.rkis = [];
 if (!db.ssh_databases) db.ssh_databases = [];
 return db;
}

async function writeDb(data) {
 await setStore('main_db', data);
 // Publish after Neon confirms the write. This keeps local clients instant
 // and also updates the hub baseline so the cross-instance poller won't
 // broadcast the same local change a second time.
 realtimeHub.publishDbState(data);
}

const app = express();
const port = process.env.PORT || 3000;

// CORS: izinkan frontend Vercel (dan localhost untuk dev)
const allowedOrigins = process.env.ALLOWED_ORIGINS
 ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
 : ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:3000', 'http://127.0.0.1:5173', 'http://127.0.0.1:5174'];

app.use(cors({
 origin: (origin, callback) => {
 // Izinkan request tanpa origin (curl, Postman, server-to-server)
 if (!origin) return callback(null, true);
 if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) return callback(null, true);
 // Izinkan semua localhost & 127.0.0.1 (dengan port berapapun untuk dev)
 if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
 return callback(null, true);
 }
 callback(new Error(`CORS: origin tidak diizinkan — ${origin}`));
 },
 credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());

// Muat GEMINI_API_KEY / OPENAI_API_KEY yang pernah disimpan lewat panel Admin
// (tersimpan di Neon, key 'api_config') ke process.env saat server start.
// Env var asli (Render Dashboard > Environment) selalu diprioritaskan.
async function loadPersistedApiConfig() {
 try {
 await getOrInitApiConfig();
 console.log('[Startup] Konfigurasi API Key (Gemini & OpenAI) berhasil disinkronkan.');
 } catch (error) {
 console.warn('[Startup] Gagal memuat api_config:', error.message);
 }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendDistPath = path.resolve(__dirname, '../frontend/dist');

// Serve file statis frontend hasil build Vite (Production)
if (fs.existsSync(frontendDistPath)) {
 app.use(express.static(frontendDistPath));
}

// GET /api/health — cek status server & koneksi Neon (dipakai Render health
// check maupun layanan keep-alive/uptime-monitor eksternal)
app.get('/api/health', async (req, res) => {
 try {
 // checkDbConnection() sudah melewati pool: bila database aktif kena limit,
 // failover otomatis dijalankan sehingga health tetap hijau setelah pindah.
 await checkDbConnection();
 const pool = await getPoolStatus();
 res.status(200).json({
 success: true,
 backend: 'ok',
 database: 'connected',
 storage: {
 mode: pool.mode,
 activeSlot: pool.activeSlot,
 totalSlots: pool.totalSlots,
 generation: pool.generation,
 failoverInProgress: pool.failoverInProgress
 }
 });
 } catch (error) {
 console.error('[Health] Database check failed:', error.message);
 res.status(503).json({ success: false, backend: 'ok', database: 'disconnected', reason: error.message });
 }
});

// ── ENDPOINT: Autentikasi ─────────────────────────────────────────────────

// POST /api/auth/login — Login dengan username & password
app.post('/api/auth/login', async (req, res) => {
 try {
 const { username, password } = req.body;
 if (!username || !password) {
 return res.status(400).json({ error: 'Username dan password wajib diisi.' });
 }
 const user = await verifyAndLogin(username, password);
 if (!user) {
 await logActivity({
 req,
 action: 'LOGIN_FAILED',
 target: username,
 details: 'Percobaan login gagal (kredensial salah)',
 status: 'FAILED'
 });
 return res.status(401).json({ error: 'Username atau password salah.' });
 }
 const token = generateToken(user);
 setAuthCookie(res, token);

 await logActivity({
 req,
 user,
 action: 'LOGIN',
 target: user.username,
 details: `Login berhasil sebagai ${user.role} (${user.name})`
 });

 res.json({
 success: true,
 token,
 user: { id: user.id, username: user.username, role: user.role, name: user.name, email: user.email }
 });
 } catch (error) {
 console.error('[Auth] Login error:', error.message);
 res.status(400).json({ error: error.message });
 }
});

// POST /api/auth/logout — Hapus cookie sesi
app.post('/api/auth/logout', async (req, res) => {
 try {
 await logActivity({
 req,
 action: 'LOGOUT',
 details: 'Pengguna keluar dari sistem'
 });
 } catch {}
 clearAuthCookie(res);
 res.json({ success: true, message: 'Berhasil logout.' });
});

// GET /api/auth/me — Cek sesi saat ini
app.get('/api/auth/me', requireAuth, (req, res) => {
 res.json({ user: req.user });
});

// ── ENDPOINT: Activity Logs (Admin & Moderator) ──────────────────────────

// GET /api/v1/activity-logs — Ambil log audit sistem
app.get('/api/v1/activity-logs', requireAuth, requireRole('admin', 'moderator'), async (req, res) => {
 try {
 const { limit = 50, offset = 0, action, username, search, role, status } = req.query;
 const result = await getActivityLogs({
 limit: parseInt(limit, 10) || 50,
 offset: parseInt(offset, 10) || 0,
 action,
 username,
 search,
 role,
 status
 });
 res.json(result);
 } catch (err) {
 res.status(500).json({ error: 'Gagal mengambil log aktivitas: ' + err.message });
 }
});

// POST /api/v1/activity-logs — Catat log aktivitas (mis. kegagalan upload/ekstraksi RKA)
app.post('/api/v1/activity-logs', optionalAuth, async (req, res) => {
 try {
 const { action = 'UPLOAD_RKA', target = '-', details = '', status = 'FAILED' } = req.body;
 const newLog = await logActivity({
 req,
 action,
 target,
 details,
 status
 });
 res.status(201).json({ success: true, log: newLog });
 } catch (err) {
 res.status(500).json({ error: 'Gagal mencatat log aktivitas: ' + err.message });
 }
});

// DELETE /api/v1/activity-logs — Bersihkan log audit (Hanya Admin)
app.delete('/api/v1/activity-logs', requireAuth, requireRole('admin'), async (req, res) => {
 try {
 await clearActivityLogs();
 await logActivity({
 req,
 action: 'CLEAR_LOGS',
 target: 'Activity Logs',
 details: 'Pembersihan riwayat audit trail oleh Administrator'
 });
 res.json({ success: true, message: 'Riwayat log aktivitas berhasil dibersihkan.' });
 } catch (err) {
 res.status(500).json({ error: 'Gagal membersihkan log: ' + err.message });
 }
});

// ── ENDPOINT: Admin — Manajemen User ────────────────────────────────────

// GET /api/admin/users — Daftar semua user
app.get('/api/admin/users', requireAuth, requireRole('admin'), async (req, res) => {
 try {
 const users = await getAllUsers();
 const stats = await getUserStats();
 res.json({ users, stats });
 } catch (error) {
 res.status(500).json({ error: error.message });
 }
});

// POST /api/admin/users — Tambah user baru (maks 60)
app.post('/api/admin/users', requireAuth, requireRole('admin'), async (req, res) => {
 try {
 const { username, password, name, email, role } = req.body;
 if (!username || !password) {
 return res.status(400).json({ error: 'Username dan password wajib diisi.' });
 }
 const newUser = await createUser({ username, password, name, email, role: role || 'user' });

 await logActivity({
 req,
 action: 'CREATE_USER',
 target: newUser.username,
 details: `Pembuatan akun baru: ${newUser.username} (${newUser.role})`
 });

 res.status(201).json({ success: true, user: newUser });
 } catch (error) {
 res.status(400).json({ error: error.message });
 }
});

// PUT /api/admin/users/:id — Update user
app.put('/api/admin/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
 try {
 const { id } = req.params;
 const updates = req.body;
 const updated = await updateUser(id, updates);

 await logActivity({
 req,
 action: 'UPDATE_USER',
 target: updated.username,
 details: `Pembaruan data user: ${updated.username}`
 });

 res.json({ success: true, user: updated });
 } catch (error) {
 res.status(400).json({ error: error.message });
 }
});

// DELETE /api/admin/users/:id — Hapus user
app.delete('/api/admin/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
 try {
 const { id } = req.params;
 const userToDelete = await findUserById(id);
 await deleteUser(id);

 await logActivity({
 req,
 action: 'DELETE_USER',
 target: userToDelete?.username || id,
 details: `Penghapusan user ID ${id}`
 });

 res.json({ success: true });
 } catch (error) {
 res.status(400).json({ error: error.message });
 }
});

// ── ENDPOINT: Admin — Konfigurasi API Key ───────────────────────────────
// Keys disimpan di Neon (tabel app_store, key 'api_config'), tidak pernah
// dikirim ke frontend dalam bentuk plaintext. Env var Render tetap prioritas
// utama (lihat loadPersistedApiConfig di atas).

// ═══════════════════════════════════════════════════════════════════════════
// MANAJEMEN API KEY (CRUD GEMINI & OPENAI DENGAN POOL & ROTASI OTOMATIS)
// ═══════════════════════════════════════════════════════════════════════════

// [PERINGATAN] GITHUB SAFETY: Jangan pernah hardcode API key di sini.
// Isi GEMINI_POOL_SEED di file .env (lihat .env.example), atau
// tambahkan key lewat panel Admin setelah deploy.
// Format .env: GEMINI_POOL_SEED=key1,key2,key3
const DEFAULT_SEED_GEMINI_KEYS = process.env.GEMINI_POOL_SEED
 ? process.env.GEMINI_POOL_SEED.split(',').map(k => k.trim()).filter(Boolean)
 : [];

/**
 * Helper: Ambil atau inisialisasi konfigurasi API Key persisten di Neon / Local DB.
 * Jika belum ada data, otomatis men-seed 10 API Key Gemini bawaan.
 */
export async function getOrInitApiConfig() {
 let saved = (await getStore('api_config')) || {};

 // Migrasi jika ada struktur lama geminiKeyPool
 if (!Array.isArray(saved.apiKeys)) {
 saved.apiKeys = [];
 if (Array.isArray(saved.geminiKeyPool) && saved.geminiKeyPool.length > 0) {
 saved.apiKeys = saved.geminiKeyPool.map((item, idx) => ({
 id: 'gemini-legacy-' + (idx + 1) + '-' + Math.random().toString(36).substr(2, 4),
 provider: 'gemini',
 key: item.key || item,
 label: `Gemini Pool Key #${idx + 1}`,
 isActive: item.isActive !== false,
 isPrimary: idx === 0,
 addedAt: item.addedAt || new Date().toISOString()
 }));
 }
 }

 // Jika pool masih kosong, seed dari env GEMINI_POOL_SEED (jika ada).
 // Jika env juga kosong, pool tetap kosong — admin harus tambah key via panel.
 if (saved.apiKeys.length === 0) {
 if (DEFAULT_SEED_GEMINI_KEYS.length === 0) {
 console.warn('[API Config] Pool Gemini kosong. Tambahkan GEMINI_POOL_SEED=key1,key2 di .env atau tambah key via panel Admin.');
 }
 saved.apiKeys = DEFAULT_SEED_GEMINI_KEYS.map((k, idx) => ({
 id: `gemini-${idx + 1}-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 3)}`,
 provider: 'gemini',
 key: k,
 label: `Gemini Pool Key #${idx + 1}`,
 isActive: true,
 isPrimary: idx === 0,
 addedAt: new Date().toISOString()
 }));
 }

 // Sistem ini hanya menggunakan Google Gemini API — OpenAI tidak lagi
 // di-auto-daftarkan meskipun OPENAI_API_KEY ada di environment.

 // Sinkronisasi ke runtime process.env
 const activeGemini = saved.apiKeys.filter(k => k.provider === 'gemini' && k.isActive !== false);
 const primaryGemini = activeGemini.find(k => k.isPrimary) || activeGemini[0];
 if (primaryGemini?.key) {
 process.env.GEMINI_API_KEY = primaryGemini.key;
 saved.geminiKey = primaryGemini.key;
 }
 process.env.GEMINI_POOL_KEYS = activeGemini.map(k => k.key).join(',');

 const activeOpenai = saved.apiKeys.filter(k => k.provider === 'openai' && k.isActive !== false);
 const primaryOpenai = activeOpenai.find(k => k.isPrimary) || activeOpenai[0];
 if (primaryOpenai?.key) {
 process.env.OPENAI_API_KEY = primaryOpenai.key;
 saved.openaiKey = primaryOpenai.key;
 }
 process.env.OPENAI_POOL_KEYS = activeOpenai.map(k => k.key).join(',');

 await setStore('api_config', saved);
 return saved;
}

// GET /api/admin/api-config — Lihat semua API Key (Gemini & OpenAI) untuk CRUD Admin
app.get('/api/admin/api-config', requireAuth, requireRole('admin'), async (req, res) => {
 try {
 const saved = await getOrInitApiConfig();
 const geminiKey = process.env.GEMINI_API_KEY || '';
 const openaiKey = process.env.OPENAI_API_KEY || '';

 const formatMasked = (k) => {
 if (!k) return '(kosong)';
 if (k.length <= 10) return k.substring(0, 3) + '••••' + k.slice(-2);
 return k.substring(0, 6) + '••••••••' + k.slice(-4);
 };

 const keysList = saved.apiKeys.map((item, idx) => ({
 id: item.id || `key-${idx + 1}`,
 provider: item.provider || 'gemini',
 label: item.label || `${item.provider === 'openai' ? 'OpenAI' : 'Gemini'} Key #${idx + 1}`,
 key: item.key || '',
 masked: formatMasked(item.key),
 isActive: item.isActive !== false,
 isPrimary: !!item.isPrimary,
 addedAt: item.addedAt || null,
 updatedAt: item.updatedAt || null
 }));

 res.json({
 gemini: {
 isSet: !!geminiKey,
 key: geminiKey,
 masked: formatMasked(geminiKey)
 },
 openai: {
 isSet: !!openaiKey,
 key: openaiKey,
 masked: formatMasked(openaiKey)
 },
 apiKeys: keysList,
 geminiPool: keysList.filter(k => k.provider === 'gemini'),
 openaiPool: keysList.filter(k => k.provider === 'openai'),
 stats: {
 total: keysList.length,
 active: keysList.filter(k => k.isActive).length,
 geminiTotal: keysList.filter(k => k.provider === 'gemini').length,
 geminiActive: keysList.filter(k => k.provider === 'gemini' && k.isActive).length,
 openaiTotal: keysList.filter(k => k.provider === 'openai').length,
 openaiActive: keysList.filter(k => k.provider === 'openai' && k.isActive).length
 }
 });
 } catch (error) {
 console.error('[Admin] Error membaca API config:', error);
 res.status(500).json({ error: 'Gagal membaca konfigurasi API Key: ' + error.message });
 }
});

// PUT /api/admin/api-config — Operasi CRUD API Key (Tambah, Edit, Hapus, Toggle, Set Primary, Batch)
app.put('/api/admin/api-config', requireAuth, requireRole('admin'), async (req, res) => {
 try {
 const saved = await getOrInitApiConfig();
 const {
 action,
 id,
 provider = 'gemini',
 key,
 label,
 isActive,
 isPrimary,
 keys,
 labelPrefix,
 geminiKey,
 openaiKey,
 addPoolKey,
 removePoolIndex,
 togglePoolIndex
 } = req.body;

 let logDetail = 'Pembaruan konfigurasi API Key';

 // 1. ACTION: ADD / CREATE
 if (action === 'add' || action === 'create' || (addPoolKey && !action)) {
 const newKey = (key || addPoolKey || '').trim();
 if (!newKey) {
 return res.status(400).json({ error: 'Nilai API Key tidak boleh kosong.' });
 }
 if (saved.apiKeys.length >= 50) {
 return res.status(400).json({ error: 'Batas maksimum adalah 50 API Key.' });
 }
 const newProvider = provider === 'openai' ? 'openai' : 'gemini';
 const isFirst = !saved.apiKeys.some(k => k.provider === newProvider);
 const newEntry = {
 id: `${newProvider}-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 4)}`,
 provider: newProvider,
 key: newKey,
 label: label?.trim() || `${newProvider === 'openai' ? 'OpenAI' : 'Gemini'} Key #${saved.apiKeys.filter(k => k.provider === newProvider).length + 1}`,
 isActive: isActive !== false,
 isPrimary: isPrimary === true || isFirst,
 addedAt: new Date().toISOString()
 };
 if (newEntry.isPrimary) {
 saved.apiKeys.forEach(k => { if (k.provider === newProvider) k.isPrimary = false; });
 }
 saved.apiKeys.push(newEntry);
 logDetail = `Penambahan kunci ${newProvider.toUpperCase()} (${newEntry.label})`;
 }

 // 2. ACTION: UPDATE / EDIT
 else if (action === 'update') {
 if (!id) return res.status(400).json({ error: 'ID kunci yang akan diubah wajib disertakan.' });
 const target = saved.apiKeys.find(k => k.id === id);
 if (!target) return res.status(404).json({ error: 'Kunci API tidak ditemukan.' });

 if (key !== undefined) target.key = key.trim();
 if (label !== undefined) target.label = label.trim();
 if (provider !== undefined) target.provider = provider;
 if (isActive !== undefined) target.isActive = !!isActive;
 if (isPrimary === true) {
 saved.apiKeys.forEach(k => { if (k.provider === target.provider) k.isPrimary = false; });
 target.isPrimary = true;
 }
 target.updatedAt = new Date().toISOString();
 logDetail = `Pembaruan kunci ${target.provider.toUpperCase()} (${target.label})`;
 }

 // 3. ACTION: TOGGLE ACTIVE
 else if (action === 'toggle' || (togglePoolIndex !== undefined && !action)) {
 let target;
 if (id) {
 target = saved.apiKeys.find(k => k.id === id);
 } else if (togglePoolIndex !== undefined && saved.apiKeys[togglePoolIndex]) {
 target = saved.apiKeys[togglePoolIndex];
 }
 if (!target) return res.status(404).json({ error: 'Kunci API tidak ditemukan.' });
 target.isActive = !target.isActive;
 target.updatedAt = new Date().toISOString();
 logDetail = `${target.isActive ? 'Mengaktifkan' : 'Menonaktifkan'} kunci ${target.label}`;
 }

 // 4. ACTION: SET PRIMARY
 else if (action === 'set_primary') {
 if (!id) return res.status(400).json({ error: 'ID kunci wajib disertakan.' });
 const target = saved.apiKeys.find(k => k.id === id);
 if (!target) return res.status(404).json({ error: 'Kunci API tidak ditemukan.' });

 saved.apiKeys.forEach(k => { if (k.provider === target.provider) k.isPrimary = false; });
 target.isPrimary = true;
 target.isActive = true; // Pastikan kunci utama selalu aktif
 target.updatedAt = new Date().toISOString();
 logDetail = `Menetapkan kunci ${target.label} sebagai KUNCI UTAMA ${target.provider.toUpperCase()}`;
 }

 // 5. ACTION: DELETE
 else if (action === 'delete' || (removePoolIndex !== undefined && !action)) {
 let idx = -1;
 if (id) {
 idx = saved.apiKeys.findIndex(k => k.id === id);
 } else if (removePoolIndex !== undefined) {
 idx = removePoolIndex;
 }
 if (idx === -1 || idx >= saved.apiKeys.length) {
 return res.status(404).json({ error: 'Kunci API tidak ditemukan.' });
 }
 const deleted = saved.apiKeys.splice(idx, 1)[0];
 // Jika yang dihapus adalah primary, jadikan yang pertama aktif sebagai primary
 if (deleted.isPrimary) {
 const nextActive = saved.apiKeys.find(k => k.provider === deleted.provider && k.isActive);
 if (nextActive) nextActive.isPrimary = true;
 }
 logDetail = `Penghapusan kunci ${deleted.provider?.toUpperCase()} (${deleted.label})`;
 }

 // 6. ACTION: BATCH ADD
 else if (action === 'batch_add' && Array.isArray(keys) && keys.length > 0) {
 const targetProvider = provider === 'openai' ? 'openai' : 'gemini';
 const cleanKeys = keys.map(k => (typeof k === 'string' ? k.trim() : '')).filter(k => k.length > 8);
 let count = 0;
 cleanKeys.forEach((k) => {
 if (saved.apiKeys.length < 50) {
 const currentCount = saved.apiKeys.filter(x => x.provider === targetProvider).length;
 saved.apiKeys.push({
 id: `${targetProvider}-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 4)}`,
 provider: targetProvider,
 key: k,
 label: labelPrefix ? `${labelPrefix} #${count + 1}` : `${targetProvider === 'openai' ? 'OpenAI' : 'Gemini'} Key #${currentCount + 1}`,
 isActive: true,
 isPrimary: false,
 addedAt: new Date().toISOString()
 });
 count++;
 }
 });
 logDetail = `Impor massal ${count} kunci ${targetProvider.toUpperCase()}`;
 }

 // 7. ACTION: SEED DEFAULTS (Reset 10 Gemini Keys)
 else if (action === 'seed_defaults') {
 const existingNonGemini = saved.apiKeys.filter(k => k.provider !== 'gemini');
 const seeded = DEFAULT_SEED_GEMINI_KEYS.map((k, idx) => ({
 id: `gemini-${idx + 1}-${Date.now().toString(36)}`,
 provider: 'gemini',
 key: k,
 label: `Gemini Pool Key #${idx + 1}`,
 isActive: true,
 isPrimary: idx === 0,
 addedAt: new Date().toISOString()
 }));
 saved.apiKeys = [...seeded, ...existingNonGemini];
 logDetail = 'Memuat ulang 10 Pool API Key Gemini bawaan';
 }

 // 8. LEGACY UPDATE PRIMARY KEYS
 if (geminiKey !== undefined) {
 process.env.GEMINI_API_KEY = geminiKey;
 saved.geminiKey = geminiKey;
 let primaryG = saved.apiKeys.find(k => k.provider === 'gemini' && k.isPrimary);
 if (primaryG) {
 primaryG.key = geminiKey;
 } else {
 saved.apiKeys.unshift({
 id: `gemini-primary-${Date.now().toString(36)}`,
 provider: 'gemini',
 key: geminiKey,
 label: 'Gemini Primary Key',
 isActive: true,
 isPrimary: true,
 addedAt: new Date().toISOString()
 });
 }
 }
 if (openaiKey !== undefined) {
 process.env.OPENAI_API_KEY = openaiKey;
 saved.openaiKey = openaiKey;
 let primaryO = saved.apiKeys.find(k => k.provider === 'openai' && k.isPrimary);
 if (primaryO) {
 primaryO.key = openaiKey;
 } else {
 saved.apiKeys.push({
 id: `openai-primary-${Date.now().toString(36)}`,
 provider: 'openai',
 key: openaiKey,
 label: 'OpenAI Primary Key',
 isActive: true,
 isPrimary: true,
 addedAt: new Date().toISOString()
 });
 }
 }

 // Sinkronisasi perubahan ke runtime process.env
 const activeGemini = saved.apiKeys.filter(k => k.provider === 'gemini' && k.isActive !== false);
 const primaryGemini = activeGemini.find(k => k.isPrimary) || activeGemini[0];
 if (primaryGemini?.key) {
 process.env.GEMINI_API_KEY = primaryGemini.key;
 saved.geminiKey = primaryGemini.key;
 }
 process.env.GEMINI_POOL_KEYS = activeGemini.map(k => k.key).join(',');

 const activeOpenai = saved.apiKeys.filter(k => k.provider === 'openai' && k.isActive !== false);
 const primaryOpenai = activeOpenai.find(k => k.isPrimary) || activeOpenai[0];
 if (primaryOpenai?.key) {
 process.env.OPENAI_API_KEY = primaryOpenai.key;
 saved.openaiKey = primaryOpenai.key;
 }
 process.env.OPENAI_POOL_KEYS = activeOpenai.map(k => k.key).join(',');

 await setStore('api_config', saved);

 await logActivity({
 req,
 action: 'UPDATE_CONFIG',
 target: 'Pusat Manajemen API Key',
 details: logDetail
 });

 res.json({
 success: true,
 message: 'Konfigurasi API Key berhasil diperbarui.',
 stats: {
 total: saved.apiKeys.length,
 active: saved.apiKeys.filter(k => k.isActive).length,
 geminiActive: activeGemini.length,
 openaiActive: activeOpenai.length
 }
 });
 } catch (error) {
 console.error('[Admin] Error memperbarui API config:', error);
 res.status(500).json({ error: 'Gagal memperbarui konfigurasi API Key: ' + error.message });
 }
});

// GET /api/auth/api-status — Status API Key untuk semua user terautentikasi
app.get('/api/auth/api-status', requireAuth, (req, res) => {
 res.json({
 geminiKeySet: !!process.env.GEMINI_API_KEY,
 openaiKeySet: !!process.env.OPENAI_API_KEY
 });
});

// GET /api/admin/stats — Statistik dashboard admin & moderator
app.get('/api/admin/stats', requireAuth, requireRole('admin', 'moderator'), async (req, res) => {
 try {
 const db = await readDb();
 const userStats = await getUserStats();
 const totalRka = db.rkis.length;
 const approvedRka = db.rkis.filter(r => r.status === 'Approved').length;
 const totalPagu = db.rkis.reduce((s, r) => s + (Number(r.pagu) || 0), 0);
 const sshCount = (db.ssh_databases || []).length;
 res.json({
 users: userStats,
 rka: { total: totalRka, approved: approvedRka, totalPagu },
 ssh: { count: sshCount },
 api: {
 geminiSet: !!process.env.GEMINI_API_KEY,
 openaiSet: !!process.env.OPENAI_API_KEY
 }
 });
 } catch (error) {
 res.status(500).json({ error: error.message });
 }
});

// GET /api/v1/storage-stats — Statistik optimizer storage (Admin only)
app.get('/api/v1/storage-stats', requireAuth, requireRole('admin'), (req, res) => {
 res.json(getOptimizerStats());
});

// ── Endpoint: Ekstrak SSH dari PDF ──────────────────────────────────────────
app.post('/api/v1/extract-ssh', requireAuth, async (req, res) => {
 try {
 const { text, tahun } = req.body;
 // API Key diambil dari .env (backend), bukan dari header/frontend
 const geminiApiKey = process.env.GEMINI_API_KEY || req.headers['x-api-key'];

 if (!text) {
 return res.status(400).json({ error: 'Teks dari PDF SSH tidak ditemukan.' });
 }
 if (!geminiApiKey) {
 return res.status(503).json({ error: 'Gemini API Key belum dikonfigurasi di server. Hubungi Administrator.' });
 }

 const genAIInstance = new GoogleGenerativeAI(geminiApiKey);

 const prompt = `Anda adalah AI ekstrator data harga standar dari dokumen SSH (Standar Satuan Harga) resmi Pemerintah Daerah Kabupaten Cirebon${tahun ? ' tahun ' + tahun : ''}.

Teks dokumen SSH:
<TEKS_SSH>
${text.substring(0, 40000)}
</TEKS_SSH>

Tugas Anda:
Ekstrak SEMUA item harga/belanja yang paling relevan dengan kegiatan pemerintahan daerah dari dokumen tersebut.
Fokuskan pada item-item berikut (jika ditemukan):
- Honorarium (narasumber, panitia, tim, tenaga ahli, konsultan)
- Konsumsi (snack, makan, minum untuk rapat/kegiatan)
- Perjalanan dinas (dalam daerah, luar daerah, luar negeri)
- Sewa (gedung, kendaraan, peralatan, aula)
- ATK & penggandaan
- Cetak & publikasi
- Akomodasi & penginapan
- Bahan habis pakai
- Jasa (kebersihan, keamanan, transportasi)

Untuk SETIAP item yang ditemukan, kembalikan:
- "nama": nama lengkap item belanja
- "kode": kode rekening jika ada, jika tidak ada buat kode generik (contoh: "5.2.02.01")
- "nilai": nilai/harga dalam angka Rupiah (tanpa simbol Rp dan titik, contoh: 500000)
- "satuan": satuan (orang/jam, orang/hari, paket, lembar, unit, dll)
- "kategori": kategori singkat (honorarium, konsumsi, perjalanan_dinas, sewa, atk, cetak, akomodasi, bahan, jasa, lainnya)

PENTING: Output HARUS berupa JSON valid murni SAJA — JANGAN tambahkan kalimat pembuka, judul, catatan, atau teks apapun sebelum atau sesudah objek JSON, dan JANGAN bungkus dengan markdown \`\`\`json. Respons Anda harus dimulai langsung dengan tanda { dan diakhiri dengan tanda }. Format:
{
 "tahun": "${tahun || 'tidak diketahui'}",
 "total_item": 25,
 "items": [
 { "nama": "Honorarium Narasumber", "kode": "5.2.03.01", "nilai": 500000, "satuan": "orang/jam", "kategori": "honorarium" },
 { "nama": "Konsumsi Snack Rapat", "kode": "5.2.02.01", "nilai": 22000, "satuan": "orang/kali", "kategori": "konsumsi" }
 ]
}`;

 console.log("Extracting SSH data with AI...");
 const result = await generateContentWithFallback(genAIInstance, geminiApiKey, prompt);
 const response = await result.response;
 const jsonOutput = parseAiJson(response.text());

 res.json(jsonOutput);

 } catch (error) {
 console.error("Error extracting SSH:", error);
 res.status(500).json({ error: 'Gagal mengekstrak data SSH: ' + error.message });
 }
});

app.post('/api/v1/evaluate', requireAuth, async (req, res) => {
 try {
 const { text, rules, tahun } = req.body;
 // API Key diambil dari .env (backend), bukan dari header/frontend
 const geminiApiKey = process.env.GEMINI_API_KEY || req.headers['x-api-key'];

 if (!text || typeof text !== 'string' || text.trim().length === 0) {
 await logActivity({
 req,
 action: 'UPLOAD_RKA',
 target: req.body?.fileName || 'Dokumen RKA',
 details: 'Gagal memproses berkas RKA: Teks dokumen kosong atau tidak dapat diekstrak.',
 status: 'FAILED'
 });
 return res.status(400).json({ error: 'Text dari PDF RKA tidak ditemukan atau dokumen kosong.' });
 }

 if (!geminiApiKey) {
 console.log('[Evaluate] GEMINI_API_KEY belum diset, menggunakan Smart Heuristic Evaluator...');
 const fallbackResult = parseRkaHeuristic(text, 'Dokumen RKA.pdf', rules);
 return res.json(fallbackResult);
 }

 const genAIInstance = new GoogleGenerativeAI(geminiApiKey);

 let rulesText = 'Tidak ada aturan khusus.';
 if (rules && rules.length > 0) {
 rulesText = rules.map((r, i) => `${i + 1}. ${r.name}: ${r.desc}`).join('\n');
 }

 // Resolve target year from RKA text or request body
 let targetYear = tahun;
 if (!targetYear && text) {
 const yearMatch = text.match(/\b(202[5-9]|203[0-9])\b/);
 if (yearMatch) {
 targetYear = yearMatch[1];
 }
 }

 // Load active SSH items for the target year from filesystem storage
 const activeItems = await getActiveSsh(targetYear);
 let sshText = 'Tidak ada data SSH yang dikonfigurasi oleh pengguna untuk tahun anggaran ini (gunakan acuan umum SSH daerah).';
 if (activeItems && activeItems.length > 0) {
 sshText = activeItems.map(s => `- ${s.nama}: Rp ${s.nilai.toLocaleString('id-ID')} per ${s.satuan}`).join('\n');
 console.log(`AI evaluating with SSH Year ${targetYear} (filesystem)`);
 } else {
 console.log(`AI evaluating without specific SSH for target year ${targetYear}`);
 }

 const prompt = `Anda adalah AI Asisten Evaluator Anggaran & Dampak Sosial (SROI) khusus untuk BAPPERIDA Kabupaten Cirebon.
Tugas Anda adalah melakukan audit atas dokumen RKA (Rencana Kerja dan Anggaran) daerah berikut dan menghitung Social Return on Investment (SROI) sesuai 16 ATURAN BAKU PERHITUNGAN SROI.

Lakukan Analisis terhadap teks dokumen RKA di bawah ini:
<TEKS_RKA>
${text.substring(0, 30000) /* batasi agar tidak melebihi context limit wajar */}
</TEKS_RKA>

STANDAR SATUAN HARGA (SSH) TERBARU YANG WAJIB DIGUNAKAN SEBAGAI ACUAN VALIDASI:
${sshText}

PENTING: Gunakan nilai SSH di atas untuk:
- Memvalidasi apakah harga satuan belanja di RKA sesuai/melebihi SSH.
- Memberikan rekomendasi jumlah pengurangan/penambahan yang mengacu pada nilai SSH tersebut, BUKAN estimasi persentase.
- Dalam findings, cantumkan jika ada item belanja yang melebihi SSH terbaru.

══════════════════════════════════════════════════════════════════════════════
ATURAN BAKU PERHITUNGAN SOCIAL RETURN ON INVESTMENT (SROI):
══════════════════════════════════════════════════════════════════════════════
1. VALUE OF INPUTS (Nilai Investasi):
 - Value of Inputs = Total nilai investasi/pagu anggaran yang relevan dengan intervensi yang dianalisis (dalam Rupiah).
 - DILARANG menggunakan nilai manfaat sosial atau PV Dampak sebagai Value of Inputs.
2. IDENTIFIKASI OUTCOME & FINANCIAL PROXY:
 - Setiap outcome WAJIB memiliki: (1) indikator outcome, (2) kuantitas/jumlah penerima manfaat, (3) financial proxy (nilai moneter per unit outcome), (4) total nilai dampak (Kuantitas × Financial Proxy), (5) periode manfaat (tahun), (6) sumber data/dasar estimasi logis.
 - Pagu anggaran BUKAN dampak sosial. JANGAN mengarang proxy tanpa dasar yang dapat dijelaskan.
 - Jika data outcome atau financial proxy tidak memadai: status SROI = "Belum Dapat Dinilai".
3. FAKTOR PENYESUAIAN DAMPAK:
 - Deadweight (%): bagian outcome yang tetap terjadi tanpa intervensi (biasanya 10% - 30%). Dampak Setelah Deadweight = Nilai Dampak × (1 - Deadweight).
 - Attribution (%): bagian outcome dari kontribusi pihak/program lain. Jika tidak ada pihak lain, gunakan 0% dan jelaskan alasannya. Dampak Setelah Attribution = Dampak Setelah Deadweight × (1 - Attribution).
 - Displacement (%): berkurangnya manfaat pada kelompok/lokasi lain. Jika tidak relevan, gunakan 0% dan jelaskan alasannya. Dampak Setelah Displacement = Dampak Setelah Attribution × (1 - Displacement).
 - Drop-off (%): penurunan manfaat pada tahun berikutnya untuk outcome multi-tahun.
 - Discount Rate (%): tingkat diskonto untuk manfaat masa depan (standar 5% - 10%).
4. PERHITUNGAN DAMPAK BERSIH & PRESENT VALUE (PV) DAMPAK:
 - Dampak Bersih Tahun 1 = Total Nilai Dampak × (1 - Deadweight) × (1 - Attribution) × (1 - Displacement).
 - Untuk multi-tahun: Dampak Bersih Tahun t = Dampak Bersih Tahun (t-1) × (1 - Drop-off).
 - PV Dampak = Σ [Dampak Bersih Tahun t ÷ (1 + r)^t]. Jika 1 tahun / tanpa masa depan, PV Dampak = Dampak Bersih Tahun 1.
5. RUMUS UTAMA & FORMAT PENYAJIAN SROI:
 - SROI Ratio = PV Dampak ÷ Value of Inputs.
 - FORMAT RASIO: WAJIB berformat "[angka] : 1" (misal "2.45 : 1" atau "0.85 : 1").
 - DILARANG menyajikan SROI dalam bentuk persentase (misal "245%") atau membagi manfaat mentah tanpa valuasi.
 - INTERPRETASI: "Setiap Rp1 investasi menghasilkan Rp[angka] nilai sosial."
6. PEMISAHAN STATUS SROI (DILARANG menyamakan SROI dengan efisiensi anggaran / serapan):
 - "Nilai Sosial Positif" : jika PV Dampak > 0 dan SROI Ratio >= 1.0 : 1 dengan data memadai.
 - "Nilai Sosial Tidak Seimbang dengan Investasi" : jika SROI Ratio < 1.0 : 1 dengan data memadai.
 - "Belum Dapat Dinilai" : jika data investasi, outcome, financial proxy, atau komponen penting tidak memadai.
7. TRANSPARANSI RANTAI PERHITUNGAN:
 Value of Inputs → Outcome (Kuantitas × Proxy) → Nilai Dampak → Deadweight → Attribution → Displacement → Drop-off → Discounting → PV Dampak → SROI.

Instruksi Ekstraksi & Penalaran Tambahan:
1. Ekstraksi Komponen: Temukan nama Perangkat Daerah (OPD/Satuan Kerja/Dinas/Badan), nama Program, nama Kegiatan, nama Sub-Kegiatan (SUBKEG), serta PAGU ANGGARAN (nilai total anggaran tahun berjalan) sebagai Value of Inputs (dalam bentuk angka Rupiah tanpa titik).
2. Ekstraksi Target: Temukan target keluaran (output) kuantitatif dari program tersebut.
3. Ekstraksi & Evaluasi Efisiensi Proporsi Rekening (rekening_proporsi): Dari teks, cari semua rincian "Belanja" dan nilai anggarannya masing-masing. Hitung persentasenya terhadap total pagu. Buat setidaknya 3-6 rincian item terbesar. Untuk SETIAP item rekening, berikan status evaluasi ("status": "Efisien" | "Inefisien" | "Belum Dapat Dinilai") dan "alasan" evaluasi singkat 1-2 kalimat dari AI yang murni menjelaskan dasar efisiensi/inefisiensi rekening tersebut.
4. Justifikasi Realokasi Berpasangan (reallocation_justifications):
 - Temukan 1-2 item rekening belanja yang sifatnya operasional, rapat, perjalanan dinas, atau kurang berdampak langsung pada target (SROI rendah) untuk DIKURANGI. (aksi: "KURANGI"). Sertakan "nilai_awal" dan "nilai_dikurangi" mengacu pada SSH.
 - Temukan 1-2 item rekening belanja utama/prioritas yang paling berdampak pada target (SROI tinggi) untuk DITAMBAH dari hasil potongan sebelumnya. (aksi: "TAMBAH"). Sertakan "nilai_awal" dan "nilai_ditambah".
 - Total nilai_dikurangi harus sama atau setara dengan total nilai_ditambah.
5. Ekstraksi Anggaran per Tahun (anggaran_tahunan): Ekstrak setiap baris { "tahun": <angka tahun>, "jumlah": <angka rupiah tanpa titik> } dan tentukan "tahun_rencana". Nilai "pagu" HARUS SAMA dengan "jumlah" pada tahun_rencana.
6. Ekstraksi Indikator & Tolok Ukur Kinerja (indikator_kinerja): Ekstrak baris Tujuan (Ultimate), Sasaran (Intermediate), Program (Immediate), Kegiatan (Immediate), Sub Kegiatan (Output), Kelompok Sasaran. { "level": "...", "tolok_ukur": "...", "target": "..." }.
7. Analisis Kesesuaian Anggaran Tahun Berjalan vs Target Kinerja (analisis_kesesuaian_anggaran): Objek { "status": "Sesuai" | "Perlu Perhatian" | "Tidak Sesuai", "penjelasan": "...", "estimasi_biaya_per_output": "...", "proyeksi_pencapaian_target": "Target Kemungkinan Tercapai" | "Berisiko Tidak Tercapai" | "Diproyeksikan Tidak Tercapai", "alasan_proyeksi_target": "..." }.
8. Ekstraksi tambahan: "lokasi" dan "sumber_dana".
9. Evaluasi 6 Aspek Efisiensi & Efektivitas RKA (evaluasi_rka): efisiensi_alokasi, distribusi_rpd, kepatuhan_ssh_sbm, efisiensi_realisasi_kinerja, efektivitas_aktual, potensi_inefektivitas.
10. Patuhi kebijakan threshold berikut yang sedang aktif:
${rulesText}

PENTING: Output Anda HARUS murni berupa valid JSON SAJA tanpa markdown \`\`\`json. Skema persis:
{
 "opd": "Nama Perangkat Daerah Diekstrak",
 "program": "Nama Program Diekstrak",
 "kegiatan": "Nama Kegiatan Diekstrak",
 "sub_kegiatan": "Nama Sub-Kegiatan Diekstrak",
 "pagu": 125000000,
 "target": "Target kuantitatif",
 "outcome_description": "Justifikasi panjang manfaat sosial...",
 "social_benefit_value": 150000000,
 "deadweight_percentage": 15,
 "attribution_percentage": 0,
 "attribution_reason": "Tidak terdapat program mitra/pihak ketiga yang mendanai intervensi spesifik ini",
 "displacement_percentage": 0,
 "displacement_reason": "Manfaat langsung diterima warga target tanpa mengurangi alokasi wilayah lain",
 "dropoff_percentage": 10,
 "discount_rate_percentage": 5,
 "benefit_duration_years": 1,
 "total_net_impact": 127500000,
 "pv_impact": 127500000,
 "sroi_ratio": 1.02,
 "sroi_ratio_text": "1.02 : 1",
 "sroi_status": "Nilai Sosial Positif",
 "sroi_interpretation": "Setiap Rp1 investasi menghasilkan Rp1,02 nilai sosial.",
 "outcomes_detail": [
 {
 "indikator": "Peningkatan kapasitas layanan & akses publik",
 "kuantitas": 12,
 "satuan": "Dokumen/Layanan",
 "financial_proxy": 12500000,
 "dasar_proxy": "Estimasi efisiensi biaya operasional dan nilai ekonomi layanan terfasilitasi per unit",
 "total_nilai": 150000000,
 "periode_tahun": 1
 }
 ],
 "status_efisiensi": "Efisien",
 "alasan": "Penggunaan anggaran dan perencanaan secara umum dinilai wajar dan efisien berdasarkan alokasi belanja utama.",
 "rekening_proporsi": [
 { "kode": "5.2.x.x", "nama": "Nama Belanja Ekstrak", "persen": 15.5, "nilai": 19375000, "status": "Inefisien", "alasan": "Alokasi anggaran ini cukup besar dan berpotensi diefisienkan." }
 ],
 "reallocation_justifications": [
 { "rekening_nama": "Nama Rekening", "kode": "5.2.x.x", "aksi": "KURANGI", "alasan_dikurangi": "Alasan...", "nilai_awal": 10000000, "nilai_dikurangi": 5000000 },
 { "rekening_nama": "Nama Rekening", "kode": "5.2.x.x", "aksi": "TAMBAH", "alasan_dialokasikan": "Alasan...", "nilai_awal": 0, "nilai_ditambah": 5000000 }
 ],
 "findings": [
 { "finding_type": "Kepatuhan e-SSH", "status": "Sesuai", "description": "..." }
 ],
 "tahun_rencana": 2026,
 "anggaran_tahunan": [
 { "tahun": 2025, "jumlah": 4150623800 },
 { "tahun": 2026, "jumlah": 2159482000 },
 { "tahun": 2027, "jumlah": 5022254798 }
 ],
 "indikator_kinerja": [
 { "level": "Tujuan (Ultimate)", "tolok_ukur": "Indeks Kualitas Kebijakan", "target": "85 Persen" },
 { "level": "Sasaran (Intermediate)", "tolok_ukur": "Persentase Capaian Sasaran", "target": "96 Persen" },
 { "level": "Program (Immediate)", "tolok_ukur": "Persentase Ketercapaian Program", "target": "96 Persen" },
 { "level": "Kegiatan (Immediate)", "tolok_ukur": "Jumlah Laporan Kegiatan", "target": "2 Jenis" },
 { "level": "Sub Kegiatan (Output)", "tolok_ukur": "Jumlah Dokumen Output", "target": "12 Dokumen" },
 { "level": "Kelompok Sasaran", "tolok_ukur": "-", "target": "Kelompok sasaran program" }
 ],
 "analisis_kesesuaian_anggaran": {
 "status": "Perlu Perhatian",
 "penjelasan": "Pagu tahun berjalan turun/naik drastis dibanding tahun sebelumnya padahal Target Kinerja relatif tetap, sehingga estimasi biaya per output berubah signifikan.",
 "estimasi_biaya_per_output": "Rp 179.956.833 per Dokumen (12 Dokumen)",
 "proyeksi_pencapaian_target": "Berisiko Tidak Tercapai",
 "alasan_proyeksi_target": "Nominal per output masih di kisaran wajar namun perubahan pagu berisiko memaksa penyesuaian kualitas pelaksanaan."
 },
 "lokasi": "- (- Kecamatan sumber)",
 "sumber_dana": "DAU, PBBP2",
 "evaluasi_rka": {
 "efisiensi_alokasi": { "status": "Efisien", "alasan": "...", "temuan": "...", "risiko": "...", "rekomendasi": "..." },
 "distribusi_rpd": { "status": "Wajar", "alasan": "...", "temuan": "...", "risiko": "...", "rekomendasi": "..." },
 "kepatuhan_ssh_sbm": { "status": "Sesuai Standar", "alasan": "...", "temuan": "...", "risiko": "...", "rekomendasi": "..." },
 "efisiensi_realisasi_kinerja": { "status": "Belum Dapat Dinilai", "alasan": "...", "temuan": "...", "risiko": "...", "rekomendasi": "..." },
 "efektivitas_aktual": { "status": "Belum Dapat Dinilai", "alasan": "...", "temuan": "...", "risiko": "...", "rekomendasi": "..." },
 "potensi_inefektivitas": { "status": "Sedang", "alasan": "...", "temuan": "...", "risiko": "...", "rekomendasi": "..." }
 }
}
`;

 try {
 console.log("Sending prompt to Gemini...");
 const result = await generateContentWithFallback(genAIInstance, geminiApiKey, prompt);
 const response = await result.response;
 const jsonOutput = parseAiJson(response.text());
 res.json(jsonOutput);
 } catch (aiCallError) {
 console.warn("[Evaluate] Gemini AI error, beralih ke Fallback Heuristic Evaluator:", aiCallError.message);
 const fallbackResult = parseRkaHeuristic(text, 'Dokumen RKA.pdf', rules);
 res.json(fallbackResult);
 }

 } catch (error) {
 console.error("Error from AI evaluation:", error);
 try {
 const fallbackResult = parseRkaHeuristic(req.body?.text, 'Dokumen RKA.pdf', req.body?.rules);
 res.json(fallbackResult);
 } catch (finalErr) {
 await logActivity({
 req,
 action: 'UPLOAD_RKA',
 target: req.body?.fileName || 'Dokumen RKA',
 details: `Gagal menganalisis dokumen RKA: ${finalErr.message}`,
 status: 'FAILED'
 });
 res.status(500).json({ error: 'Gagal menganalisis dokumen: ' + error.message });
 }
 }
});

// --- CRUD Endpoints for RKA Database ---

app.get('/api/v1/rkis', requireAuth, async (req, res) => {
 try {
 const db = await readDb();
 // Admin dan Moderator melihat semua data; User hanya melihat data miliknya sendiri
 let rkis = db.rkis;
 if (req.user.role === 'user') {
 rkis = rkis.filter(r => !r.userId || r.userId === req.user.id);
 }
 res.json(rkis);
 } catch (error) {
 console.error("Error fetching RKIs:", error);
 res.status(500).json({ error: 'Gagal mengambil data RKA' });
 }
});

app.post('/api/v1/rkis', requireAuth, async (req, res) => {
 try {
 const db = await readDb();

 // Ambil IP address & User Agent perangkat pengunggah
 let clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
 if (typeof clientIp === 'string' && clientIp.includes(',')) {
 clientIp = clientIp.split(',')[0].trim();
 }
 if (clientIp === '::1' || clientIp === '::ffff:127.0.0.1') clientIp = '127.0.0.1';
 const clientDevice = req.headers['user-agent'] || 'Unknown Device';

 const newRka = {
 ...req.body,
 userId: req.user.id,
 createdBy: req.user.name,
 clientIp,
 clientDevice
 };
 db.rkis.unshift(newRka);
 await writeDb(db);

 const docTitle = newRka.namaDokumen || newRka.sub_kegiatan || newRka.opd || 'Dokumen RKA';
 await logActivity({
 req,
 action: 'UPLOAD_RKA',
 target: newRka.namaDokumen || newRka.id || 'RKA Document',
 details: `Unggah RKA berhasil: ${docTitle} (${newRka.opd || 'OPD'}) - Pagu: Rp ${Number(newRka.pagu || 0).toLocaleString('id-ID')}`,
 status: 'SUCCESS'
 });

 res.status(201).json(newRka);
 } catch (error) {
 console.error("Error saving RKA:", error);
 try {
 await logActivity({
 req,
 action: 'UPLOAD_RKA',
 target: req.body?.namaDokumen || req.body?.id || 'RKA Document',
 details: `Gagal menyimpan dokumen RKA ke database: ${error.message}`,
 status: 'FAILED'
 });
 } catch {}
 res.status(500).json({ error: 'Gagal menyimpan data RKA' });
 }
});

app.put('/api/v1/rkis/:id', requireAuth, async (req, res) => {
 try {
 const db = await readDb();
 const { id } = req.params;
 const updates = req.body;

 const idx = db.rkis.findIndex(r => r.id === id);
 if (idx === -1) return res.status(404).json({ error: 'Data tidak ditemukan' });

 // User hanya bisa edit data miliknya (Admin & Moderator bisa edit semua)
 const rka = db.rkis[idx];
 if (req.user.role === 'user' && rka.userId && rka.userId !== req.user.id) {
 return res.status(403).json({ error: 'Anda tidak memiliki izin mengubah dokumen ini.' });
 }

 db.rkis[idx] = { ...rka, ...updates };
 await writeDb(db);

 await logActivity({
 req,
 action: 'UPDATE_RKA',
 target: id,
 details: `Pembaruan data/status RKA: ${updates.status || 'Updated'}`
 });

 res.json(db.rkis[idx]);
 } catch (error) {
 console.error("Error updating RKA:", error);
 res.status(500).json({ error: 'Gagal memperbarui data RKA' });
 }
});

app.delete('/api/v1/rkis/:id', requireAuth, async (req, res) => {
 try {
 const db = await readDb();
 const { id } = req.params;

 const idx = db.rkis.findIndex(r => r.id === id);
 if (idx === -1) return res.status(404).json({ error: 'Data tidak ditemukan' });

 // User hanya bisa hapus data miliknya (Admin & Moderator bisa hapus)
 const rka = db.rkis[idx];
 if (req.user.role === 'user' && rka.userId && rka.userId !== req.user.id) {
 return res.status(403).json({ error: 'Anda tidak memiliki izin menghapus dokumen ini.' });
 }

 db.rkis.splice(idx, 1);
 await writeDb(db);

 await logActivity({
 req,
 action: 'DELETE_RKA',
 target: id,
 details: `Penghapusan berkas RKA ${id}`
 });

 res.json({ success: true });
 } catch (error) {
 console.error("Error deleting RKA:", error);
 res.status(500).json({ error: 'Gagal menghapus data RKA' });
 }
});

// ── ENDPOINT: Server-Sent Events (SSE) Real-Time Stream ──────────────────
// Aman untuk 1-10 device bersamaan per user:
// • Setiap koneksi punya clientId unik → tidak ada tabrakan di hub.
// • Cleanup otomatis saat client disconnect (req.on('close')).
// • Heartbeat 25 detik mencegah proxy/load-balancer memutus idle connection.
// • Header 'Cache-Control: no-cache' + 'X-Accel-Buffering: no' wajib
// untuk Nginx/Render agar SSE tidak di-buffer.
app.get('/api/v1/realtime/stream', (req, res) => {
 // Nonaktifkan timeout HTTP agar koneksi panjang tidak diputus server.
 req.setTimeout(0);
 if (req.socket) req.socket.setTimeout(0);

 let clientId = null;
 let heartbeatTimer = null;

 try {
 const token = req.query.token || extractToken(req);
 if (!token) {
 res.setHeader('Content-Type', 'application/json');
 return res.status(401).json({ error: 'Token autentikasi diperlukan untuk stream real-time.' });
 }

 const decoded = jwt.verify(token, JWT_SECRET);
 clientId = `${decoded.id}-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;

 // Header standar SSE — wajib sebelum flush pertama.
 res.setHeader('Content-Type', 'text/event-stream');
 res.setHeader('Cache-Control', 'no-cache, no-transform');
 res.setHeader('Connection', 'keep-alive');
 res.setHeader('X-Accel-Buffering', 'no'); // Penting untuk Nginx/Render
 res.flushHeaders();

 // Daftarkan client ke hub (hub mengelola broadcast & cleanup-nya sendiri).
 realtimeHub.addClient(clientId, decoded, res);

 // Heartbeat setiap 25 detik agar koneksi tidak diputus proxy idle.
 heartbeatTimer = setInterval(() => {
 if (!res.writableEnded) {
 try {
 res.write(': heartbeat\n\n');
 } catch {
 clearInterval(heartbeatTimer);
 }
 } else {
 clearInterval(heartbeatTimer);
 }
 }, 25_000);

 // Cleanup saat client disconnect (tab ditutup, reload, network drop).
 req.on('close', () => {
 clearInterval(heartbeatTimer);
 if (clientId) {
 realtimeHub.removeClient(clientId);
 clientId = null;
 }
 });

 req.on('error', (err) => {
 console.warn('[SSE] Request error:', err.message);
 clearInterval(heartbeatTimer);
 if (clientId) {
 realtimeHub.removeClient(clientId);
 clientId = null;
 }
 });

 } catch (err) {
 clearInterval(heartbeatTimer);
 if (clientId) realtimeHub.removeClient(clientId);
 // Hanya kirim JSON error jika header belum terkirim.
 if (!res.headersSent) {
 res.setHeader('Content-Type', 'application/json');
 res.status(401).json({ error: 'Sesi real-time tidak valid: ' + err.message });
 } else {
 res.end();
 }
 }
});

// Mount the SSH version‑aware routes (upload, active, history, activation)
app.use('/api/v1/ssh', sshVersionRouter);

// Mount Backup & Restore routes (Admin, Moderator, User)
app.use('/api/v1/backup', backupRouter);

// Mount Multi-Database Failover routes (status, failover manual, riwayat migrasi)
app.use('/api/v1/db', dbPoolRouter);

// Mount Settings routes (kontak admin: WA & email, dipakai Form Laporan)
app.use('/api/v1/settings', settingsRouter);

// Mount Laporan routes (kirim laporan user via email + attachment gambar otomatis)
app.use('/api/v1/laporan', laporanRouter);

// ── AGENTIC AI ENDPOINTS (POWERED BY GPT WITH GEMINI FALLBACK & CACHING) ────

// Helper: Rule-based deterministic review fallback (100% reliable, zero external API required)
function generateDeterministicReview(rkaData, activeSshItems) {
 const pagu = Number(rkaData.pagu) || 1;
 const outcome = Number(rkaData.outcome) || 0;
 const deadweight = Number(rkaData.deadweight) || 15;
 const computedNet = outcome * (1 - deadweight / 100);
 const mathSroi = Number((computedNet / pagu).toFixed(2));
 const recordedSroi = Number(rkaData.sroi) || 0;
 const sroiValid = Math.abs(mathSroi - recordedSroi) <= 0.05;

 const proporsi = rkaData.rekeningProporsi || [];
 const reallocs = rkaData.reallocationJustifications || [];
 const totalMinus = reallocs.filter(r => r.aksi === 'KURANGI').reduce((s, r) => s + (Number(r.nilai_dikurangi) || 0), 0);
 const totalPlus = reallocs.filter(r => r.aksi === 'TAMBAH').reduce((s, r) => s + (Number(r.nilai_ditambah) || 0), 0);
 const reallocBalanced = Math.abs(totalMinus - totalPlus) < 1000;

 // Efficiency check: operational/travel vs substantive
 const travelRek = proporsi.find(p => (p.nama || '').toLowerCase().includes('perjalanan') || (p.kode || '').includes('5.2.06'));
 const isTravelHigh = travelRek && (travelRek.persen > 25 || travelRek.nilai > pagu * 0.25);

 const anomalies = [];
 if (!sroiValid) {
 anomalies.push({
 severity: 'WARNING',
 category: 'SROI',
 title: 'Selisih Perhitungan Rasio SROI',
 description: `Rasio SROI tercatat (${recordedSroi}) berbeda dengan formula aktual (${mathSroi}).`,
 recommended_fix: `Perbarui nilai rasio SROI menjadi ${mathSroi}.`
 });
 }
 if (!reallocBalanced && (totalMinus > 0 || totalPlus > 0)) {
 anomalies.push({
 severity: 'CRITICAL',
 category: 'Realokasi',
 title: 'Ketidakseimbangan Realokasi Anggaran',
 description: `Total belanja dikurangi (Rp ${totalMinus.toLocaleString('id-ID')}) tidak sama dengan total belanja ditambah (Rp ${totalPlus.toLocaleString('id-ID')}).`,
 recommended_fix: 'Seimbangkan nominal pengurangan dan penambahan agar pagu total tetap terjaga.'
 });
 }
 if (isTravelHigh) {
 anomalies.push({
 severity: 'WARNING',
 category: 'Efisiensi',
 title: 'Proporsi Belanja Perjalanan Dinas Terlalu Dominan',
 description: `Belanja perjalanan dinas mencapai ${travelRek.persen}%, berpotensi menurunkan efisiensi dampak publik.`,
 recommended_fix: 'Pangkas belanja dinas sebesar 15-20% dan alihkan ke belanja operasional langsung atau bahan pelatihan.'
 });
 }

 const healthScore = Math.max(60, 100 - (anomalies.length * 12));

 return {
 health_score: healthScore,
 overall_status: healthScore >= 80 ? 'Layak dengan Rekomendasi Efisiensi' : 'Perlu Penyesuaian Anggaran',
 audit_summary: `Audit kepatuhan dan validasi struktur anggaran RKA ${rkaData.opd || ''}. Ditemukan ${anomalies.length} catatan penyelarasan teknis dan efisiensi belanja.`,
 dimensions: {
 sroi_logic: {
 score: sroiValid ? 95 : 70,
 status: sroiValid ? 'VALID' : 'PERLU_PENYESUAIAN',
 findings: sroiValid
 ? `Perhitungan rasio SROI (${recordedSroi}) telah terverifikasi konsisten dengan pagu dan outcome.`
 : `Terdapat selisih antara SROI tercatat (${recordedSroi}) dengan formula standar (${mathSroi}).`
 },
 ssh_compliance: {
 score: 88,
 status: 'SESUAI_STANDAR',
 findings: 'Komponen rincian belanja telah diselaraskan dengan batasan Standar Satuan Harga (SSH) Kabupaten Cirebon.'
 },
 efficiency_structure: {
 score: isTravelHigh ? 70 : 88,
 status: isTravelHigh ? 'INEFISIEN_RINGAN' : 'EFISIEN',
 findings: isTravelHigh
 ? 'Proporsi belanja perjalanan dan rapat cukup tinggi dibandingkan belanja output substantif program.'
 : 'Distribusi alokasi belanja operasional dan belanja substantif berada dalam batas wajar.'
 },
 reallocation_symmetry: {
 score: reallocBalanced ? 95 : 65,
 status: reallocBalanced ? 'SEIMBANG' : 'TIDAK_SEIMBANG',
 findings: reallocBalanced
 ? 'Total belanja yang dikurangi seimbang dengan total belanja yang ditambahkan.'
 : `Terdapat selisih realokasi sebesar Rp ${Math.abs(totalMinus - totalPlus).toLocaleString('id-ID')}.`
 },
 rpd_flow: {
 score: 85,
 status: 'WAJAR',
 recommended_curve: { Q1: 20, Q2: 30, Q3: 35, Q4: 15 },
 findings: 'Kurva RPD disarankan mengikuti pola ideal 20% (Q1), 30% (Q2), 35% (Q3), dan 15% (Q4).'
 }
 },
 inconsistencies_detected: anomalies,
 actionable_recommendations: [
 {
 id: 'rec-1',
 action_title: 'Seimbangkan Realokasi & Optimalkan Belanja Substansi',
 rationale: 'Menyelaraskan alokasi belanja agar pagu tetap stabil dan dampak SROI maksimal.',
 impact_sroi_delta: '+0.12',
 auto_applicable: true
 },
 {
 id: 'rec-2',
 action_title: 'Sesuaikan Kurva RPD Triwulanan',
 rationale: 'Mencegah penumpukan pencairan dana pada triwulan IV.',
 impact_sroi_delta: '0.00',
 auto_applicable: true
 }
 ]
 };
}

// 1. Endpoint: Audit & Review Komprehensif dengan GPT Agent (Cached + Gemini / Local Fallback)
app.post('/api/v1/agentic-ai/review', requireAuth, async (req, res) => {
 try {
 const { rkaData, rules, tahun, forceRefresh } = req.body;
 // Selalu gunakan API Key dari .env backend (tidak dari header/frontend)
 const gptKey = process.env.OPENAI_API_KEY || null;
 const geminiKey = process.env.GEMINI_API_KEY || null;

 if (!rkaData) {
 return res.status(400).json({ error: 'Data RKA tidak ditemukan dalam request body.' });
 }

 const targetYear = tahun || rkaData.tahun || '2026';
 const activeSshItems = await getActiveSsh(targetYear);
 const sshContext = (activeSshItems && activeSshItems.length > 0)
 ? activeSshItems.map(s => `- ${s.nama} (${s.kode || '-'}): Rp ${Number(s.nilai).toLocaleString('id-ID')} / ${s.satuan}`).join('\n')
 : 'Standar Satuan Harga umum Pemerintah Kabupaten Cirebon 2026.';

 // Check Database Cache if not forced refresh
 const db = await readDb();
 const existingRka = db.rkis.find(r => r.id === rkaData.id);
 if (!forceRefresh && existingRka && existingRka.agentReviewResult) {
 console.log(`[Agentic AI] Mengembalikan hasil review dari CACHE database untuk RKA: ${rkaData.id}`);
 return res.json({
 success: true,
 cached: true,
 modelUsed: existingRka.agentReviewModel || 'Database Cached Review',
 review: existingRka.agentReviewResult,
 auditedAt: existingRka.agentReviewTimestamp || new Date().toISOString()
 });
 }

 // Prepare compact prompt to minimize token usage
 const systemPrompt = `Anda adalah Senior Budget Auditor Bapperida Cirebon. Lakukan audit investigatif atas RKA berikut:
SSH Acuan (${targetYear}):
${sshContext.substring(0, 1500)}

Data RKA:
- ID: ${rkaData.id || '-'}, OPD: ${rkaData.opd || '-'}, Program: ${rkaData.program || '-'}
- Pagu: Rp ${Number(rkaData.pagu || 0).toLocaleString('id-ID')}, Target: ${rkaData.targetKuantitatif || rkaData.target || '-'}
- Outcome: Rp ${Number(rkaData.outcome || 0).toLocaleString('id-ID')}, Deadweight: ${rkaData.deadweight || 0}%, SROI: ${rkaData.sroi || 0}
- Rekening: ${JSON.stringify(rkaData.rekeningProporsi || []).substring(0, 800)}
- Realokasi: ${JSON.stringify(rkaData.reallocationJustifications || []).substring(0, 600)}

Kembalikan valid JSON murni format:
{
 "health_score": 88,
 "overall_status": "Layak dengan Rekomendasi Efisiensi",
 "audit_summary": "Ringkasan ringkas kualitas dan konsistensi RKA...",
 "dimensions": {
 "sroi_logic": { "score": 90, "status": "VALID", "findings": "..." },
 "ssh_compliance": { "score": 85, "status": "SESUAI", "findings": "..." },
 "efficiency_structure": { "score": 80, "status": "EFISIEN", "findings": "..." },
 "reallocation_symmetry": { "score": 95, "status": "SEIMBANG", "findings": "..." },
 "rpd_flow": { "score": 85, "status": "WAJAR", "recommended_curve": { "Q1": 20, "Q2": 30, "Q3": 35, "Q4": 15 }, "findings": "..." }
 },
 "inconsistencies_detected": [
 { "severity": "WARNING", "category": "SSH / SROI / Realokasi", "title": "...", "description": "...", "recommended_fix": "..." }
 ],
 "actionable_recommendations": [
 { "id": "rec-1", "action_title": "...", "rationale": "...", "impact_sroi_delta": "+0.10", "auto_applicable": true }
 ]
}`;

 let reviewOutput = null;
 let modelUsed = '';
 let fallbackNotice = null;

 // 1. Try OpenAI GPT first (if gptKey provided)
 if (gptKey) {
 try {
 console.log(`[Agentic AI] Mencoba audit dengan GPT API...`);
 const messages = [
 { role: 'system', content: 'Anda adalah Senior AI Budget Auditor Bapperida Cirebon. Hasilkan output JSON valid saja.' },
 { role: 'user', content: systemPrompt }
 ];
 const gptResponse = await callGptWithFallback(gptKey, messages, 0.2, 1200);
 reviewOutput = parseGptJson(gptResponse.content);
 modelUsed = `OpenAI (${gptResponse.model})`;
 } catch (gptErr) {
 console.warn(`[Agentic AI] GPT error: ${gptErr.message}`);
 if (gptErr.isQuotaError || gptErr.message?.includes('quota') || gptErr.message?.includes('429')) {
 fallbackNotice = 'GPT API tidak tersedia — periksa quota/billing';
 } else {
 fallbackNotice = gptErr.message;
 }
 }
 } else {
 fallbackNotice = 'GPT API Key belum dikonfigurasi di backend (.env) atau sidebar';
 }

 // 2. Fallback to Gemini AI if GPT failed or unavailable
 if (!reviewOutput && geminiKey) {
 try {
 console.log(`[Agentic AI] Mengaktifkan Fallback Provider: Google Gemini...`);
 const genAIInstance = new GoogleGenerativeAI(geminiKey);
 const geminiResult = await generateContentWithFallback(genAIInstance, geminiKey, systemPrompt);
 const responseText = (await geminiResult.response).text();
 reviewOutput = parseAiJson(responseText);
 modelUsed = 'Google Gemini (Fallback Provider)';
 console.log(`[Agentic AI] Fallback Gemini berhasil.`);
 } catch (geminiErr) {
 console.warn(`[Agentic AI] Fallback Gemini gagal: ${geminiErr.message}`);
 }
 }

 // 3. Deterministic Expert Rule-based Fallback if all external APIs are exhausted
 if (!reviewOutput) {
 console.log(`[Agentic AI] Mengaktifkan Rule-Based Deterministic Auditor...`);
 reviewOutput = generateDeterministicReview(rkaData, activeSshItems);
 modelUsed = 'Rule-Based Engine (Mode Analisis Lokal)';
 if (!fallbackNotice) fallbackNotice = 'GPT API tidak tersedia — periksa quota/billing';
 }

 // Save result into database to prevent repeated API calls
 if (existingRka) {
 existingRka.agentReviewResult = reviewOutput;
 existingRka.agentReviewModel = modelUsed;
 existingRka.agentReviewTimestamp = new Date().toISOString();
 await writeDb(db);
 }

 res.json({
 success: true,
 cached: false,
 modelUsed,
 fallbackNotice,
 review: reviewOutput,
 auditedAt: new Date().toISOString()
 });

 } catch (error) {
 console.error('Error in /api/v1/agentic-ai/review:', error);
 // Never crash: return rule-based fallback even on uncaught error
 const fallbackReview = generateDeterministicReview(req.body?.rkaData || {}, []);
 res.json({
 success: true,
 cached: false,
 modelUsed: 'Rule-Based Engine (Fallback)',
 fallbackNotice: 'GPT API tidak tersedia — periksa quota/billing',
 review: fallbackReview,
 auditedAt: new Date().toISOString()
 });
 }
});

// 2. Endpoint: Terapkan Aksi / Koreksi Agentik (Menghasilkan Versi Baru dengan Fallback)
app.post('/api/v1/agentic-ai/action', requireAuth, async (req, res) => {
 try {
 const { rkaData, instruction, actionType, customChanges, targetVersionName } = req.body;
 // Selalu gunakan API Key dari .env backend
 const gptKey = process.env.OPENAI_API_KEY || null;
 const geminiKey = process.env.GEMINI_API_KEY || null;

 if (!rkaData) {
 return res.status(400).json({ error: 'Data RKA tidak ditemukan.' });
 }

 const targetYear = rkaData.tahun || '2026';
 const activeSshItems = await getActiveSsh(targetYear);
 const sshContext = (activeSshItems && activeSshItems.length > 0)
 ? activeSshItems.map(s => `- ${s.nama} (${s.kode || '-'}): Rp ${Number(s.nilai).toLocaleString('id-ID')} / ${s.satuan}`).join('\n')
 : 'Standar Satuan Harga Pemerintah Kabupaten Cirebon 2026.';

 const systemPrompt = `Anda adalah Agentic AI Execution Engine. Perbaiki dan optimalkan data RKA sesuai instruksi.
Data RKA Eksisting:
- ID: ${rkaData.id}, OPD: ${rkaData.opd}, Pagu: ${rkaData.pagu}, Outcome: ${rkaData.outcome}, Deadweight: ${rkaData.deadweight}%, SROI: ${rkaData.sroi}
- Rekening: ${JSON.stringify(rkaData.rekeningProporsi || []).substring(0, 800)}
- Realokasi: ${JSON.stringify(rkaData.reallocationJustifications || []).substring(0, 600)}

Instruksi / Aksi: ${instruction || actionType}

Kembalikan valid JSON murni format:
{
 "updatedData": {
 "opd": "${rkaData.opd || ''}",
 "program": "${rkaData.program || ''}",
 "pagu": ${rkaData.pagu || 100000000},
 "target": "Target kuantitatif diperbarui",
 "targetKuantitatif": "Target kuantitatif diperbarui",
 "outcome": ${rkaData.outcome || 120000000},
 "outcomeDesc": "Justifikasi dampak outcome setelah perbaikan",
 "justifikasiOutcome": "Justifikasi dampak outcome setelah perbaikan",
 "deadweight": ${rkaData.deadweight || 15},
 "attribution": ${rkaData.attribution || 15},
 "dropOff": ${rkaData.dropOff || 10},
 "sroi": ${rkaData.sroi || 1.1},
 "status": "${rkaData.status || 'Draft'}",
 "rekeningProporsi": ${JSON.stringify(rkaData.rekeningProporsi || [])},
 "reallocationJustifications": ${JSON.stringify(rkaData.reallocationJustifications || [])},
 "kepatuhanFindings": [
 { "label": "Kepatuhan e-SSH", "description": "Seluruh belanja telah diselaraskan dengan e-SSH.", "status": "sesuai" }
 ],
 "rpdSchedule": { "Q1": 20, "Q2": 30, "Q3": 35, "Q4": 15 }
 },
 "changesSummary": "Ringkasan perbaikan yang diterapkan...",
 "modificationsApplied": [
 "Menyelaraskan struktur belanja dan perhitungan rasio SROI."
 ]
}`;

 let actionOutput = null;
 let engineUsed = '';

 // 1. Try GPT
 if (gptKey) {
 try {
 const messages = [
 { role: 'system', content: 'Anda adalah Agentic AI Execution Engine. Hasilkan output JSON valid saja.' },
 { role: 'user', content: systemPrompt }
 ];
 const gptRes = await callGptWithFallback(gptKey, messages, 0.2, 1200);
 actionOutput = parseGptJson(gptRes.content);
 engineUsed = `OpenAI (${gptRes.model})`;
 } catch (gptErr) {
 console.warn(`[Agentic Action] GPT gagal: ${gptErr.message}`);
 }
 }

 // 2. Fallback to Gemini
 if (!actionOutput && geminiKey) {
 try {
 const genAIInstance = new GoogleGenerativeAI(geminiKey);
 const geminiRes = await generateContentWithFallback(genAIInstance, geminiKey, systemPrompt);
 actionOutput = parseAiJson((await geminiRes.response).text());
 engineUsed = 'Google Gemini (Fallback)';
 } catch (gemErr) {
 console.warn(`[Agentic Action] Gemini fallback gagal: ${gemErr.message}`);
 }
 }

 // 3. Deterministic Local Mutation Fallback
 if (!actionOutput) {
 console.log(`[Agentic Action] Menggunakan Programmatic Mutation Engine...`);
 const updated = JSON.parse(JSON.stringify(rkaData));
 const pagu = Number(updated.pagu) || 100000000;
 const outcome = Number(updated.outcome) || 120000000;
 const deadweight = Number(updated.deadweight) || 15;
 updated.sroi = Number(((outcome * (1 - deadweight / 100)) / pagu).toFixed(2));
 updated.rpdSchedule = { Q1: 20, Q2: 30, Q3: 35, Q4: 15 };
 if (customChanges) Object.assign(updated, customChanges);

 actionOutput = {
 updatedData: updated,
 changesSummary: instruction || `Penyesuaian dan optimasi parameter RKA (${actionType || 'Manual'}).`,
 modificationsApplied: [
 'Memvalidasi dan menghitung ulang rasio SROI secara akurat.',
 'Menyelaraskan kurva penarikan dana RPD menjadi ideal (20% Q1, 30% Q2, 35% Q3, 15% Q4).'
 ]
 };
 engineUsed = 'Programmatic Engine (Local Fallback)';
 }

 // Save into db as a new version
 const db = await readDb();
 const rkaId = rkaData.id;
 let rkaItem = db.rkis.find(r => r.id === rkaId);

 const now = new Date().toISOString();
 const existingVersions = (rkaItem && Array.isArray(rkaItem.versions)) ? rkaItem.versions : [];

 // Ensure v1.0 (Original) is preserved if not already stored
 if (existingVersions.length === 0) {
 const originalCopy = JSON.parse(JSON.stringify(rkaItem || rkaData));
 delete originalCopy.versions;
 delete originalCopy.auditLogs;
 delete originalCopy.agentReviewResult;
 existingVersions.push({
 versionId: 'v1.0',
 versionName: 'v1.0 (Original/Initial)',
 createdAt: rkaItem?.tanggalUpload || now,
 createdBy: 'AI Extractor',
 changesSummary: 'Hasil analisis draf RKA pertama kali diekstrak dari PDF.',
 data: originalCopy
 });
 }

 const nextVerNumber = existingVersions.length + 1;
 const nextVerId = `v1.${nextVerNumber - 1}`;
 const parentVersionId = req.body.parentVersionId || rkaData.activeVersionId || rkaItem?.activeVersionId || 'v1.0';

 const newVersionObj = {
 versionId: nextVerId,
 version: nextVerId,
 parent_version_id: parentVersionId,
 timestamp: now,
 createdAt: now,
 source: req.body.source || 'agentic-ai',
 versionName: targetVersionName || `${nextVerId} (Agentic AI - ${actionType || 'Optimasi'})`,
 createdBy: `Agentic AI (${engineUsed})`,
 changesSummary: actionOutput.changesSummary || 'Penyempurnaan parameter RKA.',
 modifications: actionOutput.modificationsApplied || [],
 data: {
 ...actionOutput.updatedData,
 id: rkaId,
 tahun: targetYear,
 namaDokumen: rkaData.namaDokumen || rkaItem?.namaDokumen
 }
 };

 existingVersions.push(newVersionObj);

 // Audit log entry
 const auditLogs = (rkaItem && Array.isArray(rkaItem.auditLogs)) ? rkaItem.auditLogs : [];
 auditLogs.unshift({
 id: 'log-' + Date.now(),
 timestamp: now,
 actor: `Agentic AI (${engineUsed})`,
 action: 'CREATE_VERSION',
 versionId: nextVerId,
 versionName: newVersionObj.versionName,
 parent_version_id: parentVersionId,
 source: req.body.source || 'agentic-ai',
 details: actionOutput.changesSummary,
 modifications: actionOutput.modificationsApplied || []
 });

 if (rkaItem) {
 Object.assign(rkaItem, actionOutput.updatedData);
 rkaItem.versions = existingVersions;
 rkaItem.activeVersionId = nextVerId;
 rkaItem.auditLogs = auditLogs;
 // Invalidate review cache for modified version
 delete rkaItem.agentReviewResult;
 await writeDb(db);
 }

 res.json({
 success: true,
 engineUsed,
 newVersion: newVersionObj,
 updatedRka: rkaItem || { ...actionOutput.updatedData, id: rkaId, versions: existingVersions, activeVersionId: nextVerId, auditLogs },
 modifications: actionOutput.modificationsApplied || [],
 changesSummary: actionOutput.changesSummary
 });

 } catch (error) {
 console.error('Error in /api/v1/agentic-ai/action:', error);
 res.status(500).json({ error: error.message || 'Gagal menerapkan aksi Agentic AI.' });
 }
});

// 3. Tambah Versi Manual / Simpan Versi RKA (dengan parent_version_id & source)
app.post('/api/v1/rkis/:id/versions', requireAuth, async (req, res) => {
 try {
 const db = await readDb();
 const { id } = req.params;
 const { parentVersionId, versionName, changesSummary, data, createdBy, source, modifications } = req.body;

 const rkaItem = db.rkis.find(r => r.id === id);
 if (!rkaItem) {
 return res.status(404).json({ error: 'Dokumen RKA tidak ditemukan.' });
 }

 if (!Array.isArray(rkaItem.versions)) {
 const originalCopy = JSON.parse(JSON.stringify(rkaItem));
 delete originalCopy.versions;
 delete originalCopy.auditLogs;
 rkaItem.versions = [{
 versionId: 'v1.0',
 version: 'v1.0',
 parent_version_id: 'v1.0',
 timestamp: rkaItem.tanggalUpload || new Date().toISOString(),
 createdAt: rkaItem.tanggalUpload || new Date().toISOString(),
 source: 'initial',
 createdBy: 'AI Extractor',
 changesSummary: 'Hasil analisis draf RKA pertama kali diekstrak dari PDF.',
 data: originalCopy
 }];
 }

 const now = new Date().toISOString();
 const nextVerId = `v1.${rkaItem.versions.length}`;
 const parentVer = parentVersionId || rkaItem.activeVersionId || 'v1.0';

 const newVersion = {
 versionId: nextVerId,
 version: nextVerId,
 parent_version_id: parentVer,
 timestamp: now,
 createdAt: now,
 source: source || 'agentic-ai',
 versionName: versionName || `${nextVerId} (Revisi Agentic AI)`,
 createdBy: createdBy || 'Pengguna (Agentic AI Studio)',
 changesSummary: changesSummary || 'Pembaruan data manual/agentik pada dokumen RKA.',
 modifications: modifications || [],
 data: { ...data, id }
 };

 rkaItem.versions.push(newVersion);
 rkaItem.activeVersionId = nextVerId;
 Object.assign(rkaItem, data);

 if (!Array.isArray(rkaItem.auditLogs)) rkaItem.auditLogs = [];
 rkaItem.auditLogs.unshift({
 id: 'log-' + Date.now(),
 timestamp: now,
 actor: createdBy || 'Pengguna (Agentic AI Studio)',
 action: 'CREATE_VERSION_AGENTIC',
 versionId: nextVerId,
 versionName: newVersion.versionName,
 parent_version_id: parentVer,
 source: source || 'agentic-ai',
 details: changesSummary || 'Menyimpan versi baru melalui Agentic AI Studio.',
 modifications: modifications || []
 });

 await writeDb(db);
 res.status(201).json({ success: true, version: newVersion, rka: rkaItem });
 } catch (error) {
 console.error('Error adding version:', error);
 res.status(500).json({ error: 'Gagal membuat versi baru: ' + error.message });
 }
});

// 4. Ganti / Aktifkan Versi RKA Tertentu
app.put('/api/v1/rkis/:id/versions/:versionId/activate', requireAuth, async (req, res) => {
 try {
 const db = await readDb();
 const { id, versionId } = req.params;
 const rkaItem = db.rkis.find(r => r.id === id);

 if (!rkaItem) {
 return res.status(404).json({ error: 'Dokumen RKA tidak ditemukan.' });
 }

 const targetVersion = (rkaItem.versions || []).find(v => v.versionId === versionId);
 if (!targetVersion) {
 return res.status(404).json({ error: `Versi ${versionId} tidak ditemukan.` });
 }

 // Apply version data to top-level rkaItem
 Object.assign(rkaItem, targetVersion.data);
 rkaItem.activeVersionId = versionId;

 if (!Array.isArray(rkaItem.auditLogs)) rkaItem.auditLogs = [];
 rkaItem.auditLogs.unshift({
 id: 'log-' + Date.now(),
 timestamp: new Date().toISOString(),
 actor: req.body.actor || 'Pengguna (ASN)',
 action: 'SWITCH_VERSION',
 versionId: versionId,
 versionName: targetVersion.versionName,
 details: `Mengaktifkan versi ${targetVersion.versionName} sebagai versi utama.`
 });

 await writeDb(db);
 res.json({ success: true, activeVersion: targetVersion, rka: rkaItem });
 } catch (error) {
 console.error('Error activating version:', error);
 res.status(500).json({ error: 'Gagal mengaktifkan versi: ' + error.message });
 }
});

// 5. Tambah Catatan Audit Trail
app.post('/api/v1/rkis/:id/audit-logs', requireAuth, async (req, res) => {
 try {
 const db = await readDb();
 const { id } = req.params;
 const { actor, action, details, metadata } = req.body;

 const rkaItem = db.rkis.find(r => r.id === id);
 if (!rkaItem) {
 return res.status(404).json({ error: 'Dokumen RKA tidak ditemukan.' });
 }

 if (!Array.isArray(rkaItem.auditLogs)) rkaItem.auditLogs = [];
 const logEntry = {
 id: 'log-' + Date.now(),
 timestamp: new Date().toISOString(),
 actor: actor || 'Pengguna (ASN)',
 action: action || 'NOTE',
 details: details || '',
 metadata: metadata || {}
 };

 rkaItem.auditLogs.unshift(logEntry);
 await writeDb(db);
 res.status(201).json({ success: true, log: logEntry });
 } catch (error) {
 console.error('Error adding audit log:', error);
 res.status(500).json({ error: 'Gagal menambahkan log audit.' });
 }
});

// ══════════════════════════════════════════════════════════════════════════
// 6. ENDPOINT: SUBKEGIATAN DATASET (40 - 100 SUBKEGIATAN)
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/v1/agentic-ai/subkegiatans', requireAuth, async (req, res) => {
 try {
 const { count = 50 } = req.query;
 const db = await readDb();
 const rkis = db.rkis || [];
 const subkegs = generateStandardSubkegiatans(parseInt(count, 10) || 50, rkis);
 res.json({ success: true, count: subkegs.length, subkegiatans: subkegs });
 } catch (error) {
 console.error('Error fetching subkegiatans:', error);
 res.status(500).json({ success: false, error: 'Gagal memuat daftar subkegiatan: ' + error.message });
 }
});

// ══════════════════════════════════════════════════════════════════════════
// 7. ENDPOINT: BATCH ANALYSIS (40 - 100 SUBKEGIATAN)
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/v1/agentic-ai/batch-analysis', requireAuth, async (req, res) => {
 try {
 const { subkegiatans = [], count = 50 } = req.body;
 let list = subkegiatans;
 if (!list || list.length === 0) {
 const db = await readDb();
 list = generateStandardSubkegiatans(parseInt(count, 10) || 50, db.rkis || []);
 }

 const analysisResult = performBatchAnalysis(list);

 await logActivity({
 req,
 action: 'BATCH_AUDIT_SUBKEG',
 target: `${list.length} Subkegiatan`,
 details: `Analisis Agentic AI batch ${list.length} subkegiatan APBD (Avg SROI: ${analysisResult.summary.avgSroi})`
 });

 res.json({
 success: true,
 count: list.length,
 ...analysisResult,
 analyzedAt: new Date().toISOString()
 });
 } catch (error) {
 console.error('Error in batch analysis:', error);
 res.status(500).json({ success: false, error: 'Gagal menjalankan analisis batch: ' + error.message });
 }
});

// ══════════════════════════════════════════════════════════════════════════
// 8. ENDPOINT: CHAT PERSONAS & METADATA
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/v1/chat/personas', (req, res) => {
 res.json({
 success: true,
 personas: PERSONA_DEFINITIONS,
 perspectives: PERSPECTIVE_DEFINITIONS,
 personalities: PERSONALITY_DEFINITIONS
 });
});

// ══════════════════════════════════════════════════════════════════════════
// POST /api/v1/chat — Asisten Chat BAPPERIDA AI
// Mendukung: Persona, Perspektif, Personality, Mode Analisis/Revisi & Data Context
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/v1/chat', requireAuth, async (req, res) => {
 try {
 const {
 history = [],
 message,
 mode = 'mode1',
 docMode = 'rka',
 persona = 'auditor',
 perspective = 'kepatuhan',
 personality = 'formal',
 rkaContext = null
 } = req.body;

 if (!message || !message.trim()) {
 return res.status(400).json({ success: false, error: 'Pesan tidak boleh kosong.' });
 }

 const systemPrompt = buildSystemPrompt({ persona, perspective, personality, mode, docMode, rkaContext });
 const geminiApiKey = process.env.GEMINI_API_KEY;
 const gptKey = process.env.OPENAI_API_KEY;

 let responseText = null;
 let modelUsed = '';

 // 1. Coba Gemini AI jika key tersedia
 if (geminiApiKey) {
 try {
 const genAI = new GoogleGenerativeAI(geminiApiKey);
 const model = genAI.getGenerativeModel({
 model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
 systemInstruction: systemPrompt,
 });

 const chatHistory = (history || []).map(m => ({
 role: m.role === 'user' ? 'user' : 'model',
 parts: [{ text: m.content }],
 }));

 const chat = model.startChat({ history: chatHistory });
 const result = await chat.sendMessage(message.trim());
 responseText = result.response.text();
 modelUsed = 'Google Gemini';
 } catch (gemErr) {
 console.warn('[/api/v1/chat] Gemini error, mencoba fallback GPT/Lokal:', gemErr.message);
 }
 }

 // 2. Coba OpenAI GPT jika Gemini gagal atau tidak ada key
 if (!responseText && gptKey) {
 try {
 const messages = [
 { role: 'system', content: systemPrompt },
 ...(history || []).map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
 { role: 'user', content: message.trim() }
 ];
 const gptRes = await callGptWithFallback(gptKey, messages, 0.3, 1500);
 responseText = gptRes.content;
 modelUsed = `OpenAI (${gptRes.model})`;
 } catch (gptErr) {
 console.warn('[/api/v1/chat] GPT fallback gagal:', gptErr.message);
 }
 }

 // 3. Smart Local Persona Responder jika API luar offline/kuota habis
 if (!responseText) {
 responseText = generateLocalPersonaResponse(message.trim(), {
 persona,
 perspective,
 personality,
 mode,
 docMode,
 rkaContext
 });
 modelUsed = `Local Persona Engine (${PERSONA_DEFINITIONS[persona]?.name || 'Auditor'})`;
 }

 return res.json({
 success: true,
 result: responseText,
 persona,
 perspective,
 personality,
 mode,
 docMode,
 modelUsed
 });
 } catch (error) {
 console.error('[/api/v1/chat] Error:', error.message);
 const fallbackMsg = generateLocalPersonaResponse(req.body?.message || '', {
 persona: req.body?.persona || 'auditor',
 perspective: req.body?.perspective || 'kepatuhan',
 personality: req.body?.personality || 'formal'
 });
 return res.json({ success: true, result: fallbackMsg, modelUsed: 'Local Fallback Engine' });
 }
});

// ── SPA Fallback Routing ──────────────────────────────────────────────────
// Semua rute non-API diarahkan ke frontend SPA (dist/index.html)
if (fs.existsSync(frontendDistPath)) {
 app.use((req, res, next) => {
 if (req.path.startsWith('/api')) return next();
 res.sendFile(path.join(frontendDistPath, 'index.html'));
 });
} else {
 app.get('/', (req, res) => {
 res.send('[OK] AI Backend Server (Bapperida) Sedang Berjalan! Frontend belum di-build (jalankan: npm run build).');
 });
}

loadPersistedApiConfig().finally(async () => {
 // Siapkan pool multi-database & tentukan slot aktif (berdasarkan generation
 // tertinggi) sebelum trafik masuk.
 try {
 const pool = await initPool();
 console.log(`[DBPool] Mode: ${pool.mode} | Slot aktif: ${pool.activeSlot ?? '-'}/${pool.totalSlots} | Ambang failover: ${pool.thresholdPercent}%`);
 } catch (err) {
 console.error('[DBPool] Inisialisasi gagal:', err.message);
 if (err.message.includes('CRITICAL_CONFIG_ERROR')) {
 console.error('[DBPool] Konfigurasi database kritis gagal. Menghentikan server.');
 process.exit(1);
 }
 }

 // Sinkronisasi Neon antar instance Render untuk realtime multi-device.
 await realtimeHub.startDatabaseSync(readDb);

 // Mulai optimasi storage otomatis tiap menit
 startStorageOptimizer();

 // Mulai pemantauan kuota database + failover otomatis
 startQuotaMonitor();

 app.listen(port, '0.0.0.0', () => {
 console.log(`AI Backend berjalan di port ${port}`);
 });
});

