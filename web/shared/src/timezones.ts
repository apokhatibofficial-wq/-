/**
 * Time zones offered in the console and hospital settings (the server accepts any IANA zone).
 * The region MEDLINK serves first, then a few common ones.
 */
export const TIMEZONES = [
  'Africa/Tripoli', 'Europe/Istanbul', 'Africa/Cairo', 'Africa/Tunis', 'Africa/Algiers', 'Africa/Casablanca',
  'Africa/Khartoum', 'Asia/Riyadh', 'Asia/Kuwait', 'Asia/Qatar', 'Asia/Bahrain', 'Asia/Dubai', 'Asia/Muscat',
  'Asia/Baghdad', 'Asia/Amman', 'Asia/Beirut', 'Asia/Damascus', 'Asia/Gaza', 'Asia/Aden',
  'Europe/Vienna', 'Europe/Berlin', 'Europe/London', 'UTC',
];

/** "Africa/Tripoli · GMT+02:00", computed by the browser so it follows daylight-saving rules. */
export function tzLabel(tz: string, at = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'longOffset' })
      .formatToParts(at).find(p => p.type === 'timeZoneName');
    return tz + ' · ' + (part?.value ?? '');
  } catch {
    return tz;
  }
}

/** Keeps a hospital's current zone in the list even if it is not one of the suggested ones. */
export const tzOptions = (current?: string | null) =>
  current && !TIMEZONES.includes(current) ? [current, ...TIMEZONES] : TIMEZONES;
