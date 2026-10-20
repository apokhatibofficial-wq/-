import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { Lang } from '@medlink/shared/text';
import { PT } from './patientText';
import { BX, LOCALE, normalizePhone, validPhone } from './text';

type Names = { ar: string; en: string | null; tr: string | null };
type I18n = { ar?: string | null; en?: string | null; tr?: string | null };
type Question = { id: string; type: 'short' | 'long' | 'single' | 'multi' | 'yesno' | 'date'; req: boolean; label: I18n; opts: { id: string; label: I18n }[] | null };
type Form = { versionId: string; version: number; questions: Question[] } | null;
type DayAv = { date: string; weekday: number; status: 'open' | 'full' | 'closed'; open: number; slots: { start: string; time: string }[] };
type Answer = string | string[];
type Confirmation = { ref: string; qr: string; localDate: string; localTime: string; department: Names; hospital: Names };

const API: string = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';
const lbl = (o: I18n | Names | undefined | null, l: Lang) => (o ? o[l] || o.ar || o.en || o.tr || '' : '');
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '');

const sel = (on: boolean) => ({ borderColor: on ? '#2b41c5' : '#dde2f0', background: on ? '#eef1fc' : '#ffffff', color: on ? '#1a2d99' : '#1c2340' });
const h1: React.CSSProperties = { margin: 0, fontSize: 'clamp(20px,5.5vw,24px)', fontWeight: 600, color: 'var(--ink)' };
const subP: React.CSSProperties = { margin: 0, fontSize: 15, color: 'var(--muted)' };
const input48: React.CSSProperties = { height: 48, border: '1px solid #c9cfe3', borderRadius: 10, padding: '0 14px', fontSize: 16, color: '#1c2340', outline: 'none' };
const errS: React.CSSProperties = { fontSize: 13, color: '#b42318' };

type Props = { lang: Lang; slug: string; hospital: Names; departments: { id: string; name: Names }[] };

