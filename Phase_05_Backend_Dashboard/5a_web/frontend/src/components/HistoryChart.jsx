import { useEffect, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../api.js';

const RANGES = [
  { hours: 6, label: '6h' },
  { hours: 24, label: '24h' },
  { hours: 168, label: '7d' },
  { hours: 720, label: '30d' },
];

/** Deci-Celsius never reaches this component — the API returns real values. */
function axisTime(t, hours) {
  const d = new Date(t);
  return hours <= 48
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function ChartTip({ active, payload, label, unit, hours }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const bad = p.bad ?? 0;
  const stale = p.stale ?? 0;
  return (
    <div className="ctip">
      <div className="ctip-t num">{axisTime(label, hours)}</div>
      <div className="ctip-v num">
        {p.avg === null ? '—' : p.avg.toFixed(1)} {unit}
      </div>
      {p.min !== p.max && p.avg !== null && (
        <div className="ctip-r num">
          {p.min?.toFixed(1)} – {p.max?.toFixed(1)}
        </div>
      )}
      {/* Reading quality travels with the history, not just the live panel. An
          average computed mostly from stale samples looks identical to a good
          one unless the chart says so. */}
      {(stale > 0 || bad > 0) && (
        <div className="ctip-q">
          {stale > 0 && <span className="qflag stale">{stale} stale</span>}
          {bad > 0 && <span className="qflag fail">{bad} failed</span>}
        </div>
      )}
    </div>
  );
}

/**
 * History for one sensor.
 *
 * The backend buckets and averages server-side, so a month of 30-second data
 * arrives as a few hundred points rather than 90,000. Failed readings are SQL
 * NULL and are excluded from the average automatically — which is the whole
 * reason the contract forbids sentinel values like 0 or -127.
 */
export default function HistoryChart({ sensor, unit, label }) {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.history(sensor, hours).then(({ data: d, error: e }) => {
      if (!alive) return;
      setData(d);
      setError(e);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [sensor, hours]);

  const points = data?.points ?? [];
  const hasData = points.length > 0;

  const bucketMs = (data?.bucketMinutes ?? 5) * 60_000;

  /**
   * Insert an explicit break wherever the controller reported nothing.
   *
   * A missing bucket produces no row, so without this the chart would simply
   * join the readings either side and assert measurements that were never
   * taken. Drawing a break is the honest rendering of an outage — the same
   * principle as never substituting a number for a failed reading.
   */
  const series = [];
  points.forEach((p, i) => {
    const t = new Date(p.t).getTime();
    if (i > 0) {
      const prev = new Date(points[i - 1].t).getTime();
      // Two buckets of tolerance absorbs ordinary jitter in publish timing.
      if (t - prev > bucketMs * 2.5) {
        series.push({ t: prev + bucketMs, avg: null, band: null, gap: true });
      }
    }
    series.push({
      t,
      avg: p.avg,
      min: p.min,
      max: p.max,
      band: p.min !== null && p.max !== null ? [p.min, p.max] : null,
      ok: p.ok,
      stale: p.stale,
      bad: p.bad,
    });
  });

  const gaps = series.filter((s) => s.gap).length;

  /**
   * Scale to the data, not to zero.
   *
   * Recharts anchors a numeric axis at 0 by default, which would render a real
   * four-degree swing as a flat line. None of these readings is a quantity
   * where zero is a meaningful reference point.
   */
  const vals = points.flatMap((p) => [p.min, p.max]).filter((v) => v !== null && v !== undefined);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.12, 0.5);
  const domain = vals.length ? [Number((lo - pad).toFixed(1)), Number((hi + pad).toFixed(1))] : [0, 1];

  return (
    <div className="hist">
      <div className="hist-head">
        <span className="hist-title">{label} over time</span>
        <div className="ranges">
          {RANGES.map((r) => (
            <button
              key={r.hours}
              className={`rbtn ${hours === r.hours ? 'on' : ''}`}
              onClick={() => setHours(r.hours)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <div className="hist-empty">Loading…</div>}

      {!loading && error && <div className="hist-empty">Could not load history: {error}</div>}

      {!loading && !error && !hasData && (
        <div className="hist-empty">No readings recorded in this period.</div>
      )}

      {!loading && hasData && (
        <>
          <ResponsiveContainer width="100%" height={168}>
            <ComposedChart data={series} margin={{ top: 6, right: 6, bottom: 2, left: -8 }}>
              <CartesianGrid stroke="var(--line)" vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(t) => axisTime(t, hours)}
                stroke="var(--ink-faint)"
                tick={{ fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                tickLine={false}
                minTickGap={40}
              />
              <YAxis
                domain={domain}
                stroke="var(--ink-faint)"
                tick={{ fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                tickLine={false}
                axisLine={false}
                width={44}
              />
              <Tooltip content={<ChartTip unit={unit} hours={hours} />} />
              {/* The min–max band shows spread within each bucket, so a flat
                  average built from a swinging signal is not mistaken for a
                  steady one. */}
              <Area
                dataKey="band"
                stroke="none"
                fill="var(--accent)"
                fillOpacity={0.12}
                isAnimationActive={false}
                connectNulls={false}
              />
              <Line
                dataKey="avg"
                stroke="var(--accent)"
                strokeWidth={1.6}
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
            </ComposedChart>
          </ResponsiveContainer>

          <div className="hist-foot num">
            Averaged in {data.bucketMinutes}-minute buckets · {points.length} points
            {gaps > 0 && ` · ${gaps} break${gaps > 1 ? 's' : ''} where nothing was reported`}
          </div>
        </>
      )}
    </div>
  );
}
