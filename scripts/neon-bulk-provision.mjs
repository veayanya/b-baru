#!/usr/bin/env node
// scripts/neon-bulk-provision.mjs
// ============================================================================
// Membuat banyak project Neon PostgreSQL sekaligus lewat Neon Management API,
// lalu menyimpan seluruh connection string (pooled) ke sebuah file yang siap
// dipakai oleh DATABASE_URLS_FILE (lihat lib/dbPool.js & MULTI_DATABASE.md).
//
// PENTING — jalankan skrip ini di KOMPUTERMU SENDIRI atau CI, BUKAN dari
// sandbox Claude: API Neon (console.neon.tech) tidak bisa diakses dari sini.
//
// Persiapan:
//   1. Buat API key di https://console.neon.tech/app/settings/api-keys
//   2. export NEON_API_KEY="napi_xxx..."
//   3. node scripts/neon-bulk-provision.mjs --count 1000 --region ap-southeast-2 \
//        --prefix sintra-rka --out data/neon-databases.json
//
// Batasan akun Neon (per Sep 2026): Free = 100 project, Launch = 100 project,
// Scale = 1.000 project (bisa ditambah atas permintaan). Skrip ini akan
// BERHENTI dengan pesan jelas jika API mengembalikan error kuota — tidak
// mencoba mengakali batas akunmu.
//
// Aman diulang (idempotent secara nama): project dengan nama yang sudah ada
// dilewati, bukan dibuat dobel.
// ============================================================================

const API_BASE = 'https://console.neon.tech/api/v2';
const MAX_PROJECTS = 1000;
const TARGET_STORAGE_MB = 5000;
const TARGET_STORAGE_BYTES = TARGET_STORAGE_MB * 1_000_000;
const MAX_CONCURRENCY = 10;

function parseArgs(argv) {
  const args = { count: 10, region: 'aws-ap-southeast-2', prefix: 'app', out: 'data/neon-databases.json', concurrency: 5, dbName: 'neondb' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--count') args.count = Number(argv[++i]);
    else if (a === '--region') args.region = argv[++i];
    else if (a === '--prefix') args.prefix = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (a === '--db-name') args.dbName = argv[++i];
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return args;
}

function printHelp() {
  console.log(`
Penggunaan:
  node scripts/neon-bulk-provision.mjs [opsi]

Opsi:
  --count <n>         Jumlah project yang ingin dibuat (default: 10, maksimum: ${MAX_PROJECTS})
  --region <id>        Region Neon, mis. aws-ap-southeast-2, aws-us-east-2 (default: aws-ap-southeast-2)
  --prefix <nama>      Awalan nama project, mis. "sintra-rka" → sintra-rka-001 (default: app)
  --db-name <nama>     Nama database di dalam tiap project (default: neondb)
  --out <path>         File output JSON berisi daftar connection string (default: data/neon-databases.json)
  --concurrency <n>    Jumlah request paralel ke API Neon (default: 5, maksimum: ${MAX_CONCURRENCY})

Target quota Neon: ${TARGET_STORAGE_MB} MB decimal = ${TARGET_STORAGE_BYTES} bytes per project/branch.
Jika plan/API Neon menolak quota ini, project tetap dicatat dengan status application_only;
DB_QUOTA_BYTES tetap hanya threshold aplikasi dan tidak mengubah billing/plan Neon.

Butuh env NEON_API_KEY (buat di console.neon.tech/app/settings/api-keys).
`);
}

async function neonFetch(apiKey, path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const msg = body?.message || body?.error || text || res.statusText;
    const err = new Error(`Neon API ${res.status}: ${msg}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function isQuotaExceeded(err) {
  const msg = (err.message || '').toLowerCase();
  return err.status === 403 || err.status === 422 ||
    msg.includes('limit') || msg.includes('quota') || msg.includes('exceeded');
}

async function listExistingProjects(apiKey) {
  const map = new Map(); // name → project
  let cursor;
  do {
    const qs = new URLSearchParams({ limit: '400', ...(cursor ? { cursor } : {}) });
    const page = await neonFetch(apiKey, `/projects?${qs}`);
    for (const p of page.projects || []) map.set(p.name, p);
    cursor = page.pagination?.cursor && page.projects?.length === 400 ? page.pagination.cursor : null;
  } while (cursor);
  return map;
}

/** Ambil pooled connection string (role default + database) dari sebuah project. */
async function getPooledConnectionUri(apiKey, projectId, dbName) {
  const details = await neonFetch(apiKey, `/projects/${projectId}/connection_uri?database_name=${encodeURIComponent(dbName)}&pooled=true`);
  return details.uri;
}

async function setProjectStorageQuota(apiKey, projectId) {
  try {
    await neonFetch(apiKey, `/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        project: {
          settings: {
            quota: { logical_size_bytes: TARGET_STORAGE_BYTES }
          }
        }
      })
    });
    
    // READ-BACK VERIFICATION
    const readBack = await neonFetch(apiKey, `/projects/${projectId}`);
    const project = readBack.project || {};
    
    const sizeLimit1 = Number(project.branch_logical_size_limit_bytes || 0);
    const sizeLimit2 = Number(project.settings?.quota?.logical_size_bytes || 0);
    const actualBytes = sizeLimit1 || sizeLimit2;
    
    return {
      applied: actualBytes === TARGET_STORAGE_BYTES,
      actualBytes: actualBytes || null,
      error: actualBytes === TARGET_STORAGE_BYTES ? null : 'Neon API read-back tidak mengonfirmasi kuota 5 GB (hanya mendukung metadata/ditolak oleh plan).'
    };
  } catch (err) {
    return { applied: false, actualBytes: null, error: err.message };
  }
}

