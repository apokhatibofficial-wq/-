import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, setCsrf, type HospitalMe, type Me } from '@medlink/shared/api';
import { A, LANG_PILL, loadLang, saveLang, type Lang } from '@medlink/shared/text';
import { ST } from './scanText';
import { QrCamera, type CameraError } from './camera';
import { card, DOT, isQrCode, isRef, type Kind, type ScanResponse } from './result';

type Recent = { kind: Kind; name: string | null; ref: string | null; time: string };
type Result = { kind: Kind; r: ScanResponse | null };

/** Now, in the hospital's time zone (the server's times are in hospital time too). */
const nowHm = (timeZone: string | undefined) => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone });

/**
 * The phone scanner at app.medlink.website/scan (SCREENS.md §4, designs/QR Scanner.dc.html). Single column, max 440px.
 * Recent actions live in memory only: nothing about patients is stored on the phone.
 */
export function ScanApp() {
  const [lang, setLang] = useState<Lang>(loadLang);
  const t = ST[lang];
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [hospital, setHospital] = useState<HospitalMe | null>(null);
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.title = 'MEDLINK · ' + ST[lang].scan;
    saveLang(lang);
  }, [lang]);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ user: Me; csrf: string | null }>('GET', '/auth/me');
      setCsrf(r.csrf);
      setMe(r.user.scope === 'hospital' ? r.user : null);
    } catch { setMe(null); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (me) api<HospitalMe>('GET', '/hospital/me').then(setHospital).catch(() => undefined);
  }, [me]);

  async function signOut() {
    await api('POST', '/auth/logout', {}).catch(() => undefined);
    setCsrf(null); setMe(null); setHospital(null);
  }

  const hospitalName = hospital ? (lang === 'ar' ? hospital.name.ar : lang === 'en' ? hospital.name.en || hospital.name.ar : hospital.name.tr || hospital.name.en || hospital.name.ar) : 'MEDLINK';

  return (
    <div className="scan-bg">
      <div className="scan-col">
        <header className="scan-header">
          <img src="/assets/medlink-icon.svg" alt="MEDLINK" width={30} height={30} />
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <span className="ellipsis" style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)' }}>{hospitalName}</span>
            <span style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }} role="status">
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: online ? '#13795b' : '#e8a317' }} />
              {online ? t.online : t.offline}
            </span>
          </div>
          <div className="scan-langs">
            {LANG_PILL.map(([l, label]) => (
              <button key={l} type="button" aria-pressed={l === lang} onClick={() => setLang(l)}
                style={{ background: l === lang ? 'var(--brand)' : 'transparent', color: l === lang ? '#fff' : 'var(--text)' }}>{label}</button>
            ))}
          </div>
        </header>
        {me === undefined ? null : me === null
          ? <ScanSignIn lang={lang} onSignedIn={(u, csrf) => { setCsrf(csrf); setMe(u); }} />
          : !me.permissions.includes('CheckIn')
            ? <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div role="alert" className="alert alert-danger">{t.noPermission}</div>
                <button type="button" className="scan-btn scan-btn-primary" onClick={() => void signOut()}>{t.logout}</button>
              </div>
            : <Scanner lang={lang} me={me} timeZone={hospital?.timezone} onSignOut={() => void signOut()} onExpired={() => setMe(null)} />}
      </div>
    </div>
  );
}

