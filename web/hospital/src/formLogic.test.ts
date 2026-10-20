import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockers, diff, type Q } from './formLogic.ts';
import { FT } from './formText.ts';

const q = (id: string, ar = 'سؤال', type: Q['type'] = 'short', opts: Q['opts'] = []): Q => ({ id, type, req: false, label: { ar, en: '', tr: '' }, opts });

test('diff counts added, edited, removed and reordering like the prototype', () => {
  const base = [q('a'), q('b'), q('c')];
  assert.deepEqual(diff(base, base), [0, 0, 0, 0]);
  assert.deepEqual(diff([q('a'), q('b', 'معدّل'), q('d')], base), [1, 1, 1, 0]);
  assert.deepEqual(diff([q('c'), q('a'), q('b')], base), [0, 0, 0, 1]);
});

test('blockers: Arabic text required, choice questions need two Arabic options', () => {
  const opt = (id: string, ar: string) => ({ id, label: { ar, en: '', tr: '' } });
  assert.deepEqual(blockers([q('a', '  ')], 'en'), [FT.en.errLabel(1)]);
  assert.deepEqual(blockers([q('a', 'اختر', 'single', [opt('x', 'نعم'), opt('y', '')])], 'en'), [FT.en.errOpts(1)]);
  assert.deepEqual(blockers([q('a', 'اختر', 'multi', [opt('x', 'أ'), opt('y', 'ب')])], 'ar'), []);
});

test('form-builder strings exist in all three languages', () => {
  const keys = (o: object) => Object.keys(o).sort().join(',');
  assert.equal(keys(FT.ar), keys(FT.en));
  assert.equal(keys(FT.tr), keys(FT.en));
});
