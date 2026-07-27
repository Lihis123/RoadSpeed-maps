import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SOURCE_INFERRED,
  SOURCE_TAGGED,
  isOneway,
  parseSpeedValue,
  parseWinterConditional,
  resolveMaxspeed,
} from './maxspeed.mjs';

describe('parseSpeedValue', () => {
  it('parses plain and explicit km/h values', () => {
    assert.equal(parseSpeedValue('50'), 50);
    assert.equal(parseSpeedValue('50 km/h'), 50);
    assert.equal(parseSpeedValue('80km/h'), 80);
    assert.equal(parseSpeedValue('  100  '), 100);
  });

  it('converts mph', () => {
    assert.equal(parseSpeedValue('30 mph'), 48);
    assert.equal(parseSpeedValue('70 mph'), 113);
  });

  it('resolves implicit country categories', () => {
    assert.equal(parseSpeedValue('FI:urban'), 50);
    assert.equal(parseSpeedValue('FI:rural'), 80);
    assert.equal(parseSpeedValue('FI:motorway'), 120);
    assert.equal(parseSpeedValue('FI:living_street'), 20);
  });

  it('resolves speed zones in both tagging styles', () => {
    assert.equal(parseSpeedValue('FI:30'), 30);
    assert.equal(parseSpeedValue('DE:zone30'), 30);
    assert.equal(parseSpeedValue('FI:zone:40'), 40);
  });

  it('returns null for values that cannot be known from the map', () => {
    assert.equal(parseSpeedValue('signals'), null);
    assert.equal(parseSpeedValue('variable'), null);
    assert.equal(parseSpeedValue('none'), null);
    assert.equal(parseSpeedValue(''), null);
    assert.equal(parseSpeedValue(undefined), null);
    assert.equal(parseSpeedValue('nonsense'), null);
  });

  it('rejects out-of-range numbers', () => {
    assert.equal(parseSpeedValue('0'), null);
    assert.equal(parseSpeedValue('9999'), null);
  });

  it('treats walk as a low fixed speed', () => {
    assert.equal(parseSpeedValue('walk'), 7);
  });
});

describe('parseWinterConditional', () => {
  it('extracts a winter value from a month range', () => {
    assert.equal(parseWinterConditional('100 @ (Nov 1-Feb 28)'), 100);
    assert.equal(parseWinterConditional('80 @ (Oct 15-Apr 15)'), 80);
  });

  it('handles a bare winter keyword', () => {
    assert.equal(parseWinterConditional('100 @ winter'), 100);
  });

  it('picks the winter clause out of a multi-clause value', () => {
    assert.equal(parseWinterConditional('60 @ (Mo-Fr 07:00-09:00); 100 @ (Dec 1-Mar 1)'), 100);
  });

  it('ignores conditionals unrelated to winter', () => {
    assert.equal(parseWinterConditional('30 @ (Mo-Fr 07:00-17:00)'), null);
    assert.equal(parseWinterConditional(undefined), null);
  });
});

describe('resolveMaxspeed', () => {
  it('prefers an explicit tag and marks it as tagged', () => {
    const result = resolveMaxspeed({ highway: 'primary', maxspeed: '60' });
    assert.deepEqual(result, { kmh: 60, winterKmh: null, source: SOURCE_TAGGED });
  });

  it('falls back to the Finnish statutory default for the road class', () => {
    const result = resolveMaxspeed({ highway: 'residential' });
    assert.deepEqual(result, { kmh: 50, winterKmh: null, source: SOURCE_INFERRED });
  });

  it('applies the Finnish winter reduction on motorways', () => {
    const result = resolveMaxspeed({ highway: 'motorway' });
    assert.equal(result.kmh, 120);
    assert.equal(result.winterKmh, 100);
  });

  it('lets an explicit conditional override the default winter reduction', () => {
    const result = resolveMaxspeed({
      highway: 'motorway',
      maxspeed: '120',
      'maxspeed:conditional': '80 @ (Nov 1-Mar 31)',
    });
    assert.equal(result.kmh, 120);
    assert.equal(result.winterKmh, 80);
  });

  it('uses maxspeed:type when maxspeed itself is missing', () => {
    const result = resolveMaxspeed({ highway: 'residential', 'maxspeed:type': 'FI:urban' });
    assert.equal(result.kmh, 50);
    assert.equal(result.source, SOURCE_TAGGED);
  });

  it('reports unknown when the class has no statutory default', () => {
    const result = resolveMaxspeed({ highway: 'service' });
    assert.deepEqual(result, { kmh: null, winterKmh: null, source: SOURCE_INFERRED });
  });

  it('does not treat an unknowable tag as a limit', () => {
    const result = resolveMaxspeed({ highway: 'primary', maxspeed: 'signals' });
    assert.equal(result.kmh, 80);
    assert.equal(result.source, SOURCE_INFERRED);
  });
});

describe('isOneway', () => {
  it('detects explicit oneway tagging', () => {
    assert.equal(isOneway({ oneway: 'yes' }), true);
    assert.equal(isOneway({ oneway: '-1' }), true);
    assert.equal(isOneway({ oneway: 'no' }), false);
    assert.equal(isOneway({}), false);
  });

  it('treats roundabouts as oneway', () => {
    assert.equal(isOneway({ junction: 'roundabout' }), true);
    assert.equal(isOneway({ junction: 'roundabout', oneway: 'no' }), false);
  });
});
