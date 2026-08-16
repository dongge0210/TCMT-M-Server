#!/usr/bin/env node
// tcmt-server — TCMT-M relay backend (frontend/backend separated).
//   * ingest:  receives snapshots pushed by TCMT-M --http (ServerProbe)
//   * persist: SQLite storage (snapshots + timeseries), configurable retention
//   * serve:   REST + WebSocket for the standalone viewer (TCMT-M-viewer)
// Usage: node server.js [--port 8080] [--host 0.0.0.0] [--db ~/.tcmt/server.db]
//                      [--retention-days 30] [--cors-origin *] [--auth-token ...]
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.js';
import { createHandler } from './lib/api.js';
import { createStatic } from './lib/static.js';
import { createArchiver, queryInflux } from './lib/archive.js';
import { isWsRequest, acceptUpgrade, send, createTicketStore } from './lib/ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '1.0.0';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg('--port', process.env.TCMT_SERVER_PORT || '8080'));
// Cross-device default: listen on all interfaces so TCMT-M clients and
// viewers on other machines can reach the server over the network.
const HOST = arg('--host', process.env.TCMT_SERVER_HOST || '0.0.0.0');
const DB_PATH = path.resolve(arg('--db', process.env.TCMT_SERVER_DB || '~/.tcmt/server.db').replace(/^~/, os.homedir()));
const RETENTION_DAYS = Number(arg('--retention-days', process.env.TCMT_SERVER_RETENTION || '30'));
const CORS_ORIGIN = arg('--cors-origin', process.env.TCMT_SERVER_CORS_ORIGIN || '*');
const AUTH_TOKEN = arg('--auth-token', process.env.TCMT_SERVER_TOKEN || '');
const PUBLIC_URL = arg('--public-url', process.env.TCMT_SERVER_PUBLIC_URL || '');
const TLS_CERT = arg('--tls-cert', process.env.TCMT_SERVER_TLS_CERT || '');
const TLS_KEY = arg('--tls-key', process.env.TCMT_SERVER_TLS_KEY || '');
const SCHEME = TLS_CERT && TLS_KEY ? 'https' : 'http';

// Long-term archiving into InfluxDB (optional — disabled unless the URL is set).
const INFLUX_URL = arg('--influx-url', process.env.TCMT_INFLUX_URL || '');
const INFLUX_TOKEN = arg('--influx-token', process.env.TCMT_INFLUX_TOKEN || '');
const INFLUX_ORG = arg('--influx-org', process.env.TCMT_INFLUX_ORG || 'tcmt');
const INFLUX_BUCKET = arg('--influx-bucket', process.env.TCMT_INFLUX_BUCKET || 'tcmt');

if (Boolean(TLS_CERT) !== Boolean(TLS_KEY)) {
  console.error('[tcmt-server] --tls-cert and --tls-key must be provided together');
  process.exit(1);
}

// Legacy device registry migration candidates (old data/devices.json layout).
const legacyDevices = [
  path.resolve(__dirname, arg('--legacy-devices', '')),
  path.join(__dirname, 'data', 'devices.json'),
  path.join(os.homedir(), '.tcmt', 'devices.json'),
].filter(Boolean);

const store = new Store({
  dbPath: DB_PATH,
  retentionDays: RETENTION_DAYS,
  legacyDevices,
});
const clients = new Set();
const wsTickets = createTicketStore();
const archiver = createArchiver({
  store,
  influxUrl: INFLUX_URL,
  token: INFLUX_TOKEN,
  org: INFLUX_ORG,
  bucket: INFLUX_BUCKET,
});

function broadcast(obj) {
  const text = JSON.stringify(obj);
  for (const client of [...clients]) send(client, text);
}

const apiHandler = createHandler({
  store,
  authToken: AUTH_TOKEN,
  corsOrigin: CORS_ORIGIN,
  serverInfo: {
    version: VERSION,
    startTime: Date.now(),
    wsClients: () => clients.size,
    issueWsTicket: () => wsTickets.issue(),
    // Long-history queries against the archive bucket (null when disabled).
    queryArchive: INFLUX_URL
      ? q => queryInflux({
          influxUrl: INFLUX_URL, token: INFLUX_TOKEN,
          org: INFLUX_ORG, bucket: INFLUX_BUCKET, ...q,
        })
      : null,
  },
  onSnapshot(device) {
    broadcast({ type: 'snapshot', deviceId: device.id, data: device.latest });
  },
});

// Built-in dashboard (dashboard/ folder) served at /dashboard/; everything
// else falls through to the API router.
const dashboard = createStatic({
  root: path.join(__dirname, 'dashboard'),
  prefix: '/dashboard/',
});
const handler = (req, res) => {
  if (!dashboard(req, res)) apiHandler(req, res);
};

const server = SCHEME === 'https'
  ? https.createServer({
      key: fs.readFileSync(TLS_KEY),
      cert: fs.readFileSync(TLS_CERT),
    }, handler)
  : http.createServer(handler);

server.on('upgrade', (req, socket) => {
  if (!isWsRequest(req)) {
    socket.destroy();
    return;
  }
  acceptUpgrade(
    req,
    socket,
    client => {
      clients.add(client);
      send(client, JSON.stringify({
        type: 'hello',
        server: 'tcmt-server',
        version: VERSION,
        publicUrl: PUBLIC_URL || `${SCHEME}://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`,
      }));
    },
    client => clients.delete(client),
    { authToken: AUTH_TOKEN, tickets: AUTH_TOKEN ? wsTickets : null }
  );
});

// Periodic device-list + fleet-aggregate + alert broadcast (0.5s cadence).
setInterval(() => {
  broadcast({ type: 'devices', data: store.list() });
  broadcast({ type: 'aggregate', data: store.aggregate() });
  broadcast({ type: 'alerts', data: store.alerts() });
}, 500);

server.listen(PORT, HOST, () => {
  console.log(`[tcmt-server] v${VERSION} listening on ${SCHEME}://${HOST}:${PORT}`);
  console.log(`[tcmt-server] database : ${DB_PATH} (retention ${RETENTION_DAYS}d)`);
  console.log(`[tcmt-server] CORS     : ${CORS_ORIGIN}`);
  if (PUBLIC_URL) console.log(`[tcmt-server] public   : ${PUBLIC_URL}`);
  if (AUTH_TOKEN) console.log('[tcmt-server] auth     : read APIs + /ws require Bearer <token> (--auth-token)');
  if (INFLUX_URL) console.log(`[tcmt-server] archive  : InfluxDB ${INFLUX_URL} (org ${INFLUX_ORG}, bucket ${INFLUX_BUCKET})`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    for (const iface of lanAddresses()) {
      console.log(`[tcmt-server] LAN API   : ${SCHEME}://${iface.address}:${PORT}/`);
    }
    console.log('[tcmt-server] client    : run TCMT-M and point it at this server from its TUI settings');
    console.log(AUTH_TOKEN
      ? '[tcmt-server] read APIs are protected by --auth-token'
      : '[tcmt-server] WARNING: read APIs are unauthenticated; set --auth-token for public exposure.');
  }
  console.log(`[tcmt-server] dashboard : ${SCHEME}://localhost:${PORT}/dashboard/`);
  console.log('[tcmt-server] viewer is a separate app: open TCMT-M-viewer/index.html or serve it statically.');
  archiver.start();
});

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (String(addr.family).includes('4') && !addr.internal) {
        out.push({ name, address: addr.address });
      }
    }
  }
  return out;
}

function shutdown() {
  archiver.stop();
  try { store.close(); } catch { /* already closed */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', err => console.error('[tcmt-server] uncaught:', err));
