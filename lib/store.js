// tcmt-server store — SQLite persistence via node:sqlite (zero npm deps).
//
// Tables:
//   devices     — idempotent device registry (clientKey-based)
//   snapshots   — full JSON snapshot per ingest
//   timeseries  — flattened numeric fields, indexed (device_id, field, ts)
//
// The latest snapshot is kept in memory for fast /latest + WS broadcast;
// history/fields queries read from SQLite so data survives restarts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.error('[tcmt-server] node:sqlite unavailable — need Node.js >= 22.5 (built-in SQLite).');
  process.exit(1);
}

function randomHex(len) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

// Devices are "online" when a snapshot arrived within this window.
const ONLINE_MS = 15000;

// { avg, max, maxDevice } over [{ value, deviceId }], or null when empty.
function avgMax(values) {
  if (!values.length) return null;
  let sum = 0;
  let max = -Infinity;
  let maxDevice = '';
  for (const v of values) {
    sum += v.value;
    if (v.value > max) {
      max = v.value;
      maxDevice = v.deviceId;
    }
  }
  return { avg: Math.round((sum / values.length) * 100) / 100, max, maxDevice };
}

// Flatten a nested JSON snapshot into dotted numeric paths, e.g.
// { cpu: { usage: 12 } } -> { "cpu.usage": 12 }. Arrays use [i] keys.
export function flatten(obj, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[name] = value;
    } else if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        value.forEach((item, i) => {
          if (typeof item === 'number' && Number.isFinite(item)) out[`${name}[${i}]`] = item;
          else if (item && typeof item === 'object') flatten(item, `${name}[${i}]`, out);
        });
      } else {
        flatten(value, name, out);
      }
    }
  }
  return out;
}

function freshDevice(seed = {}) {
  return {
    id: seed.id || '',
    clientKey: seed.clientKey || '',
    name: seed.name || 'Unknown',
    os: seed.os || 'Unknown',
    model: seed.model || 'Unknown',
    token: seed.token || '',
    ip: seed.ip || '', // last connection IP (in-memory, refreshed per request)
    lastSeen: seed.lastSeen || 0,
    latest: {},        // most recent snapshot (token stripped)
    latestFlat: {},    // flattened numeric fields of latest
  };
}

export class Store {
  constructor({ dbPath, retentionDays = 30, legacyDevices = [] }) {
    this.dbPath = dbPath;
    this.retentionMs = retentionDays * 86400000;
    this.devices = new Map(); // id -> device (registry + latest cache)
    this.ingestCount = 0;

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this._ensureTables();
    this._loadDevices();
    this._migrateLegacy(legacyDevices);
    this._cleanup();
  }

