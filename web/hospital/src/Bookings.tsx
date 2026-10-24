import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@medlink/shared/api';
import type { Lang } from '@medlink/shared/text';
import { BT } from './bookingsText';

type Names = { ar: string; en: string | null; tr: string | null };
type Booking = {
  id: string; ref: string; localDate: string; localTime: string; department: Names & { id: string };
  patientName: string | null; phone: string | null; status: 'waiting' | 'arrived' | 'no_show' | 'cancelled'; formVersion: number | null; cancelReason: string | null;
  arrivedAt: string | null; needsReview: boolean; createdAt: string;
};
type Event = { type: 'arrived' | 'no_show' | 'waiting'; source: string; at: string; reason: string | null; actor: string | null };
type Status = Booking['status'];
const STATUSES: Status[] = ['waiting', 'arrived', 'no_show', 'cancelled'];
/** The day board refreshes itself (a phone scan or the Windows app shows up here without reloading). */
export const LIVE_MS = 30_000;
type Question = { id: string; type: string; label: { ar?: string; en?: string; tr?: string }; opts: { id: string; label: { ar?: string; en?: string; tr?: string } }[] | null };

const lbl = (o: { ar?: string | null; en?: string | null; tr?: string | null } | undefined, l: Lang) => (o ? o[l] || o.ar || o.en || o.tr || '' : '');
const addDays = (d: string, n: number) => { const [y, m, dd] = d.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1, dd + n)); return x.toISOString().slice(0, 10); };

type Props = { lang: Lang; canCancel: boolean; canCheckIn: boolean; canCorrect: boolean; readOnly: boolean; grace: number | null; timezone: string; flash: (s: string) => void };

/**
 * The day board (hospital time zone): status chips with counts, department filter, live refresh, lookup by full
 * booking number, and the detail drawer with check-in, correction, cancellation and the history. Doctors: read-only.
 */
