import { useEffect, useState } from 'react';
import './doctor.css';

/**
 * Public doctor profile page, medlink.website/dr/{slug}, after the owner's design (medlink-DOCTOR_PROFILE.svg,
 * 2026-11-08): photo on a blue band with a wave, name with a verified badge, specialty, stars, "about", a call button,
 * then the links as tiles, and the KHATIB footer. Arabic, right to left, like the design. Everything shown comes from
 * the company; the page reads it from the API and has no other data.
 */
const API: string = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';

type LinkKind = 'instagram' | 'whatsapp' | 'facebook' | 'linkedin' | 'telegram' | 'tiktok' | 'x' | 'youtube' | 'website' | 'maps';
type Profile = {
  slug: string; name: string; specialty: string | null; about: string | null; phone: string | null; verified: boolean;
  rating: number | null; links: { kind: LinkKind; url: string }[]; shamcash: string | null; photo: string | null;
};
type View = { kind: 'loading' } | { kind: 'ok'; p: Profile } | { kind: 'notFound' } | { kind: 'error' };

const BLUE = '#092faa', SKY = '#22b8f0';

export const doctorSlugFromPath = (path: string): string | null => {
  const m = /^\/dr\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/?$/.exec(path);
  return m ? m[1] : null;
};

const LABELS: Record<LinkKind | 'shamcash', string> = {
  instagram: 'إنستغرام', whatsapp: 'واتساب', facebook: 'فيسبوك', linkedin: 'لينكد إن', telegram: 'تيليغرام', tiktok: 'تيك توك',
  x: 'X', youtube: 'يوتيوب', website: 'الموقع', maps: 'الموقع على الخريطة', shamcash: 'شام كاش',
};

export function DoctorPage({ slug }: { slug: string }) {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [cash, setCash] = useState(false);

  useEffect(() => {
    document.documentElement.lang = 'ar';
    document.documentElement.dir = 'rtl';
    let alive = true;
    fetch(API + '/public/doctors/' + slug, { credentials: 'omit' })
      .then(async r => {
        if (!alive) return;
        if (r.status === 404) setView({ kind: 'notFound' });
        else if (!r.ok) setView({ kind: 'error' });
        else setView({ kind: 'ok', p: (await r.json()) as Profile });
      })
      .catch(() => alive && setView({ kind: 'error' }));
    return () => { alive = false; };
  }, [slug]);

  useEffect(() => {
    document.title = view.kind === 'ok' ? view.p.name + ' — MEDLINK' : 'MEDLINK';
  }, [view]);

  return (
    <div className="drp">
      <div className="drp-col">
        <header className="drp-head" dir="ltr">
          <img src="/assets/medlink-logo.svg" alt="MEDLINK — Smart Hospital Appointment System" />
        </header>
        {view.kind === 'loading' && <div className="drp-band drp-band-empty" aria-busy="true" />}
        {(view.kind === 'notFound' || view.kind === 'error') && (
          <main className="drp-body" style={{ paddingTop: 48 }}>
            <h1 className="drp-name" style={{ justifyContent: 'center' }}>{view.kind === 'notFound' ? 'هذه الصفحة غير موجودة' : 'تعذّر تحميل الصفحة'}</h1>
            <p className="drp-about">{view.kind === 'notFound' ? 'تحقق من الرابط، أو تواصل مع العيادة مباشرة.' : 'تحقق من اتصالك بالإنترنت ثم أعد المحاولة.'}</p>
            {view.kind === 'error' && <button type="button" className="drp-call" onClick={() => window.location.reload()}>إعادة المحاولة</button>}
          </main>
        )}
        {view.kind === 'ok' && <Profile p={view.p} onCash={() => setCash(true)} />}
        <footer className="drp-foot" dir="ltr">
          <img src="/assets/khatib-logo.svg" alt="KHATIB" />
          <span>POWERED BY KHATIB TECHNICAL SOLUTIONS</span>
        </footer>
      </div>
      {cash && view.kind === 'ok' && view.p.shamcash && <CashSheet code={view.p.shamcash} onClose={() => setCash(false)} />}
    </div>
  );
}