export function BookingFlow({ lang: L, slug, hospital, departments }: Props) {
  const t = PT[L], x = BX[L];
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [dept, setDept] = useState<string | null>(null);
  const [form, setForm] = useState<Form | undefined>(undefined);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [days, setDays] = useState<DayAv[] | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [slot, setSlot] = useState<{ start: string; time: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<Confirmation | null>(null);
  const keyRef = useRef<string | null>(null);

  const loadForm = useCallback(async () => {
    const r = await fetch(API + '/public/hospitals/' + slug + '/form', { credentials: 'omit' });
    const f = r.ok ? ((await r.json()).form as Form) : null;
    setForm(f);
    return f;
  }, [slug]);
  useEffect(() => { void loadForm(); }, [loadForm]);

  const loadDays = useCallback(async (d: string) => {
    setDays(null);
    const r = await fetch(API + '/public/hospitals/' + slug + '/availability?departmentId=' + encodeURIComponent(d), { credentials: 'omit' });
    setDays(r.ok ? ((await r.json()).days as DayAv[]) : []);
  }, [slug]);

  const questions = form?.questions ?? [];
  const hasQuestions = questions.length > 0;
  // Step indices follow the design (0 details, 1 department, 2 questions, 3 date & time, 4 review); 2 is skipped without questions.
  const visibleSteps = hasQuestions ? [0, 1, 2, 3, 4] : [0, 1, 3, 4];
  const deptName = (id: string | null) => lbl(departments.find(d => d.id === id)?.name, L);
  const dateLabel = (d: string | null) => {
    if (!d) return '';
    const [y, m, dd] = d.split('-').map(Number);
    return new Date(y, m - 1, dd).toLocaleDateString(LOCALE[L], { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
  };

  function validate(s: number): Record<string, string> {
    const e: Record<string, string> = {};
    if (s === 0) {
      if (name.trim().length < 2) e.name = t.errName;
      if (phone.trim() && !validPhone(phone)) e.phone = t.errPhone;
    }
    if (s === 1 && !dept) e.dept = t.errDept;
    if (s === 2) for (const q of questions) {
      const v = answers[q.id];
      const empty = v == null || (Array.isArray(v) ? v.length === 0 : !String(v).trim());
      if (q.req && empty) e['q_' + q.id] = t.errReq;
    }
    if (s === 3 && !slot) e.slot = t.errSlot;
    return e;
  }

  const go = (s: number) => { setErrors({}); setStep(s); if (s === 4) keyRef.current ??= newKey(); };
  const nextStep = (s: number) => visibleSteps[visibleSteps.indexOf(s) + 1];
  const prevStep = (s: number) => visibleSteps[visibleSteps.indexOf(s) - 1];

  async function next() {
    const e = validate(step);
    setErrors(e);
    if (Object.keys(e).length) return;
    if (step === 1 && dept) void loadDays(dept);
    if (step < 4) { go(nextStep(step)); return; }
    await submit();
  }

  async function submit() {
    if (submitting || !dept || !slot) return;
    setSubmitting(true); setBanner(null);
    const clean: Record<string, Answer> = {};
    for (const q of questions) {
      const v = answers[q.id];
      if (v == null || (Array.isArray(v) ? v.length === 0 : !String(v).trim())) continue;
      clean[q.id] = typeof v === 'string' ? v.trim() : v;
    }
    try {
      const r = await fetch(API + '/public/hospitals/' + slug + '/bookings', {
        method: 'POST', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': keyRef.current ?? (keyRef.current = newKey()) },
        body: JSON.stringify({ departmentId: dept, slotStart: slot.start, patientName: name.trim(), phone: phone.trim() ? normalizePhone(phone) : null,
          formVersionId: form?.versionId ?? null, answers: clean }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok) { setDone(body as Confirmation); window.scrollTo(0, 0); return; }
      const code: string = body.error ?? '';
      keyRef.current = null; // a refused request gets a fresh key once the patient changes something
      if (code === 'SLOT_FULL' || code === 'SLOT_UNAVAILABLE') {
        setSlot(null); setBanner(code === 'SLOT_FULL' ? t.conflict : x.unavailable); void loadDays(dept); setStep(3);
      } else if (code === 'FORM_UPDATED') {
        const f = await loadForm();
        // Keep answers whose question still exists with the same type.
        const keep: Record<string, Answer> = {};
        for (const q of f?.questions ?? []) if (q.id in answers && questions.find(o => o.id === q.id)?.type === q.type) keep[q.id] = answers[q.id];
        setAnswers(keep); setBanner(x.formUpdated); setStep((f?.questions.length ?? 0) > 0 ? 2 : 3);
      } else if (code === 'NAME_INVALID') { setErrors({ name: t.errName }); setStep(0); }
      else if (code === 'PHONE_INVALID') { setErrors({ phone: t.errPhone }); setStep(0); }
      else if (code.startsWith('ANSWER_')) { const q = body.detail?.questionId; setErrors(q ? { ['q_' + q]: t.errReq } : {}); setStep(2); }
      else setBanner(code === 'RATE_LIMITED' ? x.rate : code === 'PHONE_LIMIT' ? x.phoneLimit : x.generic);
    } catch {
      setBanner(x.network); // same Idempotency-Key on retry, so no duplicate booking
    } finally { setSubmitting(false); }
  }

  function restart() {
    setDone(null); setStep(0); setName(''); setPhone(''); setDept(null); setAnswers({}); setDate(null); setSlot(null);
    setDays(null); setBanner(null); setErrors({}); keyRef.current = null; void loadForm();
  }

  if (form === undefined) return <div className="card empty">…</div>;
  if (done) return <Ticket lang={L} c={done} name={name.trim()} dateLabel={dateLabel(done.localDate)} onRestart={restart} />;

  const answerText = (q: Question) => {
    const v = answers[q.id];
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '—';
    if (q.type === 'yesno') return v === 'yes' ? t.yes : t.no;
    if (q.type === 'short' || q.type === 'long') return String(v);
    if (q.type === 'date') return dateLabel(String(v));
    return (Array.isArray(v) ? v : [v]).map(id => lbl(q.opts?.find(o => o.id === id)?.label, L)).join(', ');
  };
  const dayInfo = days?.find(d => d.date === date);
  const sv = (v: string) => ({ v: v || t.notSet, color: v ? '#1c2340' : '#8a91a8' });

  return (
    <>
      <nav style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} aria-label={t.bookTitle}>
        {visibleSteps.map((s, i) => (
          <div key={s} style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }} aria-current={s === step ? 'step' : undefined}>
            <div style={{ height: 4, borderRadius: 2, background: visibleSteps.indexOf(step) >= i ? '#2b41c5' : '#dde2f0' }} />
            <div className="ellipsis" style={{ fontSize: 'clamp(11px,2.8vw,13px)', fontWeight: s === step ? 600 : 400, color: visibleSteps.indexOf(step) >= i ? '#1a2d99' : '#5b6380' }}>{i + 1}. {t.steps[s]}</div>
          </div>
        ))}
      </nav>

      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <section style={{ flex: '1 1 520px', minWidth: 0, background: '#fff', border: '1px solid var(--border)', borderRadius: 16, padding: 'clamp(16px,5vw,28px)', display: 'flex', flexDirection: 'column', gap: 22 }}>
          {banner && <div role="alert" style={{ background: '#fff4e5', border: '1px solid #f3c27a', color: '#7a4300', borderRadius: 10, padding: '12px 14px', fontSize: 14, lineHeight: 1.5 }}>{banner}</div>}

          {step === 0 && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><h1 style={h1}>{t.s0Title}</h1><p style={subP}>{t.s0Sub}</p></div>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 500 }}>{t.name} <span style={{ color: '#b42318' }}>*</span></span>
                <input value={name} onChange={e => setName(e.target.value)} maxLength={80} autoComplete="name" style={{ ...input48, borderColor: errors.name ? '#b42318' : '#c9cfe3' }} aria-invalid={!!errors.name} />
                {errors.name && <span style={errS}>{errors.name}</span>}
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 500 }}>{t.phone} <span style={{ fontWeight: 400, color: '#5b6380' }}>({t.optional})</span></span>
                <input value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" dir="ltr" placeholder="+963 9XX XXX XXX" autoComplete="tel" style={{ ...input48, textAlign: 'start', borderColor: errors.phone ? '#b42318' : '#c9cfe3' }} aria-invalid={!!errors.phone} />
                {errors.phone && <span style={errS}>{errors.phone}</span>}
                <span style={{ fontSize: 13, color: '#5b6380' }}>{t.phoneHint}</span>
              </label>
            </>
          )}

          {step === 1 && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><h1 style={h1}>{t.s1Title}</h1><p style={subP}>{t.s1Sub}</p></div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(min(100%,200px),1fr))', gap: 10 }} role="radiogroup">
                {departments.map(d => (
                  <button key={d.id} type="button" role="radio" aria-checked={dept === d.id} onClick={() => { setDept(d.id); setDate(null); setSlot(null); setErrors({}); }}
                    style={{ minHeight: 64, textAlign: 'start', border: '1.5px solid', ...sel(dept === d.id), borderRadius: 12, padding: '14px 16px', fontSize: 16, fontWeight: 500, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <span>{lbl(d.name, L)}</span><span style={{ fontSize: 18 }}>{dept === d.id ? '✓' : ''}</span>
                  </button>
                ))}
              </div>
              {errors.dept && <span style={errS}>{errors.dept}</span>}
            </>
          )}

          {step === 2 && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><h1 style={h1}>{t.s2Title}</h1><p style={subP}>{t.s2Sub}</p></div>
              {questions.map(q => <QuestionField key={q.id} q={q} lang={L} value={answers[q.id]} err={errors['q_' + q.id]}
                onChange={v => { setAnswers(a => ({ ...a, [q.id]: v })); setErrors(e => ({ ...e, ['q_' + q.id]: '' })); }} />)}
              {form && <div style={{ fontSize: 13, color: '#5b6380' }}>{x.formVersion(form.version)}</div>}
            </>
          )}

          {step === 3 && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><h1 style={h1}>{t.s3Title}</h1><p style={subP}>{t.s3Sub}</p></div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{t.date}</div>
                {!days ? <div className="note">{x.loadingSlots}</div> : (
                  <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 6 }}>
                    {days.map(d => {
                      const [y, m, dd] = d.date.split('-').map(Number);
                      const dt = new Date(y, m - 1, dd);
                      const disabled = d.status !== 'open';
                      return (
                        <button key={d.date} type="button" disabled={disabled} aria-pressed={date === d.date} onClick={() => { setDate(d.date); setSlot(null); setErrors({}); }}
                          style={{ flex: '0 0 78px', minHeight: 92, border: '1.5px solid', ...sel(date === d.date), borderRadius: 12, padding: '10px 6px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}>
                          <span style={{ fontSize: 12, fontWeight: 500 }}>{dt.toLocaleDateString(LOCALE[L], { weekday: 'short' })}</span>
                          <span style={{ fontSize: 22, fontWeight: 600 }}>{dt.getDate()}</span>
                          <span style={{ fontSize: 12 }}>{d.status === 'closed' ? t.closed : d.status === 'full' ? t.full : t.slots(d.open)}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              {dayInfo && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{t.time} · <span style={{ fontWeight: 400, color: '#5b6380' }}>{t.slotCount(dayInfo.slots.length)}</span></div>
                  {dayInfo.slots.length === 0 ? <div className="note">{x.noSlots}</div> : (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(80px,1fr))', gap: 8 }}>
                      {dayInfo.slots.map(s => (
                        <button key={s.start} type="button" dir="ltr" aria-pressed={slot?.start === s.start} onClick={() => { setSlot(s); setErrors({}); setBanner(null); }}
                          style={{ minHeight: 44, border: '1.5px solid', ...sel(slot?.start === s.start), borderRadius: 10, fontSize: 15, fontWeight: 500 }}>{s.time}</button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {errors.slot && <span style={errS}>{errors.slot}</span>}
            </>
          )}

          {step === 4 && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><h1 style={h1}>{t.s4Title}</h1><p style={subP}>{t.s4Sub}</p></div>
              <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', borderRadius: 12 }}>
                {[
                  { k: t.patient, v: name.trim(), s: 0 },
                  ...(phone.trim() ? [{ k: t.phone, v: normalizePhone(phone), s: 0 }] : []),
                  { k: t.department, v: deptName(dept), s: 1 },
                  ...questions.map(q => ({ k: lbl(q.label, L), v: answerText(q), s: 2 })),
                  { k: t.date, v: dateLabel(date), s: 3 },
                  { k: t.time, v: slot?.time ?? '', s: 3 },
                ].map((r, i) => (
                  <div key={i} style={{ display: 'flex', columnGap: 12, rowGap: 4, padding: '12px 14px', borderBottom: '1px solid var(--divider)', flexWrap: 'wrap', alignItems: 'baseline' }}>
                    <div style={{ flex: '1 1 100%', fontSize: 13, color: '#5b6380' }}>{r.k}</div>
                    <div style={{ flex: '1 1 0', minWidth: 0, fontSize: 15, fontWeight: 500, overflowWrap: 'anywhere' }} dir="auto">{r.v}</div>
                    <button type="button" className="btn-link" onClick={() => go(r.s)}>{t.edit}</button>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 13, color: '#5b6380', lineHeight: 1.5 }}>{t.privacy}</div>
            </>
          )}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', flexWrap: 'wrap', paddingTop: 4 }}>
            {step > 0 && <button type="button" className="btn btn-secondary" style={{ height: 48, padding: '0 20px', fontSize: 15 }} onClick={() => go(prevStep(step))}>{t.back}</button>}
            <div style={{ flex: 1 }} />
            <button type="button" className="btn btn-primary" style={{ height: 48, minWidth: 160, flex: '1 1 160px', maxWidth: 260, padding: '0 24px', fontSize: 15 }} disabled={submitting} onClick={() => void next()}>
              {step === 4 ? (submitting ? t.confirming : t.confirm) : t.next}
            </button>
          </div>
        </section>

        <aside style={{ flex: '1 1 260px', maxWidth: '100%', background: '#fff', border: '1px solid var(--border)', borderRadius: 16, padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>{t.summary}</div>
          {[{ k: t.patient, ...sv(name.trim()) }, { k: t.department, ...sv(deptName(dept)) }, { k: t.date, ...sv(dateLabel(date)) }, { k: t.time, ...sv(slot?.time ?? '') }].map(r => (
            <div key={r.k} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ fontSize: 12, color: '#5b6380' }}>{r.k}</div>
              <div style={{ fontSize: 15, fontWeight: 500, color: r.color }} dir="auto">{r.v}</div>
            </div>
          ))}
          <div className="note" style={{ borderTop: '1px solid var(--divider)', paddingTop: 10 }}>{lbl(hospital, L)}</div>
        </aside>
      </div>
    </>
  );
}

function QuestionField({ q, lang: L, value, err, onChange }: { q: Question; lang: Lang; value: Answer | undefined; err?: string; onChange: (v: Answer) => void }) {
  const t = PT[L], x = BX[L];
  const opts = q.type === 'yesno' ? [{ id: 'yes', label: t.yes }, { id: 'no', label: t.no }]
    : (q.opts ?? []).map(o => ({ id: o.id, label: lbl(o.label, L) }));
  const arr = Array.isArray(value) ? value : [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 18, borderBottom: '1px solid var(--divider)' }} role="group" aria-label={lbl(q.label, L)}>
      <div style={{ fontSize: 15, fontWeight: 500, lineHeight: 1.4 }}>{lbl(q.label, L)} <span style={{ color: q.req ? '#b42318' : '#5b6380', fontWeight: 400, fontSize: 13 }}>{q.req ? t.required : t.optionalTag}</span></div>
      {(q.type === 'single' || q.type === 'multi' || q.type === 'yesno') && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {opts.map(o => {
              const on = q.type === 'multi' ? arr.includes(o.id) : value === o.id;
              return (
                <button key={o.id} type="button" aria-pressed={on} onClick={() => onChange(q.type === 'multi' ? (on ? arr.filter(i => i !== o.id) : [...arr, o.id]) : o.id)}
                  style={{ minHeight: 44, border: '1.5px solid', ...sel(on), borderRadius: 999, padding: '0 18px', fontSize: 15, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {q.type === 'multi' ? (on ? '☑ ' : '☐ ') : ''}{o.label}
                </button>
              );
            })}
          </div>
          {q.type === 'multi' && <span style={{ fontSize: 13, color: '#5b6380' }}>{t.multiHint}</span>}
        </>
      )}
      {q.type === 'short' && (
        <>
          <input value={typeof value === 'string' ? value : ''} maxLength={120} onChange={e => onChange(e.target.value.slice(0, 120))} style={input48} />
          <span style={{ fontSize: 13, color: '#5b6380' }}>{(typeof value === 'string' ? value : '').length}/120</span>
        </>
      )}
      {q.type === 'long' && (
        <>
          <textarea value={typeof value === 'string' ? value : ''} maxLength={1000} rows={4} onChange={e => onChange(e.target.value.slice(0, 1000))}
            style={{ ...input48, height: 'auto', padding: '12px 14px', resize: 'vertical' }} />
          <span style={{ fontSize: 13, color: '#5b6380' }}>{x.longCount((typeof value === 'string' ? value : '').length)}</span>
        </>
      )}
      {q.type === 'date' && <input type="date" dir="ltr" value={typeof value === 'string' ? value : ''} onChange={e => onChange(e.target.value)} style={{ ...input48, width: 200 }} />}
      {err && <span style={errS}>{err}</span>}
    </div>
  );
}

/** Confirmation ticket and its 1080×1500 PNG (layout from the design's ticketCanvas). */
function Ticket({ lang: L, c, name, dateLabel, onRestart }: { lang: Lang; c: Confirmation; name: string; dateLabel: string; onRestart: () => void }) {
  const t = PT[L];
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  useEffect(() => {
    void QRCode.toDataURL(c.qr, { errorCorrectionLevel: 'M', margin: 1, width: 400, color: { dark: '#0f1a4a', light: '#ffffff' } }).then(setQrUrl);
  }, [c.qr]);
  const hospital = lbl(c.hospital, L), dept = lbl(c.department, L);

  const canvas = useMemo(() => () => {
    const rtl = L === 'ar', W = 1080, H = 1500, cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const x = cv.getContext('2d')!, F = "'IBM Plex Sans','IBM Plex Sans Arabic',sans-serif";
    x.direction = rtl ? 'rtl' : 'ltr'; x.textAlign = rtl ? 'right' : 'left';
    const X = rtl ? W - 90 : 90;
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);
    x.fillStyle = '#1a2d99'; x.fillRect(0, 0, W, 240);
    x.fillStyle = '#ffffff'; x.font = '600 54px ' + F; x.fillText(hospital, X, 120);
    x.fillStyle = '#d6dcff'; x.font = '400 32px ' + F; x.fillText(t.ticketSub, X, 180);
    const row = (k: string, v: string, y: number) => { x.fillStyle = '#5b6380'; x.font = '400 28px ' + F; x.fillText(k, X, y); x.fillStyle = '#1c2340'; x.font = '600 44px ' + F; x.fillText(v, X, y + 56); };
    row(t.patient, name, 320); row(t.department, dept, 460); row(t.date, dateLabel, 600); row(t.time, c.localTime, 740);
    x.strokeStyle = '#c9cfe3'; x.setLineDash([14, 10]); x.lineWidth = 3; x.beginPath(); x.moveTo(90, 850); x.lineTo(W - 90, 850); x.stroke(); x.setLineDash([]);
    const qr = QRCode.create(c.qr, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size, size = 440, cell = size / n, ox = (W - size) / 2, oy = 900;
    x.fillStyle = '#0f1a4a';
    for (let r = 0; r < n; r++) for (let q = 0; q < n; q++) if (qr.modules.get(r, q)) x.fillRect(ox + q * cell, oy + r * cell, Math.ceil(cell), Math.ceil(cell));
    x.textAlign = 'center'; x.fillStyle = '#5b6380'; x.font = '400 28px ' + F; x.fillText(t.ref, W / 2, 1400);
    x.direction = 'ltr'; x.fillStyle = '#0f1a4a'; x.font = '700 52px ' + F; x.fillText(c.ref, W / 2, 1462);
    return cv;
  }, [L, c, hospital, dept, name, dateLabel, t]);

  const saveImage = () => { const a = document.createElement('a'); a.href = canvas().toDataURL('image/png'); a.download = 'MEDLINK-' + c.ref + '.png'; a.click(); };
  const printTicket = () => {
    const url = canvas().toDataURL('image/png'), w = window.open('', '_blank');
    if (!w) return;
    const img = w.document.createElement('img');
    img.src = url; img.style.cssText = 'width:100%;max-width:520px;display:block;margin:0 auto';
    img.onload = () => setTimeout(() => w.print(), 200);
    w.document.title = c.ref;
    w.document.body.appendChild(img);
  };

  return (
    <section style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 16, padding: 'clamp(16px,5vw,28px)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, textAlign: 'center' }}>
          <div aria-hidden="true" style={{ width: 52, height: 52, borderRadius: '50%', background: '#e7f6ee', color: '#13795b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, fontWeight: 700 }}>✓</div>
          <h1 style={h1}>{t.doneTitle}</h1>
        </div>
        <div style={{ width: '100%', maxWidth: 420, border: '1px solid var(--border)', borderRadius: 16, overflow: 'hidden', boxShadow: '0 8px 28px rgba(26,45,153,.10)' }}>
          <div style={{ background: '#1a2d99', color: '#fff', padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ fontSize: 17, fontWeight: 600 }}>{hospital}</div>
            <div style={{ fontSize: 13, color: '#d6dcff' }}>{t.ticketSub}</div>
          </div>
          <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ fontSize: 12, color: '#5b6380', textTransform: 'uppercase', letterSpacing: '.06em' }}>{t.patient}</div>
              <div style={{ fontSize: 18, fontWeight: 600 }} dir="auto">{name}</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div><div style={{ fontSize: 12, color: '#5b6380' }}>{t.date}</div><div style={{ fontSize: 15, fontWeight: 600 }}>{dateLabel}</div></div>
              <div><div style={{ fontSize: 12, color: '#5b6380' }}>{t.time}</div><div dir="ltr" style={{ fontSize: 15, fontWeight: 600, textAlign: 'start' }}>{c.localTime}</div></div>
              <div style={{ gridColumn: '1 / -1' }}><div style={{ fontSize: 12, color: '#5b6380' }}>{t.department}</div><div style={{ fontSize: 15, fontWeight: 600 }}>{dept}</div></div>
            </div>
            <div style={{ borderTop: '1.5px dashed #c9cfe3', paddingTop: 18, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 200, height: 200, background: '#f4f6fb', display: 'flex' }}>{qrUrl && <img src={qrUrl} alt="QR" width={200} height={200} />}</div>
              <div style={{ fontSize: 12, color: '#5b6380' }}>{t.ref}</div>
              <div dir="ltr" data-testid="booking-ref" style={{ fontSize: 24, fontWeight: 700, letterSpacing: '.08em', color: 'var(--ink)' }}>{c.ref}</div>
            </div>
          </div>
        </div>
        <div role="note" style={{ width: '100%', maxWidth: 420, background: '#fff8e6', border: '1px solid #f0d48a', color: '#6b4a00', borderRadius: 10, padding: '12px 14px', fontSize: 14, lineHeight: 1.5 }}>{t.saveWarn}</div>
        <div style={{ width: '100%', maxWidth: 420, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary" style={{ flex: '1 1 160px', height: 48, fontSize: 15 }} onClick={saveImage}>{t.save}</button>
          <button type="button" className="btn btn-secondary" style={{ flex: '1 1 120px', height: 48, fontSize: 15 }} onClick={printTicket}>{t.print}</button>
        </div>
        <button type="button" className="btn-link" onClick={onRestart}>{t.another}</button>
        <div style={{ fontSize: 12, color: '#5b6380', textAlign: 'center', maxWidth: 420 }}>{t.qrNote}</div>
      </div>
    </section>
  );
}
