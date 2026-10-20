import { T } from './consoleText.ts';
export { A, LANGS, LANG_TAG, LANG_PILL, loadLang, saveLang, type Lang, type AuthText } from '@medlink/shared/text';
import type { Lang } from '@medlink/shared/text';

export { T };
export type ConsoleText = (typeof T)['en'];



/** The permission matrix shown on the Roles tab (mirrors api/src/MedLink.Api/Auth/Permissions.cs). */
export type Mark = 'Y' | 'N' | 'O';
export const ROLE_LABELS: Record<Lang, [string[], string[]]> = {
  ar: [['مالك', 'دعم', 'مشاهد'], ['مدير المستشفى', 'استقبال', 'ماسح QR']],
  en: [['Owner', 'Support', 'Viewer'], ['Hospital admin', 'Reception', 'QR scanner']],
  tr: [['Sahip', 'Destek', 'İzleyici'], ['Hastane yöneticisi', 'Kayıt birimi', 'QR tarayıcı']],
};
export const COMPANY_PERMS: Record<Lang, [string, Mark[]][]> = {
  ar: [['إنشاء وتعديل المستشفيات', ['Y', 'N', 'N']], ['إيقاف وإعادة تفعيل', ['Y', 'N', 'N']], ['استعادة وصول المسؤول', ['Y', 'Y', 'N']], ['عرض التقارير', ['Y', 'Y', 'Y']], ['عرض سجل العمليات', ['Y', 'O', 'N']]],
  en: [['Create & edit hospitals', ['Y', 'N', 'N']], ['Suspend & reactivate', ['Y', 'N', 'N']], ['Recover admin access', ['Y', 'Y', 'N']], ['View reports', ['Y', 'Y', 'Y']], ['View audit log', ['Y', 'O', 'N']]],
  tr: [['Hastane oluştur ve düzenle', ['Y', 'N', 'N']], ['Askıya al ve etkinleştir', ['Y', 'N', 'N']], ['Yönetici erişimini kurtar', ['Y', 'Y', 'N']], ['Raporları gör', ['Y', 'Y', 'Y']], ['Denetim kaydını gör', ['Y', 'O', 'N']]],
};
export const HOSPITAL_PERMS: Record<Lang, [string, Mark[]][]> = {
  ar: [['تعديل نموذج الحجز ونشره', ['Y', 'N', 'N']], ['إعدادات المستشفى ومهلة عدم الحضور', ['Y', 'N', 'N']], ['عرض الحجوزات والبحث', ['Y', 'Y', 'N']], ['تسجيل الحضور', ['Y', 'Y', 'Y']], ['تصحيح حالة الحضور', ['Y', 'Y', 'N']], ['إدارة مستخدمي المستشفى', ['Y', 'N', 'N']]],
  en: [['Edit & publish booking form', ['Y', 'N', 'N']], ['Hospital settings & no-show grace', ['Y', 'N', 'N']], ['View & search bookings', ['Y', 'Y', 'N']], ['Check in patients', ['Y', 'Y', 'Y']], ['Correct attendance status', ['Y', 'Y', 'N']], ['Manage hospital users', ['Y', 'N', 'N']]],
  tr: [['Randevu formunu düzenle ve yayınla', ['Y', 'N', 'N']], ['Hastane ayarları ve bekleme süresi', ['Y', 'N', 'N']], ['Randevuları gör ve ara', ['Y', 'Y', 'N']], ['Hasta girişi yap', ['Y', 'Y', 'Y']], ['Giriş durumunu düzelt', ['Y', 'Y', 'N']], ['Hastane kullanıcılarını yönet', ['Y', 'N', 'N']]],
};

/** Console strings added after the prototype (Team tab, time zone). */
export const C = {
  ar: { team: 'الفريق', teamSub: 'موظفو الشركة وصلاحياتهم · للمالك فقط', timezone: 'المنطقة الزمنية',
    timezoneNote: 'تُحسب مواعيد «اليوم» ومهلة عدم الحضور بتوقيت المستشفى.', tzInvalid: 'منطقة زمنية غير معروفة.',
    teamLockedNote: 'لا يمكنك تعديل حسابك. إن فقد المالك الوحيد وصوله، يُستعاد من الخادم بالأمر reset-company-user.' },
  en: { team: 'Team', teamSub: 'Company staff and their roles · Owner only', timezone: 'Time zone',
    timezoneNote: '“Today” and the no-show grace period use the hospital’s time zone.', tzInvalid: 'Unknown time zone.',
    teamLockedNote: 'You can’t change your own account. If the only Owner loses access, it is recovered on the server with reset-company-user.' },
  tr: { team: 'Ekip', teamSub: 'Şirket personeli ve rolleri · Yalnızca Sahip', timezone: 'Saat dilimi',
    timezoneNote: '“Bugün” ve gelmeme süresi hastanenin saat dilimine göre hesaplanır.', tzInvalid: 'Bilinmeyen saat dilimi.',
    teamLockedNote: 'Kendi hesabınızı değiştiremezsiniz. Tek Sahip erişimini kaybederse sunucuda reset-company-user ile kurtarılır.' },
};
