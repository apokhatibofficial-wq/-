import { useState } from 'react';
import { ApiError, type ManagedUser } from './api';
import { UT, type Lang } from './text';

type Props = {
  lang: Lang;
  users: ManagedUser[] | null;
  /** Roles this manager may give, with their labels. */
  roles: { id: string; label: string }[];
  /** Labels for every role that can appear, including ones this manager may not change. */
  roleNames: Record<string, string>;
  /** Users holding one of these roles are shown but cannot be changed here (e.g. hospital admins). */
  lockedRoles?: string[];
  selfId: string;
  onInvite: (email: string, role: string) => Promise<{ emailSent: boolean }>;
  onChange: (id: string, change: { role?: string; disabled?: boolean }) => Promise<void>;
  onSendLink: (id: string) => Promise<{ emailSent: boolean }>;
  flash: (text: string) => void;
  lockedNote?: string;
};

/** Invite by email, change role, disable/enable and re-send links. Shared by the company Team tab and hospital staff. */
export function UsersPanel(p: Props) {
  const t = UT[p.lang];
  const [email, setEmail] = useState('');
  const [role, setRole] = useState(p.roles[0]?.id ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const fail = (e: unknown) => {
    const c = e instanceof ApiError ? e.code : '';
    setErr(c === 'EMAIL_TAKEN' ? t.emailTaken : c === 'EMAIL_INVALID' ? t.emailInvalid : c === 'LAST_OWNER' ? t.lastOwner
      : c === 'CANNOT_CHANGE_SELF' ? t.self : c === 'NETWORK' ? t.network : t.generic);
  };

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key); setErr('');
    try { await fn(); } catch (e) { fail(e); } finally { setBusy(null); }
  }

  const statusChip = (u: ManagedUser) => {
    const [label, bg, fg] = u.status === 'active' ? [t.active, '#e7f6ee', '#13795b'] : u.status === 'pending' ? [t.pending, '#fff4e5', '#7a4300'] : [t.disabled, '#fdecea', '#8a1c12'];
    return <span className="chip" style={{ background: bg, color: fg }}>{label}</span>;
  };
  const validEmail = /^\S+@\S+\.\S+$/.test(email.trim());

  return (
    <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <form className="filters" onSubmit={e => {
        e.preventDefault();
        if (!validEmail || busy) return;
        void run('invite', async () => {
          const r = await p.onInvite(email.trim(), role);
          setEmail('');
          p.flash(r.emailSent ? t.invited : t.emailNotSent);
        });
      }}>
        <input className="input" type="email" dir="ltr" placeholder={t.emailPh} aria-label={t.emailPh} value={email} onChange={e => setEmail(e.target.value)} style={{ maxWidth: 320 }} />
        <select className="input" style={{ width: 'auto', minWidth: 140, height: 40, fontSize: 14 }} value={role} aria-label={t.role} onChange={e => setRole(e.target.value)}>
          {p.roles.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        <button type="submit" className="btn btn-primary" style={{ height: 40 }} disabled={!validEmail || busy !== null}>{busy === 'invite' ? t.sending : t.invite}</button>
      </form>
      <p className="note" style={{ margin: 0 }}>{t.inviteNote}</p>
      {err && <div role="alert" className="alert alert-danger">{err}</div>}

      {p.users === null ? <div className="empty">{t.loading}</div> : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {p.users.map(u => {
            const locked = u.id === p.selfId || u.roles.some(r => p.lockedRoles?.includes(r));
            const current = u.roles[0] ?? '';
            return (
              <div key={u.id} className="user-row">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 220px' }}>
                  <bdi dir="ltr" className="ellipsis" style={{ fontSize: 14, fontWeight: 600, textAlign: 'start' }}>{u.email}</bdi>
                  <span className="note">
                    {u.has2fa ? t.with2fa : t.without2fa}
                    {u.id === p.selfId ? ' · ' + t.you : ''}
                  </span>
                </div>
                {statusChip(u)}
                {locked ? (
                  <span style={{ fontSize: 13, minWidth: 140 }}>{u.roles.map(r => p.roleNames[r] ?? r).join(' · ')}</span>
                ) : (
                  <select className="input" style={{ width: 'auto', minWidth: 140, height: 36, fontSize: 13 }} aria-label={t.role} value={current}
                    disabled={busy !== null || u.status === 'disabled'}
                    onChange={e => { const v = e.target.value; void run(u.id, async () => { await p.onChange(u.id, { role: v }); p.flash(t.roleChanged); }); }}>
                    {p.roles.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </select>
                )}
                {!locked && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {u.status !== 'disabled' && (
                      <button type="button" className="copy-btn" style={{ height: 32 }} disabled={busy !== null}
                        onClick={() => void run(u.id, async () => { const r = await p.onSendLink(u.id); p.flash(r.emailSent ? t.linkSent : t.emailNotSent); })}>
                        {u.status === 'pending' ? t.resendInvite : t.sendReset}
                      </button>
                    )}
                    <button type="button" className="copy-btn" style={{ height: 32, color: u.status === 'disabled' ? '#13795b' : '#b42318' }} disabled={busy !== null}
                      onClick={() => void run(u.id, async () => { await p.onChange(u.id, { disabled: u.status !== 'disabled' }); p.flash(t.saved); })}>
                      {u.status === 'disabled' ? t.enable : t.disable}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {p.lockedNote && <p className="note" style={{ margin: 0 }}>{p.lockedNote}</p>}
    </div>
  );
}
