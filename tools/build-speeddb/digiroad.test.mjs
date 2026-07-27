import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  directionFor,
  featureFor,
  keepWithoutLimit,
  limitFor,
  roadClassFor,
  toWgs84,
} from './digiroad.mjs';

/** A municipal single-carriageway street, the most common shape of record. */
function link(overrides = {}) {
  return { LINKKITYYP: 3, TOIMINN_LK: 4, AJOSUUNTA: 2, HALLINN_LK: 2, ...overrides };
}

describe('roadClassFor', () => {
  it('reads the class from the functional class', () => {
    assert.equal(roadClassFor(link({ TOIMINN_LK: 1 })), 'trunk');
    assert.equal(roadClassFor(link({ TOIMINN_LK: 2 })), 'primary');
    assert.equal(roadClassFor(link({ TOIMINN_LK: 3 })), 'secondary');
    assert.equal(roadClassFor(link({ TOIMINN_LK: 4 })), 'tertiary');
  });

  it('prefers the link type for motorways and expressways', () => {
    assert.equal(roadClassFor(link({ LINKKITYYP: 1, TOIMINN_LK: 1 })), 'motorway');
    assert.equal(roadClassFor(link({ LINKKITYYP: 4, TOIMINN_LK: 2 })), 'trunk');
  });

  it('gives ramps the class of the road they serve', () => {
    assert.equal(roadClassFor(link({ LINKKITYYP: 6, TOIMINN_LK: 1 })), 'motorway_link');
    assert.equal(roadClassFor(link({ LINKKITYYP: 6, TOIMINN_LK: 3 })), 'primary_link');
    assert.equal(roadClassFor(link({ LINKKITYYP: 6, TOIMINN_LK: 7 })), 'tertiary_link');
  });

  it('splits local roads by who maintains them', () => {
    assert.equal(roadClassFor(link({ TOIMINN_LK: 5, HALLINN_LK: 2 })), 'residential');
    assert.equal(roadClassFor(link({ TOIMINN_LK: 6, HALLINN_LK: 2 })), 'residential');
    assert.equal(roadClassFor(link({ TOIMINN_LK: 5, HALLINN_LK: 3 })), 'unclassified');
  });

  it('rejects links that carry no motor traffic', () => {
    assert.equal(roadClassFor(link({ LINKKITYYP: 8 })), null);
    assert.equal(roadClassFor(link({ LINKKITYYP: 9 })), null);
    assert.equal(roadClassFor(link({ LINKKITYYP: 12 })), null);
    assert.equal(roadClassFor(link({ TOIMINN_LK: 8 })), null);
  });
});

describe('keepWithoutLimit', () => {
  it('keeps public roads, where the statutory default applies', () => {
    assert.equal(keepWithoutLimit(link({ HALLINN_LK: 1 })), true);
    assert.equal(keepWithoutLimit(link({ HALLINN_LK: 2 })), true);
  });

  it('drops private roads and yard roads, where a default would be a guess', () => {
    assert.equal(keepWithoutLimit(link({ HALLINN_LK: 3 })), false);
    assert.equal(keepWithoutLimit(link({ LINKKITYYP: 10 })), false);
    assert.equal(keepWithoutLimit(link({ LINKKITYYP: 11 })), false);
  });
});

describe('directionFor', () => {
  it('follows the link direction when the limit binds both ways', () => {
    assert.deepEqual(directionFor(link({ AJOSUUNTA: 2 }), { VAIK_SUUNT: 1 }), {
      oneway: false,
      reverse: false,
    });
    assert.deepEqual(directionFor(link({ AJOSUUNTA: 3 }), { VAIK_SUUNT: 1 }), {
      oneway: true,
      reverse: false,
    });
    assert.deepEqual(directionFor(link({ AJOSUUNTA: 4 }), { VAIK_SUUNT: 1 }), {
      oneway: true,
      reverse: true,
    });
  });

  it('narrows to one direction when the limit only binds one way', () => {
    assert.deepEqual(directionFor(link(), { VAIK_SUUNT: 2 }), { oneway: true, reverse: false });
    assert.deepEqual(directionFor(link(), { VAIK_SUUNT: 3 }), { oneway: true, reverse: true });
  });

  it('treats a link with no limit record as two-way unless the link says otherwise', () => {
    assert.deepEqual(directionFor(link(), null), { oneway: false, reverse: false });
    assert.deepEqual(directionFor(link({ AJOSUUNTA: 3 }), null), { oneway: true, reverse: false });
  });
});

describe('limitFor', () => {
  it('reads the official value', () => {
    assert.equal(limitFor({ ARVO: 80 }), 80);
    assert.equal(limitFor({ ARVO: '100' }), 100);
  });

  it('rejects values that cannot be a speed limit', () => {
    assert.equal(limitFor({ ARVO: 0 }), null);
    assert.equal(limitFor({ ARVO: -1 }), null);
    assert.equal(limitFor({ ARVO: 999 }), null);
    assert.equal(limitFor({ ARVO: null }), null);
    assert.equal(limitFor(null), null);
  });
});

describe('toWgs84', () => {
  it('puts the central meridian exactly where the projection defines it', () => {
    // EPSG:3067 places 27 degrees east at a false easting of 500 000 m.
    const [[lon]] = toWgs84([[500000, 6650000]]);
    assert.equal(lon, 27);
  });

  it('reprojects a known Digiroad point to the right place', () => {
    // A link in Mariehamn, straight out of the Aland release.
    const [[lon, lat]] = toWgs84([[109292.846, 6688605.883]]);
    assert.ok(Math.abs(lon - 19.9552) < 0.001, `longitude was ${lon}`);
    assert.ok(Math.abs(lat - 60.1466) < 0.001, `latitude was ${lat}`);
  });

  it('drops points that are not finite', () => {
    assert.deepEqual(toWgs84([[Number.NaN, 1]]), []);
    assert.deepEqual(toWgs84(null), []);
  });
});

describe('featureFor', () => {
  const line = [
    [24.9, 60.1],
    [24.91, 60.11],
  ];

  it('tags the official limit so the builder stores it as signposted', () => {
    const feature = featureFor(7, link(), { ARVO: 60, VAIK_SUUNT: 1 }, line);
    assert.equal(feature.id, 7);
    assert.deepEqual(feature.properties, { highway: 'tertiary', maxspeed: '60' });
    assert.deepEqual(feature.geometry.coordinates, line);
  });

  it('leaves the limit off when Digiroad holds no record, so the builder infers it', () => {
    const feature = featureFor(8, link(), null, line);
    assert.deepEqual(feature.properties, { highway: 'tertiary' });
  });

  it('turns the line around when the limit applies against the geometry', () => {
    const feature = featureFor(9, link(), { ARVO: 40, VAIK_SUUNT: 3 }, line);
    assert.deepEqual(feature.properties, { highway: 'tertiary', maxspeed: '40', oneway: 'yes' });
    assert.deepEqual(feature.geometry.coordinates, [...line].reverse());
  });

  it('rejects links that are not drivable or have no line', () => {
    assert.equal(featureFor(1, link({ LINKKITYYP: 8 }), null, line), null);
    assert.equal(featureFor(1, link(), null, [[24.9, 60.1]]), null);
    assert.equal(featureFor(1, link(), null, null), null);
  });
});
