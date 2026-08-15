import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/store.js';
import { createHandler } from '../lib/api.js';
import { createStatic } from '../lib/static.js';
import { createTicketStore } from '../lib/ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function startServer({ authToken = '', corsOrigin = '*', serverInfo = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcmt-api-'));
  const store = new Store({ dbPath: path.join(dir, 'server.db') });
  const handler = createHandler({ store, authToken, corsOrigin, serverInfo });
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

test('stats endpoint reports server + store info', async () => {
  const startTime = Date.now() - 2000;
  const s = await startServer({
    serverInfo: { version: '9.9.9', startTime, wsClients: () => 5 },
  });
  try {
    await post(s.base, '/api/register', { clientKey: 'ck-stats', name: 'StatBox' });
    const stats = await get(s.base, '/api/stats');
    assert.equal(stats.status, 200);
    assert.equal(stats.json.service, 'tcmt-server');
    assert.equal(stats.json.version, '9.9.9');
    assert.equal(stats.json.uptimeSec, 2);
    assert.equal(stats.json.wsClients, 5);
    assert.equal(stats.json.deviceCount, 1);
    assert.equal(stats.json.onlineDevices, 1);
    assert.equal(stats.json.retentionDays, 30);
    assert.ok(stats.json.dbPath.endsWith('server.db'));
    assert.ok(stats.json.dbSizeBytes >= 0);
    assert.ok(stats.json.ingestCount >= 0);
    assert.ok(stats.json.memRssBytes > 0);

    // Protected by --auth-token like the other read APIs.
    const s2 = await startServer({ authToken: 'admin-secret' });
    try {
      const denied = await get(s2.base, '/api/stats');
      assert.equal(denied.status, 401);
    } finally {
      await closeServer(s2);
    }
  } finally {
    await closeServer(s);
  }
});

test('dashboard is served at /dashboard/ and blocks traversal', async () => {
  const staticHandler = createStatic({ root: path.join(__dirname, '..', 'dashboard') });
  // Wrap the API handler the way server.js does.
  const store = new Store({ dbPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tcmt-dash-')), 's.db') });
  const apiHandler = createHandler({ store });
  const server = http.createServer((req, res) => {
    if (!staticHandler(req, res)) apiHandler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base + '/dashboard/');
    assert.equal(page.status, 200);
    assert.ok((page.headers.get('content-type') || '').includes('text/html'));
    assert.ok((await page.text()).includes('TCMT Server Dashboard'));

    // /dashboard serves the same index (no redirect loop).
    const redir = await fetch(base + '/dashboard');
    assert.equal(redir.status, 200);
    assert.ok((redir.headers.get('content-type') || '').includes('text/html'));

    const missing = await fetch(base + '/dashboard/nope.js');
    assert.equal(missing.status, 404);

    // Encoded traversal must never serve files outside the dashboard dir.
    // (URL parsing normalizes %2e%2e to a dot segment, so this 404s via the
    // API router; the static handler's 403 guard is defense in depth.)
    const traversal = await new Promise(resolve => {
      const req = http.request(
        { host: '127.0.0.1', port: server.address().port, path: '/dashboard/%2e%2e/server.js' },
        res => {
          let body = '';
          res.on('data', c => { body += c; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        }
      );
      req.end();
    });
    assert.equal(traversal.status, 404);
    assert.ok(!traversal.body.includes('tcmt-server'));

    // API still routes alongside static.
    const ping = await fetch(base + '/ping');
    assert.equal(ping.status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.close();
  }
});

test('ws-ticket endpoint issues authenticated single-use tickets', async () => {
  const s = await startServer({ authToken: 'admin-secret', serverInfo: {
    issueWsTicket: createTicketStore().issue,
  } });
  try {
    const denied = await post(s.base, '/api/ws-ticket', {});
    assert.equal(denied.status, 401);

    const ok = await post(s.base, '/api/ws-ticket', {}, { Authorization: 'Bearer admin-secret' });
    assert.equal(ok.status, 200);
    assert.ok(ok.json.ticket);
    assert.equal(ok.json.expiresIn, 30000);
  } finally {
    await closeServer(s);
  }
});

test('ws tickets are single-use and expire', async () => {
  const store = createTicketStore({ ttlMs: 30 });
  const { ticket } = store.issue();
  assert.equal(store.consume(ticket), true);
  assert.equal(store.consume(ticket), false); // single use
  assert.equal(store.consume('nope'), false);

  const t2 = store.issue().ticket;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(store.consume(t2), false); // expired
});

test('aggregate endpoint summarizes the fleet', async () => {
  const s = await startServer();
  try {
    const a = await post(s.base, '/api/register', { clientKey: 'ck-agg-api-a', name: 'BoxA' });
    const b = await post(s.base, '/api/register', { clientKey: 'ck-agg-api-b', name: 'BoxB' });
    await post(s.base, '/api/ingest', snapshot(a.json.token));
    await post(s.base, '/api/ingest', { ...snapshot(b.json.token), cpu_usage: 90, gpu_usage: 50 });

    const agg = await get(s.base, '/api/aggregate');
    assert.equal(agg.status, 200);
    assert.equal(agg.json.total, 2);
    assert.equal(agg.json.online, 2);
    assert.equal(agg.json.cpu.usage.avg, 66.25);
    assert.equal(agg.json.cpu.usage.max, 90);
    assert.equal(agg.json.cpu.usage.maxDevice, b.json.id);
    assert.equal(agg.json.temperatures.max.value, 60.1); // max(CPU temps, SSD array)
    assert.equal(agg.json.temperatures.avg, 46.65);

    // Protected by --auth-token like the other read APIs.
    const s2 = await startServer({ authToken: 'admin-secret' });
    try {
      const denied = await get(s2.base, '/api/aggregate');
      assert.equal(denied.status, 401);
      const allowed = await get(s2.base, '/api/aggregate', { Authorization: 'Bearer admin-secret' });
      assert.equal(allowed.status, 200);
    } finally {
      await closeServer(s2);
    }
  } finally {
    await closeServer(s);
  }
});
