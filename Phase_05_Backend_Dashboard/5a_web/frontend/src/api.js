/**
 * Thin API client.
 *
 * Every call returns { data, error } rather than throwing. The dashboard's
 * defining condition right now is that nothing is connected — no firmware, mock
 * stopped, empty tables — so a failed fetch is an ordinary state to render, not
 * an exception to handle.
 */

async function get(path) {
  try {
    const res = await fetch(path, { headers: { Accept: 'application/json' } });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { data, error: data?.message || `HTTP ${res.status}` };
    return { data, error: null };
  } catch (err) {
    return { data: null, error: err.message };
  }
}

async function post(path, body) {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { data, error: data?.message || `HTTP ${res.status}` };
    return { data, error: null };
  } catch (err) {
    return { data: null, error: err.message };
  }
}

export const api = {
  status: () => get('/api/status'),
  live: () => get('/api/state/live'),
  history: (sensor, hours = 24) => get(`/api/state/history/${sensor}?hours=${hours}`),
  sensors: () => get('/api/sensors'),
  events: (limit = 100) => get(`/api/events?limit=${limit}`),

  configSchema: () => get('/api/config/schema'),
  activeConfig: () => get('/api/config/active'),
  profiles: (status) => get(`/api/config/profiles${status ? `?status=${status}` : ''}`),
  profile: (id) => get(`/api/config/profiles/${id}`),
  diff: (id) => get(`/api/config/profiles/${id}/diff`),
  createProfile: (cfg, name) => post('/api/config/profiles', { cfg, name }),
  propose: (id, ttlHours) => post(`/api/config/profiles/${id}/propose`, { ttlHours }),
  approve: (id) => post(`/api/config/profiles/${id}/approve`),
  reject: (id, reason) => post(`/api/config/profiles/${id}/reject`, { reason }),
  activate: (id) => post(`/api/config/profiles/${id}/activate`),
  republish: () => post('/api/config/republish'),

  commands: () => get('/api/commands'),
  commandTargets: () => get('/api/commands/targets'),
  issueCommand: (cmd) => post('/api/commands', cmd),
};

/** Human-readable age. Returns null when there is nothing to age. */
export function formatAge(seconds) {
  if (seconds === null || seconds === undefined) return null;
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Format a reading for display.
 *
 * NEVER substitutes a number for null. The contract's null rule means value is
 * null whenever quality is fail or init, and rendering that as 0 would corrupt
 * an operator's judgement exactly where the data is least trustworthy.
 */
export function formatValue(reading, unit) {
  if (!reading || reading.value === null || reading.value === undefined) return '—';
  const v = reading.value;
  // Pressure and temperature come off the BMP280 with one useful decimal.
  // Humidity is DHT11 and integer-only; light and air quality are raw ADC.
  const decimals = unit === 'hPa' ? 1 : Number.isInteger(v) ? 0 : 1;
  return v.toFixed(decimals);
}
