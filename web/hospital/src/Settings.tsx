import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, BOOK_ORIGIN, type HospitalMe, type ManagedUser, type Me } from '@medlink/shared/api';
import type { Lang } from '@medlink/shared/text';
import { tzLabel, tzOptions } from '@medlink/shared/timezones';
import { UsersPanel } from '@medlink/shared/UsersPanel';
import { H } from './text';

type Props = { lang: Lang; me: Me; hospital: HospitalMe; reload: () => Promise<void>; flash: (s: string) => void };

export function Settings({ lang, me, hospital, reload, flash }: Props) {
  const t = H[lang];
  const [grace, setGrace] = useState(String(hospital.noShowGraceMin));
  const [retention, setRetention] = useState(String(hospital.retentionMonths));
  const [tz, setTz] = useState(hospital.timezone);
  const [staff2fa, setStaff2fa] = useState(hospital.staffTotpRequired);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const link = hospital.slug ? BOOK_ORIGIN + '/book/' + hospital.slug : null;

  const loadUsers = useCallback(() => {
    api<{ users: ManagedUser[] }>('GET', '/hospital/users').then(r => setUsers(r.users)).catch(() => setUsers([]));
  }, []);
  useEffect(loadUsers, [loadUsers]);

  const g = Number(grace), r = Number(retention);
  const valid = Number.isInteger(g) && g >= 0 && g <= 240 && Number.isInteger(r) && r >= 1 && r <= 120;
  const changed = g !== hospital.noShowGraceMin || r !== hospital.retentionMonths || tz !== hospital.timezone || staff2fa !== hospital.staffTotpRequired;

  async function save() {
    setBusy(true); setErr('');
    try {
      await api('PATCH', '/hospital/settings', { noShowGraceMin: g, retentionMonths: r, timezone: tz, staffTotpRequired: staff2fa });
      await reload();
      flash(t.saved);
    } catch (e) {
      const c = e instanceof ApiError ? e.code : '';
      setErr(c === 'GRACE_INVALID' ? t.graceInvalid : c === 'RETENTION_INVALID' ? t.retentionInvalid : t.generic);
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h2 className="section-title">{t.bookingLink}</h2>
        {link && (
          <div className="link-box">
            <bdi dir="ltr" className="ellipsis" style={{ flex: '1 1 240px', fontSize: 15, fontWeight: 600, color: 'var(--brand-deep)' }}>{link}</bdi>
            <button type="button" className="copy-btn" style={{ height: 32 }} onClick={() => {
              navigator.clipboard?.writeText(link).catch(() => undefined);
              setCopied(true); setTimeout(() => setCopied(false), 1500);
            }}>{copied ? t.copied : t.copy}</button>
            <a className="copy-btn" style={{ height: 32, display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }} href={link} target="_blank" rel="noopener noreferrer">{t.open}</a>
          </div>
        )}
        {hospital.status !== 'active' && <div className="alert alert-warn">{t.notAccepting}</div>}
        <p className="note" style={{ margin: 0 }}>{t.bookingLinkNote}</p>
      </div>

      <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h2 className="section-title">{t.rules}</h2>
        <div className="grid-2">
          <label className="field"><span>{t.grace}</span>
            <input className="input" type="number" min={0} max={240} dir="ltr" value={grace} onChange={e => setGrace(e.target.value)} />
            <span className="note" style={{ fontWeight: 400 }}>{t.graceNote}</span>
          </label>
          <label className="field"><span>{t.retention}</span>
            <input className="input" type="number" min={1} max={120} dir="ltr" value={retention} onChange={e => setRetention(e.target.value)} />
            <span className="note" style={{ fontWeight: 400 }}>{t.retentionNote}</span>
          </label>
          <label className="field"><span>{t.timezone}</span>
            <select className="input" dir="ltr" value={tz} onChange={e => setTz(e.target.value)}>
              {tzOptions(tz).map(z => <option key={z} value={z}>{tzLabel(z)}</option>)}
            </select>
          </label>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <button type="button" role="switch" aria-checked={staff2fa} aria-labelledby="staff2fa-label" className="switch" onClick={() => setStaff2fa(v => !v)} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span id="staff2fa-label" style={{ fontSize: 14, fontWeight: 500 }}>{t.staff2fa}</span>
            <span className="note">{t.staff2faNote}</span>
          </div>
        </div>
        {err && <div role="alert" className="alert alert-danger">{err}</div>}
        <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start' }} disabled={!valid || !changed || busy} onClick={() => void save()}>{t.saveSettings}</button>
      </div>

      <h2 className="section-title">{t.users}</h2>
      <UsersPanel
        lang={lang}
        users={users}
        roles={[{ id: 'reception', label: t.roles.reception }, { id: 'scanner', label: t.roles.scanner }]}
        roleNames={t.roles}
        lockedRoles={['hosp_admin']}
        lockedNote={t.usersLocked}
        selfId={me.id}
        flash={flash}
        onInvite={async (email, role) => { const x = await api<{ emailSent: boolean }>('POST', '/hospital/users', { email, role }); loadUsers(); return x; }}
        onChange={async (id, change) => { try { await api('PATCH', '/hospital/users/' + encodeURIComponent(id), change); } finally { loadUsers(); } }}
        onSendLink={id => api<{ emailSent: boolean }>('POST', '/hospital/users/' + encodeURIComponent(id) + '/send-link', {})}
      />
    </>
  );
}
