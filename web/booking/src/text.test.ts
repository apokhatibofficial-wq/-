import { test } from 'node:test';
import assert from 'node:assert/strict';
import { B, slugFromPath } from './text.ts';

test('slug is read only from /book/{slug}', () => {
  assert.equal(slugFromPath('/book/al-noor'), 'al-noor');
  assert.equal(slugFromPath('/book/al-noor/'), 'al-noor');
  assert.equal(slugFromPath('/book/Al-Noor'), null);
  assert.equal(slugFromPath('/book/al-noor/x'), null);
  assert.equal(slugFromPath('/admin'), null);
});

test('booking strings exist in all three languages', () => {
  const keys = (o: object) => Object.keys(o).sort().join(',');
  assert.equal(keys(B.ar), keys(B.en));
  assert.equal(keys(B.tr), keys(B.en));
});