function ScanSignIn({ lang, onSignedIn }: { lang: Lang; onSignedIn: (u: Me, csrf: string | null) => void }) {
  const t = ST[lang], a = A[lang];
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      const r = await api<{ status: string; user?: Me; csrf?: string | null }>('POST', '/auth/login',
        { email: email.trim(), password, totp: step === 'code' ? code : undefined, client: 'web' });
      if (r.status === 'mfa_required') { setStep('code'); setCode(''); return; }
      if (!r.user || r.user.scope !== 'hospital') {
        setCsrf(r.csrf ?? null);
        await api('POST', '/auth/logout', {}).catch(() => undefined);
        setCsrf(null);
        setErr(t.loginErr); setStep('password');
        return;
      }
      setPassword('');
      onSignedIn(r.user, r.csrf ?? null);
    } catch (e) {
      const c = e instanceof ApiError ? e.code : '';
      // Never says which field was wrong.
      setErr(c === 'INVALID_CREDENTIALS' ? t.loginErr : c === 'ACCOUNT_LOCKED' ? a.errLocked : c === 'HTTP_429' || c === 'RATE_LIMITED' ? a.errRate
        : c === 'MFA_NOT_ENROLLED' ? a.errMfaNotEnrolled : c === 'HOSPITAL_SUSPENDED' ? a.errSuspended : c === 'NETWORK' ? a.errNetwork : a.errGeneric);
      setStep('password'); setCode('');
    } finally { setBusy(false); }
  }

  return (
    <form className="scan-body" style={{ padding: '28px 20px', gap: 18 }} onSubmit={e => { e.preventDefault(); void submit(); }}>
      <img src="/assets/medlink-logo.svg" alt="MEDLINK" style={{ width: 200, height: 'auto', alignSelf: 'center', marginBottom: 8 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: 'var(--ink)' }}>{step === 'code' ? a.totpTitle : t.loginTitle}</h1>
        <p style={{ margin: 0, fontSize: 14, color: 'var(--muted)', lineHeight: 1.5 }}>{step === 'code' ? a.totpSub : t.loginSub}</p>
      </div>
      {err && <div role="alert" className="alert alert-danger">{err}</div>}
      {step === 'password' ? (
        <>
          <label className="scan-field"><span>{a.email}</span>
            <input dir="ltr" type="email" autoComplete="username" autoCapitalize="off" value={email} onChange={e => setEmail(e.target.value)} /></label>
          <label className="scan-field"><span>{t.password}</span>
            <input dir="ltr" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
        </>
      ) : (
        <label className="scan-field"><span>{a.totpLabel}</span>
          <input dir="ltr" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} style={{ letterSpacing: '.3em', textAlign: 'center' }} /></label>
      )}
      <button type="submit" className="scan-btn scan-btn-primary" disabled={busy || (step === 'password' ? !email.trim() || !password : code.length !== 6)}>
        {busy ? t.loggingIn : step === 'code' ? a.verify : t.login}
      </button>
      {step === 'code' && <button type="button" className="scan-link" onClick={() => { setStep('password'); setErr(''); }}>{a.back}</button>}
      <div style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', lineHeight: 1.5 }}>{t.loginNote}</div>
    </form>
  );
}

