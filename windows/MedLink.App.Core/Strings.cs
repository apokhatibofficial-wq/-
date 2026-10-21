namespace MedLink.App;

public enum Lang { Ar, En, Tr }

/// <summary>
/// Every string the Windows app shows. Marked "design" = verbatim from designs/Windows App.dc.html (T and D);
/// "web" = the same text as the web sign-in (web/shared/src/text.ts); the rest is new, written in the same tone.
/// </summary>
public sealed class Strings
{
    // ---- design: window, sign-in, forgot password
    public required string WinTitle { get; init; }
    public required string BrandLine { get; init; }
    public required string Online { get; init; }
    public required string Offline { get; init; }
    public required string OfflineNote { get; init; }
    public required string SignIn { get; init; }
    public required string SignInSub { get; init; }
    public required string Password { get; init; }
    public required string Show { get; init; }
    public required string Hide { get; init; }
    public required string Caps { get; init; }
    public required string Submit { get; init; }
    public required string Submitting { get; init; }
    public required string Forgot { get; init; }
    public required string ConnSettings { get; init; }
    public required string ErrLocked { get; init; }
    public required string SignOut { get; init; }
    public required string ForgotTitle { get; init; }
    public required string ForgotBody { get; init; }
    public required string ForgotWarn { get; init; }
    public required string ForgotStaff { get; init; }
    public required string OpenWa { get; init; }
    public required string Cancel { get; init; }
    public required Func<string, string, string> WaMsg { get; init; }          // (username, hospital)
    /// <summary>The design's "incorrect username or password" without the attempts count: the server does not reveal it, because a count would show that the account exists.</summary>
    public required string ErrBad { get; init; }
    // ---- web: sign-in pieces the design did not cover
    public required string Email { get; init; }
    public required string TotpTitle { get; init; }
    public required string TotpSub { get; init; }
    public required string TotpLabel { get; init; }
    public required string Verify { get; init; }
    public required string Back { get; init; }
    public required string ErrRate { get; init; }
    public required string ErrMfaNotEnrolled { get; init; }
    public required string ErrSuspended { get; init; }
    public required string ErrNetwork { get; init; }
    public required string ErrGeneric { get; init; }
    public required string Close { get; init; }
    // ---- design: dashboard (D)
    public required string[] Nav { get; init; }
    public required string Today { get; init; }
    public required string Search { get; init; }
    public required string All { get; init; }
    public required string Waiting { get; init; }
    public required string Arrived { get; init; }
    public required string NoShow { get; init; }
    public required string AllDepts { get; init; }
    public required string CTime { get; init; }
    public required string CPatient { get; init; }
    public required string CDept { get; init; }
    public required string CRef { get; init; }
    public required string CStatus { get; init; }
    public required string CIn { get; init; }
    public required string PillOnline { get; init; }
    public required string PillOffline { get; init; }
    public required string Syncing { get; init; }
    public required string OfflineBanner { get; init; }
    public required string PendingTip { get; init; }
    public required string Empty { get; init; }
    public required string Phone { get; init; }
    public required string Date { get; init; }
    public required string Dept { get; init; }
    public required string MarkArrived { get; init; }
    public required string Correct { get; init; }
    public required string ReasonPh { get; init; }
    public required string SaveCorr { get; init; }
    public required string CorrNote { get; init; }
    public required string History { get; init; }
    public required string HBooked { get; init; }
    public required string HQr { get; init; }
    public required string HRec { get; init; }
    public required Func<int, string> PendingN { get; init; }
    public required Func<int, string> Synced { get; init; }
    public required Func<string, string, string> Conflict { get; init; }
    public required Func<string, string, string> HCorr { get; init; }
    public required Func<string, string> Live { get; init; }
    public required Func<int, string> Grace { get; init; }
    public required Func<int, string> HAuto { get; init; }
    public required Dictionary<string, string> Src { get; init; }
    // ---- new
    public required string Cancelled { get; init; }
    public required string RoleReception { get; init; }
    public required string RoleAdmin { get; init; }
    public required string RoleScanner { get; init; }
    public required string RoleDoctor { get; init; }
    public required string NotForWindows { get; init; }
    public required string SessionEnded { get; init; }
    public required string DeviceRevoked { get; init; }
    public required string ReasonMin { get; init; }
    public required string NotToday { get; init; }
    public required string CheckedIn { get; init; }
    public required string CorrSaved { get; init; }
    public required string NeedsReview { get; init; }
    public required string FindTitle { get; init; }
    public required string FindSub { get; init; }
    public required string FindPh { get; init; }
    public required string FindBtn { get; init; }
    public required string FindNone { get; init; }
    public required string FindFormat { get; init; }
    public required string SyncTitle { get; init; }
    public required string SyncNow { get; init; }
    public required string PendingCount { get; init; }
    public required string LastSync { get; init; }
    public required string Never { get; init; }
    public required string RejectedTitle { get; init; }
    public required string RejectedNone { get; init; }
    public required string SettingsTitle { get; init; }
    public required string Language { get; init; }
    public required string DeviceName { get; init; }
    public required string DeviceId { get; init; }
    public required string ServerAddress { get; init; }
    public required string ServerNote { get; init; }
    public required string AppVersion { get; init; }
    /// <summary>{0} = the new version.</summary>
    public required string UpdateReady { get; init; }
    public required string UpdateClose { get; init; }
    public required string TestConnection { get; init; }
    public required string ConnOk { get; init; }
    public required string ConnFail { get; init; }
    public required string SignOutPending { get; init; }
    public required string SignOutConfirm { get; init; }
    public required string ReadOnlyDoctor { get; init; }
    public required string Loading { get; init; }
    public required Func<int, string> LocalOnly { get; init; }
    public required Dictionary<string, string> RejectCodes { get; init; }

