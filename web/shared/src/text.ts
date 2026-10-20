/** Languages, persistence and the strings shared by every MEDLINK web app (AR default, EN, TR). */
export type Lang = 'ar' | 'en' | 'tr';
export const LANGS: Lang[] = ['ar', 'en', 'tr'];
export const LANG_TAG: Record<Lang, string> = { ar: 'العربية', en: 'English', tr: 'Türkçe' };
export const LANG_PILL: [Lang, string][] = [['ar', 'عربي'], ['en', 'EN'], ['tr', 'TR']];


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
    extraTags: { logout: 'خروج', login_locked: 'قفل', link_completed: 'تفعيل حساب', bootstrap_admin: 'إنشاء المالك', user_invite: 'دعوة مستخدم', user_role: 'تغيير دور', user_disable: 'تعطيل مستخدم', user_enable: 'تفعيل مستخدم', user_link: 'إرسال رابط', hospital_settings: 'إعدادات', department_create: 'قسم جديد', department_edit: 'تعديل قسم', schedule_edit: 'جدول مواعيد', closure_add: 'إغلاق', closure_remove: 'إلغاء إغلاق', company_user_reset_cli: 'استعادة من الخادم' } as Record<string, string>,
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
    extraTags: { logout: 'Sign-out', login_locked: 'Locked', link_completed: 'Account set up', bootstrap_admin: 'Owner created', user_invite: 'User invited', user_role: 'Role change', user_disable: 'User disabled', user_enable: 'User enabled', user_link: 'Link sent', hospital_settings: 'Settings', department_create: 'New department', department_edit: 'Department edit', schedule_edit: 'Schedule', closure_add: 'Closure', closure_remove: 'Closure removed', company_user_reset_cli: 'Server recovery' } as Record<string, string>,
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
    extraTags: { logout: 'Çıkış', login_locked: 'Kilit', link_completed: 'Hesap kuruldu', bootstrap_admin: 'Sahip oluşturuldu', user_invite: 'Kullanıcı daveti', user_role: 'Rol değişikliği', user_disable: 'Kullanıcı kapatıldı', user_enable: 'Kullanıcı açıldı', user_link: 'Bağlantı gönderildi', hospital_settings: 'Ayarlar', department_create: 'Yeni bölüm', department_edit: 'Bölüm düzenleme', schedule_edit: 'Program', closure_add: 'Kapanış', closure_remove: 'Kapanış kaldırıldı', company_user_reset_cli: 'Sunucu kurtarma' } as Record<string, string>,
    reportsPending: 'Randevu ve katılım sayıları randevu sistemi açıldığında görünür (aşama 6).',
  },
};
export type AuthText = (typeof A)['en'];

/** Hospital-side sign-in copy, verbatim from designs/Windows App.dc.html where it exists. */
export const AH = {
  ar: {
    brandLine: 'إدارة مواعيد المستشفى وتسجيل الحضور، متصل بنظام MEDLINK المركزي.',
    signInSub: 'استخدم حساب المستشفى الذي أنشأته لك KHATIB TECHNICAL SOLUTIONS.',
    forgotTitle: 'استعادة كلمة المرور', forgotBody: 'سيُفتح واتساب برسالة جاهزة إلى دعم KHATIB TECHNICAL SOLUTIONS. راجع الرسالة ثم أرسلها بنفسك.',
    forgotWarn: 'لا تُرسل كلمة المرور أو أي رمز عبر واتساب. لن تتغير كلمة المرور إلا بعد التحقق من هويتك، وستصلك خطوات إعادة التعيين بطريقة آمنة.',
    waMsg: (u: string) => 'مرحبًا، أحتاج إلى استعادة كلمة مرور حساب MEDLINK.\nاسم المستخدم: ' + (u || '—'),
    openWa: 'فتح واتساب', cancel: 'إلغاء',
    staffHint: 'موظفو الاستقبال والمسح: اطلب من مسؤول المستشفى إرسال رابط إعادة تعيين.',
  },
  en: {
    brandLine: 'Hospital appointments and check-in, connected to the MEDLINK central service.',
    signInSub: 'Use the hospital account created for you by KHATIB TECHNICAL SOLUTIONS.',
    forgotTitle: 'Recover your password', forgotBody: 'WhatsApp will open with a prepared message to KHATIB TECHNICAL SOLUTIONS support. Review it and send it yourself.',
    forgotWarn: 'Never send your password or any code over WhatsApp. Your password only changes after your identity is verified; reset steps are sent securely.',
    waMsg: (u: string) => 'Hello, I need to recover my MEDLINK account password.\nUsername: ' + (u || '—'),
    openWa: 'Open WhatsApp', cancel: 'Cancel',
    staffHint: 'Reception and scanner staff: ask your hospital admin to send you a reset link.',
  },
  tr: {
    brandLine: 'Hastane randevuları ve giriş kaydı, MEDLINK merkezi hizmetine bağlı.',
    signInSub: 'KHATIB TECHNICAL SOLUTIONS tarafından oluşturulan hastane hesabınızı kullanın.',
    forgotTitle: 'Şifre kurtarma', forgotBody: 'WhatsApp, KHATIB TECHNICAL SOLUTIONS desteğine hazır bir mesajla açılacak. Mesajı kontrol edip kendiniz gönderin.',
    forgotWarn: 'Şifrenizi veya herhangi bir kodu WhatsApp ile göndermeyin. Şifreniz yalnızca kimliğiniz doğrulandıktan sonra değişir; sıfırlama adımları güvenli şekilde iletilir.',
    waMsg: (u: string) => 'Merhaba, MEDLINK hesap şifremi kurtarmam gerekiyor.\nKullanıcı adı: ' + (u || '—'),
    openWa: 'WhatsApp’ı aç', cancel: 'İptal',
    staffHint: 'Kayıt ve tarayıcı personeli: hastane yöneticinizden sıfırlama bağlantısı isteyin.',
  },
};

