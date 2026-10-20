import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, BOOK_ORIGIN } from '@medlink/shared/api';
import { LANGS, LANG_TAG, type Lang } from '@medlink/shared/text';
import { FT } from './formText';

import { blockers, diff, hasOpts, type I18n, type Q, type QType } from './formLogic';
type Version = { version: number; publishedAt: string; publishedBy: string | null; restoredFrom: number | null; summary: number[]; questionCount: number; live: boolean };
type ServerQ = { id: string; type: QType; req: boolean; label: { ar?: string | null; en?: string | null; tr?: string | null }; opts: { id: string; label: { ar?: string | null; en?: string | null; tr?: string | null } }[] | null };

const TYPES: QType[] = ['short', 'long', 'single', 'multi', 'yesno', 'date'];
const uid = (p: string) => p + Math.random().toString(36).slice(2, 8);
const norm = (l: ServerQ['label']): I18n => ({ ar: l?.ar ?? '', en: l?.en ?? '', tr: l?.tr ?? '' });
const fromServer = (qs: ServerQ[]): Q[] => qs.map(q => ({ id: q.id, type: q.type, req: q.req, label: norm(q.label), opts: (q.opts ?? []).map(o => ({ id: o.id, label: norm(o.label) })) }));
const lbl = (o: I18n, L: Lang) => o[L] || o.ar || o.en || o.tr || '';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

type Props = { lang: Lang; slug: string | null; flash: (s: string) => void };

