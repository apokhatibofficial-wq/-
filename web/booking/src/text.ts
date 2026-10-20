/** Booking-site copy. Header, footer and department strings are verbatim from designs/Patient Booking.dc.html. */
export const B = {
  ar: {
    logoSlot: 'شعار المستشفى', bookTitle: 'حجز موعد', powered: 'مدعوم من',
    s1Title: 'اختر القسم', s1Sub: 'تظهر فقط الأقسام التي تقبل الحجز الإلكتروني حاليًا.',
    privacy: 'نجمع فقط ما يحتاجه المستشفى لجدولة زيارتك. لا تُدخل أي معلومات طبية.',
    loading: 'جارٍ التحميل…',
    soonTitle: 'الحجز الإلكتروني يفتح قريبًا', soonBody: 'هذا هو رابط الحجز الرسمي للمستشفى. سيكون اختيار الموعد متاحًا هنا قريبًا.',
    noDepts: 'لا توجد أقسام متاحة للحجز حاليًا.',
    notAcceptingTitle: 'لا يقبل هذا المستشفى الحجوزات حاليًا', notAcceptingBody: 'تواصل مع المستشفى مباشرة لحجز موعد.',
    changedTitle: 'تغيّر هذا الرابط', changedBody: 'لم يعد هذا الرابط مستخدمًا. اطلب من المستشفى رابط الحجز الجديد.',
    notFoundTitle: 'الرابط غير موجود', notFoundBody: 'تحقق من الرابط الذي وصلك من المستشفى.',
    errorTitle: 'تعذّر تحميل الصفحة', errorBody: 'تحقق من اتصالك بالإنترنت ثم حاول مرة أخرى.', retry: 'إعادة المحاولة',
    homeTitle: 'MEDLINK — نظام مواعيد المستشفيات', homeBody: 'افتح رابط الحجز الذي أرسله لك المستشفى.',
  },
  en: {
    logoSlot: 'Hospital logo', bookTitle: 'Book an appointment', powered: 'Powered by',
    s1Title: 'Choose a department', s1Sub: 'Only departments currently accepting online bookings are shown.',
    privacy: 'We only collect what the hospital needs to schedule your visit. Do not enter medical information.',
    loading: 'Loading…',
    soonTitle: 'Online booking opens soon', soonBody: 'This is the hospital’s official booking link. Choosing a time will be available here soon.',
    noDepts: 'No departments are open for booking right now.',
    notAcceptingTitle: 'This hospital isn’t taking bookings right now', notAcceptingBody: 'Please contact the hospital directly to book.',
    changedTitle: 'This link has changed', changedBody: 'This link is no longer used. Ask the hospital for its new booking link.',
    notFoundTitle: 'Link not found', notFoundBody: 'Check the link the hospital sent you.',
    errorTitle: 'The page couldn’t load', errorBody: 'Check your internet connection and try again.', retry: 'Try again',
    homeTitle: 'MEDLINK — Smart Hospital Appointment System', homeBody: 'Open the booking link your hospital sent you.',
  },
  tr: {
    logoSlot: 'Hastane logosu', bookTitle: 'Randevu al', powered: 'Altyapı:',
    s1Title: 'Bölüm seçin', s1Sub: 'Yalnızca şu anda çevrim içi randevu kabul eden bölümler gösterilir.',
    privacy: 'Yalnızca hastanenin ziyaretinizi planlaması için gereken bilgileri topluyoruz. Tıbbi bilgi girmeyin.',
    loading: 'Yükleniyor…',
    soonTitle: 'Çevrim içi randevu yakında açılıyor', soonBody: 'Bu, hastanenin resmi randevu bağlantısıdır. Saat seçimi yakında burada olacak.',
    noDepts: 'Şu anda randevuya açık bölüm yok.',
    notAcceptingTitle: 'Bu hastane şu anda randevu almıyor', notAcceptingBody: 'Randevu için lütfen hastaneyle doğrudan iletişime geçin.',
    changedTitle: 'Bu bağlantı değişti', changedBody: 'Bu bağlantı artık kullanılmıyor. Hastaneden yeni randevu bağlantısını isteyin.',
    notFoundTitle: 'Bağlantı bulunamadı', notFoundBody: 'Hastanenin size gönderdiği bağlantıyı kontrol edin.',
    errorTitle: 'Sayfa yüklenemedi', errorBody: 'İnternet bağlantınızı kontrol edip tekrar deneyin.', retry: 'Tekrar dene',
    homeTitle: 'MEDLINK — Akıllı Hastane Randevu Sistemi', homeBody: 'Hastanenizin gönderdiği randevu bağlantısını açın.',
  },
};

/** /book/{slug} → slug, or null. Only the slug characters the server accepts. */
export function slugFromPath(path: string): string | null {
  const m = /^\/book\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/?$/.exec(path);
  return m ? m[1] : null;
}
