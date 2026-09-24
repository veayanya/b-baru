#!/usr/bin/env node
// scripts/db-failover.js
// ============================================================================
// CLI untuk memantau & memindahkan database secara manual.
//
// node scripts/db-failover.js status → tampilkan semua slot & pemakaian
// node scripts/db-failover.js check → cek kuota; pindah bila melewati ambang
// node scripts/db-failover.js migrate → paksa pindah ke slot berikutnya
// node scripts/db-failover.js migrate 3 → paksa pindah ke slot nomor 3
// node scripts/db-failover.js history → riwayat migrasi
//
// Cocok dipasang sebagai Cron Job di Render (mis. tiap 6 jam: `check`).
// ============================================================================

import 'dotenv/config';
import {
 initPool,
 getPoolStatus,
 rotateToNextSlot,
 checkQuotaAndRotate,
 getMigrationHistory,
 formatBytes
} from '../lib/dbPool.js';

const cmd = (process.argv[2] || 'status').toLowerCase();
const arg = process.argv[3];

function bar(percent) {
 const width = 24;
 const filled = Math.min(width, Math.round((percent / 100) * width));
 return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${percent.toFixed(1)}%`;
}

async function printStatus(probeAll = true) {
 const status = await getPoolStatus({ probeAll });

 console.log('');
 console.log('══ STATUS MULTI-DATABASE ═══════════════════════════════════════');
 console.log(`Mode : ${status.mode}`);
 console.log(`Slot terdaftar : ${status.totalSlots} / ${status.maxSlots}`);
 console.log(`Slot aktif : ${status.activeSlot ?? '-'}`);
 console.log(`Generation : ${status.generation}`);
 console.log(`Kuota per DB : ${status.quotaLabel}`);
 console.log(`Ambang failover : ${status.thresholdPercent}%`);
 console.log('────────────────────────────────────────────────────────────────');

 for (const s of status.slots) {
 const mark = s.active ? '▶ AKTIF ' : ' siaga ';
 const health = s.healthy === false ? '[GAGAL] error' : s.healthy ? '[OK] sehat' : '? belum dicek';
 console.log(`${mark}Slot ${s.slot} · ${s.label} · ${health}`);
 console.log(` ${s.connection}`);
 if (typeof s.usagePercent === 'number') {
 console.log(` ${bar(s.usagePercent)} ${s.usedLabel} · ${s.rowCount} baris`);
 }
 if (s.lastError) console.log(` ! ${s.lastError}`);
 }
 console.log('════════════════════════════════════════════════════════════════');
 console.log('');
}

try {
 await initPool();

 switch (cmd) {
 case 'status':
 await printStatus(true);
 break;

 case 'check': {
 const result = await checkQuotaAndRotate();
 if (result.skipped) {
 console.log(`Dilewati: ${result.skipped}`);
 } else if (result.rotated) {
 console.log(`[OK] Failover dijalankan → slot ${result.record.toSlot} (${result.record.toHost})`);
 console.log(` ${result.record.keys} key · ${result.record.durationMs} ms · checksum ${result.record.checksum.slice(0, 12)}…`);
 } else if (result.usage) {
 console.log(`[OK] Aman — pemakaian ${(result.usage.ratio * 100).toFixed(1)}% (${formatBytes(result.usage.bytes)}). Belum perlu pindah.`);
 } else if (result.error) {
 console.error(`[GAGAL] ${result.error}`);
 process.exitCode = 1;
 }
 break;
 }

 case 'migrate': {
 const targetIndex = arg ? Number(arg) - 1 : null;
 const record = await rotateToNextSlot(
 arg ? `Manual CLI ke slot ${arg}` : 'Manual CLI',
 Number.isInteger(targetIndex) ? targetIndex : null
 );
 console.log(`[OK] Migrasi selesai: slot ${record.fromSlot} → slot ${record.toSlot} (${record.toHost})`);
 console.log(` ${record.keys} key · ${record.durationMs} ms`);
 console.log(` Verifikasi: ${record.verification.ok ? 'COCOK' : 'TIDAK COCOK'} (${record.verification.targetKeys} key di tujuan)`);
 if (record.backupFile) console.log(` Cadangan lokal: data/migrations/${record.backupFile}`);
 await printStatus(false);
 break;
 }

 case 'history': {
 const records = await getMigrationHistory();
 if (records.length === 0) {
 console.log('Belum ada riwayat migrasi.');
 break;
 }
 for (const r of records) {
 console.log(`• ${r.finishedAt} — slot ${r.fromSlot} → ${r.toSlot} · ${r.keys} key · ${r.durationMs} ms`);
 console.log(` alasan: ${r.reason}`);
 }
 break;
 }

 default:
 console.log('Perintah tidak dikenal. Gunakan: status | check | migrate [slot] | history');
 process.exitCode = 1;
 }
} catch (err) {
 console.error('[GAGAL] Gagal:', err.message);
 process.exitCode = 1;
}

process.exit(process.exitCode || 0);
