// Long-term archiver: moves rows older than the SQLite retention window
// into InfluxDB (line protocol over HTTP, zero npm deps). Unidirectional —
// the SQLite store stays the system of record for recent data; Influx is
// append-only long history. Runs bounded batches per tick so a single pass
// never blocks the ingest path for long.
import http from 'node:http';
import https from 'node:https';

const BATCH = 5000;
const MAX_BATCHES_PER_TICK = 20;

function postLineProtocol(influxUrl, token, org, bucket, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(influxUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const path = `/api/v2/write?org=${encodeURIComponent(org)}&bucket=${encodeURIComponent(bucket)}&precision=ms`;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Token ' + token,
      },
      timeout: 15000,
    }, res => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('influx write timeout')));
    req.end(body);
  });
}

function escapeTag(v) {
  return String(v).replace(/([ ,=])/g, '\\$1');
}

function escapeField(v) {
  return String(v).replace(/(["\\])/g, '\\$1');
}

function toLineProtocol(rows) {
  const lines = [];
  for (const r of rows) {
    // measurement: tcmt_metric, tags: device_id + field, value as float
    lines.push(
      `tcmt_metric,device_id=${escapeTag(r.deviceId)},field=${escapeTag(r.field)} value=${r.value} ${r.ts}`
    );
  }
  return lines.join('\n');
}

// createArchiver({ store, influxUrl, token, org, bucket, intervalMs }) ->
//   { start(), stop(), runOnce() }.
// runOnce drains up to MAX_BATCHES_PER_TICK batches; start() runs it on an
// interval and once at startup.
export function createArchiver({ store, influxUrl, token, org, bucket, intervalMs = 3600000 }) {
  let timer = null;
  let running = false;

  async function runOnce() {
    if (running || !influxUrl) return { archived: 0 };
    running = true;
    const cutoff = Date.now() - store.retentionMs;
    let archived = 0;
    try {
      for (let i = 0; i < MAX_BATCHES_PER_TICK; i += 1) {
        const { rows, remaining } = store.drainOldTimeseries(cutoff, BATCH);
        if (!rows.length) break;
        const ok = await postLineProtocol(influxUrl, token, org, bucket, toLineProtocol(rows));
        if (!ok) throw new Error(`influx rejected batch (HTTP ${ok})`);
        archived += rows.length;
        if (!remaining) break;
      }
    } catch (err) {
      console.error('[archive] timeseries archive failed:', err.message);
    } finally {
      running = false;
    }
    return { archived };
  }

  function start() {
    if (!influxUrl) return; // archiving disabled
    runOnce().then(r => {
      if (r.archived) console.log(`[archive] archived ${r.archived} rows`);
    }).catch(() => {});
    timer = setInterval(() => {
      runOnce().then(r => {
        if (r.archived) console.log(`[archive] archived ${r.archived} rows`);
      }).catch(() => {});
    }, intervalMs);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, runOnce };
}
