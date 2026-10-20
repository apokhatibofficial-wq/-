import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { api, ApiError, setCsrf, type Me } from './api';
import { A, AH, whatsappUrl, type Audience, type Lang } from './text';
import { LangPill } from './LangPill';

type Props = { lang: Lang; onLang: (l: Lang) => void; onSignedIn: (me: Me, csrf: string | null) => void; audience: Audience };

export function errorText(t: (typeof A)['en'], e: unknown): string {
  if (!(e instanceof ApiError)) return t.errGeneric;
  switch (e.code) {
    case 'INVALID_CREDENTIALS': return t.errBad;
    case 'ACCOUNT_LOCKED': return t.errLocked;
    case 'RATE_LIMITED': return t.errRate;
    case 'MFA_NOT_ENROLLED': return t.errMfaNotEnrolled;
    case 'HOSPITAL_SUSPENDED': return t.errSuspended;
    case 'NETWORK': return t.errNetwork;
    default: return t.errGeneric;
  }
}

export function AuthShell({ lang, onLang, children, audience }: { lang: Lang; onLang: (l: Lang) => void; children: React.ReactNode; audience: Audience }) {
  const t = audience === 'company' ? A[lang] : { ...A[lang], ...AH[lang] };
  return (
    <div className="auth">
      <div className="auth-brand">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <img src="/assets/medlink-logo-white.svg" alt="MEDLINK" style={{ width: 'min(300px,100%)', height: 'auto' }} />
          <p>{t.brandLine}</p>
        </div>
        <img src="/assets/khatib-logo-white.svg" alt="KHATIB TECHNICAL SOLUTIONS" style={{ height: 40, width: 'auto', alignSelf: 'flex-start' }} />
      </div>
      <main className="auth-main">
        <div className="auth-form">
          <div style={{ alignSelf: 'flex-end' }}><LangPill lang={lang} onLang={onLang} /></div>
          {children}
        </div>
      </main>
    </div>
  );
}

export function SignIn({ lang, onLang, onSignedIn, audience }: Props) {
  const t = A[lang];
  const h = AH[lang];
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [caps, setCaps] = useState(false);
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'password' | 'totp'>('password');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [forgot, setForgot] = useState(false);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState('CapsLock'));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      const r = await api<{ status: string; user?: Me; csrf?: string | null }>('POST', '/auth/login', {
        email: email.trim(), password, totp: step === 'totp' ? code : undefined, client: 'web',
      });
      if (r.status === 'mfa_required') { setStep('totp'); setCode(''); return; }
      if (r.user && r.user.scope !== audience) {
        // Company staff use the company console; hospital accounts use the hospital app.
        setCsrf(r.csrf ?? null);
        await api('POST', '/auth/logout', {}).catch(() => undefined);
        setCsrf(null);
        setErr(t.errBad);
        setStep('password');
        return;
      }
      setPassword('');
      onSignedIn(r.user!, r.csrf ?? null);
    } catch (ex) {
      setErr(errorText(t, ex));
      if (ex instanceof ApiError && ex.code !== 'RATE_LIMITED') { setStep('password'); setCode(''); }
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = step === 'password' ? email.includes('@') && password.length > 0 : /^\d{6}$/.test(code);

  return (
    <AuthShell lang={lang} onLang={onLang} audience={audience}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }} noValidate>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h1>{step === 'password' ? t.signIn : t.totpTitle}</h1>
          <p className="sub">{step === 'password' ? (audience === 'company' ? t.signInSub : h.signInSub) : t.totpSub}</p>
        </div>
        {err && <div role="alert" className="alert alert-danger">{err}</div>}
        {step === 'password' ? (
          <>
            <label className="field">
              <span>{t.email}</span>
              <input className="input" type="email" dir="ltr" autoComplete="username" value={email}
                onChange={e => setEmail(e.target.value)} style={{ textAlign: 'start' }} required />
            </label>
            <label className="field">
              <span>{t.password}</span>
              <div className="pw-wrap">
                <input className="input" type={showPw ? 'text' : 'password'} dir="ltr" autoComplete="current-password"
                  value={password} onChange={e => setPassword(e.target.value)} onKeyUp={onKey} onKeyDown={onKey} required />
                <button type="button" className="pw-toggle" onClick={() => setShowPw(v => !v)}>{showPw ? t.hide : t.show}</button>
              </div>
              {caps && <span style={{ fontSize: 12, color: '#7a5200', fontWeight: 400 }}>{t.caps}</span>}
            </label>
          </>
        ) : (
          <label className="field">
            <span>{t.totpLabel}</span>
            <input className="input totp-input" dir="ltr" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
              value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} autoFocus />
          </label>
        )}
        <button type="submit" className="btn btn-primary" style={{ height: 46, fontSize: 15 }} disabled={!canSubmit || busy}>
          {busy ? t.submitting : step === 'password' ? t.submit : t.verify}
        </button>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          {step === 'password'
            ? <button type="button" className="btn-link" onClick={() => setForgot(true)}>{t.forgot}</button>
            : <button type="button" className="btn-link" onClick={() => { setStep('password'); setPassword(''); setErr(''); }}>{t.back}</button>}
        </div>
      </form>
      {forgot && (
        <div className="modal-scrim" onClick={() => setForgot(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="forgot-title" onClick={e => e.stopPropagation()}>
            {audience === 'company' ? (
              <>
                <h2 id="forgot-title">{t.forgotTitle}</h2>
                <p className="body">{t.forgotBody}</p>
                <div className="modal-actions"><button className="btn btn-secondary" onClick={() => setForgot(false)}>{t.close}</button></div>
              </>
            ) : (
              <>
                <h2 id="forgot-title">{h.forgotTitle}</h2>
                <p className="body">{h.forgotBody}</p>
                <div className="alert alert-warn">{h.forgotWarn}</div>
                <pre dir="auto" className="secret" style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font)' }}>{h.waMsg(email.trim())}</pre>
                <p className="note" style={{ margin: 0 }}>{h.staffHint}</p>
                <div className="modal-actions">
                  <button className="btn btn-secondary" onClick={() => setForgot(false)}>{h.cancel}</button>
                  <a className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }}
                    href={whatsappUrl(h.waMsg(email.trim()))} target="_blank" rel="noopener noreferrer">{h.openWa}</a>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </AuthShell>
  );
}
