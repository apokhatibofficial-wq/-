import { useEffect, useState, type ReactNode } from 'react';
import { LangPill } from './LangPill';
import { A, type Lang } from './text';

export function useWidth() {
  const [w, setW] = useState(window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

export type NavItem = { key: string; label: string; soon?: boolean };

type Props = {
  lang: Lang; onLang: (l: Lang) => void;
  caption: string; nav: NavItem[]; current: string; onNav: (key: string) => void;
  email: string; roleLabel: string; onSignOut: () => void;
  title: string; subtitle?: string; actions?: ReactNode; children: ReactNode;
  soonLabel?: string; breakpoint?: number;
};

/** Dark sidebar layout from the console and form-builder designs; becomes a top bar on narrow screens. */
export function Shell(p: Props) {
  const a = A[p.lang];
  const wide = useWidth() >= (p.breakpoint ?? 860);
  const navButtons = p.nav.map(n => (
    <button key={n.key} type="button" aria-current={p.current === n.key ? 'page' : undefined} onClick={() => p.onNav(n.key)}
      style={n.soon ? { opacity: 0.7 } : undefined}>
      {n.label}{n.soon && p.soonLabel ? <span style={{ fontSize: 11, marginInlineStart: 6, opacity: 0.8 }}>· {p.soonLabel}</span> : null}
    </button>
  ));
  return (
    <div className="console">
      {wide && (
        <aside className="side" style={{ width: 236 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 8px' }}>
            <img className="logo" src="/assets/medlink-logo-white.svg" alt="MEDLINK" style={{ width: 150, height: 'auto' }} />
            <span style={{ fontSize: 11, color: '#b9c2f0' }}>{p.caption}</span>
          </div>
          <nav>{navButtons}</nav>
          <div style={{ flex: 1 }} />
          <div className="user-card">
            <bdi dir="ltr" className="ellipsis" style={{ fontSize: 13, fontWeight: 600 }} title={p.email}>{p.email}</bdi>
            <span style={{ fontSize: 12, color: '#d6dcff' }}>{p.roleLabel}</span>
            <button type="button" className="btn-link" onClick={p.onSignOut}>{a.signOut}</button>
          </div>
        </aside>
      )}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {!wide && (
          <div className="topbar">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <img src="/assets/medlink-logo-white.svg" alt="MEDLINK" style={{ height: 34, width: 'auto' }} />
              <button type="button" className="btn-link" style={{ color: '#d6dcff', fontSize: 13 }} onClick={p.onSignOut}>{a.signOut}</button>
            </div>
            <nav>{navButtons}</nav>
          </div>
        )}
        <main className="main">
          <div className="title-row">
            <div style={{ flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <h1>{p.title}</h1>
              {p.subtitle && <div style={{ fontSize: 14, color: 'var(--muted)' }}>{p.subtitle}</div>}
            </div>
            <LangPill lang={p.lang} onLang={p.onLang} />
            {p.actions}
          </div>
          {p.children}
        </main>
      </div>
    </div>
  );
}

export function Toast({ text }: { text: string | null }) {
  return text ? <div className="toast" role="status">{text}</div> : null;
}

export function useToast() {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!text) return;
    const h = setTimeout(() => setText(null), 2600);
    return () => clearTimeout(h);
  }, [text]);
  return [text, setText] as const;
}
