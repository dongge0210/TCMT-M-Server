import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { Store, flatten } from '../lib/store.js';
import { createArchiver, queryInflux } from '../lib/archive.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcmt-store-'));
  return path.join(dir, 'server.db');
}

function snapshot(over = {}) {
  return {
    cpu_usage: 42.5,
    cpu_temp: 60.1,
    memory_total: 16000000000,
    memory_used: 8000000000,
    gpu_usage: 10,
    temperatures: [{ name: 'SSD', value: 33.2, unit: '°C' }],
    ...over,
  };
}

test('flatten nested objects and arrays into dotted numeric paths', () => {
  const flat = flatten({
    cpu: { usage: 12.5 },
    temps: [30, 40],
    sensors: [{ v: 1 }, { v: 2 }],
    label: 'skip me',
    nested: { deep: { n: 7 } },
  });
  assert.equal(flat['cpu.usage'], 12.5);
  assert.equal(flat['temps[0]'], 30);
  assert.equal(flat['sensors[0].v'], 1);
  assert.equal(flat['nested.deep.n'], 7);
  assert.equal(flat.label, undefined);
});

test('register is idempotent by clientKey (and name fallback without key)', () => {
  const store = new Store({ dbPath: tempDb() });
  const a = store.register('ck-1', 'MacBook', 'macOS', 'Mac14,2');
  const b = store.register('ck-1', 'MacBook', 'macOS', 'Mac14,2');
  assert.equal(a.id, b.id);
  assert.equal(a.token, b.token);

  const c = store.register('', 'Desktop', 'Windows', 'Custom');
  const d = store.register('', 'Desktop', 'Windows', 'Custom');
  assert.equal(c.id, d.id);
  store.close();
});

test('auth and getByToken work', () => {
  const store = new Store({ dbPath: tempDb() });
  const dev = store.register('ck-2', 'TestBox', 'Linux', 'X1');
  assert.equal(store.auth(dev.token), true);
  assert.equal(store.auth('wrong'), false);
  assert.equal(store.getByToken(dev.token).id, dev.id);
  store.close();
});

test('ingest stores snapshot + timeseries and strips token from latest', () => {
  const store = new Store({ dbPath: tempDb() });
  const dev = store.register('ck-3', 'TestBox', 'macOS', 'M2');
  const ts = Date.now();
  const dev2 = store.ingest(dev.token, { ...snapshot(), token: dev.token }, ts);
  assert.ok(dev2);
  assert.equal(dev.latest.token, undefined);
  assert.equal(dev.latest.cpu_usage, 42.5);
  assert.equal(dev.latestFlat['memory_percent'], undefined); // derived, not stored
  store.close();
});

test('fields reports min/max/last/count across ingests', () => {
  const store = new Store({ dbPath: tempDb() });
  const dev = store.register('ck-4', 'TestBox', 'macOS', 'M2');
  store.ingest(dev.token, snapshot({ cpu_usage: 10 }), Date.now());
  store.ingest(dev.token, snapshot({ cpu_usage: 20 }), Date.now());
  store.ingest(dev.token, snapshot({ cpu_usage: 15 }), Date.now());
  const fields = store.fields(dev.id);
  const cpu = fields.find(f => f.field === 'cpu_usage');
  assert.deepEqual(
    { min: cpu.min, max: cpu.max, last: cpu.last, count: cpu.count },
    { min: 10, max: 20, last: 15, count: 3 }
  );
  assert.equal(store.fields('missing'), null);
  store.close();
});

test('history respects from/to/limit and bucket aggregation', () => {
  const store = new Store({ dbPath: tempDb() });
  const dev = store.register('ck-5', 'TestBox', 'macOS', 'M2');
  const base = Date.now() - 600000;
  for (let i = 0; i < 10; i += 1) {
    store.ingest(dev.token, snapshot({ cpu_usage: i * 10 }), base + i * 1000);
  }

  const all = store.history(dev.id, 'cpu_usage', base, base + 600000, 0);
  assert.equal(all.length, 10);
  assert.equal(all[0].value, 0);
  assert.equal(all[9].value, 90);

  const limited = store.history(dev.id, 'cpu_usage', base, base + 600000, 4);
  assert.equal(limited.length, 4);

  const bucketed = store.history(dev.id, 'cpu_usage', base, base + 600000, 0, 5000);
  assert.ok(bucketed.length >= 2);
  const b0 = bucketed[0];
  assert.equal(typeof b0.ts, 'number');
  assert.equal(typeof b0.avg, 'number');
  assert.ok(b0.min <= b0.avg && b0.avg <= b0.max);

  assert.equal(store.history('missing', 'cpu_usage', 0, Date.now()), null);
  store.close();
});

