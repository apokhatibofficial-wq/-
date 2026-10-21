import { T } from './consoleText.ts';
export { A, LANGS, LANG_TAG, LANG_PILL, loadLang, saveLang, type Lang, type AuthText } from '@medlink/shared/text';
import type { Lang } from '@medlink/shared/text';

export { T };
export type ConsoleText = (typeof T)['en'];



/** The permission matrix shown on the Roles tab (mirrors api/src/MedLink.Api/Auth/Permissions.cs). */
export type Mark = 'Y' | 'N' | 'O';
export const ROLE_LABELS: Record<Lang, [string[], string[]]> = {
  ar: [['مالك', 'دعم', 'مشاهد'], ['مدير المستشفى', 'استقبال', 'ماسح QR', 'طبيب']],
  en: [['Owner', 'Support', 'Viewer'], ['Hospital admin', 'Reception', 'QR scanner', 'Doctor']],
  tr: [['Sahip', 'Destek', 'İzleyici'], ['Hastane yöneticisi', 'Kayıt birimi', 'QR tarayıcı', 'Doktor']],
};
export const COMPANY_PERMS: Record<Lang, [string, Mark[]][]> = {
  ar: [['إنشاء وتعديل المستشفيات', ['Y', 'N', 'N']], ['إيقاف وإعادة تفعيل', ['Y', 'N', 'N']], ['استعادة وصول المسؤول', ['Y', 'Y', 'N']], ['عرض التقارير', ['Y', 'Y', 'Y']], ['عرض سجل العمليات', ['Y', 'O', 'N']]],
  en: [['Create & edit hospitals', ['Y', 'N', 'N']], ['Suspend & reactivate', ['Y', 'N', 'N']], ['Recover admin access', ['Y', 'Y', 'N']], ['View reports', ['Y', 'Y', 'Y']], ['View audit log', ['Y', 'O', 'N']]],
  tr: [['Hastane oluştur ve düzenle', ['Y', 'N', 'N']], ['Askıya al ve etkinleştir', ['Y', 'N', 'N']], ['Yönetici erişimini kurtar', ['Y', 'Y', 'N']], ['Raporları gör', ['Y', 'Y', 'Y']], ['Denetim kaydını gör', ['Y', 'O', 'N']]],
};
export const HOSPITAL_PERMS: Record<Lang, [string, Mark[]][]> = {
  ar: [['تعديل نموذج الحجز ونشره', ['Y', 'N', 'N', 'N']], ['إعدادات المستشفى ومهلة عدم الحضور', ['Y', 'N', 'N', 'N']], ['عرض الحجوزات والبحث', ['Y', 'Y', 'N', 'N']], ['تسجيل الحضور', ['Y', 'Y', 'Y', 'N']], ['تصحيح حالة الحضور', ['Y', 'Y', 'N', 'N']], ['إدارة مستخدمي المستشفى', ['Y', 'N', 'N', 'N']], ['عرض مواعيد قسمه فقط (بدون الهواتف)', ['N', 'N', 'N', 'Y']]],
  en: [['Edit & publish booking form', ['Y', 'N', 'N', 'N']], ['Hospital settings & no-show grace', ['Y', 'N', 'N', 'N']], ['View & search bookings', ['Y', 'Y', 'N', 'N']], ['Check in patients', ['Y', 'Y', 'Y', 'N']], ['Correct attendance status', ['Y', 'Y', 'N', 'N']], ['Manage hospital users', ['Y', 'N', 'N', 'N']], ['View own department’s appointments only (no phones)', ['N', 'N', 'N', 'Y']]],
  tr: [['Randevu formunu düzenle ve yayınla', ['Y', 'N', 'N', 'N']], ['Hastane ayarları ve bekleme süresi', ['Y', 'N', 'N', 'N']], ['Randevuları gör ve ara', ['Y', 'Y', 'N', 'N']], ['Hasta girişi yap', ['Y', 'Y', 'Y', 'N']], ['Giriş durumunu düzelt', ['Y', 'Y', 'N', 'N']], ['Hastane kullanıcılarını yönet', ['Y', 'N', 'N', 'N']], ['Yalnızca kendi bölümünün randevularını gör (telefonsuz)', ['N', 'N', 'N', 'Y']]],
};

