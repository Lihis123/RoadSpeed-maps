#!/usr/bin/env node
/**
 * Converts a Digiroad "K" release into the newline-delimited GeoJSON that
 * `build.mjs` already consumes, so the database schema stays untouched.
 *
 * Digiroad is the Finnish national road database published by Vaylavirasto
 * (Finnish Transport Infrastructure Agency) under CC BY 4.0. Its speed limits
 * are official records rather than crowd-sourced guesses, and they cover
 * effectively every road where a limit is signposted.
 *
 * Two layers are used:
 *   DR_LINKKI_K         - road links, already cut into pieces with uniform
 *                         attributes. This drives the output, so every
 *                         drivable road reaches the database.
 *   DR_NOPEUSRAJOITUS_K - speed limits (ARVO, in km/h), cut the same way and
 *                         joined back on SEGM_ID.
 *
 * Links with no official limit - mostly minor streets and private roads - are
 * still emitted, without a `maxspeed` tag, so `build.mjs` falls back to the
 * statutory default for the road class and marks the limit as inferred.
 *
 * Coordinates arrive in ETRS-TM35FIN (EPSG:3067) and are reprojected to
 * WGS84. ETRS89 and WGS84 agree to well under a metre in Finland, far inside
 * the matcher's tolerance.
 *
 * Usage:
 *   node digiroad.mjs --input <dir> --output <file.geojsonseq> [--id-base <n>]
 *
 * Regions can be converted one at a time to keep peak disk usage down; give
 * each run its own `--id-base` so the way ids stay unique once the parts are
 * concatenated.
 */

import { createWriteStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import proj4 from 'proj4';
import * as shapefile from 'shapefile';

const TM35FIN = '+proj=utm +zone=35 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
const project = proj4(TM35FIN, 'WGS84');

const SPEED_LAYER = 'DR_NOPEUSRAJOITUS_K';
const LINK_LAYER = 'DR_LINKKI_K';
const PROGRESS_INTERVAL = 250_000;
const MAX_PLAUSIBLE_KMH = 130;

/** Digiroad link types that carry no motor traffic, so they carry no limit worth storing. */
const NON_DRIVABLE_LINK_TYPES = new Set([
  8, // kevyen liikenteen vayla - cycle and footway
  9, // jalankulkualue - pedestrian area
  12, // ajopolku - track
  13, // huoltoaukko - service gap
]);

/** Digiroad functional class -> the OpenStreetMap-flavoured class names the app already knows. */
const FUNCTIONAL_CLASS = {
  1: 'trunk', // valtatie
  2: 'primary', // kantatie
  3: 'secondary', // seututie
  4: 'tertiary', // yhdystie
};

/** Ramps inherit the class of the road they serve. */
const RAMP_CLASS = {
  1: 'motorway_link',
  2: 'trunk_link',
  3: 'primary_link',
  4: 'secondary_link',
};

const ADMIN_PRIVATE = 3;

/**
 * Chooses the road class for one link.
 *
 * The class only decides the fallback limit and how the road is labelled; an
 * official limit always wins over it.
 *
 * @param {Record<string, unknown>} link attributes from DR_LINKKI_K
 * @returns {string|null} class name, or null when the link is not drivable
 */
export function roadClassFor(link) {
  const type = Number(link?.LINKKITYYP);
  const functional = Number(link?.TOIMINN_LK);

  if (NON_DRIVABLE_LINK_TYPES.has(type) || functional === 8) return null;

  if (type === 1) return 'motorway'; // moottoritie
  if (type === 4) return 'trunk'; // moottoriliikennetie
  if (type === 6) return RAMP_CLASS[functional] ?? 'tertiary_link'; // ramppi

  const named = FUNCTIONAL_CLASS[functional];
  if (named !== undefined) return named;

  // Local roads split by who maintains them: a municipal street defaults to
  // the built-up limit, a private road to the rural one.
  if (functional === 5 || functional === 6) {
    return Number(link?.HALLINN_LK) === ADMIN_PRIVATE ? 'unclassified' : 'residential';
  }

  return 'unclassified';
}

/**
 * Decides whether a link is worth keeping when Digiroad holds no limit for it.
 *
 * Without an official record the limit is only a guess from the statutory
 * default, which is sound on a public road but meaningless on a driveway,
 * forest track or yard road. Those are dropped rather than shown as 80 km/h.
 *
 * @param {Record<string, unknown>} link attributes from DR_LINKKI_K
 */
export function keepWithoutLimit(link) {
  if (Number(link?.HALLINN_LK) === ADMIN_PRIVATE) return false;

  const type = Number(link?.LINKKITYYP);
  if (type === 10 || type === 11) return false; // huolto- ja liitannaisliikennealueet

  return true;
}

/**
 * Works out which way traffic runs, and whether the limit only applies one way.
 *
 * A limit that binds in a single direction is emitted as a one-way feature
 * pointing that way, so the matcher only offers it to a driver heading in the
 * direction it actually covers.
 *
 * VAIK_SUUNT: 1 both, 2 along the geometry, 3 against it.
 * AJOSUUNTA:  2 both, 3 along the geometry, 4 against it.
 *
 * @returns {{ oneway: boolean, reverse: boolean }}
 */
export function directionFor(link, speed) {
  const effect = Number(speed?.VAIK_SUUNT);
  if (effect === 2) return { oneway: true, reverse: false };
  if (effect === 3) return { oneway: true, reverse: true };

  const flow = Number(link?.AJOSUUNTA);
  if (flow === 3) return { oneway: true, reverse: false };
  if (flow === 4) return { oneway: true, reverse: true };

  return { oneway: false, reverse: false };
}

/** Reprojects one ETRS-TM35FIN line to WGS84, rounded to the precision the database stores. */
export function toWgs84(coordinates) {
  if (!Array.isArray(coordinates)) return [];

  const points = [];
  for (const point of coordinates) {
    const [x, y] = point;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const [lon, lat] = project.forward([x, y]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    points.push([Number(lon.toFixed(7)), Number(lat.toFixed(7))]);
  }
  return points;
}

/** Reads the official limit from one speed record, or null when it is unusable. */
export function limitFor(speed) {
  const kmh = Number(speed?.ARVO);
  if (!Number.isFinite(kmh) || kmh <= 0 || kmh > MAX_PLAUSIBLE_KMH) return null;
  return Math.round(kmh);
}

/**
 * Builds one GeoJSON feature in the shape `build.mjs` expects.
 *
 * @param {number} id way id, unique across the whole conversion
 * @param {Record<string, unknown>} link attributes from DR_LINKKI_K
 * @param {Record<string, unknown>|null} speed matching DR_NOPEUSRAJOITUS_K record, if any
 * @param {Array<[number, number]>} coordinates WGS84 line
 * @returns {object|null} the feature, or null when the record cannot be used
 */
export function featureFor(id, link, speed, coordinates) {
  const highway = roadClassFor(link);
  if (highway === null) return null;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;

  const { oneway, reverse } = directionFor(link, speed);
  const points = reverse ? [...coordinates].reverse() : coordinates;

  const properties = { highway };
  const kmh = speed === null || speed === undefined ? null : limitFor(speed);
  if (kmh !== null) properties.maxspeed = String(kmh);
  if (oneway) properties.oneway = 'yes';

  return {
    type: 'Feature',
    id,
    properties,
    geometry: { type: 'LineString', coordinates: points },
  };
}

/** Finds every file with the given base name underneath a directory. */
async function findLayers(root, baseName, extension) {
  const found = [];
  const pending = [root];

  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.name.toUpperCase() === `${baseName}${extension}`) found.push(full);
    }
  }

  return found.sort();
}

/**
 * Loads the official limits for one region, keyed by SEGM_ID.
 *
 * A piece can carry two records when the limit differs by direction, so the
 * values are collected into arrays.
 */
async function readSpeedLimits(dbfPath) {
  const bySegment = new Map();
  const source = await shapefile.openDbf(dbfPath, { encoding: 'latin1' });

  for (;;) {
    const record = await source.read();
    if (record.done) break;

    const row = record.value;
    const key = row?.SEGM_ID;
    if (typeof key !== 'string') continue;

    const entry = { ARVO: row.ARVO, VAIK_SUUNT: row.VAIK_SUUNT };
    const existing = bySegment.get(key);
    if (existing === undefined) bySegment.set(key, [entry]);
    else existing.push(entry);
  }

  return bySegment;
}