function Scanner({ lang, me, timeZone, onSignOut, onExpired }: { lang: Lang; me: Me; timeZone: string | undefined; onSignOut: () => void; onExpired: () => void }) {
  const t = ST[lang];
  const [mode, setMode] = useState<'scan' | 'manual'>('scan');
  const [cam, setCam] = useState<'idle' | 'starting' | 'live' | CameraError>('idle');
  const [result, setResult] = useState<Result | null>(null);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [refQ, setRefQ] = useState('');
  const [busy, setBusy] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const camera = useRef<QrCamera | null>(null);

  // "Scan next" restarts the camera once the viewfinder (and its video element) is back on screen.
  const [resume, setResume] = useState(false);
  useEffect(() => () => camera.current?.stop(), []);

  function show(kind: Kind, r: ScanResponse | null) {
    navigator.vibrate?.(60);
    setResult({ kind, r });
    if (kind !== 'found') setRecent(list => [{ kind, name: r?.booking?.patientName ?? null, ref: r?.booking?.ref ?? null, time: nowHm(timeZone) }, ...list].slice(0, 5));
  }

  /** Calls the server; offline or rate-limited answers become result cards. Expired session → sign-in. */
  async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
    if (!navigator.onLine) { show('net', null); return; }
    setBusy(true);
    try {
      const r = await api<ScanResponse>(method, path, body);
      show(r.kind, r);
    } catch (e) {
      const c = e instanceof ApiError ? e : null;
      if (c?.status === 401) { onExpired(); return; }
      show(c?.status === 429 ? 'slow' : c?.code === 'NETWORK' || !c ? 'net' : 'bad', null);
    } finally { setBusy(false); }
  }

  async function onCode(code: string) {
    setCam('idle');
    // Codes that are not MEDLINK tickets never leave the phone.
    if (!isQrCode(code)) { show('bad', null); return; }
    await call('POST', '/scan/qr', { code: code.trim(), clientEventId: crypto.randomUUID() });
  }

  async function startCam() {
    if (!video.current) return;
    setCam('starting');
    camera.current?.stop();
    camera.current = new QrCamera(video.current, c => void onCode(c));
    try { await camera.current.start(); setCam('live'); }
    catch (e) { setCam(e === 'denied' ? 'denied' : 'none'); }
  }

  function stopCam() { camera.current?.stop(); setCam('idle'); }

  async function lookup() {
    const q = refQ.trim().toUpperCase();
    if (!isRef(q)) { show('notfound', null); return; }
    await call('GET', '/scan/lookup?ref=' + encodeURIComponent(q));
  }

  function next() {
    setResume(mode === 'scan' && result !== null && result.kind !== 'found');
    setResult(null); setRefQ('');
  }

  useEffect(() => {
    if (resume && !result && video.current) { setResume(false); void startCam(); }
  }, [resume, result]); // eslint-disable-line react-hooks/exhaustive-deps

  const c = result ? card(result.kind, result.r, t, lang) : null;
  const live = cam === 'live';

  return (
    <div className="scan-body" style={{ padding: 14, gap: 14 }}>
      <div className="scan-modes" role="tablist">
        {(['scan', 'manual'] as const).map(m => (
          <button key={m} type="button" role="tab" aria-selected={mode === m}
            onClick={() => { stopCam(); setResult(null); setMode(m); }}
            style={{ background: mode === m ? 'var(--brand)' : 'transparent', color: mode === m ? '#fff' : 'var(--text)' }}>{m === 'scan' ? t.scan : t.manual}</button>
        ))}
      </div>

      {mode === 'scan' && !result && (
        <div className="scan-finder">
          <video ref={video} muted playsInline autoPlay style={{ opacity: live ? 1 : 0 }} aria-label={t.aim} />
          <div className="scan-mask" />
          <div className="scan-frame">
            <span className="c tl" /><span className="c tr" /><span className="c bl" /><span className="c br" />
            {live && <span className="scan-line" />}
          </div>
          {(cam === 'idle' || cam === 'starting') && (
            <div className="scan-intro">
              <div style={{ fontSize: 15, lineHeight: 1.5, color: '#d6dcff', maxWidth: 260 }}>{t.camIntro}</div>
              <button type="button" className="scan-btn" style={{ background: '#fff', color: 'var(--brand-deep)', padding: '0 24px' }}
                disabled={cam === 'starting'} onClick={() => void startCam()}>{t.startCam}</button>
            </div>
          )}
          {(cam === 'denied' || cam === 'none') && (
            <div className="scan-cam-msg" role="alert">
              <span>{cam === 'denied' ? t.camDenied : t.camNone}</span>
              <button type="button" className="scan-link" onClick={() => { stopCam(); setMode('manual'); }}>{t.useManual}</button>
            </div>
          )}
          {live && <div className="scan-aim">{t.aim}</div>}
        </div>
      )}

      {mode === 'manual' && !result && (
        <form className="scan-card" style={{ padding: 18, gap: 12 }} onSubmit={e => { e.preventDefault(); void lookup(); }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--ink)' }}>{t.manualTitle}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>{t.manualSub}</div>
          </div>
          <input className="scan-ref" dir="ltr" autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="ML-XXXXXX"
            aria-label={t.ref} value={refQ} onChange={e => setRefQ(e.target.value.toUpperCase())} maxLength={9} />
          <button type="submit" className="scan-btn scan-btn-primary" disabled={busy || !refQ.trim()}>{busy ? t.looking : t.lookup}</button>
        </form>
      )}

      {c && result && (
        <div role="status" className="scan-result" style={{ borderColor: c.border }}>
          <div className="scan-result-head" style={{ background: c.bg, color: c.fg }}>
            <div className="scan-icon" style={{ background: c.fg, color: c.bg }} aria-hidden="true">{c.icon}</div>
            <div style={{ fontSize: 21, fontWeight: 700 }}>{c.title}</div>
            <div style={{ fontSize: 14, lineHeight: 1.5, maxWidth: 300 }}>{c.body}</div>
          </div>
          {c.facts && (
            <dl className="scan-facts">
              {c.facts.map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{k}</dt>
                  {/* Each value keeps its own direction (numbers, booking numbers) but all align to the same side. */}
                  <dd><bdi dir="auto">{v}</bdi></dd>
                </div>
              ))}
            </dl>
          )}
          <div style={{ padding: '0 18px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {c.canConfirm && result.r?.bookingId && (
              <button type="button" className="scan-btn" style={{ background: '#13795b', color: '#fff' }} disabled={busy}
                onClick={() => void call('POST', '/scan/checkin', { bookingId: result.r!.bookingId, clientEventId: crypto.randomUUID() })}>
                {busy ? t.confirming : t.confirm}
              </button>
            )}
            <button type="button" className="scan-btn" onClick={next}
              style={c.canConfirm ? { background: '#fff', color: 'var(--brand-deep)', border: '1px solid var(--input-border, #c9cfe3)' } : { background: 'var(--brand)', color: '#fff' }}>
              {c.canConfirm ? t.back : mode === 'scan' ? t.scanNext : t.back}
            </button>
          </div>
        </div>
      )}

      {recent.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)' }}>{t.recent}</div>
          <ul className="scan-recent">
            {recent.map((r, i) => (
              <li key={i}>
                <span className="dot" style={{ background: DOT[r.kind] }} />
                <span className="ellipsis" style={{ flex: 1, minWidth: 0, fontSize: 14 }}>
                  {(t.r[r.kind] ?? '') + (r.name ? ' · ' + r.name : '') + (r.ref ? ' · ' : '')}{r.ref && <bdi dir="ltr">{r.ref}</bdi>}
                </span>
                <span dir="ltr" style={{ fontSize: 12, color: 'var(--muted)' }}>{r.time}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ flex: 1 }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--muted)', padding: '4px 2px' }}>
        <bdi dir="ltr" className="ellipsis">{me.email}</bdi>
        <button type="button" className="scan-link" onClick={() => { stopCam(); onSignOut(); }}>{t.logout}</button>
      </div>
    </div>
  );
}
