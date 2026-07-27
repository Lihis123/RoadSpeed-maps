import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import Database from 'better-sqlite3';

import { cellId } from './geometry.mjs';
import { SOURCE_INFERRED, SOURCE_TAGGED } from './maxspeed.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));

describe('build.mjs', () => {
  let workDir;
  let db;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), 'roadspeed-'));
    const output = join(workDir, 'test.db');

    execFileSync(
      process.execPath,
      [
        join(here, 'build.mjs'),
        '--input',
        join(here, 'fixtures', 'sample.geojsonseq'),
        '--output',
        output,
        '--region',
        'fixture',
        '--tolerance',
        '5',
      ],
      { stdio: 'pipe' },
    );

    db = new Database(output, { readonly: true });
  });

  after(() => {
    db?.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('records build metadata', () => {
    const meta = Object.fromEntries(
      db.prepare('SELECT key, value FROM meta').all().map((row) => [row.key, row.value]),
    );
    assert.equal(meta.region, 'fixture');
    assert.equal(meta.schema_version, '1');
    assert.ok(Number(meta.segment_count) > 0);
  });

  it('keeps only drivable road classes', () => {
    const wayIds = db
      .prepare('SELECT DISTINCT way_id FROM segment ORDER BY way_id')
      .all()
      .map((row) => row.way_id);

    assert.deepEqual(
      wayIds,
      [1, 2, 3, 6, 8],
      'path, service and non-linestring features must be dropped',
    );
  });

  it('reads way ids from both the GeoJSON id member and the @id property', () => {
    // osmium writes a top-level `id`; other exporters use an `@id` property.
    // Reading only the property silently discarded every real-world way once.
    const fromIdMember = db.prepare('SELECT COUNT(*) AS n FROM segment WHERE way_id = 1').get();
    const fromProperty = db.prepare('SELECT COUNT(*) AS n FROM segment WHERE way_id = 8').get();

    assert.ok(fromIdMember.n > 0, 'top-level "id" must be honoured');
    assert.ok(fromProperty.n > 0, '"@id" property must still work');
  });

  it('simplifies a straight motorway into a single segment', () => {
    const rows = db.prepare('SELECT * FROM segment WHERE way_id = 1').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].maxspeed, 120);
    assert.equal(rows[0].winter, 100, 'Finnish motorways drop to 100 in winter');
    assert.equal(rows[0].source, SOURCE_TAGGED);
    assert.equal(rows[0].bearing, 0);
  });

  it('infers a limit when the way carries no maxspeed tag', () => {
    const row = db.prepare('SELECT * FROM segment WHERE way_id = 2').get();
    assert.equal(row.maxspeed, 50);
    assert.equal(row.source, SOURCE_INFERRED);
    assert.equal(row.oneway, 0);
  });

  it('stores a seasonal limit and the oneway flag', () => {
    const row = db.prepare('SELECT * FROM segment WHERE way_id = 3').get();
    assert.equal(row.maxspeed, 100);
    assert.equal(row.winter, 80);
    assert.equal(row.oneway, 1);
  });

  it('falls back to the class default when maxspeed is unknowable', () => {
    const row = db.prepare('SELECT * FROM segment WHERE way_id = 6').get();
    assert.equal(row.maxspeed, 80);
    assert.equal(row.source, SOURCE_INFERRED);
  });

  it('stores coordinates as fixed-point integers', () => {
    const row = db.prepare('SELECT * FROM segment WHERE way_id = 1').get();
    assert.equal(row.lat1, 600000000);
    assert.equal(row.lon1, 250000000);
    assert.ok(Number.isInteger(row.lat2) && Math.abs(row.lat2) < 2 ** 31);
  });

  it('indexes every segment into at least one grid cell', () => {
    const orphans = db
      .prepare('SELECT COUNT(*) AS n FROM segment WHERE id NOT IN (SELECT segment_id FROM segment_cell)')
      .get();
    assert.equal(orphans.n, 0);
  });

  it('finds a segment by looking up its grid cell', () => {
    const rows = db
      .prepare(
        `SELECT s.way_id FROM segment_cell c
         JOIN segment s ON s.id = c.segment_id
         WHERE c.cell_id = ?`,
      )
      .all(cellId(24.9, 60.2));

    assert.ok(
      rows.some((row) => row.way_id === 2),
      'the residential way must be reachable from its own cell',
    );
  });

  it('registers a long segment in every cell it crosses', () => {
    const cells = db
      .prepare(
        `SELECT COUNT(*) AS n FROM segment_cell c
         JOIN segment s ON s.id = c.segment_id
         WHERE s.way_id = 3`,
      )
      .get();
    assert.ok(cells.n > 1, 'a multi-kilometre segment spans more than one cell');
  });
});