async function ensureDatabase(apiKey, projectId, branchId, dbName, ownerName) {
  try {
    await neonFetch(apiKey, `/projects/${projectId}/branches/${branchId}/databases`, {
      method: 'POST',
      body: JSON.stringify({ database: { name: dbName, owner_name: ownerName } })
    });
  } catch (err) {
    if (!/already exists/i.test(err.message)) throw err;
  }
}

async function createProject(apiKey, name, region, dbName) {
  const created = await neonFetch(apiKey, '/projects', {
    method: 'POST',
    body: JSON.stringify({
      project: {
        name,
        region_id: region,
        pg_version: 16,
        settings: {
          quota: { logical_size_bytes: TARGET_STORAGE_BYTES }
        }
      }
    })
  });

  const project = created.project;
  const branch = created.branches?.[0];
  const role = created.roles?.[0];
  const defaultDb = created.databases?.[0];

  let dbToUse = defaultDb?.name;
  if (dbName && dbName !== defaultDb?.name) {
    await ensureDatabase(apiKey, project.id, branch.id, dbName, role.name);
    dbToUse = dbName;
  }

  const quota = await setProjectStorageQuota(apiKey, project.id);
  const uri = await getPooledConnectionUri(apiKey, project.id, dbToUse);
  return { id: project.id, name: project.name, region, database: dbToUse, uri, quota };
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!Number.isInteger(args.count) || args.count < 1) {
    console.error('❌ --count harus angka bulat positif.');
    process.exit(1);
  }
  if (args.count > MAX_PROJECTS) {
    console.error(`❌ --count tidak boleh lebih dari ${MAX_PROJECTS} project.`);
    process.exit(1);
  }

  const apiKey = process.env.NEON_API_KEY;
  if (!apiKey) {
    console.error('❌ Env NEON_API_KEY belum diset. Buat di https://console.neon.tech/app/settings/api-keys lalu:\n   export NEON_API_KEY="napi_..."');
    process.exit(1);
  }

  console.log(`Memeriksa project yang sudah ada dengan prefix "${args.prefix}-"...`);
  const existing = await listExistingProjects(apiKey);

  const names = Array.from({ length: args.count }, (_, i) =>
    `${args.prefix}-${String(i + 1).padStart(String(args.count).length, '0')}`
  );

  const toCreate = names.filter(n => !existing.has(n));
  console.log(`Target: ${args.count} project. Sudah ada: ${names.length - toCreate.length}. Akan dibuat: ${toCreate.length}.`);

  const results = [];
  const fs = await import('fs');
  const path = await import('path');

  // Project yang sudah ada: ambil ulang connection string-nya (tidak dibuat lagi)
  for (const n of names) {
    if (existing.has(n)) {
      try {
        const p = existing.get(n);
        const uri = await getPooledConnectionUri(apiKey, p.id, args.dbName);
        const quota = await setProjectStorageQuota(apiKey, p.id);
        results.push({ name: n, uri, status: quota.applied ? 'existing' : 'application_only', quota });
      } catch (err) {
        console.warn(`  ⚠ Gagal ambil connection string project lama "${n}": ${err.message}`);
      }
    }
  }

  let created = 0;
  let stoppedByQuota = false;

  await runPool(toCreate, Math.min(MAX_CONCURRENCY, Math.max(1, args.concurrency)), async (name, i) => {
    if (stoppedByQuota) return;
    try {
      const proj = await createProject(apiKey, name, args.region, args.dbName);
      results.push({ name, uri: proj.uri, status: proj.quota.applied ? 'created' : 'application_only', quota: proj.quota });
      created++;
      if (created % 10 === 0 || created === toCreate.length) {
        console.log(`  ✔ ${created}/${toCreate.length} project dibuat...`);
      }
    } catch (err) {
      if (isQuotaExceeded(err)) {
        stoppedByQuota = true;
        console.error(`\n❌ Berhenti di project ke-${i + 1}: akun Neon-mu sudah mencapai batas.`);
        console.error(`   Pesan API: ${err.message}`);
        console.error(`   Upgrade plan (Launch/Scale) di https://console.neon.tech/app/billing, lalu jalankan lagi — project yang sudah dibuat tidak akan diulang.`);
      } else {
        console.warn(`  ⚠ Gagal membuat "${name}": ${err.message}`);
      }
    }
  });

  results.sort((a, b) => a.name.localeCompare(b.name));
  const urls = results.map(r => r.uri).filter(Boolean);

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(urls, null, 2), 'utf-8');

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`Selesai. ${urls.length} connection string tersimpan di: ${args.out}`);
  console.log(`  (${results.filter(r => r.status === 'created').length} baru dibuat, ${results.filter(r => r.status === 'existing').length} existing dengan quota Neon, ${results.filter(r => r.status === 'application_only').length} application-only)`);
  if (stoppedByQuota) {
    console.log(`⚠ Proses berhenti lebih awal karena limit akun Neon (lihat pesan di atas).`);
  }
  console.log('\nLangkah berikutnya di Render:');
  console.log(`  1. Upload "${args.out}" sebagai Secret File, mis. path /etc/secrets/neon-databases.json`);
  console.log(`  2. Set env: DATABASE_URLS_FILE=/etc/secrets/neon-databases.json`);
  console.log(`  3. Set env: DB_MAX_SLOTS=${urls.length} (atau lebih, untuk ruang tambah nanti)`);
  console.log('═══════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('❌ Gagal:', err.message);
  process.exit(1);
});
