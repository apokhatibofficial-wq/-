import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockPlaces, H } from './text.ts';

test('places per block: whole slots only, times capacity', () => {
  assert.equal(blockPlaces('08:00', '12:00', 15, 2), 32);
  assert.equal(blockPlaces('08:00', '08:50', 20, 1), 2);
  assert.equal(blockPlaces('22:00', '24:00', 30, 1), 4);
  assert.equal(blockPlaces('12:00', '08:00', 15, 1), 0);
});

test('hospital strings exist in all three languages', () => {
  const keys = (o: object) => Object.keys(o).sort().join(',');
  assert.equal(keys(H.ar), keys(H.en));
  assert.equal(keys(H.tr), keys(H.en));
  for (const l of ['ar', 'en', 'tr'] as const) assert.equal(H[l].weekdays.length, 7);
});
