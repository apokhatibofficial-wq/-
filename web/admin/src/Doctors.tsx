import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@medlink/shared/api';
import { cleanSlugInput, SLUG_RE } from '@medlink/shared/slug';
import type { Lang } from './i18n';

/**
 * Doctor profile pages (medlink.website/dr/{slug}): a company product, written only by the company; doctors have no
 * account (owner's decision, 2026-11-08). The Owner edits; Support and Viewer can look.
 */
const API_BASE: string = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';
const PAGE_BASE = 'medlink.website/dr/';
const MAX_PHOTO = 400 * 1024;

export const LINK_KINDS = ['instagram', 'whatsapp', 'facebook', 'linkedin', 'telegram', 'tiktok', 'x', 'youtube', 'website', 'maps'] as const;
type LinkKind = typeof LINK_KINDS[number];
type DocLink = { kind: LinkKind; url: string };

export type Doctor = {
  id: string; slug: string; name: string; specialty: string | null; about: string | null; phone: string | null;
  verified: boolean; rating: number | null; links: DocLink[]; shamcash: string | null; published: boolean;
  hasPhoto: boolean; photoRev: number; createdAt: string; updatedAt: string;
};

const LINK_NAMES: Record<LinkKind, string> = {
  instagram: 'Instagram', whatsapp: 'WhatsApp', facebook: 'Facebook', linkedin: 'LinkedIn', telegram: 'Telegram',
  tiktok: 'TikTok', x: 'X', youtube: 'YouTube', website: 'Website', maps: 'Google Maps',
};

