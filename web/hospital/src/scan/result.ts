import type { Lang } from '@medlink/shared/text';
import type { ScanText } from './scanText';

/** What the server returns for a scan, a lookup or a check-in (api ScanEndpoints). */
export type ScanResponse = {
  kind: 'ok' | 'found' | 'already' | 'other' | 'cancelled' | 'otherday' | 'bad' | 'notfound' | 'corrected';
  bookingId?: string | null;
  booking?: { ref: string; patientName: string | null; date: string; time: string; department: { ar: string; en: string | null; tr: string | null }; arrivedAt: string | null };
};
export type Kind = ScanResponse['kind'] | 'net' | 'slow';

export type Card = { bg: string; fg: string; border: string; icon: string; title: string; body: string; facts: [string, string][] | null; canConfirm: boolean };

/** Colours and icons from the design's result table (QR Scanner prototype, C). */
const C: Record<Kind, [string, string, string, string]> = {
  ok: ['#e7f6ee', '#0d5a43', '#13795b', '✓'], found: ['#eef1fc', '#1a2d99', '#2b41c5', '✓'],
  already: ['#fff4e5', '#7a4300', '#e8a317', '!'], otherday: ['#fff4e5', '#7a4300', '#e8a317', '!'], corrected: ['#fff4e5', '#7a4300', '#e8a317', '!'],
  other: ['#fdecea', '#8a1c12', '#b42318', '✕'], cancelled: ['#fdecea', '#8a1c12', '#b42318', '✕'], bad: ['#fdecea', '#8a1c12', '#b42318', '✕'],
  notfound: ['#fdecea', '#8a1c12', '#b42318', '?'], net: ['#fff4e5', '#7a4300', '#e8a317', '!'], slow: ['#fff4e5', '#7a4300', '#e8a317', '!'],
};

/** Recent-list dot colour per result. */
export const DOT: Record<Kind, string> = {
  ok: '#13795b', found: '#2b41c5', already: '#e8a317', otherday: '#e8a317', corrected: '#e8a317', net: '#e8a317', slow: '#e8a317',
  other: '#b42318', cancelled: '#b42318', bad: '#b42318', notfound: '#b42318',
};

const locale = (l: Lang) => (l === 'ar' ? 'ar-u-nu-latn' : l === 'tr' ? 'tr-TR' : 'en-GB');

export function dayLabel(date: string, l: Lang): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(locale(l), { weekday: 'long', day: 'numeric', month: 'long' });
}

/** The result card. Details are shown only where the design shows them — never for another hospital or an unknown code. */
export function card(kind: Kind, r: ScanResponse | null, t: ScanText, l: Lang): Card {
  const [bg, fg, border, icon] = C[kind];
  const b = r?.booking;
  const [title, body] = {
    ok: [t.okTitle, t.okBody], found: [t.foundTitle, t.foundBody], already: [t.alreadyTitle, t.alreadyBody(b?.arrivedAt ?? '—')],
    other: [t.otherTitle, t.otherBody], cancelled: [t.cancelledTitle, t.cancelledBody], otherday: [t.otherdayTitle, t.otherdayBody(b ? dayLabel(b.date, l) : '—')],
    bad: [t.badTitle, t.badBody], notfound: [t.notFoundTitle, t.notFoundBody], net: [t.netTitle, t.netBody], slow: [t.slowTitle, t.slowBody],
    corrected: [t.correctedTitle, t.correctedBody],
  }[kind];
  const showFacts = b && ['ok', 'found', 'already', 'cancelled', 'otherday', 'corrected'].includes(kind);
  const dept = b ? (l === 'ar' ? b.department.ar : l === 'en' ? b.department.en || b.department.ar : b.department.tr || b.department.en || b.department.ar) : '';
  const facts: [string, string][] | null = showFacts
    ? [[t.patient, b.patientName ?? '—'], [t.time, b.time], [t.dept, dept], [t.ref, b.ref],
       ...(kind === 'ok' || kind === 'already' ? [[t.checkin, b.arrivedAt ?? '—'] as [string, string]] : [])]
    : null;
  return { bg, fg, border, icon, title, body, facts, canConfirm: kind === 'found' };
}

/** The format printed on tickets: MLK1. + 22 base64url characters. Anything else is not sent to the server. */
export const isQrCode = (s: string) => /^MLK1\.[A-Za-z0-9_-]{22}$/.test(s.trim());
export const isRef = (s: string) => /^ML-[A-Z0-9]{6}$/.test(s.trim().toUpperCase());
