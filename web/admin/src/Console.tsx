import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type AuditEntry, type Hospital, type HospitalDetail, type Me, type Names, type Reports, type Status } from './api';
import { A, COMPANY_PERMS, HOSPITAL_PERMS, LANGS, LANG_TAG, ROLE_LABELS, T, type Lang, type Mark } from './i18n';
import { cleanSlugInput, SLUG_RE, slugify } from './slug';
import { LangPill } from './LangPill';

const BOOK_BASE = 'medlink.website/book/';
type SlugState = '' | 'ok' | 'bad' | 'taken' | 'checking';
type Tab = 0 | 1 | 2 | 3;

const nameIn = (n: Names, l: Lang) => (l === 'tr' ? n.tr || n.en : n[l]);

function useWidth() {
  const [w, setW] = useState(window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

/** Asks the server whether a slug is free; the client regex only avoids pointless requests. */
function useSlugCheck(slug: string, hospitalId: string | null, unchanged: boolean): SlugState {
  const [state, setState] = useState<SlugState>('');
  useEffect(() => {
    if (!slug) { setState(''); return; }
    if (unchanged) { setState('ok'); return; }
    if (!SLUG_RE.test(slug)) { setState('bad'); return; }
    setState('checking');
    const h = setTimeout(() => {
      const q = '/admin/slugs/check?slug=' + encodeURIComponent(slug) + (hospitalId ? '&hospitalId=' + encodeURIComponent(hospitalId) : '');
      api<{ state: string }>('GET', q)
        .then(r => setState(r.state === 'ok' || r.state === 'current' ? 'ok' : r.state === 'bad' ? 'bad' : 'taken'))
        .catch(() => setState(''));
    }, 300);
    return () => clearTimeout(h);
  }, [slug, hospitalId, unchanged]);
  return state;
}

type Props = { lang: Lang; onLang: (l: Lang) => void; me: Me; onSignedOut: () => void };

export function Console({ lang: L, onLang, me, onSignedOut }: Props) {
  const t = T[L];
  const a = A[L];
  const w = useWidth();
  const wide = w >= 900;
  const can = (p: string) => me.permissions.includes(p);
  const canAudit = can('ViewAuditFull') || can('ViewAuditHospitalOnly');

  const [tab, setTab] = useState<Tab>(0);
  const [hs, setHs] = useState<Hospital[] | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [q, setQ] = useState('');
  const [sf, setSf] = useState<'all' | Status>('all');
  const [copied, setCopied] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number>();

  const flash = useCallback((m: string) => {
    setToast(m);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const load = useCallback(async () => {
    setLoadErr(false);
    try {
      const r = await api<{ hospitals: Hospital[] }>('GET', '/admin/hospitals');
      setHs(r.hospitals);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onSignedOut();
      else setLoadErr(true);
    }
  }, [onSignedOut]);
  useEffect(() => { void load(); }, [load]);

  async function signOut() {
    await api('POST', '/auth/logout', {}).catch(() => undefined);
    onSignedOut();
  }

  // ------------------------------------------------------------ status helpers
  const st = (x: Status): [string, string, string] =>
    ({ active: [t.active, '#e7f6ee', '#13795b'], suspended: [t.suspended, '#fdecea', '#8a1c12'], pending: [t.pending, '#fff4e5', '#7a4300'] } as const)[x] as [string, string, string];
  const syncInfo = (h: Hospital): [string, string] => {
    if (!h.lastSyncAt) return [t.syncNever, '#c9cfe3'];
    const mins = Math.round((Date.now() - new Date(h.lastSyncAt).getTime()) / 60000);
    if (mins < 60) return [t.syncOk(mins), '#13795b'];
    const hrs = Math.round(mins / 60);
    return [t.syncLate(hrs), hrs > 24 ? '#b42318' : '#e8a317'];
  };
  const fmtDate = (s: string) => new Date(s).toLocaleDateString(L === 'ar' ? 'ar-u-nu-latn' : L, { year: 'numeric', month: 'short', day: 'numeric' });

  // ------------------------------------------------------------ drawer
  const [selId, setSelId] = useState<string | null>(null);
  const [detail, setDetail] = useState<HospitalDetail | null>(null);
  const [edit, setEdit] = useState<{ name: { ar: string; en: string; tr: string }; slug: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [drawerErr, setDrawerErr] = useState('');
  const sh = hs?.find(h => h.id === selId) ?? null;

  const openDrawer = async (h: Hospital) => {
    setSelId(h.id);
    setDrawerErr('');
    setEdit({ name: { ar: h.name.ar, en: h.name.en, tr: h.name.tr ?? '' }, slug: h.slug });
    setDetail(null);
    try { setDetail(await api<HospitalDetail>('GET', '/admin/hospitals/' + encodeURIComponent(h.id))); } catch { /* facts stay empty */ }
  };
  const closeDrawer = () => { setSelId(null); setEdit(null); setDetail(null); };

  const editSlugState = useSlugCheck(edit?.slug ?? '', selId, !!sh && edit?.slug === sh.slug);
  const changed = !!sh && !!edit && (edit.name.ar !== sh.name.ar || edit.name.en !== sh.name.en || edit.name.tr !== (sh.name.tr ?? '') || edit.slug !== sh.slug);
  const cantSave = !can('HospitalsCreateEdit') || !changed || editSlugState !== 'ok' || !edit?.name.ar.trim() || !edit?.name.en.trim() || saving;

  async function saveDrawer() {
    if (cantSave || !sh || !edit) return;
    setSaving(true);
    setDrawerErr('');
    try {
      await api('PATCH', '/admin/hospitals/' + encodeURIComponent(sh.id), { nameAr: edit.name.ar, nameEn: edit.name.en, nameTr: edit.name.tr, slug: edit.slug });
      await load();
      setDetail(await api<HospitalDetail>('GET', '/admin/hospitals/' + encodeURIComponent(sh.id)));
      flash(t.saved);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SLUG_CHANGE_TOO_SOON' && typeof e.detail === 'string') setDrawerErr(a.tooSoon(fmtDate(e.detail)));
      else if (e instanceof ApiError && (e.code === 'SLUG_TAKEN' || e.code === 'SLUG_INVALID')) setDrawerErr(e.code === 'SLUG_TAKEN' ? t.slugTaken : t.slugBad);
      else setDrawerErr(a.errGeneric);
    } finally {
      setSaving(false);
    }
  }

  // ------------------------------------------------------------ modals
  const [modal, setModal] = useState<'create' | 'suspend' | 'recover' | null>(null);
  const [busy, setBusy] = useState(false);
  const [modalErr, setModalErr] = useState('');
  const [form, setForm] = useState({ ar: '', en: '', tr: '', email: '', slug: '', slugTouched: false });
  const [created, setCreated] = useState<{ id: string; slug: string; name: string; emailSent: boolean } | null>(null);
  const [reason, setReason] = useState('');
  const [checks, setChecks] = useState([false, false, false]);
  const [recoverDone, setRecoverDone] = useState<null | boolean>(null);
  const createSlugState = useSlugCheck(modal === 'create' ? form.slug : '', null, false);

  const openModal = (m: 'create' | 'suspend' | 'recover') => {
    setModal(m); setBusy(false); setModalErr('');
    if (m === 'create') { setCreated(null); setForm({ ar: '', en: '', tr: '', email: '', slug: '', slugTouched: false }); }
    if (m === 'suspend') setReason('');
    if (m === 'recover') { setChecks([false, false, false]); setRecoverDone(null); }
  };
  const closeModal = () => { setModal(null); setBusy(false); };

  const setF = (k: 'ar' | 'en' | 'tr' | 'email', v: string) =>
    setForm(f => { const nf = { ...f, [k]: v }; if (k === 'en' && !f.slugTouched) nf.slug = slugify(v); return nf; });

  async function confirmModal() {
    setBusy(true);
    setModalErr('');
    try {
      if (modal === 'create') {
        const r = await api<{ id: string; slug: string; emailSent: boolean }>('POST', '/admin/hospitals', {
          nameAr: form.ar.trim(), nameEn: form.en.trim(), nameTr: form.tr.trim() || null, adminEmail: form.email.trim(), slug: form.slug,
        });
        setCreated({ id: r.id, slug: r.slug, name: L === 'ar' ? form.ar.trim() : form.en.trim(), emailSent: r.emailSent });
        await load();
      } else if (modal === 'suspend' && sh) {
        const re = sh.status === 'suspended';
        await api('POST', `/admin/hospitals/${encodeURIComponent(sh.id)}/${re ? 'reactivate' : 'suspend'}`, { reason: reason.trim() });
        await load();
        closeModal();
      } else if (modal === 'recover' && sh) {
        const r = await api<{ emailSent: boolean }>('POST', `/admin/hospitals/${encodeURIComponent(sh.id)}/recover-admin`, { checks });
        setRecoverDone(r.emailSent);
      }
    } catch (e) {
      const c = e instanceof ApiError ? e.code : '';
      setModalErr(c === 'SLUG_TAKEN' ? t.slugTaken : c === 'SLUG_INVALID' ? t.slugBad : c === 'EMAIL_TAKEN' ? a.emailTaken
        : c === 'NO_ADMIN' ? a.noAdmin : c === 'NETWORK' ? a.errNetwork : a.errGeneric);
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------ data for tabs
  const ql = q.trim().toLowerCase();
  const base = useMemo(() => (hs ?? []).filter(h => !ql || LANGS.some(l => (h.name[l] ?? '').toLowerCase().includes(ql))
    || h.id.toLowerCase().includes(ql) || (h.slug ?? '').includes(ql)), [hs, ql]);
  const rows = base.filter(h => sf === 'all' || h.status === sf);

  const navLabels = t.nav;
  const tabs: Tab[] = ([0, 1, 2, 3] as Tab[]).filter(i => i !== 2 || canAudit);
  const roleLabel = me.roles.map(r => a.roleNames[r] ?? r).join(' · ');

  const nav = (cls: string) => (
    <nav className={cls}>
      {tabs.map(i => <button key={i} type="button" aria-current={tab === i ? 'page' : undefined} onClick={() => setTab(i)}>{navLabels[i]}</button>)}
    </nav>
  );

  return (
    <div className="console">
      {wide && (
        <aside className="side">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 8px' }}>
            <img className="logo" src="/assets/medlink-logo-white.svg" alt="MEDLINK" style={{ width: 150, height: 'auto' }} />
            <span style={{ fontSize: 11, color: '#b9c2f0' }}>{t.consoleName}</span>
          </div>
          {nav('')}
          <div style={{ flex: 1 }} />
          <img className="logo" src="/assets/khatib-logo-white.svg" alt="KHATIB TECHNICAL SOLUTIONS" style={{ width: 150, height: 'auto', padding: '0 8px', opacity: 0.9 }} />
          <div className="user-card">
            <bdi dir="ltr" className="ellipsis" style={{ fontSize: 13, fontWeight: 600 }} title={me.email}>{me.email}</bdi>
            <span style={{ fontSize: 12, color: '#d6dcff' }}>{roleLabel} · 2FA</span>
            <button type="button" className="btn-link" onClick={signOut}>{a.signOut}</button>
          </div>
        </aside>
      )}

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {!wide && (
          <div className="topbar">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <img src="/assets/medlink-logo-white.svg" alt="MEDLINK" style={{ height: 34, width: 'auto' }} />
              <button type="button" className="btn-link" style={{ color: '#d6dcff', fontSize: 13 }} onClick={signOut}>{a.signOut}</button>
            </div>
            {nav('')}
          </div>
        )}

        <main className="main">
          <div className="title-row">
            <div style={{ flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <h1>{navLabels[tab]}</h1>
              <div style={{ fontSize: 14, color: 'var(--muted)' }}>{t.subs[tab]}</div>
            </div>
            <LangPill lang={L} onLang={onLang} />
            {tab === 0 && can('HospitalsCreateEdit') && (
              <button type="button" className="btn btn-primary" onClick={() => openModal('create')}>+ {t.newHospital}</button>
            )}
          </div>

          {tab === 0 && (
            <>
              <div className="filters">
                <input className="input" value={q} onChange={e => setQ(e.target.value)} placeholder={t.search} aria-label={t.search} />
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {(['all', 'active', 'suspended', 'pending'] as const).map(f => (
                    <button key={f} type="button" className="sfilter" aria-pressed={sf === f} onClick={() => setSf(f)}>
                      {f === 'all' ? t.all : st(f)[0]}
                      <span style={{ fontWeight: 500, opacity: 0.8 }}>{f === 'all' ? base.length : base.filter(h => h.status === f).length}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="card table">
                <div className="trow thead cols-hosp" role="row">
                  <span>{t.cHospital}</span><span>{t.cLink}</span><span>{t.cStatus}</span><span>{t.cSync}</span><span>{t.cUsers}</span>
                </div>
                {hs === null && !loadErr && <div className="empty">{a.loading}</div>}
                {loadErr && <div className="empty">{a.loadFail} <button className="btn-link" onClick={load}>{a.retry}</button></div>}
                {rows.map(h => {
                  const sc = st(h.status), si = syncInfo(h);
                  return (
                    <div key={h.id} role="button" tabIndex={0} className="trow cols-hosp clickable" aria-selected={selId === h.id}
                      onClick={() => openDrawer(h)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void openDrawer(h); } }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                        <span className="ellipsis" style={{ fontSize: 14, fontWeight: 600 }}>{nameIn(h.name, L)}</span>
                        <span dir="ltr" className="mono" style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'start' }}>{h.id}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <span dir="ltr" className="ellipsis" title={BOOK_BASE + h.slug} style={{ fontSize: 13, color: 'var(--brand-deep)' }}>/{h.slug}</span>
                        <button type="button" className="copy-btn" title={t.copy} onClick={e => {
                          e.stopPropagation();
                          navigator.clipboard?.writeText('https://' + BOOK_BASE + h.slug).catch(() => undefined);
                          setCopied(h.id);
                          setTimeout(() => setCopied(c => (c === h.id ? null : c)), 1500);
                        }}>{copied === h.id ? t.copied : t.copy}</button>
                      </div>
                      <span><span className="chip" style={{ background: sc[1], color: sc[2] }}>{sc[0]}</span></span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}><span className="dot" style={{ background: si[1] }} />{si[0]}</span>
                      <span style={{ fontSize: 13, color: 'var(--muted)' }}>{t.usersN(h.users)}</span>
                    </div>
                  );
                })}
                {hs !== null && rows.length === 0 && <div className="empty">{t.empty}</div>}
              </div>
            </>
          )}

          {tab === 1 && <ReportsTab L={L} />}
          {tab === 2 && canAudit && <AuditTab L={L} hospitals={hs ?? []} />}
          {tab === 3 && <RolesTab L={L} />}
        </main>
      </div>

      {sh && edit && (
        <div className="scrim" onClick={closeDrawer}>
          <div className="drawer" role="dialog" aria-modal="true" aria-label={nameIn(sh.name, L)} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontSize: 19, fontWeight: 600, color: 'var(--ink)' }}>{nameIn(sh.name, L)}</div>
                <span className="chip" style={{ alignSelf: 'flex-start', background: st(sh.status)[1], color: st(sh.status)[2] }}>{st(sh.status)[0]}</span>
              </div>
              <button type="button" className="icon-btn" aria-label={a.close} onClick={closeDrawer}>×</button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t.internalId}</span>
              <div className="idbox">
                <span dir="ltr" className="mono" style={{ flex: 1, fontSize: 13 }}>{sh.id}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>🔒 {t.locked}</span>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{t.displayName}</span>
              {LANGS.map(l => (
                <label key={l} className="field">
                  <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 400 }}>{LANG_TAG[l]}</span>
                  <input className="input" style={{ height: 40, fontSize: 14 }} dir={l === 'ar' ? 'rtl' : 'ltr'} value={edit.name[l]}
                    readOnly={!can('HospitalsCreateEdit')}
                    onChange={e => { const v = e.target.value; setEdit(s => (s ? { ...s, name: { ...s.name, [l]: v } } : s)); }} />
                </label>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{t.bookingLink}</span>
              <div dir="ltr" className={'slug-input' + (editSlugState === 'bad' || editSlugState === 'taken' ? ' bad' : '')}>
                <span style={{ height: 40 }}>{BOOK_BASE}</span>
                <input style={{ height: 40, fontSize: 14 }} value={edit.slug} readOnly={!can('HospitalsCreateEdit')} aria-label={t.bookingLink}
                  onChange={e => { const v = cleanSlugInput(e.target.value); setEdit(s => (s ? { ...s, slug: v } : s)); }} />
              </div>
              {(editSlugState === 'bad' || editSlugState === 'taken') && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{editSlugState === 'bad' ? t.slugBad : t.slugTaken}</span>}
              <span className="note">{t.slugPolicy}</span>
              {detail && detail.oldSlugs.length > 0 && (
                <span dir="ltr" className="note" style={{ textAlign: 'start' }}>↪ {detail.oldSlugs.map(o => '/book/' + o.slug).join(', ')}</span>
              )}
            </div>

            {drawerErr && <div role="alert" className="alert alert-danger">{drawerErr}</div>}
            {can('HospitalsCreateEdit') && (
              <button type="button" className="btn btn-primary" style={{ height: 42, borderRadius: 8 }} disabled={cantSave} onClick={saveDrawer}>{t.save}</button>
            )}

            <div className="facts">
              {[[t.fBookings, String(sh.bookings30d)], [t.fUsers, String(sh.users)], [t.fCreated, fmtDate(sh.createdAt)], [t.fSync, syncInfo(sh)[0]]].map(([k, v]) => (
                <div key={k}><span style={{ fontSize: 12, color: 'var(--muted)' }}>{k}</span><span style={{ fontSize: 14, fontWeight: 600 }}>{v}</span></div>
              ))}
            </div>

            {(can('RecoverAdminAccess') || can('HospitalsSuspend')) && (
              <div style={{ borderTop: '1px solid var(--thead-border)', paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{t.access}</span>
                {can('RecoverAdminAccess') && <button type="button" className="action-btn" onClick={() => openModal('recover')}>{t.recover}</button>}
                {can('HospitalsSuspend') && (
                  <button type="button" className="action-btn" onClick={() => openModal('suspend')}
                    style={sh.status === 'suspended' ? { color: '#13795b', borderColor: '#9fd8bf' } : { color: '#b42318', borderColor: '#f1b4ae' }}>
                    {sh.status === 'suspended' ? t.reactivate : t.suspend}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {modal && (
        <div className="modal-scrim">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
            {modal === 'create' && (() => {
              const cant = !form.ar.trim() || !form.en.trim() || !/^\S+@\S+\.\S+$/.test(form.email) || createSlugState !== 'ok' || busy;
              const slugMsg = !form.slug ? '' : createSlugState === 'ok' ? t.slugOk : createSlugState === 'taken' ? t.slugTaken : createSlugState === 'bad' ? t.slugBad : '';
              return (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <h2 id="modal-title">{created ? t.created : t.createTitle}</h2>
                    {!created && <p className="body">{t.createBody}</p>}
                  </div>
                  {!created ? (
                    <>
                      {([['ar', t.nameAr, 'rtl', 'مستشفى …'], ['en', t.nameEn, 'ltr', '… Hospital'], ['tr', t.nameTr, 'ltr', '… Hastanesi'], ['email', t.adminEmail, 'ltr', 'admin@hospital.example']] as const).map(([k, tag, dir, ph]) => (
                        <label key={k} className="field">
                          <span>{tag}</span>
                          <input className="input" dir={dir} placeholder={ph} type={k === 'email' ? 'email' : 'text'} value={form[k]} onChange={e => setF(k, e.target.value)} />
                        </label>
                      ))}
                      <div className="field">
                        <span>{t.bookingLink}</span>
                        <div dir="ltr" className={'slug-input' + (form.slug && (createSlugState === 'bad' || createSlugState === 'taken') ? ' bad' : '')}>
                          <span>{BOOK_BASE}</span>
                          <input value={form.slug} aria-label={t.bookingLink} onChange={e => { const v = cleanSlugInput(e.target.value); setForm(f => ({ ...f, slug: v, slugTouched: true })); }} />
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 400, color: createSlugState === 'ok' ? '#13795b' : '#b42318' }}>{slugMsg}</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="alert alert-ok" style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 14, padding: 14, borderRadius: 10 }}>
                        <strong>{created.name}</strong>
                        <span dir="ltr" className="mono" style={{ fontSize: 13 }}>{created.id}</span>
                        <span dir="ltr" style={{ fontSize: 13 }}>https://{BOOK_BASE}{created.slug}</span>
                      </div>
                      {created.emailSent
                        ? <div style={{ background: 'var(--page)', borderRadius: 10, padding: '12px 14px', fontSize: 13, lineHeight: 1.6 }}>{t.activationNote}</div>
                        : <div className="alert alert-warn">{a.emailNotSent}</div>}
                    </>
                  )}
                  {modalErr && <div role="alert" className="alert alert-danger">{modalErr}</div>}
                  <div className="modal-actions">
                    <button type="button" className="btn btn-secondary" onClick={closeModal}>{created ? t.close : t.cancel}</button>
                    {!created && <button type="button" className="btn btn-primary" disabled={cant} onClick={confirmModal}>{busy ? t.creating : t.create}</button>}
                  </div>
                </>
              );
            })()}

            {modal === 'suspend' && sh && (() => {
              const re = sh.status === 'suspended';
              const cant = reason.trim().length < 5 || busy;
              return (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <h2 id="modal-title">{re ? t.reactTitle(nameIn(sh.name, L)) : t.suspendTitle(nameIn(sh.name, L))}</h2>
                    <p className="body">{re ? t.reactBody : t.suspendBody}</p>
                  </div>
                  <textarea className="input" rows={3} value={reason} placeholder={t.reasonPh} aria-label={t.reasonPh} maxLength={500} onChange={e => setReason(e.target.value)} />
                  {modalErr && <div role="alert" className="alert alert-danger">{modalErr}</div>}
                  <div className="modal-actions">
                    <button type="button" className="btn btn-secondary" onClick={closeModal}>{t.cancel}</button>
                    <button type="button" className={'btn ' + (cant ? 'btn-primary' : re ? 'btn-success' : 'btn-danger')} disabled={cant} onClick={confirmModal}>{re ? t.confirmReact : t.confirmSuspend}</button>
                  </div>
                </>
              );
            })()}

            {modal === 'recover' && sh && (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <h2 id="modal-title">{t.recoverTitle}</h2>
                  <p className="body">{t.recoverBody}</p>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {t.checks.map((label, i) => (
                    <button key={i} type="button" role="checkbox" aria-checked={checks[i]} className="check" disabled={recoverDone !== null}
                      onClick={() => setChecks(c => c.map((x, j) => (j === i ? !x : x)))}>
                      <span className="mark" aria-hidden="true">{checks[i] ? '☑' : '☐'}</span>{label}
                    </button>
                  ))}
                </div>
                {recoverDone === true && <div className="alert alert-ok" style={{ lineHeight: 1.6 }}>{t.recoverDone}</div>}
                {recoverDone === false && <div className="alert alert-warn">{a.emailNotSent}</div>}
                {modalErr && <div role="alert" className="alert alert-danger">{modalErr}</div>}
                <div className="modal-actions">
                  <button type="button" className="btn btn-secondary" onClick={closeModal}>{recoverDone !== null ? t.close : t.cancel}</button>
                  {recoverDone === null && (
                    <button type="button" className="btn btn-primary" disabled={!checks.every(Boolean) || busy} onClick={confirmModal}>{t.issueLink}</button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function useLoad<R>(path: string) {
  const [data, setData] = useState<R | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const load = useCallback(() => {
    setErr(null);
    api<R>('GET', path).then(setData).catch(e => setErr(e instanceof ApiError ? e : new ApiError(0, 'NETWORK')));
  }, [path]);
  useEffect(load, [load]);
  return { data, err, load };
}

function ReportsTab({ L }: { L: Lang }) {
  const t = T[L], a = A[L];
  const { data, err, load } = useLoad<Reports>('/admin/reports');
  if (err) return <div className="card empty">{err.status === 403 ? a.noAccess : a.loadFail} <button className="btn-link" onClick={load}>{a.retry}</button></div>;
  if (!data) return <div className="card empty">{a.loading}</div>;
  const pct = (v: number | null) => (v == null ? a.noData : Math.round(v) + '%');
  return (
    <>
      <div className="kpis">
        {[[t.kTotal, data.totalBookings.toLocaleString('en')], [t.kAttend, pct(data.averageAttendance)], [t.kActive, String(data.activeHospitals)]].map(([label, v]) => (
          <div key={label} className="card kpi"><span style={{ fontSize: 13, color: 'var(--muted)' }}>{label}</span><b>{v}</b></div>
        ))}
      </div>
      <div className="card table">
        <div className="trow thead cols-rep"><span>{t.cHospital}</span><span>{t.rBookings}</span><span>{t.rAttend}</span><span>{t.rNoShow}</span></div>
        {data.hospitals.map(h => (
          <div key={h.id} className="trow cols-rep" style={{ fontSize: 14 }}>
            <span style={{ fontWeight: 500 }}>{nameIn(h.name, L)}</span>
            <span>{h.bookings.toLocaleString('en')}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="bar"><span style={{ width: (h.attendance ?? 0) + '%' }} /></span>
              <span style={{ width: 40, fontSize: 13 }}>{pct(h.attendance)}</span>
            </span>
            <span className="muted">{pct(h.noShow)}</span>
          </div>
        ))}
        {data.hospitals.length === 0 && <div className="empty">{t.empty}</div>}
      </div>
      <div className="note">{t.reportNote} {a.reportsPending}</div>
    </>
  );
}

const TAG_KIND: Record<string, keyof (typeof T)['en']['tags']> = {
  hospital_create: 'create', hospital_edit: 'edit', hospital_suspend: 'suspend', hospital_reactivate: 'react',
  admin_recover: 'recover', login: 'login', form_publish: 'publish',
};
const TAG_COLOR: Record<string, [string, string]> = {
  create: ['#e7f6ee', '#13795b'], suspend: ['#fdecea', '#8a1c12'], react: ['#e7f6ee', '#13795b'], edit: ['#eef1fc', '#1a2d99'],
  recover: ['#fff4e5', '#7a4300'], publish: ['#eef1fc', '#1a2d99'], login: ['#f4f6fb', '#5b6380'],
};

function AuditTab({ L, hospitals }: { L: Lang; hospitals: Hospital[] }) {
  const t = T[L], a = A[L];
  const { data, err, load } = useLoad<{ entries: AuditEntry[] }>('/admin/audit');
  if (err) return <div className="card empty">{err.status === 403 ? a.noAccess : a.loadFail} <button className="btn-link" onClick={load}>{a.retry}</button></div>;
  if (!data) return <div className="card empty">{a.loading}</div>;
  const byId = new Map(hospitals.map(h => [h.id, h]));
  const when = (s: string) => {
    const d = new Date(s);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  return (
    <>
      <div className="card">
        {data.entries.map((e, i) => {
          const kind = TAG_KIND[e.action];
          const label = kind ? t.tags[kind] : a.extraTags[e.action] ?? e.action;
          const [bg, fg] = TAG_COLOR[kind ?? 'login'];
          const h = e.hospitalId ? byId.get(e.hospitalId) : undefined;
          const m = e.meta as Record<string, string | null | undefined>;
          const parts = [h ? nameIn(h.name, L) : e.target, m.slug, m.oldSlug && m.newSlug ? `${m.oldSlug} → ${m.newSlug}` : null, m.reason].filter(Boolean);
          return (
            <div key={i} style={{ display: 'flex', gap: 14, padding: '12px 16px', borderBottom: '1px solid var(--divider)', flexWrap: 'wrap', alignItems: 'baseline' }}>
              <span dir="ltr" className="mono" style={{ fontSize: 12, color: 'var(--muted)', width: 128, flexShrink: 0 }}>{when(e.at)}</span>
              <span className="chip" style={{ background: bg, color: fg, padding: '2px 8px' }}>{label}</span>
              <span style={{ flex: '1 1 260px', fontSize: 14, minWidth: 0 }}>{parts.join(' · ')}</span>
              <span dir="ltr" style={{ fontSize: 12, color: 'var(--muted)' }}>{e.actor ?? '—'}</span>
            </div>
          );
        })}
        {data.entries.length === 0 && <div className="empty">{t.empty}</div>}
      </div>
      <div className="note">{t.auditNote}</div>
    </>
  );
}

const MARK: Record<Mark, { mark: string; color: string }> = { Y: { mark: '✓', color: '#13795b' }, N: { mark: '—', color: '#c9cfe3' }, O: { mark: '◐', color: '#e8a317' } };

function RolesTab({ L }: { L: Lang }) {
  const t = T[L];
  const groups = [
    { title: t.perms.company, roles: ROLE_LABELS[L][0], perms: COMPANY_PERMS[L] },
    { title: t.perms.hospital, roles: ROLE_LABELS[L][1], perms: HOSPITAL_PERMS[L] },
  ];
  return (
    <>
      {groups.map(g => (
        <div key={g.title} className="card table">
          <div style={{ padding: '14px 16px', fontSize: 15, fontWeight: 600, color: 'var(--ink)', borderBottom: '1px solid var(--thead-border)' }}>{g.title}</div>
          <div className="trow thead cols-role" style={{ borderBottom: 'none' }}>
            <span>{t.permission}</span>
            {g.roles.map(r => <span key={r} style={{ textAlign: 'center' }}>{r}</span>)}
          </div>
          {g.perms.map(([label, cells]) => (
            <div key={label} className="trow cols-role" style={{ fontSize: 14, borderTop: '1px solid var(--divider)', borderBottom: 'none', padding: '10px 16px' }}>
              <span>{label}</span>
              {cells.map((c, i) => <span key={i} style={{ textAlign: 'center', fontWeight: 700, color: MARK[c].color }}>{MARK[c].mark}</span>)}
            </div>
          ))}
        </div>
      ))}
      <div className="note">{t.rolesNote}</div>
    </>
  );
}
