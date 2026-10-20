import { useEffect, useRef, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { api, ApiError, type LinkInfo } from './api';
import { A, type Lang } from './i18n';
import { AuthShell } from './SignIn';

/**
 * One-time setup / activation / reset link. The token arrives in the URL fragment (never sent to a
 * server by the browser) and is removed from the address bar straight away.
 */
function takeToken(): string | null {
  const m = /[#&]t=([A-Za-z0-9_-]{20,64})/.exec(window.location.hash);
  if (m) history.replaceState(null, '', window.location.pathname);
  return m ? m[1] : null;
}

// Read once at load: React may render a component twice in development and drop the first render,
// so taking the token inside the component would lose it after the fragment is cleared.
const initialToken = takeToken();

export function LinkPage({ lang, onLang }: { lang: Lang; onLang: (l: Lang) => void }) {
  const t = A[lang];
  const token = useRef<string | null>(null);
  if (token.current === null) token.current = initialToken ?? '';
  const [info, setInfo] = useState<LinkInfo | null | 'invalid'>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token.current) { setInfo('invalid'); return; }
    api<LinkInfo>('POST', '/auth/link/inspect', { token: token.current })
      .then(async r => {
        setInfo(r);
        if (r.totpUri) setQr(await QRCode.toDataURL(r.totpUri, { margin: 1, width: 400, color: { dark: '#0f1a4a', light: '#ffffff' } }));
      })
      .catch(() => setInfo('invalid'));
  }, []);

  if (info === null) return <AuthShell lang={lang} onLang={onLang}><p className="sub">{t.loading}</p></AuthShell>;
  if (info === 'invalid')
    return (
      <AuthShell lang={lang} onLang={onLang}>
        <h1>{t.linkTitles.reset}</h1>
        <div role="alert" className="alert alert-danger">{t.linkInvalid}</div>
      </AuthShell>
    );

  const min = info.passwordMinLength;
  const pwErr = pw.length > 0 && pw.length < min ? t.pwMin(min) : pw2.length > 0 && pw !== pw2 ? t.pwMismatch : '';
  const canSave = pw.length >= min && pw === pw2 && (!info.totpRequired || /^\d{6}$/.test(code)) && !busy;
  const isCompany = info.scope === 'company';

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setErr('');
    try {
      await api('POST', '/auth/link/complete', { token: token.current, password: pw, totp: info && info !== 'invalid' && info.totpRequired ? code : undefined });
      token.current = '';
      setPw(''); setPw2('');
      setDone(true);
    } catch (ex) {
      const c = ex instanceof ApiError ? ex.code : '';
      setErr(c === 'TOTP_INVALID' ? t.totpBad : c === 'PASSWORD_WEAK' ? t.pwWeak : c === 'LINK_INVALID' ? t.linkInvalid : c === 'NETWORK' ? t.errNetwork : t.errGeneric);
      if (c === 'TOTP_INVALID') setCode('');
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <AuthShell lang={lang} onLang={onLang}>
        <h1>{t.linkTitles[info.purpose]}</h1>
        <div role="status" className="alert alert-ok">{isCompany ? t.linkDone : t.linkDoneHospital}</div>
        {isCompany && <a className="btn btn-primary" href="/" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }}>{t.goSignIn}</a>}
      </AuthShell>
    );

  return (
    <AuthShell lang={lang} onLang={onLang}>
      <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 18 }} noValidate>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h1>{t.linkTitles[info.purpose]}</h1>
          <p className="sub"><bdi dir="ltr">{info.email}</bdi></p>
          <p className="sub">{t.linkSub}</p>
        </div>
        {err && <div role="alert" className="alert alert-danger">{err}</div>}
        <label className="field">
          <span>{t.newPassword}</span>
          <input className="input" type="password" dir="ltr" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} />
          <span className="note" style={{ fontWeight: 400 }}>{t.pwMin(min)}</span>
        </label>
        <label className="field">
          <span>{t.confirmPassword}</span>
          <input className="input" type="password" dir="ltr" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} />
        </label>
        {pwErr && <span style={{ fontSize: 13, color: 'var(--danger)' }}>{pwErr}</span>}
        {info.totpRequired && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid var(--thead-border)', paddingTop: 16 }}>
            <strong style={{ fontSize: 15 }}>{t.totpSetup}</strong>
            <p className="sub">{t.totpSetupSub}</p>
            {qr && <img className="qr" src={qr} alt="" />}
            <span className="note">{t.manualKey}</span>
            <div className="secret" dir="ltr">{info.totpSecret?.replace(/(.{4})/g, '$1 ').trim()}</div>
            <label className="field">
              <span>{t.totpLabel}</span>
              <input className="input totp-input" dir="ltr" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
            </label>
          </div>
        )}
        <button type="submit" className="btn btn-primary" style={{ height: 46, fontSize: 15 }} disabled={!canSave}>{busy ? t.saving : t.save}</button>
      </form>
    </AuthShell>
  );
}