export const D = {
  ar: {
    tab: 'الأطباء', sub: 'صفحات تعريف الأطباء على medlink.website/dr · يكتبها المالك',
    add: 'طبيب جديد', empty: 'لا توجد صفحات أطباء بعد.', cDoctor: 'الطبيب', cLink: 'رابط الصفحة', cStatus: 'الحالة',
    published: 'منشورة', draft: 'غير منشورة', verifiedChip: 'موثّق', copy: 'نسخ', copied: 'تم النسخ',
    newTitle: 'صفحة طبيب جديدة', editTitle: 'تعديل صفحة الطبيب', readOnly: 'للعرض فقط. يعدّل المالك صفحات الأطباء.',
    name: 'الاسم كما يظهر', namePh: 'الدكتور أحمد خطيب', slug: 'رابط الصفحة', slugNote: 'أحرف إنجليزية صغيرة وأرقام وشرطات (3–40).',
    specialty: 'الاختصاص', specialtyPh: 'اختصاصي علوم مخبرية طبية', about: 'نبذة عن الطبيب', phone: 'رقم الاتصال (زر «اتصل الآن»)',
    phoneNote: 'مثال: +963944000000. اتركه فارغًا لإخفاء الزر.', verified: 'إظهار علامة التوثيق ✓',
    rating: 'التقييم (النجوم)', noRating: 'بدون نجوم', ratingNote: 'يُحدَّد يدويًا من الشركة.',
    links: 'روابط التواصل', addLink: '+ رابط', remove: 'حذف', urlPh: 'الرابط، أو رقم الهاتف لـ WhatsApp',
    shamcash: 'شام كاش (رقم أو رمز الحساب)', shamcashNote: 'يُعرض للزائر مع زر نسخ. لا يمر أي دفع عبر MEDLINK.',
    publish: 'منشورة للعامة', publishNote: 'غير المنشورة لا تظهر لأحد غير الشركة.',
    photo: 'صورة الطبيب', choosePhoto: 'اختيار صورة', removePhoto: 'إزالة الصورة', photoNote: 'JPEG أو PNG أو WebP. تُصغَّر تلقائيًا قبل الرفع.',
    photoBad: 'تعذّر قراءة الصورة. جرّب صورة JPEG أو PNG.', photoBig: 'الصورة كبيرة جدًا حتى بعد التصغير.',
    save: 'حفظ', saving: 'جارٍ الحفظ…', saved: 'تم الحفظ.', cancel: 'إغلاق', del: 'حذف الصفحة…',
    delConfirm: 'حذف صفحة هذا الطبيب نهائيًا؟ يتوقف الرابط فورًا.', open: 'فتح الصفحة',
    errors: {
      SLUG_INVALID: 'رابط غير صالح: أحرف إنجليزية صغيرة وأرقام وشرطات (3–40).', SLUG_TAKEN: 'هذا الرابط مستخدم لطبيب آخر.',
      NAME_REQUIRED: 'الاسم مطلوب (حتى 120 حرفًا).', PHONE_INVALID: 'رقم الاتصال غير صالح.', RATING_INVALID: 'التقييم غير صالح.',
      LINK_INVALID: 'أحد الروابط غير صالح. يجب أن يبدأ بـ https://.', ABOUT_INVALID: 'النبذة طويلة جدًا (حتى 3000 حرف).',
      SPECIALTY_INVALID: 'الاختصاص طويل جدًا.', SHAMCASH_INVALID: 'رقم شام كاش طويل جدًا.', PHOTO_INVALID: 'الصورة غير مقبولة.',
    } as Record<string, string>,
    generic: 'حدث خطأ غير متوقع.', network: 'لا يوجد اتصال بالخادم.', loading: 'جارٍ التحميل…',
  },
  en: {
    tab: 'Doctors', sub: 'Doctor profile pages at medlink.website/dr · written by the Owner',
    add: 'New doctor', empty: 'No doctor pages yet.', cDoctor: 'Doctor', cLink: 'Page link', cStatus: 'Status',
    published: 'Published', draft: 'Not published', verifiedChip: 'Verified', copy: 'Copy', copied: 'Copied',
    newTitle: 'New doctor page', editTitle: 'Edit doctor page', readOnly: 'View only. The Owner edits doctor pages.',
    name: 'Display name', namePh: 'Dr. Ahmad Khatib', slug: 'Page link', slugNote: 'Lowercase letters, numbers and hyphens (3–40).',
    specialty: 'Specialty', specialtyPh: 'Medical laboratory scientist', about: 'About the doctor', phone: 'Phone (the “Call now” button)',
    phoneNote: 'For example +963944000000. Leave empty to hide the button.', verified: 'Show the verified badge ✓',
    rating: 'Rating (stars)', noRating: 'No stars', ratingNote: 'Set by the company.',
    links: 'Links', addLink: '+ Link', remove: 'Remove', urlPh: 'Link, or the phone number for WhatsApp',
    shamcash: 'ShamCash (account number or code)', shamcashNote: 'Shown to visitors with a copy button. No payment goes through MEDLINK.',
    publish: 'Published', publishNote: 'Unpublished pages are visible to the company only.',
    photo: 'Doctor photo', choosePhoto: 'Choose photo', removePhoto: 'Remove photo', photoNote: 'JPEG, PNG or WebP. Resized before upload.',
    photoBad: 'The photo could not be read. Try a JPEG or PNG.', photoBig: 'The photo is still too large after resizing.',
    save: 'Save', saving: 'Saving…', saved: 'Saved.', cancel: 'Close', del: 'Delete page…',
    delConfirm: 'Delete this doctor page for good? The link stops working at once.', open: 'Open page',
    errors: {
      SLUG_INVALID: 'Invalid link: lowercase letters, numbers and hyphens (3–40).', SLUG_TAKEN: 'Another doctor uses this link.',
      NAME_REQUIRED: 'The name is required (up to 120 characters).', PHONE_INVALID: 'Invalid phone number.', RATING_INVALID: 'Invalid rating.',
      LINK_INVALID: 'One of the links is invalid. It must start with https://.', ABOUT_INVALID: 'The text is too long (up to 3000 characters).',
      SPECIALTY_INVALID: 'The specialty is too long.', SHAMCASH_INVALID: 'The ShamCash number is too long.', PHOTO_INVALID: 'The photo was refused.',
    } as Record<string, string>,
    generic: 'Something went wrong.', network: 'No connection to the server.', loading: 'Loading…',
  },
  tr: {
    tab: 'Doktorlar', sub: 'medlink.website/dr adresindeki doktor sayfaları · Sahip yazar',
    add: 'Yeni doktor', empty: 'Henüz doktor sayfası yok.', cDoctor: 'Doktor', cLink: 'Sayfa bağlantısı', cStatus: 'Durum',
    published: 'Yayında', draft: 'Yayında değil', verifiedChip: 'Doğrulanmış', copy: 'Kopyala', copied: 'Kopyalandı',
    newTitle: 'Yeni doktor sayfası', editTitle: 'Doktor sayfasını düzenle', readOnly: 'Yalnızca görüntüleme. Doktor sayfalarını Sahip düzenler.',
    name: 'Görünen ad', namePh: 'Dr. Ahmad Khatib', slug: 'Sayfa bağlantısı', slugNote: 'Küçük harf, rakam ve tire (3–40).',
    specialty: 'Uzmanlık', specialtyPh: 'Tıbbi laboratuvar uzmanı', about: 'Doktor hakkında', phone: 'Telefon (“Şimdi ara” düğmesi)',
    phoneNote: 'Örneğin +963944000000. Düğmeyi gizlemek için boş bırakın.', verified: 'Doğrulama rozetini göster ✓',
    rating: 'Puan (yıldız)', noRating: 'Yıldız yok', ratingNote: 'Şirket belirler.',
    links: 'Bağlantılar', addLink: '+ Bağlantı', remove: 'Kaldır', urlPh: 'Bağlantı veya WhatsApp için telefon numarası',
    shamcash: 'ShamCash (hesap numarası veya kodu)', shamcashNote: 'Ziyaretçiye kopyala düğmesiyle gösterilir. MEDLINK üzerinden ödeme yapılmaz.',
    publish: 'Yayında', publishNote: 'Yayında olmayan sayfaları yalnızca şirket görür.',
    photo: 'Doktor fotoğrafı', choosePhoto: 'Fotoğraf seç', removePhoto: 'Fotoğrafı kaldır', photoNote: 'JPEG, PNG veya WebP. Yüklemeden önce küçültülür.',
    photoBad: 'Fotoğraf okunamadı. JPEG veya PNG deneyin.', photoBig: 'Fotoğraf küçültüldükten sonra da çok büyük.',
    save: 'Kaydet', saving: 'Kaydediliyor…', saved: 'Kaydedildi.', cancel: 'Kapat', del: 'Sayfayı sil…',
    delConfirm: 'Bu doktor sayfası kalıcı olarak silinsin mi? Bağlantı hemen çalışmaz olur.', open: 'Sayfayı aç',
    errors: {
      SLUG_INVALID: 'Geçersiz bağlantı: küçük harf, rakam ve tire (3–40).', SLUG_TAKEN: 'Bu bağlantıyı başka bir doktor kullanıyor.',
      NAME_REQUIRED: 'Ad gerekli (en fazla 120 karakter).', PHONE_INVALID: 'Geçersiz telefon numarası.', RATING_INVALID: 'Geçersiz puan.',
      LINK_INVALID: 'Bağlantılardan biri geçersiz. https:// ile başlamalı.', ABOUT_INVALID: 'Metin çok uzun (en fazla 3000 karakter).',
      SPECIALTY_INVALID: 'Uzmanlık çok uzun.', SHAMCASH_INVALID: 'ShamCash numarası çok uzun.', PHOTO_INVALID: 'Fotoğraf kabul edilmedi.',
    } as Record<string, string>,
    generic: 'Beklenmeyen bir hata oluştu.', network: 'Sunucuya bağlantı yok.', loading: 'Yükleniyor…',
  },
};