test('retention cleanup removes rows older than retentionDays', () => {
  const db = tempDb();
  const store = new Store({ dbPath: db, retentionDays: 1 });
  const dev = store.register('ck-6', 'TestBox', 'macOS', 'M2');
  const now = Date.now();
  store.ingest(dev.token, snapshot({ cpu_usage: 1 }), now - 3 * 86400000); // stale
  store.ingest(dev.token, snapshot({ cpu_usage: 2 }), now);                 // fresh
  store._cleanup();
  const hist = store.history(dev.id, 'cpu_usage', 0, now, 0);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].value, 2);
  store.close();
});

test('legacy devices.json migrates into a fresh DB', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcmt-legacy-'));
  const legacy = path.join(dir, 'devices.json');
  fs.writeFileSync(legacy, JSON.stringify([
    { id: 'dev_abcdef', clientKey: 'legacy-key', name: 'OldBox', os: 'macOS', model: 'M1', token: 'tcmt_legacy1', lastSeen: 1700000000000 },
  ]));
  const store = new Store({ dbPath: path.join(dir, 'server.db'), legacyDevices: [legacy] });
  assert.equal(store.get('dev_abcdef').name, 'OldBox');
  assert.equal(store.auth('tcmt_legacy1'), true);
  const again = store.register('legacy-key', 'OldBox', 'macOS', 'M1');
  assert.equal(again.id, 'dev_abcdef'); // reuses the imported device
  store.close();
});

test('history persists across restart (SQLite)', () => {
  const db = tempDb();
  const s1 = new Store({ dbPath: db });
  const dev = s1.register('ck-7', 'PersistBox', 'macOS', 'M2');
  const ts = Date.now();
  s1.ingest(dev.token, snapshot({ cpu_usage: 77 }), ts);
  s1.close();

  const s2 = new Store({ dbPath: db });
  const hist = s2.history(dev.id, 'cpu_usage', ts - 1000, ts + 1000, 0);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].value, 77);
  assert.equal(s2.get(dev.id).name, 'PersistBox'); // registry persists too
  s2.close();
});

test('outdated timeseries schema is preserved and rebuilt', () => {
  const db = tempDb();
  // Old prototype layout: `time` instead of `ts`.
  {
    const old = new DatabaseSync(db);
    old.exec('CREATE TABLE timeseries (device_id TEXT, field TEXT, time INTEGER, value REAL)');
    old.prepare('INSERT INTO timeseries VALUES (?, ?, ?, ?)')
      .run('dev_x', 'cpu_usage', 123, 42.5);
    old.close();
  }

  const store = new Store({ dbPath: db });
  const dev = store.register('ck-mig', 'MigBox', 'macOS', 'M2');
  store.ingest(dev.token, snapshot({ cpu_usage: 10 }), Date.now());

  // New schema operational.
  const hist = store.history(dev.id, 'cpu_usage', 0, Date.now() + 1, 0);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].value, 10);

  // Old data preserved under a backup table.
  const backups = store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'timeseries_backup_%'"
  ).all();
  assert.equal(backups.length, 1);
  const oldRow = store.db.prepare(`SELECT value FROM ${backups[0].name}`).get();
  assert.equal(oldRow.value, 42.5);
  store.close();
});

test('archiver moves old timeseries rows into InfluxDB (line protocol)', async () => {
  const db = tempDb();
  const store = new Store({ dbPath: db, retentionDays: 1 });
  const dev = store.register('ck-arch', 'ArchBox', 'macOS', 'M2');
  const now = Date.now();
  // Two rows older than retention, one fresh.
  store.ingest(dev.token, snapshot({ cpu_usage: 10 }), now - 2 * 86400000);
  store.ingest(dev.token, snapshot({ cpu_usage: 20 }), now - 2 * 86400000);
  store.ingest(dev.token, snapshot({ cpu_usage: 30 }), now);

  // Fake Influx server capturing the write body.
  const writes = [];
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      writes.push({ url: req.url, auth: req.headers.authorization, body });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  const port = fake.address().port;

  try {
    const archiver = createArchiver({
      store,
      influxUrl: `http://127.0.0.1:${port}`,
      token: 'test-token',
      org: 'tcmt',
      bucket: 'tcmt',
    });
    const { archived } = await archiver.runOnce();
    // 2 stale snapshots x 6 flattened fields each = 12 archived rows.
    assert.equal(archived, 12);
    assert.equal(writes.length, 1);
    assert.ok(writes[0].url.includes('/api/v2/write'));
    assert.ok(writes[0].url.includes('org=tcmt') && writes[0].url.includes('bucket=tcmt'));
    assert.equal(writes[0].auth, 'Token test-token');
    const lines = writes[0].body.trim().split('\n');
    assert.equal(lines.length, 12);
    assert.ok(lines[0].startsWith(`tcmt_metric,device_id=${dev.id},field=cpu_usage value=10 `));

    // Fresh snapshot remains (6 fields); drained rows are gone.
    const remaining = store.db.prepare('SELECT COUNT(*) AS n FROM timeseries').get().n;
    assert.equal(remaining, 6);
    const hist = store.history(dev.id, 'cpu_usage', 0, now, 0);
    assert.equal(hist.length, 1);
    assert.equal(hist[0].value, 30);
  } finally {
    await new Promise(resolve => fake.close(resolve));
    store.close();
  }
});

