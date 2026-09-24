// Uji skala besar: 1000 slot lewat DATABASE_URLS_FILE, ukur waktu startup & failover.
import fs from 'fs';

const N = 1000;
const urls = Array.from({ length: N }, (_, i) =>
  `postgresql://u:p@ep-scale${i + 1}-pooler.ap-southeast-2.aws.neon.tech/neondb?sslmode=require`
);
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/test-1000.json', JSON.stringify(urls));

process.env.DATABASE_URLS_FILE = 'data/test-1000.json';
process.env.DB_MAX_SLOTS = String(N);
process.env.DB_QUOTA_BYTES = String(2 * 1024 * 1024); // quota test kecil, bukan target produksi
process.env.DB_PROBE_CONCURRENCY = '40';

if (process.env.RUN_NEON_SCALE_INTEGRATION !== '1') {
  const { readSlotConfig } = await import('../lib/dbPool.js');
  const configured = readSlotConfig();
  console.log(`SKIP koneksi Neon: konfigurasi ${configured.length}/${N} slot terbaca.`);
  console.log('Set RUN_NEON_SCALE_INTEGRATION=1 untuk integration test dengan URL dan kredensial Neon nyata.');
  fs.rmSync('data/test-1000.json', { force: true });
  process.exit(0);
}

const { setStore, getStore } = await import('../lib/db.js');
const pool = await import('../lib/dbPool.js');

const ok = (c, m) => console.log(`${c ? '  ✔' : '  ✖'} ${m}`);

console.log('\n=== Skala 1000 slot ===');
let t0 = Date.now();
const status = await pool.initPool();
console.log(`  initPool: ${Date.now() - t0} ms | slot terdaftar=${status.totalSlots} | aktif=${status.activeSlot}`);
ok(status.totalSlots === N, `terbaca ${status.totalSlots}/${N} slot dari file`);
ok(Date.now() - t0 < 15000, `startup tetap cepat (di bawah 15 detik) walau ${N} slot`);

await setStore('main_db', { rkis: [{ id: 'BIG-1' }] });
ok((await getStore('main_db'))?.rkis?.[0]?.id === 'BIG-1', 'baca/tulis normal di skala besar');

console.log('\n=== Isi sampai penuh, ukur waktu failover ===');
const blob = 'x'.repeat(150 * 1024);
for (let i = 0; i < 12; i++) await setStore(`d_${i}`, { i, blob });

t0 = Date.now();
const res = await pool.checkQuotaAndRotate();
const dt = Date.now() - t0;
ok(res.rotated === true, `failover terpicu (waktu total: ${dt} ms)`);
ok(dt < 10000, 'failover tetap cepat walau harus mencari di antara 1000 slot');
if (res.record) console.log(`  pindah ke slot #${res.record.toSlot}, ${res.record.keys} key, verifikasi=${res.record.verification.ok}`);

console.log('\nSELESAI.\n');
fs.rmSync('data/test-1000.json', { force: true });
process.exit(0);