type Form = {
  name: string; slug: string; specialty: string; about: string; phone: string; verified: boolean; rating: string;
  links: { kind: LinkKind; url: string }[]; shamcash: string; published: boolean;
};

const emptyForm: Form = { name: '', slug: '', specialty: '', about: '', phone: '', verified: false, rating: '', links: [], shamcash: '', published: false };
const toForm = (d: Doctor): Form => ({
  name: d.name, slug: d.slug, specialty: d.specialty ?? '', about: d.about ?? '', phone: d.phone ?? '', verified: d.verified,
  rating: d.rating === null ? '' : String(d.rating), links: d.links.map(l => ({ ...l })), shamcash: d.shamcash ?? '', published: d.published,
});
const toBody = (f: Form) => ({
  name: f.name, slug: f.slug, specialty: f.specialty || null, about: f.about || null, phone: f.phone || null, verified: f.verified,
  rating: f.rating === '' ? null : Number(f.rating), links: f.links.filter(l => l.url.trim() !== ''), shamcash: f.shamcash || null, published: f.published,
});

/** Resizes to at most 900 px on the long side and re-encodes as JPEG, lowering quality until it fits the server's limit. */
export async function preparePhoto(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 900 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff'; // transparent PNGs get a white background, not black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const q of [0.86, 0.78, 0.68, 0.56, 0.45]) {
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size <= MAX_PHOTO) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return btoa(s);
    }
  }
  throw new Error('too-big');
}

