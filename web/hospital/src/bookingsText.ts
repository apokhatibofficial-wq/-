/** Bookings page copy (the design has no mock-up for it; tone follows the Windows dashboard). */
export const BT = {
  ar: {
    today: 'اليوم', prev: 'اليوم السابق', next: 'اليوم التالي', searchRef: 'رقم الحجز', find: 'بحث',
    searchNote: 'البحث برقم الحجز الكامل فقط، ولا يُسمح بالبحث بالاسم.', refFormat: 'أدخل رقم الحجز كاملًا، مثل ML-7K3Q9P.',
    time: 'الوقت', ref: 'رقم الحجز', patient: 'المريض', department: 'القسم', statusLabel: 'الحالة', phone: 'الهاتف', when: 'الموعد',
    none: 'لا توجد حجوزات في هذا اليوم.', notFound: 'لا يوجد حجز بهذا الرقم.', answers: 'إجابات النموذج', close: 'إغلاق', yes: 'نعم', no: 'لا',
    status: { waiting: 'بانتظار الحضور', arrived: 'حضر', no_show: 'لم يحضر', cancelled: 'ملغى' },
    cancelTitle: 'إلغاء الحجز', reasonPh: 'سبب الإلغاء (إلزامي)', confirmCancel: 'تأكيد الإلغاء',
    cancelNote: 'يصبح الموعد متاحًا لحجز جديد. لا يمكن التراجع عن الإلغاء.', cancelled: 'أُلغي الحجز.', cancelReason: 'سبب الإلغاء',
    notCancellable: 'لا يمكن إلغاء هذا الحجز في حالته الحالية.', generic: 'حدث خطأ غير متوقع.',
  },
  en: {
    today: 'Today', prev: 'Previous day', next: 'Next day', searchRef: 'Booking number', find: 'Find',
    searchNote: 'Search by the full booking number only; name search is not allowed.', refFormat: 'Enter the full booking number, e.g. ML-7K3Q9P.',
    time: 'Time', ref: 'Booking no.', patient: 'Patient', department: 'Department', statusLabel: 'Status', phone: 'Phone', when: 'Appointment',
    none: 'No bookings on this day.', notFound: 'No booking with that number.', answers: 'Form answers', close: 'Close', yes: 'Yes', no: 'No',
    status: { waiting: 'Waiting', arrived: 'Arrived', no_show: 'No-show', cancelled: 'Cancelled' },
    cancelTitle: 'Cancel booking', reasonPh: 'Reason for cancelling (required)', confirmCancel: 'Confirm cancel',
    cancelNote: 'The slot becomes free for a new booking. Cancelling can’t be undone.', cancelled: 'Booking cancelled.', cancelReason: 'Cancel reason',
    notCancellable: 'This booking can’t be cancelled in its current state.', generic: 'Something went wrong.',
  },
  tr: {
    today: 'Bugün', prev: 'Önceki gün', next: 'Sonraki gün', searchRef: 'Randevu numarası', find: 'Bul',
    searchNote: 'Yalnızca tam randevu numarasıyla arama yapılır; isimle arama yapılamaz.', refFormat: 'Tam randevu numarasını girin, örn. ML-7K3Q9P.',
    time: 'Saat', ref: 'Randevu no.', patient: 'Hasta', department: 'Bölüm', statusLabel: 'Durum', phone: 'Telefon', when: 'Randevu',
    none: 'Bu günde randevu yok.', notFound: 'Bu numarada randevu yok.', answers: 'Form yanıtları', close: 'Kapat', yes: 'Evet', no: 'Hayır',
    status: { waiting: 'Bekleniyor', arrived: 'Geldi', no_show: 'Gelmedi', cancelled: 'İptal' },
    cancelTitle: 'Randevuyu iptal et', reasonPh: 'İptal nedeni (zorunlu)', confirmCancel: 'İptali onayla',
    cancelNote: 'Saat yeni randevuya açılır. İptal geri alınamaz.', cancelled: 'Randevu iptal edildi.', cancelReason: 'İptal nedeni',
    notCancellable: 'Bu randevu mevcut durumunda iptal edilemez.', generic: 'Bir sorun oluştu.',
  },
};
