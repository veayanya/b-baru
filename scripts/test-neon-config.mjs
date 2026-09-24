import assert from 'node:assert/strict';
import fs from 'node:fs';

const N = 1000;
const file = 'data/test-config-1000.json';
const urls = Array.from({ length: N }, (_, i) =>
  `postgresql://user:password@ep-config${i + 1}.pooler.aws.neon.tech/neondb?sslmode=require`
);

fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(file, JSON.stringify(urls), 'utf8');
process.env.DATABASE_URLS_FILE = file;
process.env.DB_MAX_SLOTS = String(N);
process.env.DB_QUOTA_BYTES = '5000000000';

const pool = await import('../lib/dbPool.js');
const configured = pool.readSlotConfig();

assert.equal(pool.MAX_DATABASES, 1000);
assert.equal(pool.MAX_SLOTS, 1000);
assert.equal(pool.TARGET_STORAGE_BYTES, 5000000000);
assert.equal(pool.QUOTA_BYTES, 5000000000);
assert.equal(configured.length, 1000);

console.log('OK: 1000 slot config, 5000 MB decimal quota, and 1000 URL file validated.');
fs.rmSync(file, { force: true });