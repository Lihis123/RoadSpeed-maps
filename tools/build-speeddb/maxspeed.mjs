/**
 * Resolves OpenStreetMap speed limit tags into concrete km/h values for Finland.
 *
 * Runs at database build time only, so none of this ships to the phone.
 */

const KMH_PER_MPH = 1.609344;

/** Highway values kept in the database, ordered so the index doubles as a priority. */
export const ROAD_CLASSES = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'unclassified',
  'residential',
  'living_street',
  'motorway_link',
  'trunk_link',
  'primary_link',
  'secondary_link',
  'tertiary_link',
];

const ROAD_CLASS_INDEX = new Map(ROAD_CLASSES.map((name, index) => [name, index]));

export const SOURCE_TAGGED = 0;
export const SOURCE_INFERRED = 1;

/**
 * Finnish statutory limits used when a road carries an implicit `maxspeed`
 * category such as `FI:urban` rather than a number.
 */
const IMPLICIT_KMH = {
  urban: 50,
  rural: 80,
  motorway: 120,
  trunk: 100,
  living_street: 20,
  bicycle_road: 30,
  walk: 7,
};

/**
 * Fallback when a road has no usable speed tag at all. These are the Finnish
 * statutory defaults per road category and are flagged as inferred so the UI
 * can show them as lower confidence.
 */
const CLASS_DEFAULT_KMH = {
  motorway: 120,
  motorway_link: 80,
  trunk: 100,
  trunk_link: 60,
  primary: 80,
  primary_link: 60,
  secondary: 80,
  secondary_link: 60,
  tertiary: 80,
  tertiary_link: 60,
  unclassified: 80,
  residential: 50,
  living_street: 20,
};

/**
 * Finnish winter speed limits, in force roughly from late October to March.
 * Only applied to inferred limits; explicitly tagged conditionals win.
 */
const WINTER_KMH = {
  120: 100,
  100: 80,
};

const WINTER_MONTHS = new Set([11, 12, 1, 2, 3]);

const MONTH_NUMBERS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** Values that mean "a limit exists but cannot be known from the map". */
const UNKNOWABLE = new Set(['signals', 'variable', 'none', 'unposted', 'unknown']);

export function roadClassIndex(highway) {
  return ROAD_CLASS_INDEX.get(highway) ?? -1;
}

/**
 * Parses a single `maxspeed`-style value.
 * Returns km/h, or null when the value is absent, unparseable or not knowable.
 */
export function parseSpeedValue(raw) {
  if (typeof raw !== 'string') return null;

  const value = raw.trim().toLowerCase();
  if (value === '') return null;
  if (UNKNOWABLE.has(value)) return null;
  if (value === 'walk') return IMPLICIT_KMH.walk;

  const mph = /^(\d+(?:\.\d+)?)\s*mph$/.exec(value);
  if (mph) return Math.round(Number(mph[1]) * KMH_PER_MPH);

  const kmh = /^(\d+(?:\.\d+)?)(?:\s*km\/h)?$/.exec(value);
  if (kmh) {
    const parsed = Math.round(Number(kmh[1]));
    return parsed > 0 && parsed <= 300 ? parsed : null;
  }

  // Implicit categories such as "FI:urban", "FI:30" or "FI:zone:40".
  const implicit = /^[a-z]{2}:(.+)$/.exec(value);
  if (implicit) return resolveImplicitCategory(implicit[1]);

  return null;
}

/** Maps an implicit category name such as `urban` or `zone30` to km/h. */
export function resolveImplicitCategory(category) {
  if (category in IMPLICIT_KMH) return IMPLICIT_KMH[category];

  // `zone:maxspeed=FI:30` and `maxspeed:type=FI:zone30` both occur.
  const zone = /^(?:zone:?)?(\d+)$/.exec(category);
  if (zone) {
    const parsed = Number(zone[1]);
    return parsed > 0 && parsed <= 300 ? parsed : null;
  }

  return null;
}

/**
 * True when a conditional restriction applies during the Finnish winter.
 *
 * Month ranges are checked for containment of January rather than matched by
 * name, because ranges such as "Oct 15-Apr 15" cover winter without naming a
 * winter month.
 */
function isWinterCondition(condition) {
  const text = condition.toLowerCase();
  if (text.includes('winter')) return true;

  const months = [...text.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/g)].map(
    (match) => MONTH_NUMBERS[match[1]],
  );
  if (months.length === 0) return false;
  if (months.length === 1) return WINTER_MONTHS.has(months[0]);

  const start = months[0];
  const end = months[months.length - 1];
  return start <= end ? start <= 1 && 1 <= end : 1 >= start || 1 <= end;
}

/**
 * Extracts a winter value from `maxspeed:conditional`.
 *
 * Handles the common Finnish forms, for example:
 *   "100 @ (Nov 1-Feb 28)"
 *   "80 @ (Oct 15-Apr 15)"
 *   "100 @ winter"
 */
export function parseWinterConditional(raw) {
  if (typeof raw !== 'string') return null;

  for (const clause of raw.split(';')) {
    const match = /^([^@]+)@(.+)$/.exec(clause.trim());
    if (!match) continue;
    if (!isWinterCondition(match[2])) continue;

    const speed = parseSpeedValue(match[1]);
    if (speed !== null) return speed;
  }

  return null;
}

/**
 * Resolves the speed limits for one way.
 *
 * @param {Record<string, string>} tags
 * @returns {{ kmh: number|null, winterKmh: number|null, source: number }}
 */
export function resolveMaxspeed(tags) {
  const winterKmh = parseWinterConditional(tags['maxspeed:conditional']);

  const tagged =
    parseSpeedValue(tags.maxspeed) ??
    parseSpeedValue(tags['maxspeed:type']) ??
    parseSpeedValue(tags['zone:maxspeed']) ??
    parseSpeedValue(tags['source:maxspeed']);

  if (tagged !== null) {
    return { kmh: tagged, winterKmh: winterKmh ?? WINTER_KMH[tagged] ?? null, source: SOURCE_TAGGED };
  }

  const inferred = CLASS_DEFAULT_KMH[tags.highway] ?? null;
  if (inferred === null) {
    return { kmh: null, winterKmh: null, source: SOURCE_INFERRED };
  }

  return {
    kmh: inferred,
    winterKmh: winterKmh ?? WINTER_KMH[inferred] ?? null,
    source: SOURCE_INFERRED,
  };
}

/** True when the way only carries traffic in its drawn direction. */
export function isOneway(tags) {
  const value = tags.oneway;
  if (value === 'yes' || value === '1' || value === 'true' || value === '-1') return true;
  return tags.junction === 'roundabout' && value !== 'no';
}