/** Console strings added after the prototype (Team tab, time zone). */
export const C = {
  ar: { system: 'إعدادات النظام', systemSub: 'قيم عامة لكل المستشفيات · يعدّلها المالك',
    defaultTz: 'المنطقة الزمنية الافتراضية للمستشفيات الجديدة', windowDays: 'مدى الحجز المسبق (يوم)', windowNote: 'أبعد موعد يمكن للمريض حجزه.',
    noticeMin: 'أقل مدة قبل الموعد (دقيقة)', noticeNote: 'لا يُعرض موعد يبدأ بعد أقل من هذه المدة.',
    patientCancel: 'السماح للمريض بإلغاء حجزه عبر الإنترنت', patientCancelNote: 'مغلق: الإلغاء عبر الاستقبال فقط.',
    perPhone: 'حد الحجوزات لكل رقم هاتف في اليوم', perPhoneNote: '0 = بلا حد. يبقى حد الطلبات لكل جهاز وشبكة مفعّلًا دائمًا.',
    phase6Note: 'الإلغاء وحد الهاتف يُطبَّقان عند فتح الحجز الإلكتروني (المرحلة 6).',
    saveSystem: 'حفظ الإعدادات', readOnlyOwner: 'للعرض فقط. يعدّل المالك هذه القيم.', invalid: 'تحقق من القيم المدخلة.',
    bookingRules: 'قواعد الحجز لهذا المستشفى', companyValue: (v: number) => 'القيمة العامة: ' + v, useCompany: 'اتركه فارغًا لاستخدام القيمة العامة.',
    saveRules: 'حفظ قواعد الحجز', rulesSaved: 'تم حفظ قواعد الحجز.',
    team: 'الفريق', teamSub: 'موظفو الشركة وصلاحياتهم · للمالك فقط', timezone: 'المنطقة الزمنية',
    timezoneNote: 'تُحسب مواعيد «اليوم» ومهلة عدم الحضور بتوقيت المستشفى.', tzInvalid: 'منطقة زمنية غير معروفة.',
    teamLockedNote: 'لا يمكنك تعديل حسابك. إن فقد المالك الوحيد وصوله، يُستعاد من الخادم بالأمر reset-company-user.' },
  en: { system: 'System settings', systemSub: 'Values for every hospital · edited by the Owner',
    defaultTz: 'Default time zone for new hospitals', windowDays: 'Booking window (days)', windowNote: 'How far ahead a patient can book.',
    noticeMin: 'Minimum notice (minutes)', noticeNote: 'Slots starting sooner than this are not offered.',
    patientCancel: 'Let patients cancel their booking online', patientCancelNote: 'Off: only reception cancels.',
    perPhone: 'Bookings per phone number per day', perPhoneNote: '0 = no limit. The per-device and per-network rate limits always apply.',
    phase6Note: 'Cancellation and the phone limit take effect when online booking opens (phase 6).',
    saveSystem: 'Save settings', readOnlyOwner: 'View only. The Owner edits these values.', invalid: 'Check the values.',
    bookingRules: 'Booking rules for this hospital', companyValue: (v: number) => 'Company value: ' + v, useCompany: 'Leave empty to use the company value.',
    saveRules: 'Save booking rules', rulesSaved: 'Booking rules saved.',
    team: 'Team', teamSub: 'Company staff and their roles · Owner only', timezone: 'Time zone',
    timezoneNote: '“Today” and the no-show grace period use the hospital’s time zone.', tzInvalid: 'Unknown time zone.',
    teamLockedNote: 'You can’t change your own account. If the only Owner loses access, it is recovered on the server with reset-company-user.' },
  tr: { system: 'Sistem ayarları', systemSub: 'Tüm hastaneler için değerler · Sahip düzenler',
    defaultTz: 'Yeni hastaneler için varsayılan saat dilimi', windowDays: 'Randevu aralığı (gün)', windowNote: 'Hastanın en fazla kaç gün sonrasına randevu alabileceği.',
    noticeMin: 'En kısa bildirim süresi (dakika)', noticeNote: 'Bu süreden daha yakın başlayan randevular gösterilmez.',
    patientCancel: 'Hastaların randevularını çevrim içi iptal etmesine izin ver', patientCancelNote: 'Kapalı: yalnızca kayıt birimi iptal eder.',
    perPhone: 'Telefon numarası başına günlük randevu', perPhoneNote: '0 = sınır yok. Cihaz ve ağ başına istek sınırları her zaman geçerlidir.',
    phase6Note: 'İptal ve telefon sınırı çevrim içi randevu açıldığında geçerli olur (aşama 6).',
    saveSystem: 'Ayarları kaydet', readOnlyOwner: 'Yalnızca görüntüleme. Bu değerleri Sahip düzenler.', invalid: 'Değerleri kontrol edin.',
    bookingRules: 'Bu hastanenin randevu kuralları', companyValue: (v: number) => 'Şirket değeri: ' + v, useCompany: 'Şirket değerini kullanmak için boş bırakın.',
    saveRules: 'Randevu kurallarını kaydet', rulesSaved: 'Randevu kuralları kaydedildi.',
    team: 'Ekip', teamSub: 'Şirket personeli ve rolleri · Yalnızca Sahip', timezone: 'Saat dilimi',
    timezoneNote: '“Bugün” ve gelmeme süresi hastanenin saat dilimine göre hesaplanır.', tzInvalid: 'Bilinmeyen saat dilimi.',
    teamLockedNote: 'Kendi hesabınızı değiştiremezsiniz. Tek Sahip erişimini kaybederse sunucuda reset-company-user ile kurtarılır.' },
};
