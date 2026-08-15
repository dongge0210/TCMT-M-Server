// REST API router. Wire protocol is compatible with TCMT-M's ServerProbe
// (POST /api/register + /api/ingest). Frontend/backend are separated: this
// server never hosts the viewer — the viewer is a standalone app that talks
// to this API over CORS.

const MAX_BODY = 1024 * 1024;
const VERSION = '1.0.0';

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(httpError(413, 'payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJsonBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    throw httpError(400, 'invalid JSON body');
  }
}

// Accepts "-1h"/"-30m"/"-7d"/"-90s" or an absolute unix-ms timestamp.
function parseTime(value, fallback) {
  if (!value) return fallback;
  if (value[0] === '-') {
    const num = Number(value.slice(1, -1));
    const unit = value[value.length - 1];
    const ms = {
      s: 1000, m: 60000, h: 3600000, d: 86400000,
    }[unit] || 1000;
    return Date.now() - num * ms;
  }
  return Number(value) || fallback;
}

function authorized(authToken, req, url) {
  if (!authToken) return true;
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7) === authToken;
  return url.searchParams.get('access_token') === authToken;
}

export function createHandler({ store, onSnapshot, authToken = '', corsOrigin = '*', serverInfo = {} }) {
  return async function handle(req, res) {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;

      if (req.method === 'GET' && pathname === '/') {
        return json(res, 200, {
          service: 'tcmt-server',
          version: VERSION,
          note: 'API backend only — the viewer is a separate frontend app (TCMT-M-viewer).',
          endpoints: [
            'GET /ping',
            'POST /api/register',
            'POST /api/ingest',
            'POST /api/ws-ticket',
            'GET /api/aggregate',
            'GET /api/stats',
            'GET /api/alerts',
            'PUT /api/alerts',
            'GET /api/alerts/state',
            'GET /api/compare',
            'GET /api/devices/:id/export',
            'PATCH /api/devices/:id',
            'GET /api/devices',
            'GET /api/devices/:id',
            'GET /api/devices/:id/latest',
            'GET /api/devices/:id/summary',
            'GET /api/devices/:id/fields',
            'GET /api/devices/:id/history?field=&from=&to=&limit=&bucket=',
            'GET /api/devices/:id/temperatures',
            'WS /ws',
          ],
        });
      }

      if (req.method === 'GET' && pathname === '/ping') {
        return json(res, 200, { status: 'ok', time: Date.now() });
      }

      if (req.method === 'POST' && pathname === '/api/register') {
        const body = parseJsonBody(await readBody(req));
        const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        const device = store.register(body.clientKey || '', body.name, body.os, body.model, ip);
        // Handshake response: the client learns the server identity/version.
        return json(res, 200, {
          id: device.id, token: device.token, name: device.name,
          server: 'tcmt-server', version: VERSION,
        });
      }

      if (req.method === 'POST' && pathname === '/api/ingest') {
        const body = parseJsonBody(await readBody(req));
        // Only device tokens can write; admin token (--auth-token) protects reads.
        if (!store.auth(body.token)) throw httpError(401, 'unauthorized');
        const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        const device = store.ingest(body.token, body, Date.now(), ip);
        if (!device) throw httpError(401, 'unauthorized');
        if (onSnapshot) onSnapshot(device);
        return json(res, 200, { status: 'ok' });
      }

      // Single-use short-TTL ticket for browser WebSocket auth (the browser
      // WebSocket API cannot set the Authorization header).
      if (req.method === 'POST' && pathname === '/api/ws-ticket') {
        if (!authorized(authToken, req, url)) throw httpError(401, 'missing or invalid access token');
        if (!serverInfo.issueWsTicket) throw httpError(500, 'ticket issuer unavailable');
        return json(res, 200, serverInfo.issueWsTicket());
      }

      // Device management: rename / regroup / annotate.
      if (req.method === 'PATCH' && pathname.startsWith('/api/devices/')) {
        if (!authorized(authToken, req, url)) throw httpError(401, 'missing or invalid access token');
        const id = decodeURIComponent(pathname.slice('/api/devices/'.length));
        const body = parseJsonBody(await readBody(req));
        const d = store.updateDevice(id, body);
        if (!d) throw httpError(404, 'device not found');
        return json(res, 200, {
          id: d.id, name: d.name, displayName: d.displayName || d.name,
          group: d.group, note: d.note,
        });
      }

      // Alert rules: PUT with {rules: [{field, op, value}, ...]}.
      if (req.method === 'PUT' && pathname === '/api/alerts') {
        if (!authorized(authToken, req, url)) throw httpError(401, 'missing or invalid access token');
        const body = parseJsonBody(await readBody(req));
        const rules = (Array.isArray(body.rules) ? body.rules : []).filter(r =>
          r && typeof r.field === 'string' && (r.op === '>' || r.op === '<') &&
          typeof r.value === 'number');
        store.setAlertRules(rules);
        return json(res, 200, { rules });
      }

      if (req.method === 'GET' && pathname.startsWith('/api/')) {
        if (!authorized(authToken, req, url)) throw httpError(401, 'missing or invalid access token');
      }

      if (req.method === 'GET' && pathname === '/api/aggregate') {
        return json(res, 200, store.aggregate());
      }

      if (req.method === 'GET' && pathname === '/api/alerts') {
        return json(res, 200, { rules: store.alertRules() });
      }

      if (req.method === 'GET' && pathname === '/api/alerts/state') {
        return json(res, 200, store.alerts());
      }

      if (req.method === 'GET' && pathname === '/api/compare') {
        const field = url.searchParams.get('field') || '';
        const devices = (url.searchParams.get('devices') || '').split(',').filter(Boolean);
        if (!field || !devices.length) throw httpError(400, 'field and devices required');
        const from = parseTime(url.searchParams.get('from'), Date.now() - 3600000);
        const to = parseTime(url.searchParams.get('to'), Date.now());
        const bucket = Number(url.searchParams.get('bucket')) || 30;
        const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit')) || 1000));
        return json(res, 200, {
          field, from, to, bucket,
          series: store.compare(field, devices, from, to, limit, bucket),
        });
      }

      if (req.method === 'GET' && pathname === '/api/stats') {
        const uptimeSec = serverInfo.startTime
          ? Math.floor((Date.now() - serverInfo.startTime) / 1000)
          : 0;
        return json(res, 200, {
          service: 'tcmt-server',
          version: serverInfo.version || VERSION,
          uptimeSec,
          wsClients: serverInfo.wsClients ? serverInfo.wsClients() : 0,
          memRssBytes: process.memoryUsage().rss,
          ...store.stats(),
        });
      }

      if (req.method === 'GET' && pathname === '/api/devices') {
        return json(res, 200, store.list());
      }

      const deviceMatch = pathname.match(/^\/api\/devices\/([^/]+)(?:\/([^?/]+))?/);
      if (req.method === 'GET' && deviceMatch) {
        const id = decodeURIComponent(deviceMatch[1]);
        const sub = deviceMatch[2] || '';
        const device = store.get(id);
        if (!device) throw httpError(404, 'device not found');
        if (!sub) {
          const now = Date.now();
          return json(res, 200, {
            id: device.id,
            name: device.name,
            os: device.os,
            model: device.model,
            online: now - device.lastSeen < 15000,
            lastSeen: device.lastSeen,
          });
        }
        if (sub === 'latest') return json(res, 200, device.latest);
        if (sub === 'summary') return json(res, 200, store.summary(id));
        if (sub === 'fields') return json(res, 200, { deviceId: id, fields: store.fields(id) || [] });
        if (sub === 'temperatures') {
          const summary = store.summary(id);
          return json(res, 200, (summary && summary.temperatures) || []);
        }
        if (sub === 'export') {
          const field = url.searchParams.get('field') || '';
          if (!field) throw httpError(400, "missing 'field' query parameter");
          const from = parseTime(url.searchParams.get('from'), Date.now() - 3600000);
          const to = parseTime(url.searchParams.get('to'), Date.now());
          const out = store.exportCsv(id, field, from, to);
          if (!out) throw httpError(404, 'no data');
          const filename = `${out.name.replace(/[^\w.-]+/g, '_')}_${field}.csv`;
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Length': Buffer.byteLength(out.csv),
          });
          return res.end(out.csv);
        }
        if (sub === 'history') {
          const field = url.searchParams.get('field') || '';
          if (!field) throw httpError(400, "missing 'field' query parameter");
          const from = parseTime(url.searchParams.get('from'), Date.now() - 3600000);
          const to = parseTime(url.searchParams.get('to'), Date.now());
          const requested = Number(url.searchParams.get('limit'));
          const limit = Math.max(1, Math.min(5000, Number.isFinite(requested) ? requested : 1000));
          const bucketRaw = Number(url.searchParams.get('bucket'));
          const bucket = Number.isFinite(bucketRaw)
            ? Math.max(1, Math.min(604800, Math.floor(bucketRaw)))
            : 1;
          const history = store.history(id, field, from, to, limit, bucket) || [];
          return json(res, 200, {
            deviceId: id, field, from, to, count: history.length, bucket, history,
          });
        }
        if (Object.prototype.hasOwnProperty.call(device.latest, sub)) {
          return json(res, 200, device.latest[sub]);
        }
        throw httpError(404, 'unknown sub-resource');
      }

      throw httpError(404, 'not found');
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[api]', err);
      return json(res, status, { error: err.message || 'internal error' });
    }
  };
}
