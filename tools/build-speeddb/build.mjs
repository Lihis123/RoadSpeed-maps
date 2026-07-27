/**
 * Builds the offline speed limit database.
 *
 * Input is a GeoJSON Text Sequence produced by `osmium export`, streamed a line
 * at a time so memory stays flat regardless of extract size. Output is a SQLite
 * file indexed by a fixed grid so the app can find nearby road segments without
 * relying on optional SQLite modules such as R*Tree, which `expo-sqlite` does
 * not compile in.
 *
 * Usage:
 *   node build.mjs --input roads.geojsonseq --output speedlimits.db --region finland
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import Database from 'better-sqlite3';

import { bearingDegrees, cellIdsForSegment, simplify, toFixed } from './geometry.mjs';
import { ROAD_CLASSES, isOneway, resolveMaxspeed, roadClassIndex } from './maxspeed.mjs';

const SCHEMA_VERSION = 1;
const RECORD_SEPARATOR = 0x1e;
const BATCH_SIZE = 20_000;
const PROGRESS_INTERVAL = 250_000;

function parseArgs(argv) {
  const options = {
    input: 'roads.geojsonseq',
    output: 'speedlimits.db',
    region: 'unknown',
    tolerance: 5,
    limit: Infinity,
  };

  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index].replace(/^--/, '');
    const value = argv[index + 1];
    if (!(key in options)) throw new Error(`Unknown option: ${argv[index]}`);
    options[key] = key === 'tolerance' || key === 'limit' ? Number(value) : value;
  }

  if (!Number.isFinite(options.tolerance) || options.tolerance < 0) {
    throw new Error('--tolerance must be a non-negative number');
  }
  return options;
}

function createSchema(db) {
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -200000');

  db.exec(`
    CREATE TABLE meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE segment (
      id         INTEGER PRIMARY KEY,
      way_id     INTEGER NOT NULL,
      lat1       INTEGER NOT NULL,
      lon1       INTEGER NOT NULL,
      lat2       INTEGER NOT NULL,
      lon2       INTEGER NOT NULL,
      bearing    INTEGER NOT NULL,
      maxspeed   INTEGER,
      winter     INTEGER,
      source     INTEGER NOT NULL,
      road_class INTEGER NOT NULL,
      oneway     INTEGER NOT NULL
    );

    -- Maps grid cells to the segments overlapping them. WITHOUT ROWID keeps
    -- this as a single covering B-tree rather than a table plus an index.
    CREATE TABLE segment_cell (
      cell_id    INTEGER NOT NULL,
      segment_id INTEGER NOT NULL,
      PRIMARY KEY (cell_id, segment_id)
    ) WITHOUT ROWID;
  `);
}

/**
 * Extracts the numeric OSM way id.
 *
 * `osmium export --add-unique-id=type_id` writes the id as a top-level GeoJSON
 * `id` member (`"id": "w123"`), not as a property. The `@id` property is what
 * other exporters (and Overpass) produce, so both are accepted.
 */
