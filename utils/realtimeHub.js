// utils/realtimeHub.js
// SSE hub + deteksi perubahan database lintas-instance.
//
// Prinsip hemat (aplikasi bisa dibiarkan terbuka 24 jam):
//  1. Polling database HANYA berjalan selama ada klien SSE terhubung; tanpa klien
//     timer dimatikan sama sekali (sebelumnya tetap polling tiap 30 dtk selamanya).
//  2. Tiap siklus hanya membaca penanda updated_at (query kecil). Isi penuh
//     'main_db' baru ditarik bila penanda itu berubah.
//  3. Perubahan hanya dikirim ke klien yang berhak melihat dokumennya
//     (pemilik, admin, moderator) — bukan ke semua pengguna.
//
// Konfigurasi (opsional, env):
//   REALTIME_POLL_MS   interval polling saat ada klien, minimal 3000 (default 10000)
//   REALTIME_DB_POLL   isi "off" untuk mematikan polling lintas-instance
//                      (aman bila hanya ada satu instance backend)

const POLL_INTERVAL_ACTIVE = Math.max(3000, Number(process.env.REALTIME_POLL_MS) || 10000);
const POLL_DISABLED = String(process.env.REALTIME_DB_POLL || '').toLowerCase() === 'off';

// Teks mentah PDF (sourceText dkk.) besar dan tidak perlu dikirim ke klien lewat SSE;
// klien cukup tahu apakah teksnya tersedia (hasSourceText) untuk tombol "Generate Ulang AI".
const RAW_TEXT_FIELDS = ['sourceText', '_rawText', 'rawPdfText', 'rawText', 'originalText', 'extractedText'];
const toClientRka = (rka) => {
  if (!rka || typeof rka !== 'object') return rka;
  const copy = { ...rka };
  let has = false;
  for (const f of RAW_TEXT_FIELDS) {
    if (typeof copy[f] === 'string' && copy[f].trim().length > 100) has = true;
    delete copy[f];
  }
  copy.hasSourceText = has;
  return copy;
};

const toStateMap = (db) => new Map((db?.rkis || []).filter(r => r?.id).map(r => [String(r.id), r]));

// Filter penerima: pemilik dokumen, admin, dan moderator. Dokumen lama tanpa userId terlihat semua.
const visibleTo = (rka) => (user) =>
  !rka?.userId ||
  user?.role === 'admin' ||
  user?.role === 'moderator' ||
  String(user?.id) === String(rka.userId);

class RealtimeHub {
  constructor() {
    this.clients = new Map();
    this.lastRkiState = new Map();
    this.dbSyncStarted = false;
    this.heartbeatTimer = null;
    this.dbSyncTimer = null;
    this._readDbFn = null;
    this._readVersionFn = null;
    this._lastVersion = null;
    this._polling = false;
    this._starting = false;
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

    // Klien pertama → nyalakan polling; tanpa klien polling mati.
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

  // Simpan baseline RKA pada process ini dan broadcast hanya perubahan,
  // hanya kepada klien yang berhak atas dokumen tersebut.
  publishDbState(db) {
    const next = toStateMap(db);

    if (this.lastRkiState.size === 0 && next.size > 0) {
      this.lastRkiState = next;
      return;
    }

    for (const [id, rka] of next.entries()) {
      const previous = this.lastRkiState.get(id);
      if (!previous) {
        this.broadcast('RKA_CREATED', toClientRka(rka), visibleTo(rka));
      } else if (JSON.stringify(previous) !== JSON.stringify(rka)) {
        this.broadcast('RKA_UPDATED', toClientRka(rka), visibleTo(rka));
      }
    }

    for (const [id, previous] of this.lastRkiState.entries()) {
      if (!next.has(id)) this.broadcast('RKA_DELETED', { id }, visibleTo(previous));
    }

    this.lastRkiState = next;
  }

  _adjustPollingRate() {
    if (!this.dbSyncStarted || !this._readDbFn) return;
    if (this.clients.size > 0) this._startPolling();
    else this._stopPolling();
  }

  async _startPolling() {
    if (POLL_DISABLED || this.dbSyncTimer || this._starting) return;
    this._starting = true;
    try {
      // Selama tidak ada klien tidak ada yang dipantau, jadi baseline bisa basi.
      // Segarkan sekali (tanpa broadcast) sebelum mulai membandingkan.
      await this._reseedBaseline();
    } finally {
      this._starting = false;
    }
    if (this.clients.size > 0 && !this.dbSyncTimer) {
      this.dbSyncTimer = setInterval(() => this._poll(), POLL_INTERVAL_ACTIVE);
      console.log(`[Realtime DB Sync] Polling AKTIF tiap ${POLL_INTERVAL_ACTIVE / 1000}s (klien: ${this.clients.size})`);
    }
  }

  _stopPolling() {
    if (!this.dbSyncTimer) return;
    clearInterval(this.dbSyncTimer);
    this.dbSyncTimer = null;
    console.log('[Realtime DB Sync] Polling dihentikan — tidak ada klien terhubung');
  }

  async _reseedBaseline() {
    try {
      const version = this._readVersionFn ? await this._readVersionFn() : null;
      const db = await this._readDbFn();
      this.lastRkiState = toStateMap(db);
      this._lastVersion = version;
    } catch (err) {
      console.warn('[Realtime DB Sync] Reseed baseline gagal:', err.message);
    }
  }

  async _poll() {
    if (this._polling) return; // siklus sebelumnya belum selesai
    this._polling = true;
    try {
      if (this._readVersionFn) {
        const version = await this._readVersionFn();
        // Penanda sama → tidak ada perubahan, lewati pembacaan penuh.
        if (version !== null && version === this._lastVersion) return;
        const db = await this._readDbFn();
        this.publishDbState(db);
        this._lastVersion = version;
      } else {
        this.publishDbState(await this._readDbFn());
      }
    } catch (err) {
      console.warn('[Realtime DB Sync] Poll gagal:', err.message);
    } finally {
      this._polling = false;
    }
  }

  // Penting untuk multi-device/multi-instance Render: perubahan yang dibuat di
  // instance A tetap dikirim ke client yang tersambung ke instance B.
  // readVersion (opsional) = fungsi ringan yang mengembalikan penanda perubahan.
  async startDatabaseSync(readDb, readVersion = null) {
    if (this.dbSyncStarted) return;
    this.dbSyncStarted = true;
    this._readDbFn = readDb;
    this._readVersionFn = readVersion;

    await this._reseedBaseline();

    console.log(
      POLL_DISABLED
        ? '[Realtime DB Sync] Polling lintas-instance dinonaktifkan (REALTIME_DB_POLL=off)'
        : '[Realtime DB Sync] Siap — polling hanya berjalan saat ada klien terhubung'
    );
    this._adjustPollingRate();
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
      pollInterval: this.dbSyncTimer ? POLL_INTERVAL_ACTIVE : 0,
      pollMode: this.dbSyncTimer ? 'active' : 'idle',
      trackedRkis: this.lastRkiState.size
    };
  }
}

export const realtimeHub = new RealtimeHub();