    public static Strings For(Lang l) => l switch { Lang.En => En, Lang.Tr => Tr, _ => Ar };

    public static readonly Strings Ar = new()
    {
        WinTitle = "MEDLINK — تطبيق المستشفى", BrandLine = "إدارة مواعيد المستشفى وتسجيل الحضور، متصل بنظام MEDLINK المركزي.",
        Online = "متصل بالخادم", Offline = "غير متصل بالإنترنت",
        OfflineNote = "تسجيل الدخول يحتاج إلى اتصال بالخادم للتحقق من الحساب. تحقق من الشبكة ثم حاول مرة أخرى.",
        SignIn = "تسجيل الدخول", SignInSub = "استخدم حساب المستشفى الذي أنشأته لك KHATIB TECHNICAL SOLUTIONS.",
        Password = "كلمة المرور", Show = "إظهار", Hide = "إخفاء", Caps = "زر Caps Lock مفعّل.", Submit = "تسجيل الدخول", Submitting = "جارٍ التحقق…",
        Forgot = "نسيت كلمة المرور؟", ConnSettings = "إعدادات الاتصال",
        ErrBad = "اسم المستخدم أو كلمة المرور غير صحيحة.",
        ErrLocked = "تم إيقاف تسجيل الدخول مؤقتًا بعد عدة محاولات فاشلة. حاول بعد 15 دقيقة أو تواصل مع الدعم.",
        SignOut = "تسجيل الخروج", ForgotTitle = "استعادة كلمة المرور",
        ForgotBody = "سيُفتح واتساب برسالة جاهزة إلى دعم KHATIB TECHNICAL SOLUTIONS. راجع الرسالة ثم أرسلها بنفسك.",
        ForgotWarn = "لا تُرسل كلمة المرور أو أي رمز عبر واتساب. لن تتغير كلمة المرور إلا بعد التحقق من هويتك، وستصلك خطوات إعادة التعيين بطريقة آمنة.",
        ForgotStaff = "موظفو الاستقبال والأطباء والمسح: اطلب من مسؤول المستشفى إرسال رابط إعادة تعيين.",
        WaMsg = (u, h) => "مرحبًا، أحتاج إلى استعادة كلمة مرور حساب MEDLINK.\nاسم المستخدم: " + (u.Length > 0 ? u : "—") + "\nالمستشفى: " + (h.Length > 0 ? h : "—"),
        OpenWa = "فتح واتساب", Cancel = "إلغاء",
        Email = "البريد الإلكتروني", TotpTitle = "رمز التحقق", TotpSub = "أدخل الرمز المكوّن من 6 أرقام من تطبيق المصادقة.", TotpLabel = "الرمز",
        Verify = "تحقق", Back = "رجوع", ErrRate = "محاولات كثيرة من هذا الجهاز. انتظر دقيقة ثم حاول مرة أخرى.",
        ErrMfaNotEnrolled = "التحقق الثنائي غير مفعّل لهذا الحساب. اطلب رابط إعادة تعيين.", ErrSuspended = "حساب المستشفى موقوف. تواصل مع الدعم.",
        ErrNetwork = "تعذّر الاتصال بالخادم. تحقق من الشبكة وحاول مرة أخرى.", ErrGeneric = "حدث خطأ غير متوقع. حاول مرة أخرى.", Close = "إغلاق",
        Nav = ["المواعيد", "البحث عن حجز", "المزامنة", "الإعدادات"],
        Today = "اليوم", Search = "بحث بالاسم أو رقم الحجز", All = "الكل", Waiting = "بانتظار الحضور", Arrived = "حضر", NoShow = "لم يحضر", AllDepts = "كل الأقسام",
        CTime = "الوقت", CPatient = "المريض", CDept = "القسم", CRef = "رقم الحجز", CStatus = "الحالة", CIn = "الحضور",
        PillOnline = "متصل · تمت المزامنة", PillOffline = "غير متصل", PendingN = n => "غير متصل · " + n + " بانتظار المزامنة", Syncing = "جارٍ المزامنة…",
        OfflineBanner = "لا يوجد اتصال. تُحفظ تحديثات الحضور على هذا الجهاز وتُرسل تلقائيًا عند عودة الاتصال.",
        Synced = n => "تمت مزامنة " + n + " تحديث.",
        Conflict = (nm, t) => "تعارض في حجز " + nm + ": سجّل ماسح QR الحضور الساعة " + t + " قبل تحديثك، فاعتُمد الوقت الأسبق وسُجّل التعديلان.",
        Live = nm => "وصل تسجيل حضور من ماسح الهاتف: " + nm,
        Grace = m => "يُسجَّل «لم يحضر» تلقائيًا من الخادم بعد " + m + " دقيقة",
        PendingTip = "محفوظ محليًا، بانتظار المزامنة", Empty = "لا توجد حجوزات مطابقة.", Phone = "الهاتف", Date = "الموعد", Dept = "القسم",
        Src = new() { ["qr"] = "عبر ماسح QR", ["reception"] = "يدويًا من الاستقبال", ["auto"] = "تلقائيًا من الخادم", ["correction"] = "بتصحيح يدوي" },
        MarkArrived = "تسجيل الحضور يدويًا", Correct = "تصحيح الحالة", ReasonPh = "سبب التصحيح (إلزامي)", SaveCorr = "حفظ التصحيح",
        CorrNote = "يُسجَّل التصحيح مع السبب والوقت والحساب في سجل التدقيق.", History = "السجل",
        HBooked = "تم الحجز عبر الرابط", HQr = "حضر · ماسح QR", HRec = "حضر · الاستقبال", HAuto = m => "لم يحضر · تلقائي بعد " + m + " دقيقة",
        HCorr = (st, r) => "تصحيح إلى «" + st + "»: " + r,
        Cancelled = "ملغى", RoleReception = "موظف استقبال", RoleAdmin = "مدير المستشفى", RoleScanner = "ماسح QR", RoleDoctor = "طبيب",
        NotForWindows = "هذا الحساب لا يملك صلاحية استخدام تطبيق Windows.",
        SessionEnded = "انتهت الجلسة. سجّل الدخول مرة أخرى.", DeviceRevoked = "أُلغي هذا الجهاز من إعدادات المستشفى. سجّل الدخول مرة أخرى لتسجيله من جديد.",
        ReasonMin = "اكتب سببًا من 5 أحرف على الأقل.", NotToday = "يُسجَّل الحضور في يوم الموعد فقط.", CheckedIn = "تم تسجيل الحضور",
        CorrSaved = "تم حفظ التصحيح.", NeedsReview = "تصحيحان متعارضان · يحتاج مراجعة",
        FindTitle = "البحث عن حجز", FindSub = "أدخل رقم الحجز كاملًا كما يظهر على تأكيد المريض. لا يمكن البحث بالاسم حفاظًا على الخصوصية.",
        FindPh = "ML-XXXXXX", FindBtn = "بحث", FindNone = "لا يوجد حجز بهذا الرقم في النسخة المحلية (من أمس حتى 30 يومًا قادمة).",
        FindFormat = "أدخل رقم الحجز كاملًا، مثل ML-7K3Q9P.",
        SyncTitle = "المزامنة", SyncNow = "مزامنة الآن", PendingCount = "بانتظار المزامنة", LastSync = "آخر مزامنة", Never = "لم تتم بعد",
        RejectedTitle = "تحديثات رفضها الخادم", RejectedNone = "لا توجد تحديثات مرفوضة.",
        SettingsTitle = "الإعدادات", Language = "اللغة", DeviceName = "اسم الجهاز", DeviceId = "معرّف الجهاز", ServerAddress = "عنوان الخادم",
        ServerNote = "يُضبط عنوان الخادم عند التثبيت ولا يُغيَّر من هنا.", AppVersion = "الإصدار", UpdateReady = "الإصدار {0} من MEDLINK جاهز، وسيُثبَّت عند إعادة فتح التطبيق. لا تضيع تسجيلات الحضور غير المُرسلة.", UpdateClose = "إغلاق للتحديث", TestConnection = "اختبار الاتصال",
        ConnOk = "الاتصال بالخادم يعمل.", ConnFail = "تعذّر الوصول إلى الخادم.",
        SignOutPending = "توجد تحديثات حضور لم تُرسل بعد. ستبقى محفوظة على هذا الجهاز وتُرسل عند دخولك مرة أخرى.", SignOutConfirm = "تسجيل الخروج على أي حال",
        ReadOnlyDoctor = "عرض فقط: مواعيد أقسامك، بدون أرقام الهواتف.", Loading = "جارٍ التحميل…",
        LocalOnly = n => n + " تحديث محفوظ محليًا",
        RejectCodes = new() { ["CANCELLED"] = "الحجز ملغى", ["OTHER_DAY"] = "ليس يوم الموعد", ["NOT_FOUND"] = "الحجز غير موجود", ["BAD_TIME"] = "وقت الجهاز غير صحيح",
            ["FORBIDDEN"] = "لا تملك الصلاحية", ["REASON_REQUIRED"] = "السبب مطلوب" },
    };

