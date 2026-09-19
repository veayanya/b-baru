#!/usr/bin/env node
// scripts/seed-db.js
// Jalankan SEKALI sebelum deploy pertama kali untuk inisialisasi database:
// node scripts/seed-db.js
//
// Pastikan DATABASE_URL sudah diset di environment atau file .env

import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
 console.error('[GAGAL] DATABASE_URL belum diset.');
 console.error(' Set via: export DATABASE_URL="postgresql://..." lalu jalankan ulang');
 console.error(' Atau buat file .env dengan isi: DATABASE_URL=postgresql://...');
 process.exit(1);
}

const sql = neon(connectionString);

async function main() {
 console.log('[MULAI] Memulai inisialisasi database Neon PostgreSQL...');

 await sql`
 CREATE TABLE IF NOT EXISTS app_store (
 key TEXT PRIMARY KEY,
 data JSONB NOT NULL,
 updated_at TIMESTAMPTZ DEFAULT NOW()
 )
 `;
 console.log('[OK] Tabel app_store berhasil dibuat/diverifikasi.');

 // Seed main_db (rkis + ssh_databases) jika belum ada
 const existingMain = await sql`SELECT key FROM app_store WHERE key = 'main_db'`;
 if (existingMain.length === 0) {
 await sql`INSERT INTO app_store (key, data) VALUES ('main_db', ${JSON.stringify({ rkis: [], ssh_databases: [] })})`;
 console.log('[OK] Dokumen main_db (rkis, ssh_databases) diinisialisasi kosong.');
 } else {
 console.log('ℹ main_db sudah ada, skip.');
 }

 // Seed users_db + admin default jika belum ada
 const existingUsers = await sql`SELECT key FROM app_store WHERE key = 'users_db'`;
 if (existingUsers.length === 0) {
 const salt = await bcrypt.genSalt(10);
 const hashed = await bcrypt.hash('Admin@2026!', salt);
 const usersDb = {
 users: [
 {
 id: 'admin-001',
 username: 'admin',
 password: hashed,
 role: 'admin',
 name: 'Administrator',
 email: 'admin@bapperida.go.id',
 isActive: true,
 createdAt: new Date().toISOString(),
 lastLogin: null
 }
 ]
 };
 await sql`INSERT INTO app_store (key, data) VALUES ('users_db', ${JSON.stringify(usersDb)})`;
 console.log('[OK] Admin default dibuat:');
 console.log(' username : admin');
 console.log(' password : Admin@2026!');
 console.log(' [PERINGATAN] GANTI PASSWORD SEGERA setelah login pertama!');
 } else {
 console.log('ℹ users_db sudah ada, skip seed admin.');
 }

 console.log('\n[SELESAI] Database Neon siap digunakan oleh backend Render!');
}

main().catch(err => {
 console.error('[GAGAL] Error:', err.message);
 process.exit(1);
});
