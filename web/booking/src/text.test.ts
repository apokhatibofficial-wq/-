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

test('phone rule matches the server', async () => {
  const { validPhone, normalizePhone } = await import('./text.ts');
  assert.equal(normalizePhone('+963 (944) 123-456'), '+963944123456');
  assert.ok(validPhone('0944 123 456'));
  assert.ok(!validPhone('12ab345'));
  assert.ok(!validPhone('123456'));
});
