import regions from '../icing-regions.json' with { type: 'json' };

const endpoint = 'https://apihub.kma.go.kr/api/typ01/url/sfc_nc_var.php';
const columns = ['ta', 'td', 'hm', 'ws_10m', 'rn_60m', 'sd_tot', 'sd_3hr'];
const intervalMs = 30 * 60_000;
const offsetMs = 9 * 3600_000;
const cache = new Map();
const pending = new Map();

const localStamp = ms => new Date(ms + offsetMs).toISOString().slice(0, 16).replace(/\D/g, '');

function readTime(value) {
  if (!/^\d{12}$/.test(value)) return NaN;
  const time = Date.parse(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10)}:00+09:00`);
  return Number.isFinite(time) && localStamp(time) === value ? time : NaN;
}

function readNumber(text, min, max) {
  if (!/^-?\d+(?:\.\d+)?$/.test(text ?? '')) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}

export function parseKmaGrid(text, start, end) {
  const lines = text.split(/\r?\n/).map(line => line.trim());
  if (!lines.includes('#START7777') || !lines.includes('#7777END')) return [];
  const header = lines.find(line => /^#\s*tm\s*,/i.test(line));
  const keys = header?.replace(/^#\s*/, '').split(',').map(value => value.trim().toLowerCase());
  if (!keys || !columns.every(key => keys.includes(key)) || new Set(keys).size !== keys.length) return [];
  const rows = new Map();
  const conflicts = new Set();
  for (const line of lines) {
    const cells = line.split(',').map(value => value.trim());
    if (cells.length !== keys.length) continue;
    const time = readTime(cells[0]);
    if (!Number.isFinite(time) || time < start || time > end || time % intervalMs !== 0) continue;
    const read = (key, min, max) => readNumber(cells[keys.indexOf(key)], min, max);
    const row = {
      time, temperatureC: read('ta', -70, 60), dewPointC: read('td', -100, 60),
      humidity: read('hm', 0, 100), windMps: read('ws_10m', 0, 100),
      rain60mMm: read('rn_60m', 0, 500), snowDepthCm: read('sd_tot', 0, 1000), newSnow3hCm: read('sd_3hr', 0, 300),
    };
    if (!Object.entries(row).some(([key, value]) => key !== 'time' && value !== null)) continue;
    if (rows.has(time) && JSON.stringify(rows.get(time)) !== JSON.stringify(row)) conflicts.add(time);
    rows.set(time, row);
  }
  return [...rows.values()].filter(row => !conflicts.has(row.time)).sort((a, b) => a.time - b.time);
}

export async function getKmaGrid(env, area = 'gwanak') {
  const now = Date.now();
  const existing = cache.get(area);
  if (existing?.expires > now) return existing.result;
  if (!pending.has(area)) {
    pending.set(area, fetchGrid(env, area, now).then(result => {
      cache.set(area, { expires: now + (result.status === 'ok' ? 180_000 : 60_000), result });
      return result;
    }).finally(() => pending.delete(area)));
  }
  return pending.get(area);
}

async function fetchGrid(env, area, now) {
  const key = (env?.KMA_GRID_API_KEY ?? env?.KMA_API_KEY)?.trim();
  if (!key) return { status: 'unavailable' };
  const [lon, lat] = regions[area].weatherCenter;
  const latest = Math.floor(now / intervalMs) * intervalMs;
  for (const end of [latest, latest - intervalMs]) {
    const start = end - 2 * intervalMs;
    const url = new URL(endpoint);
    url.search = new URLSearchParams({
      lon: String(lon), lat: String(lat), tm1: localStamp(start), tm2: localStamp(end),
      obs: columns.join(','), itv: '30', disp: '0', help: '1', authKey: key,
    });
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (response.status === 403) return { status: 'permission' };
      if (!response.ok || Number(response.headers.get('content-length')) > 50_000) continue;
      const text = await response.text();
      if (text.length > 50_000 || text.includes(key)) continue;
      const rows = parseKmaGrid(text, Math.max(start, now - 3 * intervalMs), end);
      if (rows.length) return { status: 'ok', rows };
    } catch { /* Try the previous analysis window after an upstream timeout. */ }
  }
  return { status: 'unavailable' };
}
