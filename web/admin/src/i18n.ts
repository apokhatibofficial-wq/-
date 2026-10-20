import { T } from './consoleText.ts';

export type Lang = 'ar' | 'en' | 'tr';
export const LANGS: Lang[] = ['ar', 'en', 'tr'];
export const LANG_TAG: Record<Lang, string> = { ar: 'العربية', en: 'English', tr: 'Türkçe' };
export const LANG_PILL: [Lang, string][] = [['ar', 'عربي'], ['en', 'EN'], ['tr', 'TR']];

export { T };
export type ConsoleText = (typeof T)['en'];

export function loadLang(): Lang {
  try {
    const v = localStorage.getItem('medlink.lang');
    if (v === 'ar' || v === 'en' || v === 'tr') return v;
  } catch { /* storage unavailable */ }
  return 'ar';
}

export function saveLang(l: Lang) {
  try { localStorage.setItem('medlink.lang', l); } catch { /* storage unavailable */ }
}

/** Sign-in, one-time-link and console strings that the prototypes did not cover. */
export const A = {
  ar: {
    brandLine: 'لوحة تحكم الشركة لإدارة حسابات المستشفيات وروابط الحجز.',
    signIn: 'تسجيل الدخول', signInSub: 'لوحة تحكم KHATIB TECHNICAL SOLUTIONS. للموظفين المصرّح لهم فقط.',
    email: 'البريد الإلكتروني', password: 'كلمة المرور', show: 'إظهار', hide: 'إخفاء', caps: 'زر Caps Lock مفعّل.',
    submit: 'تسجيل الدخول', submitting: 'جارٍ التحقق…', forgot: 'نسيت كلمة المرور؟',
    totpTitle: 'رمز التحقق', totpSub: 'أدخل الرمز المكوّن من 6 أرقام من تطبيق المصادقة.', totpLabel: 'الرمز', verify: 'تحقق', back: 'رجوع',
    errBad: 'البيانات غير صحيحة. تحقق منها وحاول مرة أخرى.',
    errLocked: 'تم إيقاف تسجيل الدخول مؤقتًا بعد عدة محاولات فاشلة. حاول بعد 15 دقيقة.',
    errRate: 'محاولات كثيرة من هذا الجهاز. انتظر دقيقة ثم حاول مرة أخرى.',
    errMfaNotEnrolled: 'التحقق الثنائي غير مفعّل لهذا الحساب. اطلب رابط إعادة تعيين.',
    errSuspended: 'حساب المستشفى موقوف. تواصل مع الدعم.',
    errNetwork: 'تعذّر الاتصال بالخادم. تحقق من الشبكة وحاول مرة أخرى.',
    errGeneric: 'حدث خطأ غير متوقع. حاول مرة أخرى.',
    forgotTitle: 'استعادة الوصول', forgotBody: 'اطلب من مالك حساب الشركة إصدار رابط إعادة تعيين بعد التحقق من هويتك. لا تُرسل كلمة المرور أو أي رمز لأي أحد.',
    close: 'إغلاق', signOut: 'تسجيل الخروج',
    linkTitles: { setup: 'إعداد حساب المالك', activation: 'تفعيل الحساب', reset: 'إعادة تعيين كلمة المرور' } as Record<string, string>,
    linkSub: 'اختر كلمة مرور قوية لا تستخدمها في أي مكان آخر.',
    linkInvalid: 'هذا الرابط غير صالح أو انتهت صلاحيته أو استُخدم من قبل. اطلب رابطًا جديدًا.',
    newPassword: 'كلمة المرور الجديدة', confirmPassword: 'تأكيد كلمة المرور',
    pwMin: (n: number) => 'على الأقل ' + n + ' حرفًا.', pwMismatch: 'كلمتا المرور غير متطابقتين.', pwWeak: 'كلمة المرور ضعيفة. استخدم عبارة أطول.',
    totpSetup: 'التحقق الثنائي (إلزامي)', totpSetupSub: 'امسح الرمز بتطبيق مصادقة (مثل Google Authenticator أو Microsoft Authenticator)، ثم أدخل الرمز الظاهر.',
    manualKey: 'أو أدخل المفتاح يدويًا:', totpBad: 'الرمز غير صحيح. تأكد من وقت الهاتف وحاول مرة أخرى.',
    save: 'حفظ وتفعيل', saving: 'جارٍ الحفظ…',
    linkDone: 'تم. يمكنك الآن تسجيل الدخول بكلمة المرور الجديدة.', linkDoneHospital: 'تم. يمكنك الآن تسجيل الدخول إلى تطبيق المستشفى بكلمة المرور الجديدة.',
    goSignIn: 'الذهاب إلى تسجيل الدخول',
    loading: 'جارٍ التحميل…', loadFail: 'تعذّر تحميل البيانات.', retry: 'إعادة المحاولة',
    noAccess: 'لا تملك صلاحية لعرض هذا القسم.',
    emailNotSent: 'تم الحفظ، لكن تعذّر إرسال البريد. أعد المحاولة من «استعادة وصول المسؤول».',
    tooSoon: (d: string) => 'يُسمح بتغيير الرابط مرة كل 30 يومًا. التغيير التالي ممكن بعد ' + d + '.',
    emailTaken: 'هذا البريد مستخدم لحساب آخر.', noAdmin: 'لا يوجد مسؤول نشط لهذا المستشفى.',
    noData: '—', roleNames: { owner: 'مالك', support: 'دعم', viewer: 'مشاهد' } as Record<string, string>,
    extraTags: { logout: 'خروج', login_locked: 'قفل', link_completed: 'تفعيل حساب', bootstrap_admin: 'إنشاء المالك' } as Record<string, string>,
    reportsPending: 'تظهر أرقام الحجوزات والحضور بعد تفعيل نظام الحجز (المرحلة 6).',
  },
  en: {
    brandLine: 'Company console for hospital accounts and booking links.',
    signIn: 'Sign in', signInSub: 'KHATIB TECHNICAL SOLUTIONS console. Authorised staff only.',
    email: 'Email', password: 'Password', show: 'Show', hide: 'Hide', caps: 'Caps Lock is on.',
    submit: 'Sign in', submitting: 'Verifying…', forgot: 'Forgot password?',
    totpTitle: 'Verification code', totpSub: 'Enter the 6-digit code from your authenticator app.', totpLabel: 'Code', verify: 'Verify', back: 'Back',
    errBad: 'Those details are incorrect. Check them and try again.',
    errLocked: 'Sign-in is paused after several failed attempts. Try again in 15 minutes.',
    errRate: 'Too many attempts from this device. Wait a minute and try again.',
    errMfaNotEnrolled: 'Two-step verification is not set up for this account. Ask for a reset link.',
    errSuspended: 'This hospital account is suspended. Contact support.',
    errNetwork: 'Can’t reach the server. Check the network and try again.',
    errGeneric: 'Something went wrong. Try again.',
    forgotTitle: 'Recover access', forgotBody: 'Ask the company owner to issue a reset link after verifying your identity. Never send your password or any code to anyone.',
    close: 'Close', signOut: 'Sign out',
    linkTitles: { setup: 'Set up the owner account', activation: 'Activate your account', reset: 'Reset your password' } as Record<string, string>,
    linkSub: 'Choose a strong password you don’t use anywhere else.',
    linkInvalid: 'This link is invalid, expired or already used. Ask for a new one.',
    newPassword: 'New password', confirmPassword: 'Confirm password',
    pwMin: (n: number) => 'At least ' + n + ' characters.', pwMismatch: 'The passwords don’t match.', pwWeak: 'That password is too weak. Use a longer phrase.',
    totpSetup: 'Two-step verification (required)', totpSetupSub: 'Scan the code with an authenticator app (such as Google Authenticator or Microsoft Authenticator), then enter the code it shows.',
    manualKey: 'Or enter the key manually:', totpBad: 'That code is wrong. Check your phone’s clock and try again.',
    save: 'Save and activate', saving: 'Saving…',
    linkDone: 'Done. You can now sign in with your new password.', linkDoneHospital: 'Done. You can now sign in to the hospital app with your new password.',
    goSignIn: 'Go to sign in',
    loading: 'Loading…', loadFail: 'Couldn’t load the data.', retry: 'Retry',
    noAccess: 'You don’t have permission to view this section.',
    emailNotSent: 'Saved, but the email couldn’t be sent. Retry from “Recover admin access”.',
    tooSoon: (d: string) => 'The link can change once every 30 days. The next change is possible after ' + d + '.',
    emailTaken: 'This email is already used by another account.', noAdmin: 'This hospital has no active admin.',
    noData: '—', roleNames: { owner: 'Owner', support: 'Support', viewer: 'Viewer' } as Record<string, string>,
    extraTags: { logout: 'Sign-out', login_locked: 'Locked', link_completed: 'Account set up', bootstrap_admin: 'Owner created' } as Record<string, string>,
    reportsPending: 'Booking and attendance numbers appear once booking is live (phase 6).',
  },
  tr: {
    brandLine: 'Hastane hesapları ve randevu bağlantıları için şirket paneli.',
    signIn: 'Giriş yap', signInSub: 'KHATIB TECHNICAL SOLUTIONS paneli. Yalnızca yetkili personel.',
    email: 'E-posta', password: 'Şifre', show: 'Göster', hide: 'Gizle', caps: 'Caps Lock açık.',
    submit: 'Giriş yap', submitting: 'Doğrulanıyor…', forgot: 'Şifremi unuttum',
    totpTitle: 'Doğrulama kodu', totpSub: 'Kimlik doğrulama uygulamanızdaki 6 haneli kodu girin.', totpLabel: 'Kod', verify: 'Doğrula', back: 'Geri',
    errBad: 'Bilgiler hatalı. Kontrol edip tekrar deneyin.',
    errLocked: 'Çok sayıda başarısız denemeden sonra giriş durduruldu. 15 dakika sonra deneyin.',
    errRate: 'Bu cihazdan çok fazla deneme yapıldı. Bir dakika bekleyip tekrar deneyin.',
    errMfaNotEnrolled: 'Bu hesapta iki adımlı doğrulama kurulu değil. Sıfırlama bağlantısı isteyin.',
    errSuspended: 'Bu hastane hesabı askıya alındı. Destekle iletişime geçin.',
    errNetwork: 'Sunucuya ulaşılamıyor. Ağı kontrol edip tekrar deneyin.',
    errGeneric: 'Bir sorun oluştu. Tekrar deneyin.',
    forgotTitle: 'Erişimi kurtar', forgotBody: 'Kimliğiniz doğrulandıktan sonra şirket sahibinden bir sıfırlama bağlantısı isteyin. Şifrenizi veya herhangi bir kodu kimseye göndermeyin.',
    close: 'Kapat', signOut: 'Çıkış yap',
    linkTitles: { setup: 'Sahip hesabını kur', activation: 'Hesabınızı etkinleştirin', reset: 'Şifrenizi sıfırlayın' } as Record<string, string>,
    linkSub: 'Başka hiçbir yerde kullanmadığınız güçlü bir şifre seçin.',
    linkInvalid: 'Bu bağlantı geçersiz, süresi dolmuş veya kullanılmış. Yeni bir bağlantı isteyin.',
    newPassword: 'Yeni şifre', confirmPassword: 'Şifreyi onayla',
    pwMin: (n: number) => 'En az ' + n + ' karakter.', pwMismatch: 'Şifreler eşleşmiyor.', pwWeak: 'Şifre çok zayıf. Daha uzun bir ifade kullanın.',
    totpSetup: 'İki adımlı doğrulama (zorunlu)', totpSetupSub: 'Kodu bir kimlik doğrulama uygulamasıyla (Google Authenticator veya Microsoft Authenticator gibi) tarayın, ardından gösterilen kodu girin.',
    manualKey: 'Veya anahtarı elle girin:', totpBad: 'Kod hatalı. Telefonunuzun saatini kontrol edip tekrar deneyin.',
    save: 'Kaydet ve etkinleştir', saving: 'Kaydediliyor…',
    linkDone: 'Tamam. Artık yeni şifrenizle giriş yapabilirsiniz.', linkDoneHospital: 'Tamam. Artık hastane uygulamasına yeni şifrenizle giriş yapabilirsiniz.',
    goSignIn: 'Girişe git',
    loading: 'Yükleniyor…', loadFail: 'Veriler yüklenemedi.', retry: 'Tekrar dene',
    noAccess: 'Bu bölümü görüntüleme yetkiniz yok.',
    emailNotSent: 'Kaydedildi, ancak e-posta gönderilemedi. “Yönetici erişimini kurtar” ile tekrar deneyin.',
    tooSoon: (d: string) => 'Bağlantı 30 günde bir değiştirilebilir. Sonraki değişiklik ' + d + ' tarihinden sonra mümkün.',
    emailTaken: 'Bu e-posta başka bir hesapta kullanılıyor.', noAdmin: 'Bu hastanenin aktif yöneticisi yok.',
    noData: '—', roleNames: { owner: 'Sahip', support: 'Destek', viewer: 'İzleyici' } as Record<string, string>,
    extraTags: { logout: 'Çıkış', login_locked: 'Kilit', link_completed: 'Hesap kuruldu', bootstrap_admin: 'Sahip oluşturuldu' } as Record<string, string>,
    reportsPending: 'Randevu ve katılım sayıları randevu sistemi açıldığında görünür (aşama 6).',
  },
};
export type AuthText = (typeof A)['en'];

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
