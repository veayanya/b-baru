// Uji end-to-end multi-database failover memakai driver mock in-memory.
// Jalankan: node scripts/test-failover.mjs
process.env.DB_QUOTA_BYTES = String(9 * 1024 * 1024);   // kuota kecil agar cepat penuh
process.env.DB_QUOTA_THRESHOLD = '0.85';
for (let i = 1; i <= 10; i++) {
  const name = i === 1 ? 'DATABASE_URL' : `DATABASE_URL_${i}`;
  process.env[name] = `postgresql://u:p@ep-db${i}-pooler.ap-southeast-2.aws.neon.tech/neondb?sslmode=require`;
}

const { getStore, setStore, getAllStoreData, checkDbConnection } = await import('../lib/db.js');
const pool = await import('../lib/dbPool.js');
const { __stores } = await import('@neondatabase/serverless');

const ok = (c, m) => console.log(`${c ? '  ✔' : '  ✖'} ${m}`);

console.log('\n=== 1. Inisialisasi pool ===');
const st0 = await pool.initPool();
console.log(`  mode=${st0.mode} slots=${st0.totalSlots} aktif=${st0.activeSlot} kuota=${st0.quotaLabel} ambang=${st0.thresholdPercent}%`);
ok(st0.totalSlots === 10, 'terdaftar 10 slot (maksimum)');
ok(st0.activeSlot === 1, 'slot aktif awal = 1');

console.log('\n=== 2. Tulis data & baca kembali ===');
await setStore('main_db', { rkis: [{ id: 'RKA-1', nama: 'Dokumen awal' }] });
await setStore('users_db', { users: [{ id: 'u1', username: 'admin' }] });
const read = await getStore('main_db');
ok(read?.rkis?.[0]?.id === 'RKA-1', 'data terbaca dari slot aktif');
ok(String(await checkDbConnection()).length > 0, 'health check koneksi berhasil');

console.log('\n=== 3. Isi database sampai melewati ambang 85% ===');
const blob = 'x'.repeat(200 * 1024);
for (let i = 0; i < 40; i++) await setStore(`arsip_${i}`, { i, blob });
let usage = await pool.measureUsage(pool.getActiveSlotIndex(), { force: true });
console.log(`  pemakaian slot aktif: ${(usage.ratio * 100).toFixed(1)}% (${pool.formatBytes(usage.bytes)})`);

console.log('\n=== 4. Monitor kuota → failover otomatis ===');
const result = await pool.checkQuotaAndRotate();
ok(result.rotated === true, 'failover otomatis terpicu oleh ambang kuota');
if (result.record) {
  const r = result.record;
  console.log(`  slot ${r.fromSlot} → slot ${r.toSlot} | ${r.keys} key | ${r.durationMs} ms`);
  ok(r.verification.ok, `verifikasi checksum cocok (${r.verification.targetKeys} key di tujuan)`);
  ok(!!r.backupFile, `cadangan lokal dibuat: data/migrations/${r.backupFile}`);
}

console.log('\n=== 5. Data utuh setelah pindah ===');
const after = await getStore('main_db');
ok(after?.rkis?.[0]?.nama === 'Dokumen awal', 'main_db identik di database baru');
const all = await getAllStoreData();
ok(Object.keys(all).length >= 40, `semua key ikut pindah (${Object.keys(all).length} key)`);
ok(!('__db_pool_state' in all), 'key internal pool tidak bocor ke file backup');

console.log('\n=== 6. Database sumber mati mendadak → failover saat penulisan ===');
const activeIdx = pool.getActiveSlotIndex();
const hostAktif = `ep-db${activeIdx + 1}-pooler.ap-southeast-2.aws.neon.tech/neondb`;
__stores.get(hostAktif).capBytes = 1; // simulasi: penulisan berikutnya ditolak kuota
const slotSebelum = pool.getActiveSlotIndex();
await setStore('main_db', { rkis: [{ id: 'RKA-2', nama: 'Ditulis saat limit' }] });
const slotSesudah = pool.getActiveSlotIndex();
ok(slotSesudah !== slotSebelum, `penulisan dialihkan otomatis: slot ${slotSebelum + 1} → slot ${slotSesudah + 1}`);
const recovered = await getStore('main_db');
ok(recovered?.rkis?.[0]?.id === 'RKA-2', 'penulisan yang sempat gagal berhasil diulang di database baru');

console.log('\n=== 7. Restart server → slot aktif tetap konsisten ===');
const before = pool.getActiveSlotIndex();
const st2 = await pool.initPool({ force: true });
ok(pool.getActiveSlotIndex() === before, `setelah re-init tetap di slot ${st2.activeSlot} (generation ${st2.generation})`);

console.log('\n=== 8. Riwayat migrasi ===');
const hist = await pool.getMigrationHistory();
ok(hist.length >= 2, `tercatat ${hist.length} migrasi`);
hist.forEach(h => console.log(`  • slot ${h.fromSlot} → ${h.toSlot} · ${h.keys} key · ${h.reason}`));

console.log('\n=== 9. Password tersamarkan ===');
const status = await pool.getPoolStatus({ probeAll: true });
ok(status.slots.every(s => s.connection.includes(':****@')), 'connection string ditampilkan tanpa password');
console.log('  contoh:', status.slots[0].connection);

console.log('\n=== 10. Status akhir seluruh slot ===');
status.slots.forEach(s =>
  console.log(`  slot ${s.slot} ${s.active ? '◀ AKTIF' : '  siaga'} | ${s.usedLabel ?? '-'} (${s.usagePercent ?? '-'}%) | ${s.rowCount ?? '-'} baris`)
);

console.log('\nSELESAI.\n');
process.exit(0);