export function Bookings({ lang: L, canCancel, canCheckIn, canCorrect, readOnly, grace, timezone, flash }: Props) {
  const t = BT[L];
  const [date, setDate] = useState<string | null>(null);
  const [rows, setRows] = useState<Booking[] | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState<null | { b: Booking; answers: Record<string, unknown>; questions: Question[]; events: Event[] }>(null);
  const [filter, setFilter] = useState<'all' | Status>('all');
  const [dept, setDept] = useState('all');
  const mine = useRef(new Set<string>()); // bookings this user just changed: no "checked in" notice for them
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [today, setToday] = useState<string | null>(null);
  const [corrType, setCorrType] = useState<'arrived' | 'no_show' | 'waiting'>('arrived');
  const [corrReason, setCorrReason] = useState('');

  const load = useCallback(async (d: string | null) => {
    setRows(null); setSearching(false);
    const r = await api<{ date: string; bookings: Booking[] }>('GET', '/hospital/bookings' + (d ? '?date=' + d : ''));
    setDate(r.date); setRows(r.bookings);
    if (!d) setToday(r.date);
  }, []);
  useEffect(() => { void load(null); }, [load]);

  // Live refresh of today's list while the page is visible; arrivals recorded elsewhere are announced.
  const rowsRef = useRef<Booking[] | null>(null);
  rowsRef.current = rows;
  useEffect(() => {
    if (searching || !date || date !== today) return;
    const timer = setInterval(async () => {
      if (document.visibilityState !== 'visible' || !rowsRef.current) return;
      let r: { date: string; bookings: Booking[] };
      try { r = await api('GET', '/hospital/bookings?date=' + date); } catch { return; }
      const before = new Map(rowsRef.current.map(b => [b.id, b.status]));
      for (const b of r.bookings)
        if (b.status === 'arrived' && before.has(b.id) && before.get(b.id) !== 'arrived' && !mine.current.delete(b.id)) flash(t.live(b.patientName ?? b.ref));
      setRows(r.bookings);
      setOpen(o => {
        const n = o && r.bookings.find(b => b.id === o.b.id);
        return o && n && (n.status !== o.b.status || n.needsReview !== o.b.needsReview) ? { ...o, b: n } : o;
      });
    }, LIVE_MS);
    return () => clearInterval(timer);
  }, [date, today, searching, flash, t]);

  async function search() {
    const ref = query.trim().toUpperCase();
    if (!/^ML-[A-Z0-9]{6}$/.test(ref)) { setErr(t.refFormat); return; }
    setErr(''); setRows(null); setSearching(true);
    const r = await api<{ bookings: Booking[] }>('GET', '/hospital/bookings?ref=' + encodeURIComponent(ref));
    setRows(r.bookings);
  }

  async function openBooking(b: Booking) {
    const r = await api<{ answers: Record<string, unknown>; questions: Question[]; events: Event[] }>('GET', '/hospital/bookings/' + encodeURIComponent(b.id));
    setOpen({ b, answers: r.answers, questions: r.questions, events: r.events }); setReason(''); setErr(''); setCorrReason('');
    setCorrType(b.status === 'arrived' ? 'no_show' : 'arrived');
  }

  async function refreshList() { if (searching) await search(); else await load(date); }

  /** Check-in (no reason) or correction (with a reason); the server applies the approved conflict policy. */
  async function attendance(type: 'arrived' | 'no_show' | 'waiting', reasonText?: string) {
    if (!open) return;
    setErr('');
    try {
      const r = await api<{ status: Booking['status']; arrivedAt: string | null; needsReview: boolean }>('POST',
        '/hospital/bookings/' + encodeURIComponent(open.b.id) + '/attendance', reasonText === undefined ? { type } : { type, reason: reasonText });
      mine.current.add(open.b.id);
      const d = await api<{ events: Event[] }>('GET', '/hospital/bookings/' + encodeURIComponent(open.b.id)).catch(() => ({ events: open.events }));
      setOpen({ ...open, b: { ...open.b, status: r.status, arrivedAt: r.arrivedAt, needsReview: r.needsReview }, events: d.events });
      setCorrReason('');
      flash(reasonText === undefined ? t.checkedIn : t.saved);
      await refreshList();
    } catch (e) {
      const c = e instanceof ApiError ? e.code : '';
      setErr(c === 'OTHER_DAY' ? t.otherDay : c === 'CANCELLED' ? t.notCancellable : t.generic);
    }
  }
  const clock = (iso: string) => new Date(iso).toLocaleTimeString(L === 'ar' ? 'ar-u-nu-latn' : L, { hour: '2-digit', minute: '2-digit', timeZone: timezone });

  async function cancel() {
    if (!open) return;
    try {
      await api('POST', '/hospital/bookings/' + encodeURIComponent(open.b.id) + '/cancel', { reason: reason.trim() });
      setOpen(null); flash(t.cancelled);
      await refreshList();
    } catch (e) { setErr(e instanceof ApiError && e.code === 'NOT_CANCELLABLE' ? t.notCancellable : t.generic); }
  }

  const chip = (s: Booking['status']) => {
    const [bg, fg] = s === 'waiting' ? ['#eef1fc', '#1a2d99'] : s === 'arrived' ? ['#e7f6ee', '#13795b'] : s === 'no_show' ? ['#fff4e5', '#7a4300'] : ['#fdecea', '#8a1c12'];
    return <span className="chip" style={{ background: bg, color: fg }}>{t.status[s]}</span>;
  };
  const answerText = (q: Question, v: unknown) => {
    if (v == null) return '—';
    if (q.type === 'yesno') return v === 'yes' ? t.yes : t.no;
    if (q.type === 'single' || q.type === 'multi') return (Array.isArray(v) ? v : [v]).map(id => lbl(q.opts?.find(o => o.id === id)?.label, L)).join(', ');
    return String(v);
  };
  const departments = [...new Map((rows ?? []).map(b => [b.department.id, b.department])).values()];
  const deptRows = (rows ?? []).filter(b => searching || dept === 'all' || b.department.id === dept);
  const shown = deptRows.filter(b => searching || filter === 'all' || b.status === filter);
  const dayLabel = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd).toLocaleDateString(L === 'ar' ? 'ar-u-nu-latn' : L, { weekday: 'long', day: 'numeric', month: 'long' }); };

  return (
    <>
      <div className="filters">
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <button type="button" className="copy-btn" style={{ height: 36 }} aria-label={t.prev} disabled={!date} onClick={() => date && void load(addDays(date, -1))}>‹</button>
          <button type="button" className="copy-btn" style={{ height: 36 }} onClick={() => void load(null)}>{t.today}</button>
          <button type="button" className="copy-btn" style={{ height: 36 }} aria-label={t.next} disabled={!date} onClick={() => date && void load(addDays(date, 1))}>›</button>
          {date && !searching && <strong style={{ marginInlineStart: 8, fontSize: 15 }}>{dayLabel(date)}</strong>}
        </div>
        <form style={{ display: 'flex', gap: 6, marginInlineStart: 'auto' }} onSubmit={e => { e.preventDefault(); void search(); }}>
          <input className="input" dir="ltr" style={{ height: 36, width: 180, fontFamily: 'var(--mono)', fontSize: 14 }} placeholder="ML-XXXXXX" aria-label={t.searchRef} value={query} onChange={e => setQuery(e.target.value)} />
          <button type="submit" className="btn btn-secondary" style={{ height: 36 }}>{t.find}</button>
        </form>
      </div>
      <p className="note" style={{ margin: 0 }}>{t.searchNote}</p>
      {readOnly && <div className="alert" style={{ background: 'var(--soft, #eef1fc)', color: 'var(--brand-deep)' }}>{t.readOnly}</div>}
      {rows && !searching && rows.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {(['all', ...STATUSES] as const).map(k => {
            const n = k === 'all' ? deptRows.length : deptRows.filter(b => b.status === k).length;
            return (
              <button key={k} type="button" className="copy-btn" aria-pressed={filter === k} onClick={() => setFilter(k)}
                style={{ height: 32, ...(filter === k ? { background: '#2b41c5', borderColor: '#2b41c5', color: '#fff' } : {}) }}>
                {k === 'all' ? t.all : t.status[k]} <bdi style={{ fontWeight: 700, marginInlineStart: 4 }}>{n}</bdi>
              </button>
            );
          })}
          {departments.length > 1 && (
            <select className="input" style={{ height: 32, width: 'auto', minWidth: 150 }} aria-label={t.allDepts} value={dept} onChange={e => setDept(e.target.value)}>
              <option value="all">{t.allDepts}</option>
              {departments.map(d => <option key={d.id} value={d.id}>{lbl(d, L)}</option>)}
            </select>
          )}
          <span className="note" style={{ marginInlineStart: 'auto' }}>{date === today ? t.liveNote : ''}{date === today && grace ? ' · ' + t.grace(grace) : ''}</span>
        </div>
      )}
      {err && !open && <div role="alert" className="alert alert-danger">{err}</div>}

      <div className="card table">
        <div className="trow thead" style={{ gridTemplateColumns: '64px 110px minmax(140px,1.4fr) minmax(120px,1fr) 110px', minWidth: 620 }}>
          <span>{t.time}</span><span>{t.ref}</span><span>{t.patient}</span><span>{t.department}</span><span>{t.statusLabel}</span>
        </div>
        {rows === null && <div className="empty">…</div>}
        {rows?.length === 0 && <div className="empty">{searching ? t.notFound : t.none}</div>}
        {rows && rows.length > 0 && shown.length === 0 && <div className="empty">{t.none}</div>}
        {shown.map(b => (
          <div key={b.id} role="button" tabIndex={0} className="trow clickable" onClick={() => void openBooking(b)} onKeyDown={e => { if (e.key === 'Enter') void openBooking(b); }}
            style={{ gridTemplateColumns: '64px 110px minmax(140px,1.4fr) minmax(120px,1fr) 110px', minWidth: 620, fontSize: 14 }}>
            <span dir="ltr" className="mono">{searching ? b.localDate.slice(5) + ' ' : ''}{b.localTime}</span>
            <span dir="ltr" className="mono" style={{ fontSize: 13 }}>{b.ref}</span>
            <span className="ellipsis" style={{ fontWeight: 500 }} dir="auto">{b.patientName ?? '—'}</span>
            <span className="ellipsis">{lbl(b.department, L)}</span>
            <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>{chip(b.status)}{b.needsReview && <span title={t.needsReview} aria-label={t.needsReview} style={{ color: '#b54708', fontWeight: 700 }}>!</span>}</span>
          </div>
        ))}
      </div>

      {open && (
        <div className="scrim" onClick={() => setOpen(null)}>
          <div className="drawer" role="dialog" aria-modal="true" aria-label={open.b.ref} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div dir="ltr" className="mono" style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)', textAlign: 'start' }}>{open.b.ref}</div>
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{chip(open.b.status)}{open.b.needsReview && <span className="chip" style={{ background: '#fff4e5', color: '#7a4300' }}>{t.needsReview}</span>}</span>
              </div>
              <button type="button" className="icon-btn" aria-label={t.close} onClick={() => setOpen(null)}>×</button>
            </div>
            <div className="facts">
              {[[t.patient, open.b.patientName ?? '—'], [t.phone, open.b.phone ?? '—'], [t.department, lbl(open.b.department, L)], [t.when, open.b.localDate + ' ' + open.b.localTime], ...(open.b.arrivedAt ? [[t.arrivedAt, clock(open.b.arrivedAt)]] : [])].map(([k, v]) => (
                <div key={k}><span className="note">{k}</span><span style={{ fontSize: 14, fontWeight: 600 }} dir="auto">{v}</span></div>
              ))}
            </div>
            {open.questions.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{t.answers}{open.b.formVersion ? ' · v' + open.b.formVersion : ''}</span>
                {open.questions.map(q => (
                  <div key={q.id} style={{ borderTop: '1px solid var(--divider)', paddingTop: 8 }}>
                    <div className="note">{lbl(q.label, L)}</div>
                    <div style={{ fontSize: 14 }} dir="auto">{answerText(q, open.answers[q.id])}</div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{t.history}</span>
              {[{ at: open.b.createdAt, text: t.booked, extra: '' }, ...open.events.map(e => ({
                at: e.at, text: t.status[e.type] + ' · ' + (t.src[e.source] ?? e.source), extra: [e.reason, e.actor].filter(Boolean).join(' · '),
              }))].map((h, i) => (
                <div key={i} style={{ display: 'flex', gap: 10, fontSize: 13, borderTop: i ? '1px solid var(--divider)' : 'none', paddingTop: i ? 6 : 0 }}>
                  <span dir="ltr" className="mono" style={{ whiteSpace: 'nowrap', color: 'var(--muted, #5b6478)' }}>{new Date(h.at).toLocaleDateString('en-CA', { timeZone: timezone }).slice(5)} {clock(h.at)}</span>
                  <span style={{ flex: 1 }}><span>{h.text}</span>{h.extra && <span className="note" style={{ display: 'block' }} dir="auto">{h.extra}</span>}</span>
                </div>
              ))}
            </div>
            {open.b.status === 'cancelled' && open.b.cancelReason && <div className="alert alert-danger">{t.cancelReason}: {open.b.cancelReason}</div>}
            {err && <div role="alert" className="alert alert-danger">{err}</div>}
            {canCheckIn && open.b.status === 'waiting' && open.b.localDate === today && (
              <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={() => void attendance('arrived')}>{t.markArrived}</button>
            )}
            {canCorrect && open.b.status !== 'cancelled' && (
              <div style={{ borderTop: '1px solid var(--thead-border)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{t.correct}</span>
                <div role="radiogroup" aria-label={t.correct} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {(['arrived', 'no_show', 'waiting'] as const).map(k => (
                    <button key={k} type="button" role="radio" aria-checked={corrType === k} className="copy-btn"
                      style={{ height: 32, ...(corrType === k ? { background: '#eef1fc', borderColor: 'var(--brand)', color: 'var(--brand-deep)' } : {}) }}
                      onClick={() => setCorrType(k)}>{t.status[k]}</button>
                  ))}
                </div>
                <textarea className="input" rows={2} maxLength={300} placeholder={t.corrReasonPh} aria-label={t.corrReasonPh} value={corrReason} onChange={e => setCorrReason(e.target.value)} />
                <button type="button" className="btn btn-secondary" style={{ alignSelf: 'flex-start' }} disabled={corrReason.trim().length < 5}
                  onClick={() => void attendance(corrType, corrReason.trim())}>{t.saveCorr}</button>
                <span className="note">{t.corrNote}</span>
              </div>
            )}
            {canCancel && open.b.status === 'waiting' && (
              <div style={{ borderTop: '1px solid var(--thead-border)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{t.cancelTitle}</span>
                <textarea className="input" rows={2} maxLength={300} placeholder={t.reasonPh} aria-label={t.reasonPh} value={reason} onChange={e => setReason(e.target.value)} />
                <button type="button" className="btn btn-danger" style={{ alignSelf: 'flex-start' }} disabled={reason.trim().length < 3} onClick={() => void cancel()}>{t.confirmCancel}</button>
                <span className="note">{t.cancelNote}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
