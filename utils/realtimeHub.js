// utils/realtimeHub.js
// SSE hub + cross-instance database change detection.
// Dengan adaptive polling: hemat query saat tidak ada klien terhubung.

const POLL_INTERVAL_ACTIVE = 1500; // 1.5 detik saat ada klien SSE
const POLL_INTERVAL_IDLE = 30000; // 30 detik saat tidak ada klien (hemat ~95% query)

class RealtimeHub {
 constructor() {
 this.clients = new Map();
 this.lastRkiState = new Map();
 this.dbSyncStarted = false;
 this.heartbeatTimer = null;
 this.dbSyncTimer = null;
 this._readDbFn = null;
 this._currentPollInterval = POLL_INTERVAL_ACTIVE;
 this.startHeartbeat();
 }

 addClient(clientId, user, res) {
 // Render/proxy/load-balancer friendly SSE headers.
 res.writeHead(200, {
 'Content-Type': 'text/event-stream; charset=utf-8',
 'Cache-Control': 'no-cache, no-transform',
 'Connection': 'keep-alive',
 'X-Accel-Buffering': 'no'
 });

 if (typeof res.flushHeaders === 'function') res.flushHeaders();
 if (res.socket) res.socket.setTimeout(0);

 // Tell browser its native retry hint too.
 res.write('retry: 5000\n\n');
 res.write(`data: ${JSON.stringify({
 type: 'CONNECTED',
 message: 'Terhubung ke server real-time Sintra',
 timestamp: new Date().toISOString()
 })}\n\n`);

 this.clients.set(clientId, { id: clientId, user, res });
 console.log(`[Realtime SSE] Klien terhubung: ${user.username} (${user.role}) - Total: ${this.clients.size}`);

 // Adaptive polling: ada klien baru → percepat polling ke 1.5 detik
 this._adjustPollingRate();

 const cleanup = () => this.removeClient(clientId);
 res.on('close', cleanup);
 res.on('error', cleanup);
 }

 removeClient(clientId) {
 const client = this.clients.get(clientId);
 if (!client) return;
 this.clients.delete(clientId);
 console.log(`[Realtime SSE] Klien terputus: ${client.user?.username || clientId} - Sisa: ${this.clients.size}`);

 // Adaptive polling: jika tidak ada klien lagi → perlambat polling
 this._adjustPollingRate();
 }

 broadcast(eventType, payload, filterFn = null) {
 const dataString = JSON.stringify({
 type: eventType,
 payload,
 timestamp: new Date().toISOString()
 });
 const sseMessage = `data: ${dataString}\n\n`;

 for (const [clientId, client] of this.clients.entries()) {
 try {
 if (filterFn && !filterFn(client.user)) continue;
 if (client.res.destroyed || client.res.writableEnded) {
 this.removeClient(clientId);
 continue;
 }
 client.res.write(sseMessage);
 } catch (err) {
 console.error(`[Realtime SSE] Gagal mengirim ke ${clientId}:`, err.message);
 this.removeClient(clientId);
 }
 }
 }

 // Simpan baseline RKA pada process ini dan broadcast hanya perubahan.
 publishDbState(db) {
 const next = new Map((db?.rkis || []).filter(r => r?.id).map(r => [String(r.id), r]));

 if (this.lastRkiState.size === 0 && next.size > 0) {
 this.lastRkiState = next;
 return;
 }

 for (const [id, rka] of next.entries()) {
 const previous = this.lastRkiState.get(id);
 if (!previous) {
 this.broadcast('RKA_CREATED', rka);
 } else if (JSON.stringify(previous) !== JSON.stringify(rka)) {
 this.broadcast('RKA_UPDATED', rka);
 }
 }

 for (const id of this.lastRkiState.keys()) {
 if (!next.has(id)) this.broadcast('RKA_DELETED', { id });
 }

 this.lastRkiState = next;
 }

 // Adaptive polling: sesuaikan interval berdasarkan jumlah klien terhubung
 _adjustPollingRate() {
 if (!this.dbSyncStarted || !this._readDbFn) return;

 const desiredInterval = this.clients.size > 0 ? POLL_INTERVAL_ACTIVE : POLL_INTERVAL_IDLE;

 if (desiredInterval === this._currentPollInterval) return; // Tidak berubah

 // Ganti interval
 if (this.dbSyncTimer) clearInterval(this.dbSyncTimer);

 this._currentPollInterval = desiredInterval;
 const label = desiredInterval === POLL_INTERVAL_ACTIVE ? 'AKTIF (1.5s)' : 'IDLE (30s)';
 console.log(`[Realtime DB Sync] Polling disesuaikan → ${label} (klien: ${this.clients.size})`);

 const poll = async () => {
 try {
 const db = await this._readDbFn();
 this.publishDbState(db);
 } catch (err) {
 console.warn('[Realtime DB Sync] Poll gagal:', err.message);
 }
 };

 this.dbSyncTimer = setInterval(poll, desiredInterval);
 }

 // Penting untuk multi-device/multi-instance Render:
 // tiap instance mengecek updated_at/data Neon. Jadi perubahan yang dibuat
 // di instance A tetap dikirim ke client yang tersambung ke instance B.
 async startDatabaseSync(readDb) {
 if (this.dbSyncStarted) return;
 this.dbSyncStarted = true;
 this._readDbFn = readDb;

 try {
 const initial = await readDb();
 this.lastRkiState = new Map((initial?.rkis || []).filter(r => r?.id).map(r => [String(r.id), r]));
 } catch (err) {
 console.warn('[Realtime DB Sync] Initial sync gagal:', err.message);
 }

 const poll = async () => {
 try {
 const db = await readDb();
 this.publishDbState(db);
 } catch (err) {
 console.warn('[Realtime DB Sync] Poll gagal:', err.message);
 }
 };

 // Mulai dengan interval idle jika belum ada klien
 this._currentPollInterval = this.clients.size > 0 ? POLL_INTERVAL_ACTIVE : POLL_INTERVAL_IDLE;
 const label = this._currentPollInterval === POLL_INTERVAL_ACTIVE ? 'AKTIF (1.5s)' : 'IDLE (30s)';
 console.log(`[Realtime DB Sync] Dimulai dengan mode ${label}`);

 this.dbSyncTimer = setInterval(poll, this._currentPollInterval);
 }

 startHeartbeat() {
 this.heartbeatTimer = setInterval(() => {
 for (const [clientId, client] of this.clients.entries()) {
 try {
 if (client.res.destroyed || client.res.writableEnded) {
 this.removeClient(clientId);
 continue;
 }
 client.res.write(': keep-alive\n\n');
 } catch {
 this.removeClient(clientId);
 }
 }
 }, 15000);
 }

 // Statistik untuk endpoint monitoring
 getStats() {
 return {
 connectedClients: this.clients.size,
 pollInterval: this._currentPollInterval,
 pollMode: this._currentPollInterval === POLL_INTERVAL_ACTIVE ? 'active' : 'idle',
 trackedRkis: this.lastRkiState.size
 };
 }
}

export const realtimeHub = new RealtimeHub();