function parseWayId(feature) {
  const properties = feature.properties ?? {};
  const raw = feature.id ?? properties['@id'] ?? properties.id ?? properties['@way_id'];
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return null;

  const match = /^w?(\d+)$/.exec(raw);
  return match ? Number(match[1]) : null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  console.log(`Reading  ${options.input}`);
  console.log(`Writing  ${options.output}`);
  console.log(`Region   ${options.region}`);
  console.log(`Simplify ${options.tolerance} m\n`);

  const db = new Database(options.output);
  createSchema(db);

  const insertSegment = db.prepare(`
    INSERT INTO segment (
      id, way_id, lat1, lon1, lat2, lon2, bearing,
      maxspeed, winter, source, road_class, oneway
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCell = db.prepare(
    'INSERT OR IGNORE INTO segment_cell (cell_id, segment_id) VALUES (?, ?)',
  );

  const flush = db.transaction((segments, cells) => {
    for (const row of segments) insertSegment.run(row);
    for (const row of cells) insertCell.run(row);
  });

  const stats = {
    lines: 0,
    ways: 0,
    skippedClass: 0,
    skippedGeometry: 0,
    skippedWayId: 0,
    segments: 0,
    nodesBefore: 0,
    nodesAfter: 0,
    tagged: 0,
    inferred: 0,
    unknown: 0,
    winter: 0,
  };

  let segmentId = 0;
  let pendingSegments = [];
  let pendingCells = [];

  const reader = createInterface({
    input: createReadStream(options.input, { highWaterMark: 1 << 20 }),
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    stats.lines += 1;
    if (stats.lines % PROGRESS_INTERVAL === 0) {
      console.log(
        `  ${stats.lines.toLocaleString()} features -> ${stats.segments.toLocaleString()} segments`,
      );
    }
    if (stats.ways >= options.limit) break;

    const text = line.charCodeAt(0) === RECORD_SEPARATOR ? line.slice(1) : line;
    if (text.length === 0 || text.charCodeAt(0) !== 0x7b /* { */) continue;

    let feature;
    try {
      feature = JSON.parse(text);
    } catch {
      continue;
    }

    const geometry = feature.geometry;
    if (!geometry || geometry.type !== 'LineString') continue;

    const tags = feature.properties ?? {};
    const classIndex = roadClassIndex(tags.highway);
    if (classIndex < 0 || tags.area === 'yes') {
      stats.skippedClass += 1;
      continue;
    }

    const wayId = parseWayId(feature);
    if (wayId === null) {
      stats.skippedWayId += 1;
      continue;
    }

    const coordinates = geometry.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      stats.skippedGeometry += 1;
      continue;
    }

    stats.ways += 1;
    stats.nodesBefore += coordinates.length;

    const points = options.tolerance > 0 ? simplify(coordinates, options.tolerance) : coordinates;
    stats.nodesAfter += points.length;

    const { kmh, winterKmh, source } = resolveMaxspeed(tags);
    if (kmh === null) stats.unknown += 1;
    else if (source === 0) stats.tagged += 1;
    else stats.inferred += 1;
    if (winterKmh !== null) stats.winter += 1;

    const oneway = isOneway(tags) ? 1 : 0;

    for (let index = 0; index < points.length - 1; index += 1) {
      const [lon1, lat1] = points[index];
      const [lon2, lat2] = points[index + 1];
      if (lon1 === lon2 && lat1 === lat2) continue;

      segmentId += 1;
      stats.segments += 1;

      pendingSegments.push([
        segmentId,
        wayId,
        toFixed(lat1),
        toFixed(lon1),
        toFixed(lat2),
        toFixed(lon2),
        bearingDegrees(lon1, lat1, lon2, lat2),
        kmh,
        winterKmh,
        source,
        classIndex,
        oneway,
      ]);

      for (const cell of cellIdsForSegment(lon1, lat1, lon2, lat2)) {
        pendingCells.push([cell, segmentId]);
      }
    }

    if (pendingSegments.length >= BATCH_SIZE) {
      flush(pendingSegments, pendingCells);
      pendingSegments = [];
      pendingCells = [];
    }
  }

  if (pendingSegments.length > 0) flush(pendingSegments, pendingCells);

  const generatedAt = new Date().toISOString();
  const insertMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  db.transaction(() => {
    insertMeta.run('schema_version', String(SCHEMA_VERSION));
    insertMeta.run('region', options.region);
    insertMeta.run('generated_at', generatedAt);
    insertMeta.run('tolerance_m', String(options.tolerance));
    insertMeta.run('segment_count', String(stats.segments));
    insertMeta.run('way_count', String(stats.ways));
    insertMeta.run('road_classes', ROAD_CLASSES.join(','));
  })();

  console.log('\nCompacting...');
  db.exec('VACUUM');
  db.exec('ANALYZE');
  db.close();

  const { size } = await stat(options.output);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const reduction = stats.nodesBefore > 0 ? 1 - stats.nodesAfter / stats.nodesBefore : 0;

  console.log(`
Done in ${seconds}s
  ways kept          ${stats.ways.toLocaleString()}
  segments           ${stats.segments.toLocaleString()}
  node reduction     ${(reduction * 100).toFixed(1)}%
  tagged limits      ${stats.tagged.toLocaleString()}
  inferred limits    ${stats.inferred.toLocaleString()}
  unknown limits     ${stats.unknown.toLocaleString()}
  winter limits      ${stats.winter.toLocaleString()}
  skipped: class     ${stats.skippedClass.toLocaleString()}
  skipped: geometry  ${stats.skippedGeometry.toLocaleString()}
  skipped: way id    ${stats.skippedWayId.toLocaleString()}
  database size      ${(size / 1024 / 1024).toFixed(1)} MB
`);

  if (stats.segments === 0) {
    throw new Error('No segments were written; check the osmium filter and input path.');
  }
  if (stats.skippedWayId > stats.ways) {
    throw new Error('Most features had no usable id; check the osmium --add-unique-id option.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
