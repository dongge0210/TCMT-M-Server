import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.js';
import { createHandler } from '../lib/api.js';

async function startServer({ authToken = '', corsOrigin = '*' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcmt-api-'));
  const store = new Store({ dbPath: path.join(dir, 'server.db') });
  const handler = createHandler({ store, authToken, corsOrigin });
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { store, server, base: `http://127.0.0.1:${port}` };
}

async function closeServer(s) {
  await new Promise(resolve => s.server.close(resolve));
  s.store.close();
}

async function post(base, p, body, headers = {}) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function get(base, p, headers = {}) {
  const res = await fetch(base + p, { headers });
  return { status: res.status, json: await res.json(), headers: res.headers };
}

function snapshot(token) {
  return {
    token,
    cpu_usage: 42.5,
    cpu_temp: 60.1,
    memory_total: 16000000000,
    memory_used: 8000000000,
    gpu_usage: 10,
    temperatures: [{ name: 'SSD', value: 33.2, unit: '°C' }],
  };
}

test('CORS headers, service info, and OPTIONS preflight', async () => {
  const s = await startServer({ corsOrigin: 'https://viewer.example' });
  try {
    const root = await get(s.base, '/');
    assert.equal(root.status, 200);
    assert.equal(root.json.service, 'tcmt-server');
    assert.equal(root.headers.get('access-control-allow-origin'), 'https://viewer.example');

    const pre = await fetch(s.base + '/api/devices', { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://viewer.example');
  } finally {
    await closeServer(s);
  }
});

test('register -> ingest -> devices/latest/summary/fields/history', async () => {
  const s = await startServer();
  try {
    const reg = await post(s.base, '/api/register', {
      clientKey: 'ck-api', name: 'MacBook', os: 'macOS', model: 'Mac14,2',
    });
    assert.equal(reg.status, 200);
    const { id, token } = reg.json;
    assert.ok(id && token);

    const bad = await post(s.base, '/api/ingest', snapshot('nope'));
    assert.equal(bad.status, 401);

    const ing = await post(s.base, '/api/ingest', snapshot(token));
    assert.equal(ing.status, 200);

    const devices = await get(s.base, '/api/devices');
    assert.equal(devices.json.length, 1);
    assert.equal(devices.json[0].name, 'MacBook');

    const latest = await get(s.base, `/api/devices/${id}/latest`);
    assert.equal(latest.json.cpu_usage, 42.5);
    assert.equal(latest.json.token, undefined);

    const summary = await get(s.base, `/api/devices/${id}/summary`);
    assert.equal(summary.json.memory.percent, 50);
    assert.equal(summary.json.temperatures.length, 2);

    const fields = await get(s.base, `/api/devices/${id}/fields`);
    const cpu = fields.json.fields.find(f => f.field === 'cpu_usage');
    assert.equal(cpu.min, 42.5);
    assert.equal(cpu.count, 1);

    const hist = await get(s.base, `/api/devices/${id}/history?field=cpu_usage&from=-1h&bucket=60`);
    assert.ok(hist.json.count >= 1);
    assert.ok(hist.json.history[0].avg !== undefined);

    const missing = await get(s.base, '/api/devices/nope');
    assert.equal(missing.status, 404);
  } finally {
    await closeServer(s);
  }
});

test('--auth-token protects reads but not device-token writes', async () => {
  const s = await startServer({ authToken: 'admin-secret' });
  try {
    const noAuth = await get(s.base, '/api/devices');
    assert.equal(noAuth.status, 401);

    const withAuth = await get(s.base, '/api/devices', { Authorization: 'Bearer admin-secret' });
    assert.equal(withAuth.status, 200);

    const reg = await post(s.base, '/api/register', { clientKey: 'ck-sec', name: 'SecBox' });
    const ing = await post(s.base, '/api/ingest', snapshot(reg.json.token));
    assert.equal(ing.status, 200);
  } finally {
    await closeServer(s);
  }
});

test('history survives a server restart (same db file)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcmt-restart-'));
  const dbPath = path.join(dir, 'server.db');

  const store1 = new Store({ dbPath });
  const handler1 = createHandler({ store: store1 });
  const server1 = http.createServer(handler1);
  await new Promise(resolve => server1.listen(0, '127.0.0.1', resolve));
  const base1 = `http://127.0.0.1:${server1.address().port}`;

  const reg = await post(base1, '/api/register', { clientKey: 'ck-restart', name: 'RestartBox' });
  const ts = Date.now();
  await post(base1, '/api/ingest', { token: reg.json.token, cpu_usage: 88, ts });
  await new Promise(resolve => server1.close(resolve));
  store1.close();

  const store2 = new Store({ dbPath });
  const handler2 = createHandler({ store: store2 });
  const server2 = http.createServer(handler2);
  await new Promise(resolve => server2.listen(0, '127.0.0.1', resolve));
  const base2 = `http://127.0.0.1:${server2.address().port}`;
  try {
    const hist = await get(base2, `/api/devices/${reg.json.id}/history?field=cpu_usage&from=${ts - 1000}&to=${ts + 1000}`);
    assert.ok(hist.json.count >= 1);
    assert.equal(hist.json.history[0].value, 88);
  } finally {
    await new Promise(resolve => server2.close(resolve));
    store2.close();
  }
});
