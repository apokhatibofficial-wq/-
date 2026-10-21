import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, setCsrf, type HospitalMe, type Me } from '@medlink/shared/api';
import { loadLang, saveLang, type Lang } from '@medlink/shared/text';
import { SignIn } from '@medlink/shared/SignIn';
import { LinkPage } from '@medlink/shared/LinkPage';
import { Shell, Toast, useToast, type NavItem } from '@medlink/shared/Shell';
import { H, nameIn } from './text';
import { Departments } from './Departments';
import { Settings } from './Settings';
import { FormBuilder } from './FormBuilder';
import { Bookings } from './Bookings';
import { FT } from './formText';

type Page = 'appointments' | 'bookings' | 'form' | 'departments' | 'settings';
// Appointments (today's check-in board) arrives with the Windows app and the QR scanner.
const SOON: Page[] = ['appointments'];

export function App() {
  const [lang, setLang] = useState<Lang>(loadLang);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [hospital, setHospital] = useState<HospitalMe | null>(null);
  const [page, setPage] = useState<Page>('departments');
  const [toast, setToast] = useToast();
  const isLink = window.location.pathname.replace(/\/+$/, '') === '/link';

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    saveLang(lang);
  }, [lang]);

  const loadHospital = useCallback(async () => {
    try { setHospital(await api<HospitalMe>('GET', '/hospital/me')); } catch { /* shown as missing */ }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ user: Me; csrf: string | null }>('GET', '/auth/me');
      setCsrf(r.csrf);
      setMe(r.user);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setCsrf(null);
      setMe(null);
    }
  }, []);

  useEffect(() => { if (!isLink) void refresh(); }, [isLink, refresh]);
  useEffect(() => { if (me?.scope === 'hospital') void loadHospital(); }, [me, loadHospital]);

  if (isLink) return <LinkPage audience="hospital" lang={lang} onLang={setLang} />;
  if (me === undefined) return null;
  if (me === null || me.scope !== 'hospital')
    return <SignIn audience="hospital" lang={lang} onLang={setLang} onSignedIn={(u, csrf) => { setCsrf(csrf); setMe(u); }} />;

  const t = H[lang];
  const isAdmin = me.roles.includes('hosp_admin');
  const pages: Page[] = isAdmin ? ['appointments', 'bookings', 'form', 'departments', 'settings']
    : me.roles.includes('reception') ? ['appointments', 'bookings', 'departments'] : ['appointments', 'departments'];
  const nav: NavItem[] = pages.map(k => ({ key: k, label: t.nav[k], soon: SOON.includes(k) }));
  const current = pages.includes(page) ? page : 'departments';

  async function signOut() {
    await api('POST', '/auth/logout', {}).catch(() => undefined);
    setCsrf(null);
    setMe(null);
    setHospital(null);
  }

  return (
    <>
      <Shell
        lang={lang} onLang={setLang}
        caption={hospital ? nameIn(hospital.name, lang) : t.caption}
        nav={nav} current={current} onNav={k => setPage(k as Page)} soonLabel={t.soon}
        email={me.email} roleLabel={me.roles.map(r => t.roles[r] ?? r).join(' · ') + (isAdmin ? ' · 2FA' : '')}
        onSignOut={signOut}
        title={t.nav[current]}
        subtitle={SOON.includes(current) ? t.subs.soon : current === 'departments' ? t.subs.departments : current === 'form' ? FT[lang].titleSub : current === 'bookings' ? t.subs.bookings : t.subs.settings}
      >
        {SOON.includes(current) && <div className="card empty" style={{ lineHeight: 1.6 }}>{t.soonBody.appointments}</div>}
        {current === 'form' && <FormBuilder lang={lang} slug={hospital?.slug ?? null} flash={setToast} />}
        {current === 'bookings' && <Bookings lang={lang} canCancel={me.permissions.includes('AttendanceCorrect')} canCheckIn={me.permissions.includes('CheckIn')} canCorrect={me.permissions.includes('AttendanceCorrect')} timezone={hospital?.timezone ?? 'Asia/Damascus'} flash={setToast} />}
        {current === 'departments' && <Departments lang={lang} canEdit={me.permissions.includes('HospitalSettings')} flash={setToast} />}
        {current === 'settings' && hospital && <Settings lang={lang} me={me} hospital={hospital} reload={loadHospital} flash={setToast} />}
      </Shell>
      <Toast text={toast} />
    </>
  );
}
