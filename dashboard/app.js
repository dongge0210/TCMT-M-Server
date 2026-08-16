// TCMT Server Dashboard — fleet overview + server stats.
// Data sources:
//   WS aggregate (0.5s)  -> fleet stat cards + sparklines
//   WS devices  (0.5s)   -> device table status
//   WS snapshot (on ingest) -> per-device latest values + ingest rate
//   REST /api/stats (5s) -> wsClients / uptime / db path / retention
const API = (localStorage.getItem('tcmt_api') || window.TCMT_API || location.origin)
  .trim().replace(/\/+$/, '');

let accessToken = localStorage.getItem('tcmt_viewer_token') || '';
let promptShown = false;

const state = {
  devices: [],            // list from WS /api/devices
  latestNow: {},          // id -> latest snapshot
  aggregate: null,
  sparks: { cpu: [], mem: [], gpu: [], temp: [] },
  ingestTimes: [],        // snapshot message timestamps (last 10s)
  ws: null,
  reconnectTimer: null,
  backfilling: new Set(),
  detailId: null,         // device detail overlay
  detailField: 'cpu_usage',
  detailRange: '1h',
  detailFields: [],
  alerts: { rules: [], active: [] },
  selected: new Set(),    // devices picked for comparison
  compareField: 'cpu_usage',
  compareRange: '1h',
  compareDevices: [],
};

const SPARK_CAP = 120; // 0.5s cadence -> ~1 minute
const MAX_BACKFILL_RETRY = 3;

const $ = id => document.getElementById(id);