/** The console reads a photo through the API (signed in), so an unpublished page's photo shows too. */
function usePhotoUrl(id: string | null, rev: number, has: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!id || !has) { setUrl(null); return; }
    let alive = true, made: string | null = null;
    fetch(API_BASE + '/admin/doctors/' + encodeURIComponent(id) + '/photo', { credentials: 'include' })
      .then(r => (r.ok ? r.blob() : null))
      .then(b => { if (alive && b) { made = URL.createObjectURL(b); setUrl(made); } })
      .catch(() => undefined);
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [id, rev, has]);
  return url;
}

export function DoctorsTab({ L, canEdit, flash, creating, onCreateDone }: {
  L: Lang; canEdit: boolean; flash: (s: string) => void; creating: boolean; onCreateDone: () => void;
}) {
  const t = D[L];
  const [list, setList] = useState<Doctor[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Doctor | 'new' | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(() => {
    setFailed(false);
    api<{ doctors: Doctor[] }>('GET', '/admin/doctors').then(r => setList(r.doctors)).catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);
  useEffect(() => { if (creating) { setOpen('new'); onCreateDone(); } }, [creating, onCreateDone]);

  return (
    <>
      <div className="card table">
        <div className="trow thead cols-doc" role="row">
          <span>{t.cDoctor}</span><span>{t.cLink}</span><span>{t.cStatus}</span>
        </div>
        {list === null && !failed && <div className="empty">{t.loading}</div>}
        {failed && <div className="empty">{t.generic} <button className="btn-link" onClick={load}>↻</button></div>}
        {list?.map(d => (
          <div key={d.id} role="button" tabIndex={0} className="trow cols-doc clickable" onClick={() => setOpen(d)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(d); } }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <Thumb doctor={d} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <span className="ellipsis" style={{ fontSize: 14, fontWeight: 600 }}>{d.name}</span>
                <span className="ellipsis" style={{ fontSize: 12, color: 'var(--muted)' }}>{d.specialty ?? ''}</span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span dir="ltr" className="ellipsis" style={{ fontSize: 13, color: 'var(--brand-deep)' }}>/dr/{d.slug}</span>
              <button type="button" className="copy-btn" onClick={e => {
                e.stopPropagation();
                navigator.clipboard?.writeText('https://' + PAGE_BASE + d.slug).catch(() => undefined);
                setCopied(d.id);
                setTimeout(() => setCopied(c => (c === d.id ? null : c)), 1500);
              }}>{copied === d.id ? t.copied : t.copy}</button>
            </div>
            <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span className="chip" style={d.published ? { background: '#e3f6ec', color: '#0f7a43' } : { background: '#eef0f6', color: '#5b6380' }}>{d.published ? t.published : t.draft}</span>
              {d.verified && <span className="chip" style={{ background: '#e8f0ff', color: '#1a3fb0' }}>✓ {t.verifiedChip}</span>}
            </span>
          </div>
        ))}
        {list !== null && list.length === 0 && <div className="empty">{t.empty}</div>}
      </div>
      {open !== null && (
        <Editor L={L} doctor={open === 'new' ? null : open} canEdit={canEdit}
          onClose={() => setOpen(null)}
          onSaved={(d, msg) => { flash(msg); load(); setOpen(d); }}
          onDeleted={() => { setOpen(null); load(); }} />
      )}
    </>
  );
}

function Thumb({ doctor }: { doctor: Doctor }) {
  const url = usePhotoUrl(doctor.id, doctor.photoRev, doctor.hasPhoto);
  return (
    <div aria-hidden="true" style={{ width: 40, height: 40, borderRadius: 20, flexShrink: 0, overflow: 'hidden', background: '#e6ecfb', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#1a3fb0', fontWeight: 700 }}>
      {url ? <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : (doctor.name.replace(/^(الدكتور|الدكتورة|د\.|Dr\.?)\s*/i, '').trim()[0] ?? '?')}
    </div>
  );
}

function Editor({ L, doctor, canEdit, onClose, onSaved, onDeleted }: {
  L: Lang; doctor: Doctor | null; canEdit: boolean; onClose: () => void; onSaved: (d: Doctor, msg: string) => void; onDeleted: () => void;
}) {
  const t = D[L];
  const [f, setF] = useState<Form>(doctor ? toForm(doctor) : emptyForm);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ data: string; preview: string } | null>(null);
  const current = usePhotoUrl(doctor?.id ?? null, doctor?.photoRev ?? 0, doctor?.hasPhoto ?? false);
  useEffect(() => { setF(doctor ? toForm(doctor) : emptyForm); setPending(null); setErr(''); }, [doctor]);
  useEffect(() => () => { if (pending) URL.revokeObjectURL(pending.preview); }, [pending]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF(x => ({ ...x, [k]: v }));
  const slugOk = SLUG_RE.test(f.slug) && !f.slug.includes('--');
  const valid = f.name.trim() !== '' && slugOk;
  const ro = !canEdit;
  const errorText = (e: unknown) => e instanceof ApiError ? (t.errors[e.code] ?? (e.code === 'NETWORK' ? t.network : t.generic)) : t.generic;

  async function pick(file: File | undefined) {
    if (!file) return;
    setErr('');
    try {
      const data = await preparePhoto(file);
      const bin = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      setPending({ data, preview: URL.createObjectURL(new Blob([bin], { type: 'image/jpeg' })) });
    } catch (e) {
      setErr((e as Error)?.message === 'too-big' ? t.photoBig : t.photoBad);
    }
  }

  async function save() {
    setBusy(true); setErr('');
    try {
      const r = doctor
        ? await api<{ doctor: Doctor }>('PATCH', '/admin/doctors/' + encodeURIComponent(doctor.id), toBody(f))
        : await api<{ doctor: Doctor }>('POST', '/admin/doctors', toBody(f));
      let d = r.doctor;
      if (pending) {
        const p = await api<{ photoRev: number }>('PUT', '/admin/doctors/' + encodeURIComponent(d.id) + '/photo', { data: pending.data });
        d = { ...d, hasPhoto: true, photoRev: p.photoRev };
        setPending(null);
      }
      onSaved(d, t.saved);
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  }

  async function removePhoto() {
    if (!doctor) { setPending(null); return; }
    setBusy(true); setErr('');
    try {
      const p = await api<{ photoRev: number }>('DELETE', '/admin/doctors/' + encodeURIComponent(doctor.id) + '/photo', {});
      onSaved({ ...doctor, hasPhoto: false, photoRev: p.photoRev }, t.saved);
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  }

  async function del() {
    if (!doctor || !window.confirm(t.delConfirm)) return;
    setBusy(true); setErr('');
    try { await api('DELETE', '/admin/doctors/' + encodeURIComponent(doctor.id)); onDeleted(); }
    catch (e) { setErr(errorText(e)); setBusy(false); }
  }

  const photo = pending?.preview ?? current;
  return (
    <div className="scrim" onClick={onClose}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label={doctor ? t.editTitle : t.newTitle} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <div style={{ flex: 1, fontSize: 19, fontWeight: 600, color: 'var(--ink)' }}>{doctor ? t.editTitle : t.newTitle}</div>
          <button type="button" className="icon-btn" aria-label={t.cancel} onClick={onClose}>×</button>
        </div>
        {ro && <div className="alert alert-warn">{t.readOnly}</div>}

        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <div style={{ width: 88, height: 88, borderRadius: 16, overflow: 'hidden', background: '#e6ecfb', flexShrink: 0 }}>
            {photo && <img src={photo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 14, fontWeight: 500 }}>{t.photo}</span>
            {!ro && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <label className="btn btn-secondary" style={{ cursor: 'pointer' }}>
                  {t.choosePhoto}
                  <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={e => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
                </label>
                {photo && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void removePhoto()}>{t.removePhoto}</button>}
              </div>
            )}
            <span className="note">{t.photoNote}</span>
          </div>
        </div>

        <label className="field"><span>{t.name}</span>
          <input className="input" value={f.name} readOnly={ro} maxLength={120} placeholder={t.namePh} onChange={e => set('name', e.target.value)} />
        </label>
        <label className="field"><span>{t.slug}</span>
          <div className={'slug-input' + (f.slug !== '' && !slugOk ? ' bad' : '')} dir="ltr">
            <span>{PAGE_BASE}</span>
            <input value={f.slug} readOnly={ro} maxLength={40} onChange={e => set('slug', cleanSlugInput(e.target.value))} aria-invalid={f.slug !== '' && !slugOk} />
          </div>
          <span className="note" style={{ fontWeight: 400 }}>{t.slugNote}</span>
        </label>
        <label className="field"><span>{t.specialty}</span>
          <input className="input" value={f.specialty} readOnly={ro} maxLength={160} placeholder={t.specialtyPh} onChange={e => set('specialty', e.target.value)} />
        </label>
        <label className="field"><span>{t.about}</span>
          <textarea className="input" rows={5} value={f.about} readOnly={ro} maxLength={3000} onChange={e => set('about', e.target.value)} style={{ resize: 'vertical', minHeight: 110 }} />
        </label>
        <div className="grid-2">
          <label className="field"><span>{t.phone}</span>
            <input className="input" dir="ltr" inputMode="tel" value={f.phone} readOnly={ro} maxLength={24} onChange={e => set('phone', e.target.value)} />
            <span className="note" style={{ fontWeight: 400 }}>{t.phoneNote}</span>
          </label>
          <label className="field"><span>{t.rating}</span>
            <select className="input" value={f.rating} disabled={ro} onChange={e => set('rating', e.target.value)}>
              <option value="">{t.noRating}</option>
              {[5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1].map(v => <option key={v} value={String(v)}>{'★'.repeat(Math.floor(v))}{v % 1 ? '½' : ''} ({v})</option>)}
            </select>
            <span className="note" style={{ fontWeight: 400 }}>{t.ratingNote}</span>
          </label>
        </div>

        <div className="field"><span>{t.links}</span>
          {f.links.map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: 8 }}>
              <select className="input" style={{ flex: '0 0 140px' }} value={l.kind} disabled={ro}
                onChange={e => { const k = e.target.value as LinkKind; setF(x => ({ ...x, links: x.links.map((y, j) => (j === i ? { ...y, kind: k } : y)) })); }}>
                {LINK_KINDS.map(k => <option key={k} value={k}>{LINK_NAMES[k]}</option>)}
              </select>
              <input className="input" dir="ltr" style={{ flex: 1, minWidth: 0 }} value={l.url} readOnly={ro} maxLength={500} placeholder={t.urlPh}
                onChange={e => { const v = e.target.value; setF(x => ({ ...x, links: x.links.map((y, j) => (j === i ? { ...y, url: v } : y)) })); }} />
              {!ro && <button type="button" className="btn btn-secondary" onClick={() => setF(x => ({ ...x, links: x.links.filter((_, j) => j !== i) }))}>{t.remove}</button>}
            </div>
          ))}
          {!ro && f.links.length < 12 && (
            <button type="button" className="btn-link" style={{ alignSelf: 'flex-start' }}
              onClick={() => setF(x => ({ ...x, links: [...x.links, { kind: LINK_KINDS[x.links.length % LINK_KINDS.length], url: '' }] }))}>{t.addLink}</button>
          )}
        </div>

        <label className="field"><span>{t.shamcash}</span>
          <input className="input" dir="ltr" value={f.shamcash} readOnly={ro} maxLength={100} onChange={e => set('shamcash', e.target.value)} />
          <span className="note" style={{ fontWeight: 400 }}>{t.shamcashNote}</span>
        </label>

        {[['verified', t.verified, null], ['published', t.publish, t.publishNote]].map(([k, label, note]) => (
          <div key={k as string} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <button type="button" role="switch" aria-checked={f[k as 'verified' | 'published']} aria-label={label as string} className="switch" disabled={ro}
              onClick={() => set(k as 'verified' | 'published', !f[k as 'verified' | 'published'])} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 14, fontWeight: 500 }}>{label}</span>
              {note && <span className="note">{note}</span>}
            </div>
          </div>
        ))}

        {err && <div role="alert" className="alert alert-danger">{err}</div>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {!ro && <button type="button" className="btn btn-primary" disabled={!valid || busy} onClick={() => void save()}>{busy ? t.saving : t.save}</button>}
          {doctor?.published && <a className="btn btn-secondary" href={'https://' + PAGE_BASE + doctor.slug} target="_blank" rel="noopener noreferrer">{t.open}</a>}
          <div style={{ flex: 1 }} />
          {!ro && doctor && <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void del()}>{t.del}</button>}
        </div>
      </div>
    </div>
  );
}