    public static readonly Strings En = new()
    {
        WinTitle = "MEDLINK — Hospital app", BrandLine = "Hospital appointments and check-in, connected to the MEDLINK central service.",
        Online = "Connected to server", Offline = "No internet connection",
        OfflineNote = "Signing in needs a server connection to verify your account. Check the network and try again.",
        SignIn = "Sign in", SignInSub = "Use the hospital account created for you by KHATIB TECHNICAL SOLUTIONS.",
        Password = "Password", Show = "Show", Hide = "Hide", Caps = "Caps Lock is on.", Submit = "Sign in", Submitting = "Verifying…",
        Forgot = "Forgot password?", ConnSettings = "Connection settings",
        ErrBad = "Incorrect username or password.",
        ErrLocked = "Sign-in is paused after several failed attempts. Try again in 15 minutes or contact support.",
        SignOut = "Sign out", ForgotTitle = "Recover your password",
        ForgotBody = "WhatsApp will open with a prepared message to KHATIB TECHNICAL SOLUTIONS support. Review it and send it yourself.",
        ForgotWarn = "Never send your password or any code over WhatsApp. Your password only changes after your identity is verified; reset steps are sent securely.",
        ForgotStaff = "Reception, doctors and scanner staff: ask your hospital admin to send you a reset link.",
        WaMsg = (u, h) => "Hello, I need to recover my MEDLINK account password.\nUsername: " + (u.Length > 0 ? u : "—") + "\nHospital: " + (h.Length > 0 ? h : "—"),
        OpenWa = "Open WhatsApp", Cancel = "Cancel",
        Email = "Email", TotpTitle = "Verification code", TotpSub = "Enter the 6-digit code from your authenticator app.", TotpLabel = "Code",
        Verify = "Verify", Back = "Back", ErrRate = "Too many attempts from this device. Wait a minute and try again.",
        ErrMfaNotEnrolled = "Two-step verification is not set up for this account. Ask for a reset link.", ErrSuspended = "This hospital account is suspended. Contact support.",
        ErrNetwork = "Can’t reach the server. Check the network and try again.", ErrGeneric = "Something went wrong. Try again.", Close = "Close",
        Nav = ["Appointments", "Find booking", "Sync", "Settings"],
        Today = "Today", Search = "Search name or booking no.", All = "All", Waiting = "Awaiting", Arrived = "Arrived", NoShow = "No-show", AllDepts = "All departments",
        CTime = "Time", CPatient = "Patient", CDept = "Department", CRef = "Booking no.", CStatus = "Status", CIn = "Check-in",
        PillOnline = "Online · synced", PillOffline = "Offline", PendingN = n => "Offline · " + n + " pending", Syncing = "Syncing…",
        OfflineBanner = "No connection. Check-in updates are saved on this PC and sent automatically when the connection returns.",
        Synced = n => n + " update(s) synced.",
        Conflict = (nm, t) => "Conflict on " + nm + ": the QR scanner recorded arrival at " + t + " before your update. The earlier time was kept and both edits were logged.",
        Live = nm => "Check-in received from phone scanner: " + nm,
        Grace = m => "Server marks no-show automatically after " + m + " min",
        PendingTip = "Saved locally, waiting to sync", Empty = "No matching bookings.", Phone = "Phone", Date = "Appointment", Dept = "Department",
        Src = new() { ["qr"] = "via QR scanner", ["reception"] = "manually at reception", ["auto"] = "automatically by server", ["correction"] = "by manual correction" },
        MarkArrived = "Check in manually", Correct = "Correct status", ReasonPh = "Reason for correction (required)", SaveCorr = "Save correction",
        CorrNote = "Corrections are logged with reason, time and account in the audit log.", History = "History",
        HBooked = "Booked via link", HQr = "Arrived · QR scanner", HRec = "Arrived · reception", HAuto = m => "No-show · automatic after " + m + " min",
        HCorr = (st, r) => "Corrected to “" + st + "”: " + r,
        Cancelled = "Cancelled", RoleReception = "Reception", RoleAdmin = "Hospital admin", RoleScanner = "QR scanner", RoleDoctor = "Doctor",
        NotForWindows = "This account can’t use the Windows app.",
        SessionEnded = "Your session ended. Sign in again.", DeviceRevoked = "This PC was revoked in the hospital settings. Sign in again to register it.",
        ReasonMin = "Write a reason of at least 5 characters.", NotToday = "Check-in is only possible on the appointment day.", CheckedIn = "Checked in",
        CorrSaved = "Correction saved.", NeedsReview = "Conflicting corrections · needs review",
        FindTitle = "Find booking", FindSub = "Enter the full booking number exactly as it appears on the patient’s confirmation. Name search isn’t allowed, to protect privacy.",
        FindPh = "ML-XXXXXX", FindBtn = "Find", FindNone = "No booking with that number in the local copy (yesterday to 30 days ahead).",
        FindFormat = "Enter the full booking number, e.g. ML-7K3Q9P.",
        SyncTitle = "Sync", SyncNow = "Sync now", PendingCount = "Waiting to sync", LastSync = "Last sync", Never = "Not yet",
        RejectedTitle = "Updates the server rejected", RejectedNone = "No rejected updates.",
        SettingsTitle = "Settings", Language = "Language", DeviceName = "Device name", DeviceId = "Device ID", ServerAddress = "Server address",
        ServerNote = "The server address is set at installation and can’t be changed here.", AppVersion = "Version", UpdateReady = "MEDLINK {0} is ready and will be installed the next time the app opens. Unsent check-ins are kept.", UpdateClose = "Close to update", TestConnection = "Test connection",
        ConnOk = "The server connection works.", ConnFail = "Can’t reach the server.",
        SignOutPending = "Some check-in updates haven’t been sent yet. They stay on this PC and are sent when you sign in again.", SignOutConfirm = "Sign out anyway",
        ReadOnlyDoctor = "View only: your departments’ appointments, without phone numbers.", Loading = "Loading…",
        LocalOnly = n => n + " update(s) saved locally",
        RejectCodes = new() { ["CANCELLED"] = "Booking cancelled", ["OTHER_DAY"] = "Not the appointment day", ["NOT_FOUND"] = "Booking not found", ["BAD_TIME"] = "PC clock is wrong",
            ["FORBIDDEN"] = "Not permitted", ["REASON_REQUIRED"] = "Reason required" },
    };