/* ── helpers ─────────────────────────────────────────── */
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (accessToken) headers['Authorization'] = 'Bearer ' + accessToken;
  const res = await fetch(API + path, { ...opts, headers });
  if (res.status === 401) {
    await askAccessToken();
    throw new Error('401 unauthorized');
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function askAccessToken() {
  if (promptShown) return;
  promptShown = true;
  const token = window.prompt('该 server 需要访问令牌（--auth-token 配置的值）：');
  if (token) {
    accessToken = token.trim();
    localStorage.setItem('tcmt_viewer_token', accessToken);
    location.reload();
  }
}

function fmt(v, digits = 1) {
  return v === undefined || v === null || Number.isNaN(Number(v)) ? '--' : Number(v).toFixed(digits);
}

function fmtBytes(v) {
  if (v === undefined || v === null) return '';
  const n = Number(v);
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  let x = n;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
  return x.toFixed(1) + ' ' + units[i];
}

function fmtSpeed(bps) {
  if (bps === undefined || bps === null || !Number.isFinite(Number(bps))) return '--';
  const v = Number(bps) / (1024 * 1024);
  return v.toFixed(1) + ' MB/s';
}

// Escape strings interpolated into innerHTML (device names/os/model are
// client-supplied and must never be treated as markup).
function esc(s) {
  return String(s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function timeAgo(ts) {
  if (!ts) return '--';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return '刚刚';
  if (s < 60) return s + 's 前';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm 前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h 前';
  return Math.floor(h / 24) + 'd 前';
}

function fmtUptime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '--';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${sec % 60}s`;
}

function devName(id) {
  const d = state.devices.find(x => x.id === id);
  return d ? d.name : id;
}

function setConn(mode) {
  $('connDot').className = 'dot ' + mode;
  $('connText').textContent =
    mode === 'on' ? '实时连接' : mode === 'poll' ? '轮询模式' : '未连接';
}

/* ── fleet stat cards (WS aggregate) ────────────────── */
function renderFleet() {
  const a = state.aggregate;
  if (!a) return;
  $('statTotal').textContent = a.total;
  $('statOnline').textContent = a.online;
  $('statOffline').textContent = a.offline;

  const cpu = a.cpu.usage;
  $('statCpuAvg').textContent = fmt(cpu && cpu.avg, 0);
  $('statCpuPeak').innerHTML = peakText(cpu, '%'); // safe: values are numbers, name is esc()'d
  const mem = a.memory.percent;
  $('statMemAvg').textContent = fmt(mem && mem.avg, 0);
  $('statMemPeak').innerHTML = peakText(mem, '%');
  const gpu = a.gpu.usage;
  $('statGpuAvg').textContent = fmt(gpu && gpu.avg, 0);
  $('statGpuPeak').innerHTML = peakText(gpu, '%');

  const tmax = a.temperatures.max;
  if (tmax) {
    $('statTempMax').textContent = `${fmt(tmax.value, 1)}°C`;
    $('statTempSub').innerHTML =
      `${esc(tmax.name)} · ${esc(devName(tmax.deviceId))}` +
      (a.temperatures.avg !== null ? ` · 均值 ${fmt(a.temperatures.avg, 1)}°C` : '');
  } else {
    $('statTempMax').textContent = '--';
    $('statTempSub').textContent = '';
  }
}

function peakText(stat, unit) {
  if (!stat) return '';
  const cls = stat.max > 80 ? ' class="hot"' : '';
  return `峰值 <b${cls}>${fmt(stat.max, 0)}${unit}</b> · ${esc(devName(stat.maxDevice))}`;
}

/* ── sparklines (fleet avg trend, WS aggregate) ─────── */
function pushSparks() {
  const a = state.aggregate;
  if (!a) return;
  const feed = {
    cpu: a.cpu.usage ? a.cpu.usage.avg : null,
    mem: a.memory.percent ? a.memory.percent.avg : null,
    gpu: a.gpu.usage ? a.gpu.usage.avg : null,
    temp: a.temperatures.avg,
  };
  for (const [key, value] of Object.entries(feed)) {
    if (value === null || value === undefined) continue;
    const arr = state.sparks[key];
    arr.push(value);
    if (arr.length > SPARK_CAP) arr.shift();
  }
  drawSparks();
}

function drawSparks() {
  for (const [key, canvasId] of Object.entries({ cpu: 'sparkCpu', mem: 'sparkMem', gpu: 'sparkGpu', temp: 'sparkTemp' })) {
    const values = state.sparks[key];
    const canvas = $(canvasId);
    if (!canvas || !values || values.length < 2) continue;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 220;
    const h = canvas.clientHeight || 44;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (max === min) { min -= 1; max += 1; }
    const x = i => (i / (values.length - 1)) * w;
    const y = v => 2 + (1 - (v - min) / (max - min)) * (h - 4);
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    values.forEach((v, i) => {
      if (i === 0) ctx.moveTo(x(i), y(v));
      else ctx.lineTo(x(i), y(v));
    });
    ctx.stroke();

    // Current value label (e.g. "32.8%" / "43.2°C") next to the trend.
    const units = { cpu: '%', mem: '%', gpu: '%', temp: '°C' };
    const label = $('sparkVal' + key.charAt(0).toUpperCase() + key.slice(1));
    if (label) label.textContent = values[values.length - 1].toFixed(1) + (units[key] || '');
  }
}

/* ── device table ───────────────────────────────────── */
// Rows are only rebuilt when the device set changes; value updates happen
// in place so text selection and hover states never flicker.
const EMPTY_ROWS =
  '<tr><td colspan="10" class="empty">等待设备接入…（启动 TCMT-M --http 后自动出现）</td></tr>';

function deviceRowMarkup(d) {
  return (
    // esc(d.id) keeps the attribute safe (ids can come from legacy migration);
    // CSS.escape(raw id) still matches because HTML parsing restores the raw value.
    `<tr data-device="${esc(d.id)}" tabindex="0">` +
    `<td class="col-sel"><input type="checkbox" class="sel" data-id="${esc(d.id)}" aria-label="选择对比"></td>` +
    `<td><span class="dname"><span class="dot"></span><span class="cell-name">${esc(d.displayName || d.name)}</span></span>` +
    `<span class="cell-state" style="font-size:11px;color:var(--muted)"></span>` +
    `<span class="cell-sub"></span></td>` +
    `<td class="cell-os">${esc(d.os || '--')}</td>` +
    `<td>${esc(d.model || '--')}</td>` +
    `<td class="num cell-ip">--</td>` +
    `<td class="num cell-cpu">--</td>` +
    `<td class="num cell-mem">--</td>` +
    `<td class="num cell-gpu">--</td>` +
    `<td class="num cell-temp">--</td>` +
    `<td class="cell-seen">--</td>` +
    `</tr>`
  );
}

function renderGroupFilter() {
  const groups = [...new Set(state.devices.map(d => d.group).filter(Boolean))].sort();
  const sel = $('groupFilter');
  const prev = sel.value;
  sel.innerHTML = '<option value="">全部分组</option>' +
    groups.map(g => `<option>${esc(g)}</option>`).join('');
  if (groups.includes(prev)) sel.value = prev;
}

function renderDevices() {
  const tbody = $('deviceRows');
  $('deviceCount').textContent = state.devices.length ? `${state.devices.length} 台` : '';
  const group = $('groupFilter').value;
  const visible = group ? state.devices.filter(d => d.group === group) : state.devices;
  const ids = visible.map(d => d.id).join(',');
  if (ids !== state.deviceIds) {
    state.deviceIds = ids;
    tbody.innerHTML = visible.length ? visible.map(deviceRowMarkup).join('') : EMPTY_ROWS;
    renderGroupFilter();
  }
  if (!visible.length) return;
  for (const d of visible) {
    const row = tbody.querySelector(`tr[data-device="${CSS.escape(d.id)}"]`);
    if (!row) {
      state.deviceIds = ''; // structure is stale — rebuild once
      renderDevices();
      return;
    }
    const data = state.latestNow[d.id];
    const cpu = data && data.cpu_usage !== undefined ? data.cpu_usage : null;
    const mem = data && data.memory_total && data.memory_used !== undefined
      ? (data.memory_used / data.memory_total) * 100 : null;
    const gpu = data && data.gpu_usage !== undefined ? data.gpu_usage : null;
    const temp = data && data.cpu_temp !== undefined ? data.cpu_temp : null;
    row.querySelector('.cell-ip').textContent = d.ip || '--';
    row.querySelector('.cell-cpu').textContent = cpu === null ? '--' : cpu.toFixed(0) + '%';
    row.querySelector('.cell-mem').textContent = mem === null ? '--' : mem.toFixed(0) + '%';
    row.querySelector('.cell-gpu').textContent = gpu === null ? '--' : gpu.toFixed(0) + '%';
    row.querySelector('.cell-temp').textContent = temp === null ? '--' : temp.toFixed(1) + '°C';
    row.querySelector('.cell-seen').textContent = timeAgo(d.lastSeen);
    const osTxt = (d.os || '--') + (data && data.os_version ? ' ' + data.os_version : '');
    row.querySelector('.cell-os').textContent = osTxt;
    const sub = [];
    if (d.group) sub.push(d.group);
    if (data && data.cpu_name) sub.push(data.cpu_name);
    if (data && data.memory_total) sub.push(fmtBytes(data.memory_total));
    if (d.displayName && d.displayName !== d.name) sub.push('原名 ' + d.name);
    row.querySelector('.cell-sub').textContent = sub.join(' · ');
    const dot = row.querySelector('.dname .dot');
    dot.className = 'dot' + (d.online ? ' on' : '');
    row.querySelector('.cell-state').textContent = d.online ? '' : '· 离线';
    row.querySelector('.sel').checked = state.selected.has(d.id);
    row.classList.toggle('alerted', state.alerts.active.some(a => a.deviceId === d.id));
  }
}

$('groupFilter').addEventListener('change', () => {
  state.deviceIds = '';
  renderDevices();
});

/* ── device selection + compare ─────────────────────── */
function updateCompareBtn() {
  const n = state.selected.size;
  $('compareBtn').disabled = n < 2;
  $('compareBtn').textContent = `对比所选 (${n})`;
}
$('deviceRows').addEventListener('change', e => {
  const cb = e.target.closest('.sel');
  if (!cb) return;
  if (cb.checked) state.selected.add(cb.dataset.id);
  else state.selected.delete(cb.dataset.id);
  updateCompareBtn();
});
$('compareBtn').addEventListener('click', () => {
  if (state.selected.size < 2) return;
  openCompare([...state.selected]);
});

async function backfillLatest(id, retries = 0) {
  if (state.backfilling.has(id)) return;
  state.backfilling.add(id);
  try {
    state.latestNow[id] = await api('/api/devices/' + id + '/latest');
    renderDevices();
  } catch (err) {
    if (err.message !== '401 unauthorized' && retries < MAX_BACKFILL_RETRY) {
      setTimeout(() => backfillLatest(id, retries + 1), 3000);
    }
  } finally {
    state.backfilling.delete(id);
  }
}

/* ── server stats ───────────────────────────────────── */
async function loadStats() {
  try {
    const s = await api('/api/stats');
    $('statWs').textContent = s.wsClients;
    $('statDb').textContent = s.dbPath;
    $('statRetention').textContent = `${s.retentionDays} 天`;
    $('statUptime').textContent = fmtUptime(s.uptimeSec);
    $('versionTag').textContent = 'v' + s.version;
    // Server self-monitoring panel
    $('srvDbSize').textContent = fmtBytes(s.dbSizeBytes);
    $('srvIngests').textContent = String(s.ingestCount || 0);
    $('srvWs').textContent = s.wsClients;
    $('srvUptime').textContent = fmtUptime(s.uptimeSec);
    $('srvMem').textContent = fmtBytes(s.memRssBytes);
    $('srvVersion').textContent = 'v' + s.version;
  } catch { /* 401 handled by api(); network errors are transient */ }
}

function pruneIngestRate() {
  const cutoff = Date.now() - 10000;
  state.ingestTimes = state.ingestTimes.filter(t => t > cutoff);
  const rate = (state.ingestTimes.length / 10).toFixed(1) + '/s';
  $('statRate').textContent = rate;
  $('srvRate').textContent = rate;
}

/* ── alerts + rules editor ──────────────────────────── */
function renderAlerts() {
  const { rules, active } = state.alerts;
  $('statAlerts').textContent = active.length;
  $('statAlerts').style.color = active.length ? '#ef4444' : '';
  $('statAlertsSub').textContent = rules.length ? `${rules.length} 条规则` : '';
  $('alertsPanel').hidden = active.length === 0 && rules.length === 0;
  $('alertsList').innerHTML = active.length
    ? active.map(a =>
        `<li><span>${esc(a.deviceName)}</span>` +
        `<b>${esc(a.field)} ${esc(a.op)} ${a.value}</b>` +
        `<span>当前 <b>${a.current}</b></span></li>`
      ).join('')
    : '<li class="empty">当前无告警</li>';
  $('rulesRows').innerHTML = rules.map((r, i) =>
    `<div class="rule-row" data-i="${i}">` +
    `<input type="text" data-k="field" value="${esc(r.field)}" aria-label="字段" />` +
    `<select data-k="op"><option${r.op === '>' ? ' selected' : ''}>&gt;</option>` +
    `<option${r.op === '<' ? ' selected' : ''}>&lt;</option></select>` +
    `<input type="number" data-k="value" value="${r.value}" aria-label="阈值" />` +
    `<button type="button" class="btn danger" data-del="${i}" aria-label="删除规则">×</button>` +
    `</div>`
  ).join('');
}

function saveRules() {
  const rows = [...document.querySelectorAll('#rulesRows .rule-row')];
  const rules = rows.map(row => ({
    field: row.querySelector('[data-k=field]').value.trim(),
    op: row.querySelector('[data-k=op]').value === '<' ? '<' : '>',
    value: Number(row.querySelector('[data-k=value]').value),
  })).filter(r => r.field && Number.isFinite(r.value));
  api('/api/alerts', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules }),
  }).then(res => {
    state.alerts.rules = res.rules;
    renderAlerts();
    $('ruleHint').textContent = '已保存';
  }).catch(() => { $('ruleHint').textContent = '保存失败'; });
}

$('ruleAdd').addEventListener('click', () => {
  state.alerts.rules.push({ field: '', op: '>', value: 0 });
  renderAlerts();
});
$('rulesRows').addEventListener('click', e => {
  const del = e.target.closest('[data-del]');
  if (del) {
    state.alerts.rules.splice(Number(del.dataset.del), 1);
    renderAlerts();
  }
});
$('ruleSave').addEventListener('click', saveRules);

/* ── device detail page (hash-routed: #/device/<id>) ── */
function openDetail(id) {
  if (state.detailId === id) return;
  state.detailId = id;
  state.detailField = 'cpu_usage';
  state.detailRange = '1h';
  $('deviceOverlay').hidden = false;
  renderDetail();
  const d = state.devices.find(x => x.id === id);
  if (d) {
    $('mgrName').value = d.displayName || '';
    $('mgrGroup').value = d.group || '';
    $('mgrNote').value = d.note || '';
  }
  $('mgrHint').textContent = '';
  loadDetailFields();
  loadDetailHistory();
}

function closeDetail() {
  state.detailId = null;
  $('deviceOverlay').hidden = true;
}

// Deep links: #/device/<id> opens the page, any other hash returns to the
// dashboard. Row clicks navigate via location.hash so the back button works.
window.addEventListener('hashchange', () => {
  const m = location.hash.match(/^#\/device\/([^/]+)$/);
  if (m) openDetail(decodeURIComponent(m[1]));
  else {
    closeDetail();
    closeCompare();
  }
});

function renderDetail() {
  const id = state.detailId;
  const d = state.devices.find(x => x.id === id);
  const data = state.latestNow[id] || {};
  if (!d) return;
  $('detailName').innerHTML =
    `<span class="dot ${d.online ? 'on' : ''}"></span> ${esc(d.displayName || d.name)}`;
  const parts = [];
  parts.push(`系统 <b>${esc((d.os || '--') + (data.os_version ? ' ' + data.os_version : ''))}</b>`);
  parts.push(`型号 <b>${esc(d.model || '--')}</b>`);
  if (data.cpu_name) parts.push(`CPU <b>${esc(data.cpu_name)}</b>`);
  if (data.gpu_name) parts.push(`GPU <b>${esc(data.gpu_name)}</b>`);
  if (data.memory_total) parts.push(`内存 <b>${fmtBytes(data.memory_total)}</b>`);
  if (data.uptime !== undefined) parts.push(`运行 <b>${fmtUptime(data.uptime)}</b>`);
  parts.push(`最后在线 <b>${timeAgo(d.lastSeen)}</b>`);
  parts.push(`IP <b>${esc(d.ip || '--')}</b>`);
  parts.push(`ID <b>${esc(id)}</b>`);
  $('detailInfo').innerHTML = parts.join('');

  const temps = [];
  if (data.cpu_temp !== undefined) temps.push({ name: 'CPU', value: data.cpu_temp, unit: '°C' });
  if (data.gpu_temp !== undefined) temps.push({ name: 'GPU', value: data.gpu_temp, unit: '°C' });
  if (Array.isArray(data.temperatures)) {
    for (const t of data.temperatures) {
      if (t && t.value !== undefined) {
        temps.push({ name: t.name || 'Sensor', value: t.value, unit: t.unit || '°C' });
      }
    }
  }
  $('detailTemps').innerHTML = temps.length
    ? temps.map(t => `<li><span>${esc(t.name)}</span><b>${fmt(t.value, 1)}${esc(t.unit || '')}</b></li>`).join('')
    : '<li class="empty">暂无数据</li>';

  const m = [];
  if (data.ax !== undefined) m.push(['加速度', `${fmt(data.ax, 2)} / ${fmt(data.ay, 2)} / ${fmt(data.az, 2)} g`]);
  if (data.gx !== undefined) m.push(['角速度', `${fmt(data.gx, 2)} / ${fmt(data.gy, 2)} / ${fmt(data.gz, 2)} °/s`]);
  if (data.lidAngle !== undefined) m.push(['开合角', `${fmt(data.lidAngle, 1)}°`]);
  if (data.hb !== undefined) m.push(['心跳', String(data.hb)]);
  if (data.imut !== undefined) m.push(['IMU 温度', `${fmt(data.imut, 1)}°C`]);
  $('detailMotion').innerHTML = m.length
    ? m.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')
    : '<tr><td colspan="2" style="color:var(--muted)">暂无数据</td></tr>';

  // Disks (volumes): name + used/total with percent.
  const disks = Array.isArray(data.disks) ? data.disks : [];
  $('detailDisks').innerHTML = disks.length
    ? disks.map(d => {
        const used = d.used !== undefined && d.total
          ? `${fmtBytes(d.used)} / ${fmtBytes(d.total)}` : '--';
        const pct = d.used !== undefined && d.total
          ? ` (${((d.used / d.total) * 100).toFixed(0)}%)` : '';
        return `<tr><td>${esc(d.name || '?')}</td><td>${used}${pct}</td></tr>`;
      }).join('')
    : '<tr><td colspan="2" style="color:var(--muted)">暂无数据</td></tr>';

  // Network adapters: name + down/up speeds.
  const nets = Array.isArray(data.net) ? data.net : [];
  $('detailNet').innerHTML = nets.length
    ? nets.map(n =>
        `<tr><td>${esc(n.name || '?')}</td><td>↓ ${fmtSpeed(n.down)} · ↑ ${fmtSpeed(n.up)}</td></tr>`
      ).join('')
    : '<tr><td colspan="2" style="color:var(--muted)">暂无数据</td></tr>';

  // Battery (optional).
  const b = data.battery;
  $('detailBattery').innerHTML = b
    ? `<tr><td>电量</td><td>${b.percent}%${b.charging ? ' · 充电中' : ''}</td></tr>` +
      (b.health !== undefined
        ? `<tr><td>健康度</td><td>${fmt(b.health, 1)}%</td></tr>` : '')
    : '<tr><td colspan="2" style="color:var(--muted)">无电池</td></tr>';
}

async function loadDetailFields() {
  if (!state.detailId) return;
  try {
    const res = await api('/api/devices/' + state.detailId + '/fields');
    state.detailFields = res.fields || [];
    // Render values with units: memory_* are raw bytes, *_usage is %,
    // *_temp is °C, lidAngle is ° — everything else stays plain.
    const fmtVal = (field, v) => {
      if (field === 'memory_used' || field === 'memory_total') return fmtBytes(v);
      if (field === 'memory_percent' || field.endsWith('_usage')) return fmt(v, 1) + '%';
      if (field.endsWith('_temp') || field.includes('temp')) return fmt(v, 1) + '°C';
      if (field === 'lidAngle') return fmt(v, 1) + '°';
      return fmt(v);
    };
    $('detailFieldsTable').querySelector('tbody').innerHTML = state.detailFields.map(f =>
      `<tr><td>${esc(f.field)}</td><td class="num">${fmtVal(f.field, f.last)}</td>` +
      `<td class="num">${fmtVal(f.field, f.min)}</td><td class="num">${fmtVal(f.field, f.max)}</td>` +
      `<td class="num">${f.count}</td></tr>`
    ).join('');
    const sel = $('detailField');
    sel.innerHTML = '';
    for (const f of state.detailFields) {
      const opt = document.createElement('option');
      opt.value = f.field;
      opt.textContent = f.field;
      sel.appendChild(opt);
    }
    if (state.detailFields.length &&
        !state.detailFields.some(f => f.field === state.detailField)) {
      state.detailField = state.detailFields[0].field;
    }
    sel.value = state.detailField;
    loadDetailHistory();
  } catch { /* server may not have data yet */ }
}

function niceBucket(rangeMs) {
  let raw = Math.max(1, Math.round(rangeMs / 1500000));
  const pow = 10 ** Math.floor(Math.log10(raw));
  const m = raw / pow;
  const nice = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return nice * pow;
}

const DETAIL_RANGE_MS = { '1h': 3600000, '6h': 21600000, '24h': 86400000 };

async function loadDetailHistory() {
  if (!state.detailId || !state.detailField) return;
  // "长期" routes to the InfluxDB archive (requires --influx-url on the server).
  if (state.detailRange === 'archive') {
    try {
      const res = await api(
        `/api/devices/${state.detailId}/archive?field=${encodeURIComponent(state.detailField)}` +
        '&from=-90d&to=&bucket=3600'
      );
      drawDetailChart(res.history || []);
      $('detailHint').textContent = `Influx 归档 · ${res.count} 点 · 1h 聚合 · 最近 90 天`;
    } catch {
      drawDetailChart([]);
      $('detailHint').textContent = '归档未配置（server 需 --influx-url）';
    }
    return;
  }
  const bucket = niceBucket(DETAIL_RANGE_MS[state.detailRange]);
  try {
    const res = await api(
      `/api/devices/${state.detailId}/history?field=${encodeURIComponent(state.detailField)}` +
      `&from=-${state.detailRange}&to=&limit=2000&bucket=${bucket}`
    );
    drawDetailChart(res.history || []);
    $('detailHint').textContent = `${res.count} 点 · ${bucket}s 聚合 · ${state.detailRange}`;
  } catch {
    drawDetailChart([]);
    $('detailHint').textContent = '加载失败';
  }
}

// Units per field family (shared by the chart and the fields table).
function fieldUnit(field) {
  if (field === 'memory_used' || field === 'memory_total') return 'B';
  if (field === 'memory_percent' || field.endsWith('_usage')) return '%';
  if (field.endsWith('_temp') || field.includes('temp')) return '°C';
  if (field === 'lidAngle') return '°';
  return '';
}

function fmtAxis(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1) + 'G';
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return v.toFixed(1);
}

function hhmm(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

let detailSeries = { points: [], unit: '' };
let hoverIdx = null;

function drawDetailChart(points) {
  const canvas = $('detailChart');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 800;
  const h = canvas.clientHeight || 220;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const padL = 56, padR = 12, padT = 10, padB = 22;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const unit = fieldUnit(state.detailField);
  const values = points.map(p => (p.value !== undefined ? p.value : p.avg));
  detailSeries = { points, unit };

  if (values.length < 2) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('暂无数据（等客户端推送）', padL + plotW / 2, h / 2);
    ctx.textAlign = 'left';
    return;
  }
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max === min) { min -= 1; max += 1; }
  const range = max - min;
  const x = i => padL + (i / (values.length - 1)) * plotW;
  const y = v => padT + (1 - (v - min) / range) * plotH;

  // Grid + dynamic Y-axis numbers (left)
  ctx.strokeStyle = '#232a38';
  ctx.fillStyle = '#94a3b8';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 3; i += 1) {
    const v = min + (range * i) / 3;
    const gy = y(v);
    ctx.beginPath();
    ctx.moveTo(padL, gy);
    ctx.lineTo(w - padR, gy);
    ctx.stroke();
    ctx.fillText(fmtAxis(v), padL - 6, gy + 4);
  }
  // Dynamic X-axis time labels (bottom)
  ctx.textAlign = 'center';
  const t0 = points[0].ts;
  const t1 = points[points.length - 1].ts;
  for (let i = 0; i <= 3; i += 1) {
    const ts = t0 + ((t1 - t0) * i) / 3;
    const gx = padL + (plotW * i) / 3;
    ctx.beginPath();
    ctx.moveTo(gx, padT);
    ctx.lineTo(gx, h - padB);
    ctx.stroke();
    ctx.fillText(hhmm(ts), gx, h - 6);
  }
  ctx.textAlign = 'left';

  // Area fill
  const gradient = ctx.createLinearGradient(0, padT, 0, h - padB);
  gradient.addColorStop(0, 'rgba(34, 197, 94, 0.2)');
  gradient.addColorStop(1, 'rgba(34, 197, 94, 0)');
  ctx.beginPath();
  values.forEach((v, i) => {
    if (i === 0) ctx.moveTo(x(i), y(v));
    else ctx.lineTo(x(i), y(v));
  });
  ctx.lineTo(x(values.length - 1), h - padB);
  ctx.lineTo(x(0), h - padB);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Line
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2;
  ctx.beginPath();
  values.forEach((v, i) => {
    if (i === 0) ctx.moveTo(x(i), y(v));
    else ctx.lineTo(x(i), y(v));
  });
  ctx.stroke();

  // Hover crosshair + tooltip (time + value)
  if (hoverIdx !== null && hoverIdx < values.length) {
    const hx = x(hoverIdx);
    const hy = y(values[hoverIdx]);
    ctx.strokeStyle = 'rgba(148, 163, 184, .6)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(hx, padT);
    ctx.lineTo(hx, h - padB);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    ctx.arc(hx, hy, 3.5, 0, Math.PI * 2);
    ctx.fill();
    const ts = points[hoverIdx].ts;
    const label = `${new Date(ts).toTimeString().slice(0, 8)}  ${fmtAxis(values[hoverIdx])}${unit}`;
    ctx.font = '11px monospace';
    const tw = ctx.measureText(label).width + 12;
    const bx = Math.min(hx + 8, w - padR - tw);
    const by = Math.max(padT, hy - 26);
    ctx.fillStyle = 'rgba(15, 23, 42, .95)';
    ctx.fillRect(bx, by, tw, 20);
    ctx.strokeStyle = '#334155';
    ctx.strokeRect(bx, by, tw, 20);
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(label, bx + 6, by + 14);
  }
}

$('detailChart').addEventListener('mousemove', e => {
  if (!detailSeries.points.length) return;
  const canvas = $('detailChart');
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const padL = 56, padR = 12;
  const plotW = canvas.clientWidth - padL - padR;
  const frac = Math.max(0, Math.min(1, (mx - padL) / plotW));
  hoverIdx = Math.round(frac * (detailSeries.points.length - 1));
  drawDetailChart(detailSeries.points);
});
$('detailChart').addEventListener('mouseleave', () => {
  if (hoverIdx === null) return;
  hoverIdx = null;
  drawDetailChart(detailSeries.points);
});

$('detailClose').addEventListener('click', () => { location.hash = ''; });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('deviceOverlay').hidden) location.hash = '';
});
$('detailField').addEventListener('change', () => {
  state.detailField = $('detailField').value;
  loadDetailHistory();
});
document.querySelectorAll('#detailRanges button').forEach(btn => {
  btn.addEventListener('click', () => {
    state.detailRange = btn.dataset.range;
    document.querySelectorAll('#detailRanges button').forEach(b =>
      b.classList.toggle('active', b === btn)
    );
    loadDetailHistory();
  });
});
$('deviceRows').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-device]');
  if (tr) location.hash = '#/device/' + tr.dataset.device;
});
$('deviceRows').addEventListener('keydown', e => {
  const tr = e.target.closest('tr[data-device]');
  if (tr && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    location.hash = '#/device/' + tr.dataset.device;
  }
});

// Deep link support on first load.
{
  const m = location.hash.match(/^#\/device\/([^/]+)$/);
  if (m) openDetail(decodeURIComponent(m[1]));
}

/* ── multi-device comparison ────────────────────────── */
const CMP_COLORS = ['#22c55e', '#4dd0e1', '#7c8cff', '#ffb74d', '#f472b6', '#a3e635'];

function openCompare(ids) {
  state.compareDevices = ids;
  $('compareOverlay').hidden = false;
  loadCompareFields();
  loadCompare();
}

function closeCompare() {
  state.compareDevices = [];
  $('compareOverlay').hidden = true;
}

async function loadCompareFields() {
  if (!state.compareDevices.length) return;
  try {
    const res = await api('/api/devices/' + state.compareDevices[0] + '/fields');
    const fields = (res.fields || []).map(f => f.field);
    const sel = $('compareField');
    sel.innerHTML = '';
    for (const f of fields) {
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f;
      sel.appendChild(opt);
    }
    if (!fields.includes(state.compareField) && fields.length) state.compareField = fields[0];
    sel.value = state.compareField;
  } catch { /* first device may have no data yet */ }
}

async function loadCompare() {
  if (!state.compareDevices.length || !state.compareField) return;
  const bucket = niceBucket(DETAIL_RANGE_MS[state.compareRange]);
  try {
    const res = await api(
      `/api/compare?field=${encodeURIComponent(state.compareField)}` +
      `&devices=${state.compareDevices.map(encodeURIComponent).join(',')}` +
      `&from=-${state.compareRange}&to=&bucket=${bucket}`
    );
    drawCompareChart(res.series || []);
    $('compareHint').textContent = `${res.series.length} 台 · ${bucket}s 聚合 · ${state.compareRange}`;
  } catch {
    drawCompareChart([]);
    $('compareHint').textContent = '加载失败';
  }
}

function drawCompareChart(series) {
  const canvas = $('compareChart');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 800;
  const h = canvas.clientHeight || 320;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const padL = 56, padR = 12, padT = 10, padB = 22;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const unit = fieldUnit(state.compareField);

  const withVals = series
    .map(s => ({ ...s, values: s.points.map(p => (p.value !== undefined ? p.value : p.avg)) }))
    .filter(s => s.values.length >= 2);
  if (!withVals.length) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('暂无数据（等客户端推送）', padL + plotW / 2, h / 2);
    ctx.textAlign = 'left';
    return;
  }
  let min = Infinity, max = -Infinity;
  for (const s of withVals) for (const v of s.values) { if (v < min) min = v; if (v > max) max = v; }
  if (max === min) { min -= 1; max += 1; }
  const range = max - min;
  const n = withVals[0].values.length;
  const x = i => padL + (i / (n - 1)) * plotW;
  const y = v => padT + (1 - (v - min) / range) * plotH;

  ctx.strokeStyle = '#232a38';
  ctx.fillStyle = '#94a3b8';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 3; i += 1) {
    const v = min + (range * i) / 3;
    const gy = y(v);
    ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke();
    ctx.fillText(fmtAxis(v), padL - 6, gy + 4);
  }
  ctx.textAlign = 'center';
  const p0 = withVals[0].points;
  const t0 = p0[0].ts, t1 = p0[p0.length - 1].ts;
  for (let i = 0; i <= 3; i += 1) {
    const gx = padL + (plotW * i) / 3;
    ctx.beginPath(); ctx.moveTo(gx, padT); ctx.lineTo(gx, h - padB); ctx.stroke();
    ctx.fillText(hhmm(t0 + ((t1 - t0) * i) / 3), gx, h - 6);
  }
  ctx.textAlign = 'left';

  withVals.forEach((s, si) => {
    const color = CMP_COLORS[si % CMP_COLORS.length];
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    s.values.forEach((v, i) => {
      if (i === 0) ctx.moveTo(x(i), y(v));
      else ctx.lineTo(x(i), y(v));
    });
    ctx.stroke();
  });

  // Legend: swatch + device name + latest value, top-right.
  ctx.font = '11px monospace';
  let lx = w - padR;
  withVals.slice().reverse().forEach((s) => {
    const idx = withVals.indexOf(s);
    const color = CMP_COLORS[idx % CMP_COLORS.length];
    const label = `${s.name} ${fmtAxis(s.values[s.values.length - 1])}${unit}`;
    const tw = ctx.measureText(label).width + 18;
    lx -= tw;
    ctx.fillStyle = color;
    ctx.fillRect(lx, 4, 9, 9);
    ctx.fillStyle = '#dfe4ee';
    ctx.fillText(label, lx + 13, 12);
    lx -= 4;
  });
}

$('compareClose').addEventListener('click', () => { location.hash = ''; });
$('compareField').addEventListener('change', () => {
  state.compareField = $('compareField').value;
  loadCompare();
});
document.querySelectorAll('#compareRanges button').forEach(btn => {
  btn.addEventListener('click', () => {
    state.compareRange = btn.dataset.range;
    document.querySelectorAll('#compareRanges button').forEach(b =>
      b.classList.toggle('active', b === btn)
    );
    loadCompare();
  });
});

/* ── device management + export ─────────────────────── */
$('mgrSave').addEventListener('click', async () => {
  try {
    await api('/api/devices/' + state.detailId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: $('mgrName').value,
        group: $('mgrGroup').value,
        note: $('mgrNote').value,
      }),
    });
    state.devices = await api('/api/devices');
    renderDevices();
    renderDetail();
    $('mgrHint').textContent = '已保存';
  } catch { $('mgrHint').textContent = '保存失败'; }
});

$('mgrExport').addEventListener('click', async () => {
  const field = state.detailField || 'cpu_usage';
  const headers = {};
  if (accessToken) headers['Authorization'] = 'Bearer ' + accessToken;
  try {
    const res = await fetch(
      API + `/api/devices/${state.detailId}/export?field=${encodeURIComponent(field)}&from=-24h`,
      { headers }
    );
    if (!res.ok) { $('mgrHint').textContent = '导出失败'; return; }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.detailField}_24h.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch { $('mgrHint').textContent = '导出失败'; }
});

/* ── WebSocket ──────────────────────────────────────── */
async function connectWs() {
  // Browser WebSocket cannot send the Authorization header, so exchange the
  // long-lived token for a single-use short-TTL ticket (keeps it out of URLs
  // and logs). Without --auth-token the connection is open anyway.
  let ticket = '';
  if (accessToken) {
    try {
      const t = await api('/api/ws-ticket', { method: 'POST' });
      ticket = t.ticket;
    } catch {
      scheduleReconnect();
      return;
    }
  }
  const wsUrl = API.replace(/^http/, 'ws') + '/ws' +
    (ticket ? '?ticket=' + encodeURIComponent(ticket) : '');
  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch {
    scheduleReconnect();
    return;
  }
  state.ws = ws;
  ws.onopen = () => setConn('on');
  ws.onclose = () => {
    setConn('poll');
    scheduleReconnect();
  };
  ws.onerror = () => ws.close();
  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'hello') {
      $('versionTag').textContent = 'v' + msg.version;
    } else if (msg.type === 'devices') {
      state.devices = msg.data;
      renderDevices();
      for (const d of state.devices) {
        if (!state.latestNow[d.id]) backfillLatest(d.id);
      }
    } else if (msg.type === 'aggregate') {
      state.aggregate = msg.data;
      renderFleet();
      pushSparks();
    } else if (msg.type === 'alerts') {
      state.alerts = msg.data || { rules: [], active: [] };
      renderAlerts();
      renderDevices();
    } else if (msg.type === 'snapshot') {
      state.latestNow[msg.deviceId] = msg.data;
      state.ingestTimes.push(Date.now());
      renderDevices();
      if (msg.deviceId === state.detailId) renderDetail();
    }
  };
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(connectWs, 3000);
}

/* ── boot ───────────────────────────────────────────── */
loadStats();
connectWs();
api('/api/alerts').then(res => {
  state.alerts.rules = res.rules || [];
  renderAlerts();
}).catch(() => { /* alerts optional */ });
setInterval(loadStats, 5000);
setInterval(pruneIngestRate, 1000);
setInterval(renderDevices, 1000); // refresh "最后在线" column
window.addEventListener('resize', drawSparks);
