import { test } from 'node:test';
import assert from 'node:assert/strict';
import { card, isQrCode, isRef, type ScanResponse } from './result.ts';
import { ST } from './scanText.ts';

const booking: ScanResponse['booking'] = { ref: 'ML-ABC234', patientName: 'مريض تجريبي', date: '2026-10-22', time: '10:30', department: { ar: 'الباطنية', en: 'Internal medicine', tr: null }, arrivedAt: '10:21' };

test('checked in: green, details and check-in time', () => {
  const c = card('ok', { kind: 'ok', booking }, ST.ar, 'ar');
  assert.equal(c.title, 'تم تسجيل الحضور');
  assert.equal(c.border, '#13795b');
  assert.deepEqual(c.facts?.map(f => f[1]), ['مريض تجريبي', '10:30', 'الباطنية', 'ML-ABC234', '10:21']);
});

test('another hospital and unknown codes never show details', () => {
  for (const k of ['other', 'bad', 'notfound', 'net'] as const) {
    const c = card(k, { kind: k as ScanResponse['kind'], booking }, ST.en, 'en');
    assert.equal(c.facts, null, k);
    assert.ok(!c.body.includes('مريض') && !c.body.includes('ML-ABC234'), k);
  }
});

test('already checked in shows the earlier time; other day shows the date', () => {
  assert.equal(card('already', { kind: 'already', booking }, ST.en, 'en').body, 'This booking was checked in at 10:21. It wasn’t recorded again.');
  assert.match(card('otherday', { kind: 'otherday', booking }, ST.en, 'en').body, /22 October/);
});

test('only a found booking can be confirmed; Turkish falls back to English department name', () => {
  assert.equal(card('found', { kind: 'found', booking }, ST.tr, 'tr').canConfirm, true);
  assert.equal(card('ok', { kind: 'ok', booking }, ST.tr, 'tr').canConfirm, false);
  assert.equal(card('found', { kind: 'found', booking }, ST.tr, 'tr').facts?.[2][1], 'Internal medicine');
});

test('code and booking-number formats', () => {
  assert.ok(isQrCode('MLK1.' + 'A'.repeat(22)));
  assert.ok(!isQrCode('MLK1.' + 'A'.repeat(21)));
  assert.ok(!isQrCode('https://example.com/MLK1.' + 'A'.repeat(22)));
  assert.ok(isRef('ml-abc234'));
  assert.ok(!isRef('ML-ABC23'));
});