/** Approved support number (README decisions). The prepared message never contains secrets. */
export const SUPPORT_WHATSAPP = '4368181700732';
export const whatsappUrl = (text: string) => 'https://wa.me/' + SUPPORT_WHATSAPP + '?text=' + encodeURIComponent(text);

export type Audience = 'company' | 'hospital';

/** Users panel (company Team tab and hospital staff). */
export const UT = {
  ar: {
    emailPh: 'البريد الإلكتروني', role: 'الدور', invite: 'إرسال دعوة', sending: 'جارٍ الإرسال…',
    inviteNote: 'يصل رابط تفعيل لمرة واحدة صالح 24 ساعة. يختار المستخدم كلمة المرور بنفسه، ولا يراها أحد غيره.',
    active: 'نشط', pending: 'بانتظار التفعيل', disabled: 'معطّل', with2fa: 'التحقق الثنائي مفعّل', without2fa: 'بدون تحقق ثنائي', you: 'أنت',
    resendInvite: 'إعادة إرسال الدعوة', sendReset: 'إرسال رابط إعادة تعيين', disable: 'تعطيل', enable: 'تفعيل',
    invited: 'أُرسلت الدعوة.', linkSent: 'أُرسل الرابط.', roleChanged: 'تم تغيير الدور وأُلغيت جلساته.', saved: 'تم الحفظ.',
    emailNotSent: 'تم الحفظ، لكن تعذّر إرسال البريد. أعد المحاولة.',
    emailTaken: 'هذا البريد مستخدم لحساب آخر.', emailInvalid: 'البريد غير صالح.', lastOwner: 'يجب أن يبقى مالك نشط واحد على الأقل.',
    self: 'لا يمكنك تعديل حسابك من هنا.', network: 'تعذّر الاتصال بالخادم.', generic: 'حدث خطأ غير متوقع.', loading: 'جارٍ التحميل…',
  },
  en: {
    emailPh: 'Email', role: 'Role', invite: 'Send invite', sending: 'Sending…',
    inviteNote: 'A one-time activation link valid for 24 hours is emailed. The user chooses their own password; nobody else ever sees it.',
    active: 'Active', pending: 'Awaiting activation', disabled: 'Disabled', with2fa: '2FA on', without2fa: 'No 2FA', you: 'you',
    resendInvite: 'Resend invite', sendReset: 'Send reset link', disable: 'Disable', enable: 'Enable',
    invited: 'Invite sent.', linkSent: 'Link sent.', roleChanged: 'Role changed; their sessions were signed out.', saved: 'Saved.',
    emailNotSent: 'Saved, but the email couldn’t be sent. Try again.',
    emailTaken: 'This email is already used by another account.', emailInvalid: 'That email isn’t valid.', lastOwner: 'At least one active Owner must remain.',
    self: 'You can’t change your own account here.', network: 'Can’t reach the server.', generic: 'Something went wrong.', loading: 'Loading…',
  },
  tr: {
    emailPh: 'E-posta', role: 'Rol', invite: 'Davet gönder', sending: 'Gönderiliyor…',
    inviteNote: '24 saat geçerli, tek kullanımlık bir etkinleştirme bağlantısı e-postayla gönderilir. Şifreyi kullanıcı kendisi seçer; başka kimse görmez.',
    active: 'Aktif', pending: 'Aktivasyon bekliyor', disabled: 'Devre dışı', with2fa: '2FA açık', without2fa: '2FA yok', you: 'siz',
    resendInvite: 'Daveti yeniden gönder', sendReset: 'Sıfırlama bağlantısı gönder', disable: 'Devre dışı bırak', enable: 'Etkinleştir',
    invited: 'Davet gönderildi.', linkSent: 'Bağlantı gönderildi.', roleChanged: 'Rol değişti; oturumları kapatıldı.', saved: 'Kaydedildi.',
    emailNotSent: 'Kaydedildi, ancak e-posta gönderilemedi. Tekrar deneyin.',
    emailTaken: 'Bu e-posta başka bir hesapta kullanılıyor.', emailInvalid: 'E-posta geçersiz.', lastOwner: 'En az bir aktif Sahip kalmalıdır.',
    self: 'Kendi hesabınızı buradan değiştiremezsiniz.', network: 'Sunucuya ulaşılamıyor.', generic: 'Bir sorun oluştu.', loading: 'Yükleniyor…',
  },
};