export function FormBuilder({ lang: L, slug, flash }: Props) {
  const t = FT[L];
  const [live, setLive] = useState<{ version: number; publishedAt: string; publishedBy: string | null; qs: Q[] } | null | undefined>(undefined);
  const [draft, setDraft] = useState<Q[]>([]);
  const [tab, setTab] = useState<'editor' | 'versions'>('editor');
  const [openId, setOpenId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [modal, setModal] = useState<null | { kind: 'publish' } | { kind: 'restore'; v: number }>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<null | { title: string; qs: Q[] }>(null);
  const [saveErr, setSaveErr] = useState('');
  const loaded = useRef(false);

  const load = useCallback(async () => {
    const [f, v] = await Promise.all([
      api<{ live: { version: number; publishedAt: string; publishedBy: string | null; questions: ServerQ[] } | null; draft: { questions: ServerQ[] } | null }>('GET', '/hospital/form'),
      api<{ versions: Version[] }>('GET', '/hospital/form/versions'),
    ]);
    const l = f.live ? { version: f.live.version, publishedAt: f.live.publishedAt, publishedBy: f.live.publishedBy, qs: fromServer(f.live.questions) } : null;
    setLive(l);
    setDraft(f.draft ? fromServer(f.draft.questions) : l?.qs ?? []);
    setVersions(v.versions);
    loaded.current = true;
  }, []);
  useEffect(() => { void load(); }, [load]);

  const liveQs = useMemo(() => live?.qs ?? [], [live]);
  const d = diff(draft, liveQs);
  const nChanges = d[0] + d[1] + d[2] + d[3];
  const dirty = nChanges > 0;

  // Autosave the draft (never touches the live form). Equal to live → no draft row.
  useEffect(() => {
    if (!loaded.current || live === undefined) return;
    const h = setTimeout(() => {
      const req = dirty
        ? api('PUT', '/hospital/form/draft', { questions: draft, baseVersion: live?.version ?? 0 })
        : api('DELETE', '/hospital/form/draft');
      req.then(() => setSaveErr('')).catch((e: unknown) => setSaveErr(e instanceof ApiError ? e.code : 'NETWORK'));
    }, 600);
    return () => clearTimeout(h);
  }, [draft, dirty, live]);

  const upd = (id: string, fn: (q: Q) => Q) => setDraft(ds => ds.map(q => (q.id === id ? fn(structuredClone(q)) : q)));
  const move = (i: number, j: number) => setDraft(ds => { if (j < 0 || j >= ds.length) return ds; const c = [...ds]; const [x] = c.splice(i, 1); c.splice(j, 0, x); return c; });
  const addQ = (type: QType) => {
    const q: Q = { id: uid('q'), type, req: false, label: { ar: '', en: '', tr: '' }, opts: hasOpts(type) ? [0, 1].map(() => ({ id: uid('o'), label: { ar: '', en: '', tr: '' } })) : [] };
    setDraft(ds => [...ds, q]); setOpenId(q.id); setTab('editor');
  };

  async function confirmPublish() {
    setBusy(true); setFailed(false);
    try {
      // Make sure the server has exactly this draft, then publish it.
      await api('PUT', '/hospital/form/draft', { questions: draft, baseVersion: live?.version ?? 0 });
      const r = await api<{ version: number }>('POST', '/hospital/form/publish', {});
      setModal(null); flash(t.toast(r.version)); await load();
    } catch { setModal(null); setFailed(true); } finally { setBusy(false); }
  }

  async function confirmRestore(v: number) {
    setBusy(true); setFailed(false);
    try {
      const r = await api<{ version: number }>('POST', '/hospital/form/versions/' + v + '/restore', {});
      setModal(null); flash(t.toast(r.version)); await load(); setTab('editor');
    } catch { setModal(null); setFailed(true); } finally { setBusy(false); }
  }

  async function openVersionPreview(v: number) {
    const r = await api<{ questions: ServerQ[] }>('GET', '/hospital/form/versions/' + v);
    setPreview({ title: t.previewV(v), qs: fromServer(r.questions) });
  }

  if (live === undefined) return <div className="card empty">…</div>;
  const nextV = (versions[0]?.version ?? 0) + 1;
  const fmt = (s: string) => new Date(s).toLocaleString(L === 'ar' ? 'ar-u-nu-latn' : L, { dateStyle: 'medium', timeStyle: 'short' });
  const blocked = blockers(draft, L);

  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-secondary" onClick={() => setPreview({ title: t.previewDraft, qs: draft })}>{t.preview}</button>
        <button type="button" className="btn btn-primary" disabled={!dirty} onClick={() => setModal({ kind: 'publish' })}>{t.publish}</button>
      </div>

      <div className="card" style={{ padding: '12px 16px', display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center', fontSize: 14 }}>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="dot" style={{ background: live ? '#13795b' : '#c9cfe3' }} />
          <strong>{live ? t.liveV(live.version) : '—'}</strong>
          {live && <span className="note">{fmt(live.publishedAt)}{live.publishedBy ? ' · ' + t.by + ' ' : ''}<bdi dir="ltr">{live.publishedBy ?? ''}</bdi></span>}
        </span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="dot" style={{ background: dirty ? '#e8a317' : '#c9cfe3' }} />
          <span>{dirty ? t.draftN(nChanges) : t.noChanges}</span>
          {dirty && <button type="button" className="btn-link" onClick={() => setDraft(liveQs)}>{t.discard}</button>}
        </span>
        <span style={{ flex: 1 }} />
        {slug && <bdi dir="ltr" className="note">{BOOK_ORIGIN.replace(/^https?:\/\//, '')}/book/{slug}</bdi>}
      </div>
      {saveErr && <div role="alert" className="alert alert-danger">{saveErr}</div>}

      {failed && (
        <div role="alert" className="alert alert-danger" style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}><strong>{t.failTitle}</strong> {t.failBody(live?.version ?? 0)}</div>
          <button type="button" className="icon-btn" style={{ background: 'transparent' }} aria-label={t.close} onClick={() => setFailed(false)}>×</button>
        </div>
      )}

      <div role="tablist" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--thead-border)' }}>
        {(['editor', 'versions'] as const).map((k, i) => (
          <button key={k} role="tab" aria-selected={tab === k} type="button" onClick={() => setTab(k)}
            style={{ border: 'none', background: 'none', padding: '10px 14px', fontSize: 14, fontWeight: tab === k ? 600 : 400, color: tab === k ? 'var(--brand)' : 'var(--muted)', borderBottom: '2px solid ' + (tab === k ? 'var(--brand)' : 'transparent'), marginBottom: -1 }}>
            {t.tabs[i]}{k === 'versions' ? ' (' + versions.length + ')' : ''}
          </button>
        ))}
      </div>

      {tab === 'editor' && (
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 520px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {draft.length === 0 && <div className="card empty">{t.empty}</div>}
            {draft.map((q, i) => {
              const base = liveQs.find(b => b.id === q.id);
              const tag = !base ? t.tagNew : !same(base, q) ? t.tagEdited : '';
              const missing = LANGS.some(l => !q.label[l].trim()) || (hasOpts(q.type) && q.opts.some(o => LANGS.some(l => !o.label[l].trim())));
              const open = openId === q.id;
              return (
                <div key={q.id} className="card" draggable onDragStart={() => setDragId(q.id)} onDragEnd={() => setDragId(null)}
                  onDragOver={e => e.preventDefault()} onDrop={() => { if (dragId && dragId !== q.id) move(draft.findIndex(x => x.id === dragId), i); setDragId(null); }}
                  style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14, borderColor: open ? 'var(--brand)' : undefined, opacity: dragId === q.id ? 0.5 : 1 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <span title={t.drag} aria-hidden="true" style={{ cursor: 'grab', color: '#9aa6d8', fontSize: 16, paddingTop: 2 }}>⋮⋮</span>
                    <span style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--soft)', color: 'var(--brand-deep)', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{i + 1}</span>
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ fontSize: 15, fontWeight: 500, color: lbl(q.label, L) ? '#1c2340' : '#8a91a8' }}>{lbl(q.label, L) || t.untitled}</div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <span className="chip" style={{ background: 'var(--page)', color: 'var(--muted)' }}>{t.types[q.type]}</span>
                        <span className="chip" style={q.req ? { background: '#fdecea', color: '#b42318' } : { background: 'var(--page)', color: 'var(--muted)' }}>{q.req ? t.required : t.optional}</span>
                        {tag && <span className="chip" style={{ background: 'var(--soft)', color: 'var(--brand-deep)' }}>{tag}</span>}
                        {missing && <span className="chip" style={{ background: '#fff4e5', color: '#7a4300' }}>{t.missing}</span>}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                      <button type="button" className="copy-btn" disabled={i === 0} title={t.moveUp} aria-label={t.moveUp} onClick={() => move(i, i - 1)}>↑</button>
                      <button type="button" className="copy-btn" disabled={i === draft.length - 1} title={t.moveDown} aria-label={t.moveDown} onClick={() => move(i, i + 1)}>↓</button>
                      <button type="button" className="copy-btn" onClick={() => setOpenId(open ? null : q.id)}>{open ? t.done : t.edit}</button>
                      <button type="button" className="copy-btn" title={t.delete} aria-label={t.delete} style={{ color: '#b42318' }} onClick={() => setDraft(ds => ds.filter(x => x.id !== q.id))}>×</button>
                    </div>
                  </div>
                  {open && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, borderTop: '1px solid var(--divider)', paddingTop: 14 }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{t.answerType}</span>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {TYPES.map(ty => (
                            <button key={ty} type="button" className="sfilter" aria-pressed={q.type === ty} onClick={() => upd(q.id, x => {
                              x.type = ty;
                              if (hasOpts(ty) && x.opts.length < 2) x.opts = [...x.opts, ...[0, 1].slice(x.opts.length).map(() => ({ id: uid('o'), label: { ar: '', en: '', tr: '' } }))];
                              if (!hasOpts(ty)) x.opts = [];
                              return x;
                            })}>{t.types[ty]}</button>
                          ))}
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{t.questionText}</span>
                        {LANGS.map(l => (
                          <label key={l} className="field"><span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 400 }}>{LANG_TAG[l]}</span>
                            <input className="input" dir={l === 'ar' ? 'rtl' : 'ltr'} maxLength={140} value={q.label[l]} onChange={e => { const v = e.target.value; upd(q.id, x => { x.label[l] = v; return x; }); }} />
                          </label>
                        ))}
                      </div>
                      {hasOpts(q.type) && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <span style={{ fontSize: 13, fontWeight: 600 }}>{t.options}</span>
                          {q.opts.map((o, oi) => (
                            <div key={o.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <span className="note" style={{ width: 18 }}>{oi + 1}</span>
                              <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,140px),1fr))', gap: 6 }}>
                                {LANGS.map(l => (
                                  <input key={l} className="input" style={{ height: 38, fontSize: 14 }} dir={l === 'ar' ? 'rtl' : 'ltr'} maxLength={80} placeholder={LANG_TAG[l]} aria-label={LANG_TAG[l]}
                                    value={o.label[l]} onChange={e => { const v = e.target.value; upd(q.id, x => { x.opts[oi].label[l] = v; return x; }); }} />
                                ))}
                              </div>
                              <button type="button" className="copy-btn" aria-label={t.delete} onClick={() => upd(q.id, x => { x.opts.splice(oi, 1); return x; })}>×</button>
                            </div>
                          ))}
                          <button type="button" className="btn-link" style={{ alignSelf: 'flex-start' }} onClick={() => upd(q.id, x => { x.opts.push({ id: uid('o'), label: { ar: '', en: '', tr: '' } }); return x; })}>+ {t.addOption}</button>
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <button type="button" role="switch" aria-checked={q.req} aria-labelledby={'req-' + q.id} className="switch" onClick={() => upd(q.id, x => { x.req = !x.req; return x; })} />
                        <span id={'req-' + q.id} style={{ fontSize: 14 }}>{t.requiredQ}</span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <aside style={{ flex: '1 1 240px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{t.addQuestion}</span>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {TYPES.map(ty => <button key={ty} type="button" className="action-btn" style={{ height: 40, fontSize: 13 }} onClick={() => addQ(ty)}>+ {t.types[ty]}</button>)}
              </div>
            </div>
            <div className="alert alert-warn" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <strong>{t.privacyTitle}</strong><span>{t.privacyBody}</span>
            </div>
          </aside>
        </div>
      )}

      {tab === 'versions' && (
        <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <p className="note" style={{ margin: '0 0 8px' }}>{t.versionsSub}</p>
          {versions.map((v, i) => (
            <div key={v.version} className="user-row">
              <span className="chip" style={v.live ? { background: '#e7f6ee', color: '#13795b', fontSize: 13 } : { background: 'var(--page)', color: 'var(--muted)', fontSize: 13 }}>v{v.version}</span>
              <div style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 14, fontWeight: 500 }}>
                  {v.restoredFrom ? t.restoredFrom(v.restoredFrom) : i === versions.length - 1 ? t.initial : t.sum(v.summary[0], v.summary[1], v.summary[2], v.summary[3])}
                  {v.live && <span className="chip" style={{ background: '#e7f6ee', color: '#13795b', marginInlineStart: 8 }}>{t.live}</span>}
                </span>
                <span className="note">{fmt(v.publishedAt)} · <bdi dir="ltr">{v.publishedBy ?? ''}</bdi> · {v.questionCount}{versions[i + 1] ? ' · ← v' + versions[i + 1].version : ''}</span>
              </div>
              <button type="button" className="copy-btn" style={{ height: 32 }} onClick={() => void openVersionPreview(v.version)}>{t.preview}</button>
              {!v.live && <button type="button" className="copy-btn" style={{ height: 32 }} onClick={() => setModal({ kind: 'restore', v: v.version })}>{t.restore}</button>}
            </div>
          ))}
          {versions.length === 0 && <div className="empty">—</div>}
        </div>
      )}

      {modal && (
        <div className="modal-scrim">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="fb-modal">
            {modal.kind === 'publish' ? (
              <>
                <h2 id="fb-modal">{t.publishTitle}</h2>
                <p className="body">{t.publishBody}</p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, textAlign: 'center' }}>
                  {[[t.added, d[0], '#13795b'], [t.modified, d[1], '#1a2d99'], [t.removed, d[2], '#b42318'], [t.newVersion, 'v' + nextV, '#0f1a4a']].map(([k, v, c]) => (
                    <div key={String(k)} style={{ background: 'var(--thead)', borderRadius: 10, padding: '10px 6px' }}>
                      <div style={{ fontSize: 22, fontWeight: 700, color: String(c) }}>{v}</div>
                      <div className="note">{k}</div>
                    </div>
                  ))}
                </div>
                {blocked.length > 0 && <div role="alert" className="alert alert-danger">{blocked.map(b => <div key={b}>{b}</div>)}</div>}
                <div className="modal-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setModal(null)}>{t.backToEdit}</button>
                  <button type="button" className="btn btn-primary" disabled={busy || blocked.length > 0} onClick={() => void confirmPublish()}>{busy ? t.publishing : t.confirmPublish}</button>
                </div>
              </>
            ) : (
              <>
                <h2 id="fb-modal">{t.restoreTitle(modal.v)}</h2>
                <p className="body">{t.restoreBody(modal.v, nextV)}</p>
                {dirty && <div className="alert alert-warn">{t.draftReplace}</div>}
                <div className="modal-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setModal(null)}>{t.backToEdit}</button>
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void confirmRestore(modal.v)}>{busy ? t.publishing : t.confirmRestore}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {preview && <Preview lang={L} title={preview.title} qs={preview.qs} onClose={() => setPreview(null)} />}
    </>
  );
}

/** Full-screen preview of the booking "Questions" step. It never creates a booking or sends data. */
function Preview({ lang: L, title, qs, onClose }: { lang: Lang; title: string; qs: Q[]; onClose: () => void }) {
  const t = FT[L];
  const [device, setDevice] = useState<'phone' | 'desktop'>('phone');
  const [ans, setAns] = useState<Record<string, string | string[]>>({});
  const [err, setErr] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  const check = () => {
    const e: Record<string, string> = {};
    for (const q of qs) {
      const v = ans[q.id];
      if (q.req && (v == null || (Array.isArray(v) ? !v.length : !v.trim()))) e[q.id] = t.errReq;
    }
    setErr(e); setDone(Object.keys(e).length === 0);
  };
  return (
    <div className="modal-scrim" style={{ alignItems: 'stretch', background: 'rgba(15,26,74,.6)' }}>
      <div role="dialog" aria-modal="true" aria-label={title} style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: 1000, margin: '0 auto' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', color: '#fff' }}>
          <strong style={{ fontSize: 16, flex: 1 }}>{title}</strong>
          <div className="langs" style={{ background: '#fff' }}>
            {(['phone', 'desktop'] as const).map(k => <button key={k} type="button" aria-pressed={device === k} onClick={() => setDevice(k)}>{t[k]}</button>)}
          </div>
          <button type="button" className="btn btn-secondary" style={{ height: 36 }} onClick={onClose}>{t.close}</button>
        </div>
        <div className="alert alert-warn">{t.previewBanner}</div>
        <div style={{ flex: 1, overflow: 'auto', display: 'flex', justifyContent: 'center' }}>
          <div style={{ width: device === 'phone' ? 390 : 960, maxWidth: '100%', background: '#f4f6fb', border: device === 'phone' ? '8px solid #0f1a4a' : '1px solid #dde2f0', borderRadius: device === 'phone' ? 28 : 12, overflow: 'auto', alignSelf: 'flex-start' }}>
            <div style={{ background: '#fff', borderBottom: '1px solid #dde2f0', padding: '12px 16px', fontSize: 15, fontWeight: 600 }}>{t.bookTitle}</div>
            <div style={{ padding: 16 }}>
              <div style={{ background: '#fff', border: '1px solid #dde2f0', borderRadius: 16, padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div><h3 style={{ margin: 0, fontSize: 20, color: 'var(--ink)' }}>{t.pTitle}</h3><p className="note" style={{ margin: '4px 0 0', fontSize: 14 }}>{t.pSub}</p></div>
                {qs.map(q => {
                  const v = ans[q.id];
                  const opts = q.type === 'yesno' ? [{ id: 'yes', label: t.yes }, { id: 'no', label: t.no }] : q.opts.map(o => ({ id: o.id, label: lbl(o.label, L) || '…' }));
                  const arr = Array.isArray(v) ? v : [];
                  const set = (x: string | string[]) => { setAns(a => ({ ...a, [q.id]: x })); setErr(e => ({ ...e, [q.id]: '' })); setDone(false); };
                  return (
                    <div key={q.id} style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 14, borderBottom: '1px solid #eef0f6' }}>
                      <div style={{ fontSize: 15, fontWeight: 500 }}>{lbl(q.label, L) || t.untitled} <span style={{ fontSize: 13, color: q.req ? '#b42318' : '#5b6380', fontWeight: 400 }}>{q.req ? t.required : t.optional}</span></div>
                      {(hasOpts(q.type) || q.type === 'yesno') && (
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {opts.map(o => {
                            const on = q.type === 'multi' ? arr.includes(o.id) : v === o.id;
                            return <button key={o.id} type="button" className="sfilter" style={{ height: 44 }} aria-pressed={on}
                              onClick={() => set(q.type === 'multi' ? (on ? arr.filter(i => i !== o.id) : [...arr, o.id]) : o.id)}>{q.type === 'multi' ? (on ? '☑ ' : '☐ ') : ''}{o.label}</button>;
                          })}
                        </div>
                      )}
                      {q.type === 'short' && <input className="input" maxLength={120} value={typeof v === 'string' ? v : ''} onChange={e => set(e.target.value)} />}
                      {q.type === 'long' && <textarea className="input" rows={3} maxLength={1000} value={typeof v === 'string' ? v : ''} onChange={e => set(e.target.value)} />}
                      {q.type === 'date' && <input className="input" type="date" dir="ltr" style={{ width: 200 }} value={typeof v === 'string' ? v : ''} onChange={e => set(e.target.value)} />}
                      {err[q.id] && <span style={{ fontSize: 13, color: '#b42318' }}>{err[q.id]}</span>}
                    </div>
                  );
                })}
                {done && <div className="alert alert-ok">{t.pDone}</div>}
                <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-end' }} onClick={check}>{t.continue}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