    public static readonly Strings Tr = new()
    {
        WinTitle = "MEDLINK — Hastane uygulaması", BrandLine = "Hastane randevuları ve giriş kaydı, MEDLINK merkezi hizmetine bağlı.",
        Online = "Sunucuya bağlı", Offline = "İnternet bağlantısı yok",
        OfflineNote = "Giriş için hesabınızın sunucuda doğrulanması gerekir. Ağı kontrol edip tekrar deneyin.",
        SignIn = "Giriş yap", SignInSub = "KHATIB TECHNICAL SOLUTIONS tarafından oluşturulan hastane hesabınızı kullanın.",
        Password = "Şifre", Show = "Göster", Hide = "Gizle", Caps = "Caps Lock açık.", Submit = "Giriş yap", Submitting = "Doğrulanıyor…",
        Forgot = "Şifremi unuttum", ConnSettings = "Bağlantı ayarları",
        ErrBad = "Kullanıcı adı veya şifre hatalı.",
        ErrLocked = "Çok sayıda başarısız denemeden sonra giriş durduruldu. 15 dakika sonra deneyin veya destekle iletişime geçin.",
        SignOut = "Çıkış yap", ForgotTitle = "Şifre kurtarma",
        ForgotBody = "WhatsApp, KHATIB TECHNICAL SOLUTIONS desteğine hazır bir mesajla açılacak. Mesajı kontrol edip kendiniz gönderin.",
        ForgotWarn = "Şifrenizi veya herhangi bir kodu WhatsApp ile göndermeyin. Şifreniz yalnızca kimliğiniz doğrulandıktan sonra değişir; sıfırlama adımları güvenli şekilde iletilir.",
        ForgotStaff = "Kayıt, doktor ve tarayıcı personeli: hastane yöneticinizden sıfırlama bağlantısı isteyin.",
        WaMsg = (u, h) => "Merhaba, MEDLINK hesap şifremi kurtarmam gerekiyor.\nKullanıcı adı: " + (u.Length > 0 ? u : "—") + "\nHastane: " + (h.Length > 0 ? h : "—"),
        OpenWa = "WhatsApp’ı aç", Cancel = "İptal",
        Email = "E-posta", TotpTitle = "Doğrulama kodu", TotpSub = "Kimlik doğrulama uygulamanızdaki 6 haneli kodu girin.", TotpLabel = "Kod",
        Verify = "Doğrula", Back = "Geri", ErrRate = "Bu cihazdan çok fazla deneme yapıldı. Bir dakika bekleyip tekrar deneyin.",
        ErrMfaNotEnrolled = "Bu hesapta iki adımlı doğrulama kurulu değil. Sıfırlama bağlantısı isteyin.", ErrSuspended = "Bu hastane hesabı askıya alındı. Destekle iletişime geçin.",
        ErrNetwork = "Sunucuya ulaşılamıyor. Ağı kontrol edip tekrar deneyin.", ErrGeneric = "Bir sorun oluştu. Tekrar deneyin.", Close = "Kapat",
        Nav = ["Randevular", "Rezervasyon bul", "Senkronizasyon", "Ayarlar"],
        Today = "Bugün", Search = "Ad veya randevu no. ara", All = "Tümü", Waiting = "Bekleniyor", Arrived = "Geldi", NoShow = "Gelmedi", AllDepts = "Tüm bölümler",
        CTime = "Saat", CPatient = "Hasta", CDept = "Bölüm", CRef = "Randevu no.", CStatus = "Durum", CIn = "Giriş",
        PillOnline = "Çevrim içi · senkron", PillOffline = "Çevrim dışı", PendingN = n => "Çevrim dışı · " + n + " bekliyor", Syncing = "Senkronize ediliyor…",
        OfflineBanner = "Bağlantı yok. Giriş güncellemeleri bu bilgisayarda saklanır ve bağlantı gelince otomatik gönderilir.",
        Synced = n => n + " güncelleme senkronize edildi.",
        Conflict = (nm, t) => nm + " için çakışma: QR tarayıcı gelişi sizden önce " + t + " olarak kaydetti. Erken saat korundu, iki işlem de kaydedildi.",
        Live = nm => "Telefon tarayıcısından giriş alındı: " + nm,
        Grace = m => "Sunucu " + m + " dk sonra otomatik \"gelmedi\" işaretler",
        PendingTip = "Yerel kayıtlı, senkronizasyon bekliyor", Empty = "Eşleşen randevu yok.", Phone = "Telefon", Date = "Randevu", Dept = "Bölüm",
        Src = new() { ["qr"] = "QR tarayıcı ile", ["reception"] = "kayıt biriminde elle", ["auto"] = "sunucu tarafından otomatik", ["correction"] = "elle düzeltme ile" },
        MarkArrived = "Elle giriş yap", Correct = "Durumu düzelt", ReasonPh = "Düzeltme nedeni (zorunlu)", SaveCorr = "Düzeltmeyi kaydet",
        CorrNote = "Düzeltmeler neden, saat ve hesapla denetim kaydına yazılır.", History = "Geçmiş",
        HBooked = "Bağlantı ile randevu alındı", HQr = "Geldi · QR tarayıcı", HRec = "Geldi · kayıt birimi", HAuto = m => "Gelmedi · " + m + " dk sonra otomatik",
        HCorr = (st, r) => "\"" + st + "\" olarak düzeltildi: " + r,
        Cancelled = "İptal", RoleReception = "Kayıt birimi", RoleAdmin = "Hastane yöneticisi", RoleScanner = "QR tarayıcı", RoleDoctor = "Doktor",
        NotForWindows = "Bu hesap Windows uygulamasını kullanamaz.",
        SessionEnded = "Oturumunuz sona erdi. Tekrar giriş yapın.", DeviceRevoked = "Bu bilgisayar hastane ayarlarından iptal edildi. Yeniden kaydetmek için tekrar giriş yapın.",
        ReasonMin = "En az 5 karakterlik bir neden yazın.", NotToday = "Giriş yalnızca randevu gününde yapılabilir.", CheckedIn = "Giriş yapıldı",
        CorrSaved = "Düzeltme kaydedildi.", NeedsReview = "Çelişen düzeltmeler · inceleme gerekli",
        FindTitle = "Rezervasyon bul", FindSub = "Randevu numarasını hastanın onayında göründüğü gibi tam girin. Gizlilik için isimle arama yapılamaz.",
        FindPh = "ML-XXXXXX", FindBtn = "Bul", FindNone = "Yerel kopyada bu numarada randevu yok (dünden 30 gün sonrasına kadar).",
        FindFormat = "Tam randevu numarasını girin, örn. ML-7K3Q9P.",
        SyncTitle = "Senkronizasyon", SyncNow = "Şimdi senkronize et", PendingCount = "Senkronizasyon bekleyen", LastSync = "Son senkronizasyon", Never = "Henüz yok",
        RejectedTitle = "Sunucunun reddettiği güncellemeler", RejectedNone = "Reddedilen güncelleme yok.",
        SettingsTitle = "Ayarlar", Language = "Dil", DeviceName = "Cihaz adı", DeviceId = "Cihaz kimliği", ServerAddress = "Sunucu adresi",
        ServerNote = "Sunucu adresi kurulumda ayarlanır ve buradan değiştirilemez.", AppVersion = "Sürüm", UpdateReady = "MEDLINK {0} hazır; uygulama bir sonraki açılışta güncellenecek. Gönderilmemiş girişler korunur.", UpdateClose = "Güncellemek için kapat", TestConnection = "Bağlantıyı test et",
        ConnOk = "Sunucu bağlantısı çalışıyor.", ConnFail = "Sunucuya ulaşılamıyor.",
        SignOutPending = "Henüz gönderilmemiş giriş güncellemeleri var. Bu bilgisayarda kalır ve tekrar giriş yaptığınızda gönderilir.", SignOutConfirm = "Yine de çıkış yap",
        ReadOnlyDoctor = "Yalnızca görüntüleme: bölümlerinizin randevuları, telefon numaraları olmadan.", Loading = "Yükleniyor…",
        LocalOnly = n => n + " güncelleme yerel olarak kayıtlı",
        RejectCodes = new() { ["CANCELLED"] = "Randevu iptal", ["OTHER_DAY"] = "Randevu günü değil", ["NOT_FOUND"] = "Randevu bulunamadı", ["BAD_TIME"] = "Bilgisayar saati yanlış",
            ["FORBIDDEN"] = "Yetki yok", ["REASON_REQUIRED"] = "Neden gerekli" },
    };

    public string StatusLabel(string status) => status switch
    {
        "waiting" => Waiting, "arrived" => Arrived, "no_show" => NoShow, "cancelled" => Cancelled, _ => status,
    };

    public string RoleLabel(IReadOnlyCollection<string> roles) =>
        roles.Contains("hosp_admin") ? RoleAdmin : roles.Contains("reception") ? RoleReception : roles.Contains("doctor") ? RoleDoctor
        : roles.Contains("scanner") ? RoleScanner : "";
}