  // Older prototype DBs have incompatible layouts (e.g. timeseries without
  // a `ts` column). Detect that and preserve the old data under a backup
  // table name before the fresh schema is created — nothing is dropped.
  _ensureCompatible(table, requiredCols) {
    const info = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!info.length) return; // table doesn't exist yet — CREATE will make it
    const cols = new Set(info.map(c => c.name));
    if (requiredCols.every(c => cols.has(c))) return; // current schema
    const backup = `${table}_backup_${Date.now()}`;
    this.db.exec(`ALTER TABLE ${table} RENAME TO ${backup}`);
    console.log(`[store] ${table} schema outdated — preserved as ${backup}`);
  }

  _ensureTables() {
    this._ensureCompatible('devices', ['id', 'client_key', 'name', 'os', 'model', 'token', 'created_at', 'last_seen']);
    this._ensureCompatible('snapshots', ['id', 'device_id', 'ts', 'data']);
    this._ensureCompatible('timeseries', ['device_id', 'field', 'ts', 'value']);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id         TEXT PRIMARY KEY,
        client_key TEXT UNIQUE,
        name       TEXT NOT NULL DEFAULT 'Unknown',
        os         TEXT NOT NULL DEFAULT 'Unknown',
        model      TEXT NOT NULL DEFAULT 'Unknown',
        token      TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        ts        INTEGER NOT NULL,
        data      TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS timeseries (
        device_id TEXT NOT NULL,
        field     TEXT NOT NULL,
        ts        INTEGER NOT NULL,
        value     REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_timeseries_lookup
        ON timeseries(device_id, field, ts);
      CREATE INDEX IF NOT EXISTS idx_snapshots_lookup
        ON snapshots(device_id, ts);
    `);
  }

  _loadDevices() {
    const rows = this.db.prepare(
      'SELECT id, client_key, name, os, model, token, last_seen FROM devices'
    ).all();
    for (const row of rows) {
      this.devices.set(row.id, freshDevice({
        id: row.id,
        clientKey: row.client_key || '',
        name: row.name,
        os: row.os,
        model: row.model,
        token: row.token,
        lastSeen: row.last_seen,
      }));
    }
  }

  // One-time import from the old data/devices.json (only when the registry is
  // empty, so a fresh DB re-imports, and an existing DB never duplicates).
  _migrateLegacy(legacyDevices = []) {
    if (this.devices.size > 0) return;
    for (const file of legacyDevices) {
      let arr = null;
      try {
        arr = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        continue; // missing / unreadable / not JSON
      }
      if (!Array.isArray(arr)) continue;
      let imported = 0;
      for (const d of arr) {
        if (!d || !d.id || !d.token) continue;
        this._insertDeviceRow({
          id: d.id,
          clientKey: d.clientKey || '',
          name: d.name || 'Unknown',
          os: d.os || 'Unknown',
          model: d.model || 'Unknown',
          token: d.token,
          lastSeen: d.lastSeen || Date.now(),
        });
        imported += 1;
      }
      if (imported > 0) {
        console.log(`[store] migrated ${imported} devices from ${file}`);
        return;
      }
    }
  }

  _insertDeviceRow(d) {
    // Keep the same object reference in memory that callers receive, so
    // ingest() updates (latest/lastSeen) are visible everywhere.
    const dev = d.latest !== undefined ? d : freshDevice(d);
    this.devices.set(d.id, dev);
    this.db.prepare(`
      INSERT OR REPLACE INTO devices
        (id, client_key, name, os, model, token, created_at, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(d.id, d.clientKey, d.name, d.os, d.model, d.token, d.lastSeen, d.lastSeen);
  }

  register(clientKey, name, os, model, ip = '') {
    // Stable identity across restarts: prefer the random per-machine clientKey
    // (works across NAT rebinds / IP changes / shared public servers); fall
    // back to name for older clients without a key.
    for (const existing of this.devices.values()) {
      if ((clientKey && existing.clientKey === clientKey) || (!clientKey && existing.name === name)) {
        existing.clientKey = clientKey || existing.clientKey;
        existing.os = os || existing.os;
        existing.model = model || existing.model;
        if (ip) existing.ip = ip;
        existing.lastSeen = Date.now();
        this.db.prepare(`
          UPDATE devices SET client_key = ?, os = ?, model = ?, last_seen = ?
          WHERE id = ?
        `).run(existing.clientKey, existing.os, existing.model, existing.lastSeen, existing.id);
        return existing;
      }
    }
    let id = 'dev_' + randomHex(6);
    while (this.devices.has(id)) id = 'dev_' + randomHex(6);
    const device = freshDevice();
    device.id = id;
    device.clientKey = clientKey || '';
    device.token = 'tcmt_' + randomHex(7);
    device.name = name || 'Unknown';
    device.os = os || 'Unknown';
    device.model = model || 'Unknown';
    device.lastSeen = Date.now();
    device.ip = ip;
    this._insertDeviceRow(device);
    return device;
  }

  auth(token) {
    if (!token) return false;
    for (const d of this.devices.values()) if (d.token === token) return true;
    return false;
  }

  get(id) {
    return this.devices.get(id) || null;
  }

  getByToken(token) {
    for (const d of this.devices.values()) if (d.token === token) return d;
    return null;
  }

  // Public device list with live online status.
  list() {
    const now = Date.now();
    return [...this.devices.values()].map(d => ({
      id: d.id,
      name: d.name,
      os: d.os,
      model: d.model,
      ip: d.ip,
      online: now - d.lastSeen < ONLINE_MS,
      lastSeen: d.lastSeen,
    }));
  }

  // Fleet overview: counts across all devices, value stats (avg/max) from
  // online devices only — stale snapshots would skew the "current" picture.
  // Reads in-memory latest snapshots, so it is cheap enough to broadcast.
  aggregate() {
    const now = Date.now();
    const out = {
      ts: now,
      total: this.devices.size,
      online: 0,
      offline: 0,
      cpu: { usage: null, temp: null },
      memory: { percent: null },
      gpu: { usage: null, temp: null },
      temperatures: { avg: null, max: null },
    };
    const cpuUsage = [];
    const cpuTemp = [];
    const memPct = [];
    const gpuUsage = [];
    const gpuTemp = [];
    const temps = [];

    for (const d of this.devices.values()) {
      if (now - d.lastSeen >= ONLINE_MS) {
        out.offline += 1;
        continue;
      }
      out.online += 1;
      const latest = d.latest || {};
      if (typeof latest.cpu_usage === 'number') cpuUsage.push({ value: latest.cpu_usage, deviceId: d.id });
      if (typeof latest.cpu_temp === 'number') {
        cpuTemp.push({ value: latest.cpu_temp, deviceId: d.id });
        temps.push({ value: latest.cpu_temp, name: 'CPU', unit: '°C', deviceId: d.id });
      }
      if (latest.memory_total && typeof latest.memory_used === 'number') {
        memPct.push({
          value: Math.round((latest.memory_used / latest.memory_total) * 1000) / 10,
          deviceId: d.id,
        });
      }
      if (typeof latest.gpu_usage === 'number') gpuUsage.push({ value: latest.gpu_usage, deviceId: d.id });
      if (typeof latest.gpu_temp === 'number') {
        gpuTemp.push({ value: latest.gpu_temp, deviceId: d.id });
        temps.push({ value: latest.gpu_temp, name: 'GPU', unit: '°C', deviceId: d.id });
      }
      for (const t of Array.isArray(latest.temperatures) ? latest.temperatures : []) {
        if (t && typeof t === 'object' && typeof t.value === 'number') {
          temps.push({
            value: t.value,
            name: t.name || t.sensor || t.id || 'Sensor',
            unit: t.unit || '°C',
            deviceId: d.id,
          });
        }
      }
    }

    out.cpu.usage = avgMax(cpuUsage);
    out.cpu.temp = avgMax(cpuTemp);
    out.memory.percent = avgMax(memPct);
    out.gpu.usage = avgMax(gpuUsage);
    out.gpu.temp = avgMax(gpuTemp);
    if (temps.length) {
      out.temperatures.avg = Math.round((temps.reduce((s, t) => s + t.value, 0) / temps.length) * 100) / 100;
      out.temperatures.max = temps.reduce((a, b) => (b.value > a.value ? b : a));
    }
    return out;
  }

  ingest(token, data, ts = Date.now(), ip = '') {
    const device = this.getByToken(token);
    if (!device) return null;
    if (ip) device.ip = ip; // connection IP may change (NAT rebind / reattach)
    const { token: _dropped, ...rest } = data; // never expose the token in snapshots
    const flat = flatten(rest);

    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO snapshots (device_id, ts, data) VALUES (?, ?, ?)')
        .run(device.id, ts, JSON.stringify(rest));
      const insertTs = this.db.prepare(
        'INSERT INTO timeseries (device_id, field, ts, value) VALUES (?, ?, ?, ?)'
      );
      for (const [field, value] of Object.entries(flat)) {
        insertTs.run(device.id, field, ts, value);
      }
      this.db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(ts, device.id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    device.latest = rest;
    device.latestFlat = flat;
    device.lastSeen = ts;
    this.ingestCount += 1;
    if (this.ingestCount % 500 === 0) this._cleanup();
    return device;
  }

  // Numeric fields seen for a device, with min/max/last/count ("整理" index).
  fields(id) {
    const device = this.get(id);
    if (!device) return null;
    const rows = this.db.prepare(`
      SELECT field, MIN(value) AS min, MAX(value) AS max, COUNT(*) AS count
      FROM timeseries WHERE device_id = ? GROUP BY field ORDER BY field
    `).all(id);
    if (!rows.length) {
      return Object.entries(device.latestFlat).map(([field, value]) => ({
        field, min: value, max: value, last: value, count: 1,
      }));
    }
    return rows.map(r => ({
      field: r.field,
      min: r.min,
      max: r.max,
      last: device.latestFlat[r.field] ?? r.max,
      count: r.count,
    }));
  }

  // Time series query. With bucket > 1, returns per-bucket {ts, avg, min, max}
  // (on-the-fly downsampling; no aggregate tables in v1).
  history(id, field, from, to, limit = 1000, bucket = 1) {
    const device = this.get(id);
    if (!device) return null;
    let rows;
    if (bucket > 1) {
      rows = this.db.prepare(`
        SELECT CAST(CAST(ts AS REAL) / ? AS INTEGER) * ? AS ts,
               AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max
        FROM timeseries
        WHERE device_id = ? AND field = ? AND ts >= ? AND ts <= ?
        GROUP BY ts ORDER BY ts ASC
      `).all(bucket, bucket, id, field, from, to);
      rows = rows.map(r => ({ ts: r.ts, avg: r.avg, min: r.min, max: r.max }));
    } else {
      rows = this.db.prepare(`
        SELECT ts, value FROM timeseries
        WHERE device_id = ? AND field = ? AND ts >= ? AND ts <= ?
        ORDER BY ts ASC
      `).all(id, field, from, to);
      rows = rows.map(r => ({ ts: r.ts, value: r.value }));
    }
    if (limit > 0 && rows.length > limit) {
      // Evenly-spaced downsampling to keep the response bounded.
      const step = rows.length / limit;
      const sampled = [];
      for (let i = 0; i < limit; i += 1) sampled.push(rows[Math.floor(i * step)]);
      return sampled;
    }
    return rows;
  }

  // Organized view: pulls the fields the UI cares about out of the raw
  // snapshot, derives memory percent and a temperatures list.
  summary(id) {
    const device = this.get(id);
    if (!device) return null;
    const latest = device.latest || {};
    const out = {
      id: device.id,
      name: device.name,
      os: device.os,
      model: device.model,
      lastSeen: device.lastSeen,
      cpu: {},
      memory: {},
      gpu: {},
      motion: {},
      temperatures: [],
    };
    if (latest.cpu_usage !== undefined) out.cpu.usage = latest.cpu_usage;
    if (latest.cpu_temp !== undefined) out.cpu.temp = latest.cpu_temp;
    if (latest.memory_total && latest.memory_used !== undefined) {
      out.memory.total = latest.memory_total;
      out.memory.used = latest.memory_used;
      out.memory.percent = Math.round((latest.memory_used / latest.memory_total) * 1000) / 10;
    }
    if (latest.gpu_usage !== undefined) out.gpu.usage = latest.gpu_usage;
    if (latest.gpu_temp !== undefined) out.gpu.temp = latest.gpu_temp;
    for (const key of ['ax', 'ay', 'az', 'gx', 'gy', 'gz', 'lidAngle', 'hb', 'imut']) {
      if (latest[key] !== undefined) out.motion[key] = latest[key];
    }
    if (latest.cpu_temp !== undefined) out.temperatures.push({ name: 'CPU', value: latest.cpu_temp, unit: '°C' });
    if (latest.gpu_temp !== undefined) out.temperatures.push({ name: 'GPU', value: latest.gpu_temp, unit: '°C' });
    if (Array.isArray(latest.temperatures)) {
      for (const t of latest.temperatures) {
        if (t && typeof t === 'object' && t.value !== undefined) {
          out.temperatures.push({
            name: t.name || t.sensor || t.id || 'Sensor',
            value: t.value,
            unit: t.unit || '°C',
          });
        }
      }
    }
    return out;
  }

  // Server-side overview: device counts + storage configuration.
  stats() {
    const list = this.list();
    // DB size includes WAL/SHM sidecars (recent writes live in the WAL).
    let dbSizeBytes = 0;
    for (const p of [this.dbPath, this.dbPath + '-wal', this.dbPath + '-shm']) {
      try { dbSizeBytes += fs.statSync(p).size; } catch { /* optional file */ }
    }
    return {
      deviceCount: this.devices.size,
      onlineDevices: list.filter(d => d.online).length,
      dbPath: this.dbPath,
      dbSizeBytes,
      retentionDays: Math.round(this.retentionMs / 86400000),
      ingestCount: this.ingestCount,
    };
  }

  _cleanup() {
    const cutoff = Date.now() - this.retentionMs;
    this.db.prepare('DELETE FROM snapshots WHERE ts < ?').run(cutoff);
    this.db.prepare('DELETE FROM timeseries WHERE ts < ?').run(cutoff);
  }

  close() {
    this.db.close();
  }
}
