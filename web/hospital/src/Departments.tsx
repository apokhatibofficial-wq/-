import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Closure, type Department, type ScheduleBlock } from '@medlink/shared/api';
import type { Lang } from '@medlink/shared/text';
import { blockPlaces, H, nameIn } from './text';

type Props = { lang: Lang; canEdit: boolean; flash: (s: string) => void };

const emptyBlock = (weekday: number): ScheduleBlock => ({ weekday, start: '08:00', end: '12:00', slotMinutes: 15, capacity: 1 });

export function Departments({ lang, canEdit, flash }: Props) {
  const t = H[lang];
  const [deps, setDeps] = useState<Department[] | null>(null);
  const [closures, setClosures] = useState<Closure[]>([]);
  const [loadErr, setLoadErr] = useState(false);
  const [form, setForm] = useState({ ar: '', en: '', tr: '' });
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [d, c] = await Promise.all([
        api<{ departments: Department[] }>('GET', '/hospital/departments'),
        api<{ closures: Closure[] }>('GET', '/hospital/closures'),
      ]);
      setDeps(d.departments);
      setClosures(c.closures);
      setLoadErr(false);
    } catch { setLoadErr(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const errText = (e: unknown) => {
    const c = e instanceof ApiError ? e.code : '';
    return c === 'NAME_TAKEN' ? t.nameTaken : c === 'NAME_REQUIRED' ? t.nameRequired : c === 'SCHEDULE_OVERLAP' ? t.scheduleOverlap
      : c === 'SCHEDULE_INVALID' ? t.scheduleInvalid : c === 'CLOSURE_EXISTS' ? t.closureExists : t.generic;
  };

  async function add() {
    setErr('');
    try {
      await api('POST', '/hospital/departments', { nameAr: form.ar, nameEn: form.en || null, nameTr: form.tr || null });
      setForm({ ar: '', en: '', tr: '' });
      flash(t.saved);
      await load();
    } catch (e) { setErr(errText(e)); }
  }

  async function move(i: number, dir: -1 | 1) {
    if (!deps) return;
    const j = i + dir;
    if (j < 0 || j >= deps.length) return;
    // Renumber the whole list so the order is stable even if old sort values collide.
    const order = deps.map(d => d.id);
    [order[i], order[j]] = [order[j], order[i]];
    try {
      await Promise.all(order.map((id, k) => api('PATCH', '/hospital/departments/' + encodeURIComponent(id), { sort: (k + 1) * 10 })));
    } finally { await load(); }
  }

  if (loadErr) return <div className="card empty">{t.generic} <button className="btn-link" onClick={() => void load()}>↻</button></div>;
  if (!deps) return <div className="card empty">…</div>;

  return (
    <>
      {!canEdit && <div className="alert alert-warn">{t.readOnly}</div>}

      {canEdit && (
        <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2 className="section-title">{t.addDept}</h2>
          <div className="grid-2">
            {([['ar', t.deptNameAr, 'rtl'], ['en', t.deptNameEn, 'ltr'], ['tr', t.deptNameTr, 'ltr']] as const).map(([k, label, dir]) => (
              <label key={k} className="field"><span>{label}</span>
                <input className="input" dir={dir} value={form[k]} maxLength={120} onChange={e => { const v = e.target.value; setForm(f => ({ ...f, [k]: v })); }} />
              </label>
            ))}
          </div>
          {err && <div role="alert" className="alert alert-danger">{err}</div>}
          <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start' }} disabled={!form.ar.trim()} onClick={() => void add()}>+ {t.addDept}</button>
        </div>
      )}

      {deps.length === 0 && <div className="card empty">{t.noDepts}</div>}
      {deps.map((d, i) => (
        <DepartmentCard key={d.id} d={d} lang={lang} canEdit={canEdit} first={i === 0} last={i === deps.length - 1}
          onMove={dir => void move(i, dir)} onChanged={load} flash={flash} errText={errText} />
      ))}

      <Closures lang={lang} canEdit={canEdit} deps={deps} closures={closures} onChanged={load} flash={flash} errText={errText} />
    </>
  );
}

function DepartmentCard({ d, lang, canEdit, first, last, onMove, onChanged, flash, errText }: {
  d: Department; lang: Lang; canEdit: boolean; first: boolean; last: boolean; onMove: (dir: -1 | 1) => void;
  onChanged: () => Promise<void>; flash: (s: string) => void; errText: (e: unknown) => string;
}) {
  const t = H[lang];
  const [editing, setEditing] = useState(false);
  const [names, setNames] = useState({ ar: d.name.ar, en: d.name.en ?? '', tr: d.name.tr ?? '' });
  const [blocks, setBlocks] = useState<ScheduleBlock[]>(d.schedules);
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { setBlocks(d.schedules); setDirty(false); }, [d.schedules]);

  const patch = async (body: object) => {
    setErr('');
    try { await api('PATCH', '/hospital/departments/' + encodeURIComponent(d.id), body); flash(t.saved); await onChanged(); return true; }
    catch (e) { setErr(errText(e)); return false; }
  };

  const setBlock = (idx: number, change: Partial<ScheduleBlock>) => {
    setBlocks(bs => bs.map((b, k) => (k === idx ? { ...b, ...change } : b)));
    setDirty(true);
  };

  async function saveSchedule() {
    setBusy(true); setErr('');
    try {
      await api('PUT', '/hospital/departments/' + encodeURIComponent(d.id) + '/schedules', { blocks });
      flash(t.scheduleSaved);
      await onChanged();
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14, opacity: d.active ? 1 : 0.75 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--ink)' }}>{nameIn(d.name, lang)}</div>
          <div className="note">{[d.name.ar, d.name.en, d.name.tr].filter(Boolean).join(' · ')}</div>
        </div>
        <span className="chip" style={d.active ? { background: '#e7f6ee', color: '#13795b' } : { background: '#f4f6fb', color: '#5b6380' }}>{d.active ? t.active : t.inactive}</span>
        {canEdit && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="copy-btn" aria-label={t.moveUp} disabled={first} onClick={() => onMove(-1)}>↑</button>
            <button type="button" className="copy-btn" aria-label={t.moveDown} disabled={last} onClick={() => onMove(1)}>↓</button>
            <button type="button" className="copy-btn" onClick={() => setEditing(v => !v)}>{editing ? t.done : t.edit}</button>
            <button type="button" className="copy-btn" onClick={() => void patch({ active: !d.active })}>{d.active ? t.hide : t.show}</button>
          </div>
        )}
      </div>

      {editing && canEdit && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="grid-2">
            {([['ar', t.deptNameAr, 'rtl'], ['en', t.deptNameEn, 'ltr'], ['tr', t.deptNameTr, 'ltr']] as const).map(([k, label, dir]) => (
              <label key={k} className="field"><span>{label}</span>
                <input className="input" dir={dir} value={names[k]} maxLength={120} onChange={e => { const v = e.target.value; setNames(n => ({ ...n, [k]: v })); }} />
              </label>
            ))}
          </div>
          <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start', height: 40 }} disabled={!names.ar.trim()}
            onClick={async () => { if (await patch({ nameAr: names.ar, nameEn: names.en || null, nameTr: names.tr || null })) setEditing(false); }}>{t.save}</button>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{t.schedule}</span>
        {t.weekdays.map((dayName, wd) => {
          const day = blocks.map((b, idx) => ({ b, idx })).filter(x => x.b.weekday === wd);
          const places = day.reduce((n, x) => n + blockPlaces(x.b.start, x.b.end, x.b.slotMinutes, x.b.capacity), 0);
          return (
            <div key={wd} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap', borderTop: '1px solid var(--divider)', paddingTop: 8 }}>
              <span style={{ width: 92, fontSize: 13, fontWeight: 600, paddingTop: 8 }}>{dayName}</span>
              <div style={{ flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {day.length === 0 && <span className="note" style={{ paddingTop: 8 }}>{t.noSchedule}</span>}
                {day.map(({ b, idx }) => (
                  <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }} dir="ltr">
                    <input className="input" type="time" aria-label={t.from} style={{ width: 118, height: 36, fontSize: 14 }} value={b.start} disabled={!canEdit} onChange={e => setBlock(idx, { start: e.target.value })} />
                    <span>–</span>
                    <input className="input" type="time" aria-label={t.to} style={{ width: 118, height: 36, fontSize: 14 }} value={b.end === '24:00' ? '23:59' : b.end} disabled={!canEdit} onChange={e => setBlock(idx, { end: e.target.value })} />
                    <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }} title={t.slot}>⏱
                      <input className="input" type="number" min={5} max={240} aria-label={t.slot} style={{ width: 70, height: 36, fontSize: 14 }} value={b.slotMinutes} disabled={!canEdit} onChange={e => setBlock(idx, { slotMinutes: Number(e.target.value) })} />
                    </label>
                    <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }} title={t.capacity}>👤
                      <input className="input" type="number" min={1} max={100} aria-label={t.capacity} style={{ width: 64, height: 36, fontSize: 14 }} value={b.capacity} disabled={!canEdit} onChange={e => setBlock(idx, { capacity: Number(e.target.value) })} />
                    </label>
                    {canEdit && <button type="button" className="copy-btn" aria-label={t.removeBlock} onClick={() => { setBlocks(bs => bs.filter((_, k) => k !== idx)); setDirty(true); }}>×</button>}
                  </div>
                ))}
              </div>
              <span className="note" style={{ minWidth: 90, paddingTop: 8 }}>{places > 0 ? t.perDay(places) : ''}</span>
              {canEdit && <button type="button" className="copy-btn" style={{ marginTop: 4 }} onClick={() => { setBlocks(bs => [...bs, emptyBlock(wd)]); setDirty(true); }}>{t.addBlock}</button>}
            </div>
          );
        })}
      </div>
      {err && <div role="alert" className="alert alert-danger">{err}</div>}
      {canEdit && (
        <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start', height: 40 }} disabled={!dirty || busy} onClick={() => void saveSchedule()}>{t.saveSchedule}</button>
      )}
      <p className="note" style={{ margin: 0 }}>{t.slot} · {t.capacity}</p>
    </div>
  );
}

