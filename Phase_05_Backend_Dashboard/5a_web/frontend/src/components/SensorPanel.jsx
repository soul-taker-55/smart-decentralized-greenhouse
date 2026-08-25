import { formatAge, formatValue } from '../api.js';

/**
 * A single reading, with its quality rule.
 *
 * ─── THE SIGNATURE ELEMENT ─────────────────────────────────────────────────
 *
 * Every value sits on a 3px rule whose PATTERN encodes quality:
 *
 *   ok       solid          the reading is fresh and plausible
 *   stale    dashed         last good value, older than sys.stale_after_s
 *   fail     hatched red    read error or out of physical bounds — value null
 *   init     fine dots      never successfully read since boot
 *   no_data  wide dots      this sensor has never reported at all
 *
 * Pattern rather than colour alone, so the state survives greyscale printing
 * (this ends up in a thesis) and colour-blindness. The flag is also spelled out
 * in text beneath it. Three redundant encodings, because a stale reading
 * displayed as current is the single most likely way this dashboard could
 * mislead someone.
 *
 * `init` is kept distinct from `fail` deliberately: a DHT11 needs a couple of
 * seconds before its first reading, and without the distinction it is
 * impossible to tell "broken" from "not asked yet" — a difference that shows up
 * in the logs after every reboot.
 */
function Reading({ reading, unit, place }) {
  const quality = reading?.quality ?? 'no_data';
  const value = formatValue(reading, unit);
  const isEmpty = value === '—';
  const age = formatAge(reading?.ageSeconds);

  const flagLabel = {
    ok: 'OK',
    stale: 'STALE',
    fail: 'FAIL',
    init: 'INIT',
    no_data: 'NO DATA',
  }[quality];

  const flagTitle = {
    ok: 'Fresh and within plausible range.',
    stale: 'Last known value, older than the configured staleness window.',
    fail: 'Read error or outside physical bounds. No value is available.',
    init: 'Never successfully read since boot. The sensor may still be warming up.',
    no_data: 'This sensor has not reported since the database was last cleared.',
  }[quality];

  return (
    <div className="reading">
      {place && <div className="place">{place}</div>}
      <div className={`val num ${isEmpty ? 'none' : ''}`}>{value}</div>
      <div className={`qrule ${quality}`} role="presentation" />
      <div className="qmeta">
        <span className={`qflag ${quality}`} title={flagTitle}>
          {flagLabel}
        </span>
        <span className="qage">{age ?? ''}</span>
      </div>
    </div>
  );
}

/**
 * One panel per sensing type.
 *
 * Paired sensors render inner and outer side by side. The comparison is the
 * point: this is a sealed box whose entire control strategy turns on the
 * difference between inside and outside, so putting the two numbers anywhere
 * but adjacent would hide the thing an operator is actually looking for.
 */
export default function SensorPanel({ group }) {
  return (
    <div className="card">
      <div className="card-head">
        <span className="label">{group.label}</span>
        <span className="unit">{group.unit}</span>
      </div>

      {group.note && (
        // A caveat that changes how the number should be READ is not a
        // footnote. The MQ135 cannot produce calibrated ppm, and a bare number
        // invites someone to read it as one.
        <div className={`card-note ${group.key === 'air_quality' ? 'loud' : ''}`}>{group.note}</div>
      )}

      <div className={`readings ${group.paired ? '' : 'single'}`}>
        {group.paired ? (
          <>
            <Reading reading={group.inner} unit={group.unit} place="Inside" />
            <Reading reading={group.outer} unit={group.unit} place="Outside" />
          </>
        ) : (
          <Reading reading={group.single} unit={group.unit} place={null} />
        )}
      </div>
    </div>
  );
}
