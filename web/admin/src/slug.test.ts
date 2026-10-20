import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLUG_RE, slugify, cleanSlugInput } from './slug.ts';
import { A, COMPANY_PERMS, HOSPITAL_PERMS } from './i18n.ts';

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

test('every language has the same strings and permission rows', () => {
  const keys = (o: object) => Object.keys(o).sort().join(',');
  assert.equal(keys(A.ar), keys(A.en));
  assert.equal(keys(A.tr), keys(A.en));
  for (const m of [COMPANY_PERMS, HOSPITAL_PERMS]) {
    assert.deepEqual(m.ar.map(r => r[1]), m.en.map(r => r[1]));
    assert.deepEqual(m.tr.map(r => r[1]), m.en.map(r => r[1]));
  }
});