function Closures({ lang, canEdit, deps, closures, onChanged, flash, errText }: {
  lang: Lang; canEdit: boolean; deps: Department[]; closures: Closure[]; onChanged: () => Promise<void>;
  flash: (s: string) => void; errText: (e: unknown) => string;
}) {
  const t = H[lang];
  const [date, setDate] = useState('');
  const [dep, setDep] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const depName = (id: string | null) => (id ? nameIn(deps.find(d => d.id === id)?.name ?? { ar: '—', en: null, tr: null }, lang) : t.wholeHospital);

  async function add() {
    setErr('');
    try {
      await api('POST', '/hospital/closures', { date, departmentId: dep || null, reason: reason.trim() || null });
      setDate(''); setReason('');
      flash(t.saved);
      await onChanged();
    } catch (e) { setErr(errText(e)); }
  }

  return (
    <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 className="section-title">{t.closures}</h2>
      <p className="note" style={{ margin: 0 }}>{t.closuresSub}</p>
      {canEdit && (
        <div className="form-row">
          <label className="field"><span>{t.date}</span><input className="input" type="date" dir="ltr" style={{ height: 40, width: 170 }} value={date} onChange={e => setDate(e.target.value)} /></label>
          <label className="field"><span>{t.scope}</span>
            <select className="input" style={{ height: 40, minWidth: 180 }} value={dep} onChange={e => setDep(e.target.value)}>
              <option value="">{t.wholeHospital}</option>
              {deps.map(d => <option key={d.id} value={d.id}>{nameIn(d.name, lang)}</option>)}
            </select>
          </label>
          <label className="field" style={{ flex: '1 1 200px' }}><span>{t.reason}</span><input className="input" style={{ height: 40 }} maxLength={200} value={reason} onChange={e => setReason(e.target.value)} /></label>
          <button type="button" className="btn btn-primary" style={{ height: 40, alignSelf: 'flex-end' }} disabled={!date} onClick={() => void add()}>{t.addClosure}</button>
        </div>
      )}
      {err && <div role="alert" className="alert alert-danger">{err}</div>}
      {closures.length === 0 ? <div className="note">{t.noClosures}</div> : closures.map(c => (
        <div key={c.id} className="user-row">
          <span dir="ltr" className="mono" style={{ fontSize: 13, width: 110 }}>{c.date}</span>
          <span style={{ fontSize: 14, fontWeight: 500, flex: '0 1 200px' }}>{depName(c.departmentId)}</span>
          <span className="note" style={{ flex: '1 1 160px' }}>{c.reason}</span>
          {canEdit && <button type="button" className="copy-btn" onClick={async () => { try { await api('DELETE', '/hospital/closures/' + encodeURIComponent(c.id)); flash(t.saved); } finally { await onChanged(); } }}>{t.remove}</button>}
        </div>
      ))}
    </div>
  );
}
