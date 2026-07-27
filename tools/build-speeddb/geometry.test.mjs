import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bearingDegrees, cellId, cellIdsForSegment, simplify, toFixed } from './geometry.mjs';

describe('bearingDegrees', () => {
  it('reports north, east, south and west', () => {
    assert.equal(bearingDegrees(25, 60, 25, 61), 0);
    assert.equal(bearingDegrees(25, 60, 26, 60), 90);
    assert.equal(bearingDegrees(25, 60, 25, 59), 180);
    assert.equal(bearingDegrees(25, 60, 24, 60), 270);
  });

  it('always returns a value in [0, 360)', () => {
    for (let lon = -180; lon < 180; lon += 17) {
      const value = bearingDegrees(25, 60, lon, 61);
      assert.ok(value >= 0 && value < 360, `bearing ${value} out of range`);
    }
  });
});

describe('simplify', () => {
  it('keeps short lines untouched', () => {
    const points = [
      [25, 60],
      [25.001, 60.001],
    ];
    assert.equal(simplify(points, 5).length, 2);
  });

  it('collapses a straight line to its endpoints', () => {
    const points = [];
    for (let step = 0; step <= 20; step += 1) points.push([25, 60 + step * 0.001]);

    const result = simplify(points, 5);
    assert.deepEqual(result, [
      [25, 60],
      [25, 60.02],
    ]);
  });

  it('preserves a corner that exceeds the tolerance', () => {
    const points = [
      [25, 60],
      [25.01, 60],
      [25.01, 60.01],
    ];
    assert.equal(simplify(points, 5).length, 3);
  });

  it('never drops the first or last point', () => {
    const points = [
      [25, 60],
      [25.00001, 60.00001],
      [25.00002, 60],
    ];
    const result = simplify(points, 50);
    assert.deepEqual(result[0], [25, 60]);
    assert.deepEqual(result[result.length - 1], [25.00002, 60]);
  });
});

describe('cell indexing', () => {
  it('gives neighbouring coordinates distinct cells', () => {
    assert.notEqual(cellId(25.005, 60.005), cellId(25.015, 60.005));
    assert.notEqual(cellId(25.005, 60.005), cellId(25.005, 60.015));
  });

  it('gives coordinates inside one cell the same identifier', () => {
    assert.equal(cellId(25.001, 60.001), cellId(25.009, 60.009));
  });

  it('produces non-negative identifiers across the globe', () => {
    for (const [lon, lat] of [
      [-179.9, -89.9],
      [179.9, 89.9],
      [0, 0],
      [25, 60],
    ]) {
      const id = cellId(lon, lat);
      assert.ok(id >= 0 && Number.isSafeInteger(id), `cell ${id} invalid for ${lon},${lat}`);
    }
  });

  it('covers every cell a long segment crosses', () => {
    const ids = cellIdsForSegment(25.0, 60.0, 25.05, 60.03);
    assert.equal(ids.length, 6 * 4);
    assert.ok(ids.includes(cellId(25.0, 60.0)));
    assert.ok(ids.includes(cellId(25.05, 60.03)));
    assert.ok(ids.includes(cellId(25.025, 60.015)));
  });

  it('returns a single cell for a short segment', () => {
    assert.deepEqual(cellIdsForSegment(25.001, 60.001, 25.002, 60.002), [cellId(25.001, 60.001)]);
  });
});

describe('toFixed', () => {
  it('scales degrees into int32 range', () => {
    assert.equal(toFixed(60.1695), 601695000);
    assert.equal(toFixed(-24.9354), -249354000);
    assert.ok(Math.abs(toFixed(180)) < 2 ** 31);
  });
});