function Profile({ p, onCash }: { p: Profile; onCash: () => void }) {
  const tiles = [...p.links.map(l => ({ key: l.kind + l.url, kind: l.kind as LinkKind | 'shamcash', href: l.url as string | null })),
    ...(p.shamcash ? [{ key: 'shamcash', kind: 'shamcash' as const, href: null }] : [])];
  return (
    <>
      <div className="drp-band">
        {p.photo && <img className="drp-photo" src={API + p.photo} alt={p.name} />}
        <svg className="drp-wave" viewBox="0 0 1080 200" preserveAspectRatio="none" aria-hidden="true">
          <path d="M0 40 C 220 150, 420 150, 620 100 S 960 30, 1080 70 L1080 200 L0 200 Z" fill="#0aa0e8" opacity=".55" />
          <path d="M0 95 C 250 190, 470 175, 640 120 S 940 60, 1080 110 L1080 200 L0 200 Z" fill="#f4f4f4" />
        </svg>
      </div>
      <main className="drp-body">
        <h1 className="drp-name">
          <span>{p.name}</span>
          {p.verified && (
            <svg className="drp-check" viewBox="0 0 48 48" role="img" aria-label="موثّق">
              <circle cx="24" cy="24" r="24" fill="#5fd38d" /><path d="M14 25l7 7 13-14" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </h1>
        {p.specialty && <div className="drp-spec">{p.specialty}</div>}
        {p.rating !== null && <Stars value={p.rating} />}
        {p.about && (
          <section className="drp-section">
            <h2 className="drp-h2" style={{ textAlign: 'center' }}>عن {p.name}</h2>
            <p className="drp-about">{p.about}</p>
          </section>
        )}
        {p.phone && <a className="drp-call" href={'tel:' + p.phone}>اتصل الآن</a>}
        {tiles.length > 0 && (
          <section className="drp-section">
            <h2 className="drp-h2">الروابط</h2>
            <div className="drp-tiles">
              {tiles.map(t => t.href
                ? <a key={t.key} className="drp-tile" href={t.href} target="_blank" rel="noopener noreferrer nofollow"><Icon kind={t.kind} /><span>{LABELS[t.kind]}</span></a>
                : <button key={t.key} type="button" className="drp-tile" onClick={onCash}><Icon kind={t.kind} /><span>{LABELS[t.kind]}</span></button>)}
            </div>
          </section>
        )}
      </main>
    </>
  );
}

function Stars({ value }: { value: number }) {
  return (
    <div className="drp-stars" role="img" aria-label={`التقييم ${value} من 5`}>
      {[1, 2, 3, 4, 5].map(i => {
        const fill = value >= i ? 1 : value >= i - 0.5 ? 0.5 : 0;
        return (
          <svg key={i} viewBox="0 0 24 24" aria-hidden="true">
            <defs>
              <linearGradient id={'drs' + i} x1="0" x2="1">
                {/* Stars fill from the right in a right-to-left page. */}
                <stop offset={1 - fill} stopColor="#cfd8e6" /><stop offset={1 - fill} stopColor={SKY} />
              </linearGradient>
            </defs>
            <path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6L2.5 9.4l6.6-.8z" fill={`url(#drs${i})`} />
          </svg>
        );
      })}
    </div>
  );
}

function CashSheet({ code, onClose }: { code: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="drp-scrim" onClick={onClose}>
      <div className="drp-sheet" role="dialog" aria-modal="true" aria-label="شام كاش" onClick={e => e.stopPropagation()}>
        <Icon kind="shamcash" />
        <h2 className="drp-h2" style={{ textAlign: 'center' }}>شام كاش</h2>
        <p className="drp-note">رقم الحساب للتحويل. انسخه والصقه في تطبيق شام كاش.</p>
        <div className="drp-code" dir="ltr">{code}</div>
        <button type="button" className="drp-call" onClick={() => {
          navigator.clipboard?.writeText(code).then(() => setCopied(true)).catch(() => undefined);
        }}>{copied ? 'تم النسخ ✓' : 'نسخ رقم الحساب'}</button>
        <button type="button" className="drp-close" onClick={onClose}>إغلاق</button>
      </div>
    </div>
  );
}

/** Simple line icons in the design's blue. Brand marks are drawn as plain shapes, not copied logos. */
function Icon({ kind }: { kind: LinkKind | 'shamcash' }) {
  const s = { fill: 'none', stroke: BLUE, strokeWidth: 2.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const f = { fill: BLUE };
  const body = (() => {
    switch (kind) {
      case 'instagram': return <><rect x="3" y="3" width="18" height="18" rx="5" {...s} /><circle cx="12" cy="12" r="4.2" {...s} /><circle cx="17.3" cy="6.7" r="1.2" {...f} /></>;
      case 'whatsapp': return <><path d="M4 20l1.3-4A8.5 8.5 0 1 1 8.4 19z" {...s} /><path d="M9 8.6c0 3.2 3 6.3 6.3 6.4l1.2-1.6-2-1-.9.8a5 5 0 0 1-2.3-2.3l.8-.9-1-2z" {...f} /></>;
      case 'facebook': return <path d="M14 21v-7.5h2.6l.4-3H14V8.6c0-.9.3-1.5 1.6-1.5H17V4.4A19 19 0 0 0 14.8 4.3C12.6 4.3 11 5.6 11 8.1v2.4H8.5v3H11V21z" {...f} />;
      case 'linkedin': return <><rect x="4" y="9.5" width="3.4" height="10.5" rx=".6" {...f} /><circle cx="5.7" cy="5.6" r="2" {...f} /><path d="M10 9.5h3.2v1.6c.7-1.1 1.9-1.9 3.6-1.9 2.6 0 3.6 1.7 3.6 4.4V20H17v-5.7c0-1.4-.4-2.4-1.7-2.4s-1.9 1-1.9 2.4V20H10z" {...f} /></>;
      case 'telegram': return <path d="M3.5 11.4l16-6.2c.8-.3 1.5.2 1.2 1.4l-2.7 12.8c-.2.9-.8 1.1-1.5.7l-4.2-3.1-2 2c-.2.2-.4.4-.9.4l.3-4.3 7.8-7c.3-.3-.1-.5-.5-.2l-9.6 6-4.1-1.3c-.9-.3-.9-.9.2-1.2z" {...f} />;
      case 'tiktok': return <path d="M14.5 3h3c.2 2 1.6 3.6 3.5 3.8v3a7 7 0 0 1-3.5-1.1v6.1A5.8 5.8 0 1 1 11.7 9v3.1a2.8 2.8 0 1 0 2.8 2.8z" {...f} />;
      case 'x': return <path d="M4 4h4.6l3.8 5.3L17 4h2.6l-5.9 6.9L20.5 20h-4.6l-4.1-5.7L6.9 20H4.3l6.3-7.3z" {...f} />;
      case 'youtube': return <><rect x="2.5" y="5.5" width="19" height="13" rx="4" {...f} /><path d="M10 9v6l5.2-3z" fill="#fff" /></>;
      case 'website': return <><circle cx="12" cy="12" r="9" {...s} /><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9S14.6 18.4 12 21c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z" {...s} /></>;
      case 'maps': return <><path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z" {...s} /><circle cx="12" cy="10" r="2.4" {...f} /></>;
      case 'shamcash': return <><rect x="3" y="6" width="18" height="13" rx="3" {...s} /><path d="M3 10h18" {...s} /><rect x="14" y="13" width="4.5" height="3" rx="1" {...f} /></>;
    }
  })();
  return <svg className="drp-icon" viewBox="0 0 24 24" aria-hidden="true">{body}</svg>;
}
