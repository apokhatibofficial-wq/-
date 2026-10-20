import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLUG_RE, slugify, cleanSlugInput } from './slug.ts';
import { A, AH, UT } from './text.ts';

test('slugify follows the prototype and produces valid slugs', () => {
  assert.equal(slugify('Al-Noor General Hospital'), 'al-noor-general-hospital');
  assert.equal(slugify('Al-Amal Children’s Hospital'), 'al-amal-childrens-hospital');
  assert.equal(slugify('  Şifa Hastanesi  '), 'sifa-hastanesi');
  assert.ok(SLUG_RE.test(slugify('A'.repeat(60) + ' Hospital')));
});

test('slug rule matches the server', () => {
  for (const ok of ['abc', 'al-noor', 'a1-b2', 'x'.repeat(40)]) assert.ok(SLUG_RE.test(ok), ok);
  for (const bad of ['ab', '-abc', 'abc-', 'Abc', 'ab_c', 'x'.repeat(41)]) assert.ok(!SLUG_RE.test(bad), bad);
  assert.equal(cleanSlugInput('Al Noor_1!'), 'alnoor1');
});

test('every language has the same shared strings', () => {
  const keys = (o: object) => Object.keys(o).sort().join(',');
  for (const m of [A, AH, UT]) {
    assert.equal(keys(m.ar), keys(m.en));
    assert.equal(keys(m.tr), keys(m.en));
  }
});