test('queryInflux parses annotated CSV into points', async () => {
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/csv' });
      res.end([
        '#datatype,string,long,dateTime:RFC3339,dateTime:RFC3339,dateTime:RFC3339,double,string,string,string',
        '#group,false,false,true,true,false,false,true,true,true',
        '#default,_result,,,,,,,,',
        ',result,table,_start,_stop,_time,_value,_field,_measurement,device_id',
        ',,0,2026-08-01T00:00:00Z,2026-08-02T00:00:00Z,2026-08-01T01:00:00Z,42.5,cpu_usage,tcmt_metric,dev_x',
        ',,0,2026-08-01T00:00:00Z,2026-08-02T00:00:00Z,2026-08-01T02:00:00Z,43.5,cpu_usage,tcmt_metric,dev_x',
        '',
      ].join('\n'));
    });
  });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  const port = fake.address().port;
  try {
    const points = await queryInflux({
      influxUrl: `http://127.0.0.1:${port}`,
      token: 't', org: 'tcmt', bucket: 'tcmt',
      deviceId: 'dev_x', field: 'cpu_usage',
      from: Date.now() - 86400000, to: Date.now(), bucketSec: 3600,
    });
    assert.equal(points.length, 2);
    assert.equal(points[0].value, 42.5);
    assert.ok(points[1].ts > points[0].ts);
  } finally {
    await new Promise(resolve => fake.close(resolve));
  }
});

test('aggregate summarizes fleet counts and avg/max over online devices', () => {
  const store = new Store({ dbPath: tempDb() });
  const a = store.register('ck-agg-a', 'BoxA', 'macOS', 'M2');
  const b = store.register('ck-agg-b', 'BoxB', 'Windows', 'PC');
  const now = Date.now();
  store.ingest(a.token, snapshot({ cpu_usage: 20, cpu_temp: 55, gpu_usage: 10, gpu_temp: 60 }), now);
  store.ingest(b.token, snapshot({ cpu_usage: 40, cpu_temp: 65, gpu_usage: 30, gpu_temp: 80 }), now);

  const agg = store.aggregate();
  assert.equal(agg.total, 2);
  assert.equal(agg.online, 2);
  assert.equal(agg.offline, 0);
  assert.equal(agg.cpu.usage.avg, 30);
  assert.equal(agg.cpu.usage.max, 40);
  assert.equal(agg.cpu.usage.maxDevice, b.id);
  assert.equal(agg.gpu.temp.max, 80);
  assert.equal(agg.memory.percent.avg, 50);
  // Temperatures aggregate covers CPU + GPU + sensor array across the fleet.
  assert.equal(agg.temperatures.max.value, 80);
  assert.equal(agg.temperatures.max.name, 'GPU');
  assert.equal(agg.temperatures.max.deviceId, b.id);
  assert.equal(agg.temperatures.avg, 54.4); // (55+60+65+80+33.2+33.2)/6

  // A device that stops ingesting counts toward totals but not value stats.
  store.ingest(a.token, snapshot({ cpu_usage: 999 }), now - 60000);
  const stale = store.aggregate();
  assert.equal(stale.total, 2);
  assert.equal(stale.online, 1);
  assert.equal(stale.offline, 1);
  assert.equal(stale.cpu.usage.max, 40); // 999 excluded
  assert.equal(stale.cpu.usage.maxDevice, b.id);
  store.close();
});

test('aggregate handles an empty registry', () => {
  const store = new Store({ dbPath: tempDb() });
  const agg = store.aggregate();
  assert.equal(agg.total, 0);
  assert.equal(agg.online, 0);
  assert.equal(agg.offline, 0);
  assert.equal(agg.cpu.usage, null);
  assert.equal(agg.temperatures.max, null);
  store.close();
});
