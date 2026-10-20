import { useCallback, useEffect, useState } from 'react';
import { LangPill } from '@medlink/shared/LangPill';
import { loadLang, saveLang, type Lang } from '@medlink/shared/text';
import { B, slugFromPath } from './text';

type Names = { ar: string; en: string | null; tr: string | null };
type Info = { state: 'active'; slug: string; name: Names; acceptingBookings: boolean; departments: { id: string; name: Names }[] };
type View = { kind: 'loading' } | { kind: 'home' } | { kind: 'ok'; info: Info } | { kind: 'changed' } | { kind: 'notFound' } | { kind: 'error' };

const API: string = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';
const nameIn = (n: Names, l: Lang) => (l === 'ar' ? n.ar : l === 'en' ? n.en || n.ar : n.tr || n.en || n.ar);

export function App() {
  const [lang, setLang] = useState<Lang>(loadLang);
  const [view, setView] = useState<View>({ kind: 'loading' });
  const t = B[lang];

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    saveLang(lang);
  }, [lang]);

  const load = useCallback(async () => {
    const slug = slugFromPath(window.location.pathname);
    if (!slug) { setView(window.location.pathname === '/' ? { kind: 'home' } : { kind: 'notFound' }); return; }
    setView({ kind: 'loading' });
    try {
      // This endpoint never redirects: a renamed link returns the current page and its current slug.
      const res = await fetch(API + '/public/slugs/' + slug, { credentials: 'omit' });
      if (res.status === 404) { setView({ kind: 'notFound' }); return; }
      if (!res.ok) { setView({ kind: 'error' }); return; }
      const info = (await res.json()) as Info | { state: 'changed' };
      if (info.state === 'changed') { setView({ kind: 'changed' }); return; }
      if (info.slug !== slug) history.replaceState(null, '', '/book/' + info.slug); // show the current link
      setView({ kind: 'ok', info });
    } catch { setView({ kind: 'error' }); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    document.title = view.kind === 'ok' ? nameIn(view.info.name, lang) + ' — ' + t.bookTitle : 'MEDLINK — ' + t.bookTitle;
  }, [view, lang, t.bookTitle]);

  const hospitalName = view.kind === 'ok' ? nameIn(view.info.name, lang) : 'MEDLINK';

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--page)' }}>
      <header style={{ background: '#fff', borderBottom: '1px solid var(--border)' }}>
        <div style={{ maxWidth: 1040, margin: '0 auto', padding: '12px clamp(14px,4vw,20px)', display: 'flex', alignItems: 'center', gap: 'clamp(10px,3vw,14px)' }}>
          {view.kind === 'ok' && (
            <div aria-hidden="true" style={{ width: 44, height: 44, borderRadius: 12, background: '#eef1fc', border: '1px dashed #9aa6d8', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#5b6380', textAlign: 'center', lineHeight: 1.1, flexShrink: 0 }}>{t.logoSlot}</div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="ellipsis" style={{ fontSize: 'clamp(15px,4vw,18px)', fontWeight: 600, color: 'var(--ink)' }}>{hospitalName}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>{t.bookTitle}</div>
          </div>
          <LangPill lang={lang} onLang={setLang} />
        </div>
      </header>

      <main style={{ flex: 1, width: '100%', maxWidth: 1040, margin: '0 auto', padding: 'clamp(14px,4vw,24px) clamp(12px,4vw,20px) 40px', display: 'flex', flexDirection: 'column', gap: 'clamp(14px,3vw,20px)' }}>
        {view.kind === 'loading' && <Card><p className="sub" style={{ margin: 0 }}>{t.loading}</p></Card>}
        {view.kind === 'home' && <Message title={t.homeTitle} body={t.homeBody} />}
        {view.kind === 'changed' && <Message title={t.changedTitle} body={t.changedBody} tone="warn" />}
        {view.kind === 'notFound' && <Message title={t.notFoundTitle} body={t.notFoundBody} />}
        {view.kind === 'error' && <Message title={t.errorTitle} body={t.errorBody} action={<button className="btn btn-primary" onClick={() => void load()}>{t.retry}</button>} />}
        {view.kind === 'ok' && (
          !view.info.acceptingBookings
            ? <Message title={t.notAcceptingTitle} body={t.notAcceptingBody} tone="warn" />
            : (
              <Card>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <h1 style={{ margin: 0, fontSize: 'clamp(20px,5.5vw,24px)', fontWeight: 600, color: 'var(--ink)' }}>{t.s1Title}</h1>
                  <p style={{ margin: 0, fontSize: 14, color: 'var(--muted)', lineHeight: 1.55 }}>{t.s1Sub}</p>
                </div>
                {view.info.departments.length === 0
                  ? <div className="note">{t.noDepts}</div>
                  : (
                    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(min(100%,200px),1fr))', gap: 10 }}>
                      {view.info.departments.map(d => (
                        <li key={d.id} style={{ minHeight: 64, border: '1px solid var(--border)', borderRadius: 12, padding: '0 16px', display: 'flex', alignItems: 'center', fontSize: 15, fontWeight: 500, background: '#fff' }}>{nameIn(d.name, lang)}</li>
                      ))}
                    </ul>
                  )}
                <div className="alert alert-warn" role="status"><strong>{t.soonTitle}</strong><br />{t.soonBody}</div>
                <p className="note" style={{ margin: 0 }}>{t.privacy}</p>
              </Card>
            )
        )}
      </main>

      <footer style={{ borderTop: '1px solid var(--border)', background: '#fff' }}>
        <div style={{ maxWidth: 1040, margin: '0 auto', padding: '14px 20px', display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: 'var(--muted)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{t.powered} <img src="/assets/medlink-logo.svg" alt="MEDLINK" style={{ height: 44, width: 'auto' }} /></span>
          <img src="/assets/khatib-logo.svg" alt="KHATIB TECHNICAL SOLUTIONS" style={{ height: 26, width: 'auto' }} />
        </div>
      </footer>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div style={{ background: '#fff', borderRadius: 16, border: '1px solid var(--border)', padding: 'clamp(16px,5vw,28px)', display: 'flex', flexDirection: 'column', gap: 16, boxShadow: '0 8px 28px rgba(26,45,153,.10)' }}>{children}</div>;
}

function Message({ title, body, tone, action }: { title: string; body: string; tone?: 'warn'; action?: React.ReactNode }) {
  return (
    <Card>
      <h1 style={{ margin: 0, fontSize: 'clamp(20px,5.5vw,24px)', fontWeight: 600, color: tone === 'warn' ? '#7a4300' : 'var(--ink)' }}>{title}</h1>
      <p style={{ margin: 0, fontSize: 15, color: 'var(--muted)', lineHeight: 1.6 }}>{body}</p>
      {action}
    </Card>
  );
}