/** Writes one line, waiting for the stream to drain so memory stays flat. */
function writeLine(stream, text) {
  if (stream.write(text)) return null;
  return new Promise((resolve) => stream.once('drain', resolve));
}

function parseArgs(argv) {
  const options = { input: null, output: null, idBase: 0 };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--input') options.input = argv[++index];
    else if (argument === '--output') options.output = argv[++index];
    else if (argument === '--id-base') options.idBase = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (options.input === null) throw new Error('Missing --input <directory>');
  if (options.output === null) throw new Error('Missing --output <file>');
  if (!Number.isSafeInteger(options.idBase) || options.idBase < 0) {
    throw new Error('--id-base must be a whole number');
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const linkLayers = await findLayers(options.input, LINK_LAYER, '.SHP');
  if (linkLayers.length === 0) {
    throw new Error(`No ${LINK_LAYER}.shp found under ${options.input}`);
  }

  console.log(`Reading  ${options.input}`);
  console.log(`Writing  ${options.output}`);
  console.log(`Regions  ${linkLayers.length}\n`);

  const stream = createWriteStream(options.output);
  const stats = { links: 0, written: 0, official: 0, inferred: 0, skipped: 0, unlimited: 0 };
  let wayId = options.idBase;

  for (const linkPath of linkLayers) {
    const directory = path.dirname(linkPath);
    const [speedPath] = await findLayers(directory, SPEED_LAYER, '.DBF');
    if (speedPath === undefined) {
      throw new Error(`No ${SPEED_LAYER}.dbf beside ${linkPath}`);
    }

    const limits = await readSpeedLimits(speedPath);
    const source = await shapefile.open(linkPath, linkPath.replace(/\.shp$/i, '.dbf'), {
      encoding: 'latin1',
    });

    console.log(`  ${path.basename(directory)}: ${limits.size.toLocaleString()} official limits`);

    for (;;) {
      const record = await source.read();
      if (record.done) break;

      stats.links += 1;
      if (stats.links % PROGRESS_INTERVAL === 0) {
        console.log(
          `    ${stats.links.toLocaleString()} links -> ${stats.written.toLocaleString()} features`,
        );
      }

      const link = record.value?.properties;
      const geometry = record.value?.geometry;
      if (geometry?.type !== 'LineString') continue;
      if (roadClassFor(link) === null) {
        stats.skipped += 1;
        continue;
      }

      const points = toWgs84(geometry.coordinates);
      const matched = limits.get(link?.SEGM_ID);

      if (matched === undefined && !keepWithoutLimit(link)) {
        stats.unlimited += 1;
        continue;
      }

      for (const speed of matched ?? [null]) {
        wayId += 1;
        const feature = featureFor(wayId, link, speed, points);
        if (feature === null) continue;

        stats.written += 1;
        if (feature.properties.maxspeed === undefined) stats.inferred += 1;
        else stats.official += 1;

        const pending = writeLine(stream, `${JSON.stringify(feature)}\n`);
        if (pending !== null) await pending;
      }
    }

    limits.clear();
  }

  await new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.end(resolve);
  });

  const size = await stat(options.output);
  const share = stats.written === 0 ? 0 : (stats.official / stats.written) * 100;
  console.log(`\nLinks read     ${stats.links.toLocaleString()}`);
  console.log(`Not drivable   ${stats.skipped.toLocaleString()}`);
  console.log(`Private, no    ${stats.unlimited.toLocaleString()} official limit`);
  console.log(`Features       ${stats.written.toLocaleString()}`);
  console.log(`Official       ${stats.official.toLocaleString()} (${share.toFixed(1)}%)`);
  console.log(`Inferred       ${stats.inferred.toLocaleString()}`);
  console.log(`Output         ${(size.size / 1e6).toFixed(1)} MB`);
}

if (process.argv[1]?.endsWith('digiroad.mjs')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
