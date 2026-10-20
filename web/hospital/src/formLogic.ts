import type { Lang } from '@medlink/shared/text';
import { FT } from './formText.ts';

export type I18n = { ar: string; en: string; tr: string };
export type QType = 'short' | 'long' | 'single' | 'multi' | 'yesno' | 'date';
export type Opt = { id: string; label: I18n };
export type Q = { id: string; type: QType; req: boolean; label: I18n; opts: Opt[] };

export const hasOpts = (t: QType) => t === 'single' || t === 'multi';

/** [added, edited, removed, reordered] — the prototype's comparison, used for the status strip and the publish dialog. */
export function diff(qs: Q[], base: Q[]): [number, number, number, number] {
  const bm = new Map(base.map(q => [q.id, JSON.stringify(q)]));
  const dm = new Set(qs.map(q => q.id));
  const a = qs.filter(q => !bm.has(q.id)).length;
  const e = qs.filter(q => bm.has(q.id) && bm.get(q.id) !== JSON.stringify(q)).length;
  const r = base.filter(q => !dm.has(q.id)).length;
  const common = qs.filter(q => bm.has(q.id)).map(q => q.id).join();
  const bc = base.filter(q => dm.has(q.id)).map(q => q.id).join();
  return [a, e, r, common !== bc ? 1 : 0];
}

/** Publish blockers from the design: Arabic text on every question; at least two Arabic options on choice questions. */
export function blockers(qs: Q[], L: Lang): string[] {
  const t = FT[L], out: string[] = [];
  qs.forEach((q, i) => {
    if (!q.label.ar.trim()) out.push(t.errLabel(i + 1));
    if (hasOpts(q.type) && q.opts.filter(o => o.label.ar.trim()).length < 2) out.push(t.errOpts(i + 1));
  });
  return out;
}

