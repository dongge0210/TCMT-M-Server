import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, flatten } from '../lib/store.js';

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
