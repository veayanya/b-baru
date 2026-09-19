import crypto from 'crypto';
import { getStore, setStore } from '../lib/db.js';

// Disimpan di Neon PostgreSQL, key 'main_db' di tabel app_store.
// Key ini SAMA dengan yang dipakai server.js, supaya rkis & ssh_databases
// tetap berbagi satu "dokumen" seperti dulu berbagi satu file data/db.json.
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
}

/**
 * Return the list of SSH databases WITHOUT the heavy `items` array,
 * used for the archive/version list panel in the UI.
 */
export async function getAllSshDatabases() {
 const db = await readDb();
 return db.ssh_databases
 .map(({ items, ...meta }) => ({
 ...meta,
 total_item: meta.total_item ?? (items ? items.length : 0)
 }))
 .sort((a, b) => new Date(b.tanggalUpload) - new Date(a.tanggalUpload));
}

/**
 * Return the full record (including items) for a single SSH database.
 */
export async function getSshDatabaseById(id) {
 const db = await readDb();
 return db.ssh_databases.find(s => s.id === id) || null;
}

/**
 * Create a new SSH database version. If status is 'active', archive any
 * other database of the same tahun so only one stays active per year.
 */
export async function createSshDatabase(payload) {
 const db = await readDb();

 const newEntry = {
 id: crypto.randomUUID(),
 tahun: String(payload.tahun || '').trim(),
 versi: payload.versi || 'v1.0',
 filename: payload.filename || 'ssh-manual-upload.pdf',
 total_item: payload.total_item ?? (payload.items ? payload.items.length : 0),
 status: payload.status || 'active',
 tanggalUpload: new Date().toISOString(),
 items: Array.isArray(payload.items) ? payload.items : []
 };

 if (newEntry.status === 'active') {
 db.ssh_databases.forEach(s => {
 if (s.tahun === newEntry.tahun) {
 s.status = 'archived';
 }
 });
 }

 db.ssh_databases.unshift(newEntry);
 await writeDb(db);
 return newEntry;
}

/**
 * Update the status of an SSH database (e.g., set to 'active' and archive others for that year).
 */
export async function updateSshDatabaseStatus(id, status) {
 const db = await readDb();
 const target = db.ssh_databases.find(s => s.id === id);
 if (!target) return null;

 if (status === 'active') {
 db.ssh_databases.forEach(s => {
 if (s.tahun === target.tahun) {
 s.status = 'archived';
 }
 });
 }
 target.status = status;
 await writeDb(db);
 return target;
}

/**
 * Delete an SSH database version by id.
 */
export async function deleteSshDatabase(id) {
 const db = await readDb();
 const idx = db.ssh_databases.findIndex(s => s.id === id);
 if (idx === -1) return false;
 db.ssh_databases.splice(idx, 1);
 await writeDb(db);
 return true;
}

/**
 * Get the items array of the currently active SSH database for a given tahun.
 * Used by /api/v1/evaluate to ground the AI's price validation.
 */
export async function getActiveSsh(tahun) {
 if (!tahun) return [];
 const db = await readDb();
 const target = String(tahun).trim();
 const active = db.ssh_databases.find(
 s => String(s.tahun).trim() === target && s.status === 'active'
 );
 return active && Array.isArray(active.items) ? active.items : [];
}
