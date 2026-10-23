// עטיפה ל-opening_hours.js: Open now, שעות היום והשבוע המלא, לפי אזור הזמן של המקום.
// הספרייה גדולה (כולל לוחות חגים), ולכן נטענת ברקע: הרשימה מוצגת מיד, והשעות מתווספות כשהיא מוכנה.
let OpeningHours = null;
export const hoursReady = import('opening_hours')
  .then((m) => { OpeningHours = m.default; })
  .catch((e) => console.error('[hours] opening_hours.js failed to load', e));

// מלבני תיחום גסים של מדינות אירופה: [קוד, אזור זמן, minLon, minLat, maxLon, maxLat].
// נבחר המלבן שהנקודה הכי קרובה למרכזו, ביחס לאלכסון שלו. זה קירוב: ליד גבולות עדיף שדה country ידני.
const COUNTRIES = [
  ['pt', 'Europe/Lisbon', -9.6, 36.9, -6.1, 42.2], ['es', 'Europe/Madrid', -9.4, 35.9, 4.4, 43.8],
  ['ie', 'Europe/Dublin', -10.7, 51.4, -5.9, 55.4], ['gb', 'Europe/London', -8.7, 49.8, 1.8, 60.9],
  ['fr', 'Europe/Paris', -5.2, 41.3, 9.6, 51.1], ['be', 'Europe/Brussels', 2.5, 49.5, 6.4, 51.5],
  ['nl', 'Europe/Amsterdam', 3.3, 50.7, 7.3, 53.6], ['lu', 'Europe/Luxembourg', 5.7, 49.4, 6.6, 50.2],
  ['de', 'Europe/Berlin', 5.9, 47.2, 15.1, 55.1], ['ch', 'Europe/Zurich', 5.9, 45.8, 10.5, 47.9],
  ['li', 'Europe/Vaduz', 9.47, 47.04, 9.64, 47.28], ['at', 'Europe/Vienna', 9.5, 46.3, 17.2, 49.1],
  ['it', 'Europe/Rome', 6.6, 35.4, 18.6, 47.1], ['mt', 'Europe/Malta', 14.1, 35.8, 14.6, 36.1],
  ['dk', 'Europe/Copenhagen', 8.0, 54.5, 15.2, 57.8], ['no', 'Europe/Oslo', 4.5, 57.9, 31.2, 71.2],
  ['se', 'Europe/Stockholm', 11.0, 55.3, 24.2, 69.1], ['fi', 'Europe/Helsinki', 20.5, 59.8, 31.6, 70.1],
  ['ee', 'Europe/Tallinn', 21.7, 57.5, 28.2, 59.7], ['lv', 'Europe/Riga', 20.9, 55.6, 28.3, 58.1],
  ['lt', 'Europe/Vilnius', 20.9, 53.9, 26.9, 56.5], ['pl', 'Europe/Warsaw', 14.1, 49.0, 24.2, 54.9],
  ['cz', 'Europe/Prague', 12.09, 48.55, 18.86, 51.06], ['sk', 'Europe/Bratislava', 16.83, 47.73, 22.57, 49.61],
  ['hu', 'Europe/Budapest', 16.1, 45.7, 22.9, 48.6], ['si', 'Europe/Ljubljana', 13.4, 45.4, 16.6, 46.9],
  ['hr', 'Europe/Zagreb', 13.5, 42.4, 19.5, 46.6], ['ba', 'Europe/Sarajevo', 15.7, 42.5, 19.7, 45.3],
  ['rs', 'Europe/Belgrade', 18.8, 42.2, 23.1, 46.2], ['me', 'Europe/Podgorica', 18.4, 41.8, 20.4, 43.6],
  ['xk', 'Europe/Belgrade', 20.0, 41.8, 21.8, 43.3], ['al', 'Europe/Tirane', 19.2, 39.6, 21.1, 42.7],
  ['mk', 'Europe/Skopje', 20.4, 40.8, 23.1, 42.4], ['gr', 'Europe/Athens', 19.3, 34.8, 29.7, 41.8],
  ['bg', 'Europe/Sofia', 22.3, 41.2, 28.7, 44.3], ['ro', 'Europe/Bucharest', 20.2, 43.6, 29.8, 48.3],
  ['md', 'Europe/Chisinau', 26.6, 45.4, 30.2, 48.5], ['ua', 'Europe/Kyiv', 22.1, 44.3, 40.3, 52.4],
  ['by', 'Europe/Minsk', 23.1, 51.2, 32.8, 56.2], ['cy', 'Asia/Nicosia', 32.2, 34.5, 34.6, 35.7],
  ['tr', 'Europe/Istanbul', 26.0, 35.8, 44.8, 42.1], ['is', 'Atlantic/Reykjavik', -24.6, 63.3, -13.4, 66.6],
  ['ad', 'Europe/Andorra', 1.4, 42.4, 1.8, 42.7], ['mc', 'Europe/Monaco', 7.4, 43.72, 7.44, 43.76],
  ['sm', 'Europe/San_Marino', 12.4, 43.89, 12.52, 43.99], ['va', 'Europe/Vatican', 12.44, 41.9, 12.46, 41.91],
];
const TZ_BY_COUNTRY = Object.fromEntries(COUNTRIES.map((c) => [c[0], c[1]]));

/** קוד מדינה (ISO2, אותיות קטנות) לפי שדה country או לפי קואורדינטות. */
export function countryOf(place) {
  if (place.country) return place.country.toLowerCase();
  if (!place.lonlat) return null;
  const [lon, lat] = place.lonlat;
  let best = null;
  let bestScore = Infinity;
  for (const [cc, , x1, y1, x2, y2] of COUNTRIES) {
    if (lon < x1 || lon > x2 || lat < y1 || lat > y2) continue;
    const score = Math.hypot(lon - (x1 + x2) / 2, lat - (y1 + y2) / 2) / Math.hypot(x2 - x1, y2 - y1);
    if (score < bestScore) [best, bestScore] = [cc, score];
  }
  return best;
}

export function timezoneOf(place) {
  if (place.timezone) return place.timezone;
  return TZ_BY_COUNTRY[countryOf(place)] || null;
}

/**
 * "שעון קיר" באזור הזמן של המקום, כ-Date מקומי של הדפדפן.
 * opening_hours.js עובד על שדות הזמן המקומיים, ולכן מזיזים את השעון במקום להמיר.
 */
export function wallClock(date, tz) {
  if (!tz) return new Date(date);
  let parts;
  try {
    parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(date).map((p) => [p.type, p.value]),
    );
  } catch {
    return new Date(date);
  }
  return new Date(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
}

const pad = (n) => String(n).padStart(2, '0');
export const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const DAY = 864e5;

/** מפענח ערך שעות. מחזיר { oh } או { error } (גם לשדה ריק). */
export function parseHours(value, place = {}) {
  if (!value) return { error: 'empty' };
  if (!OpeningHours) return { error: 'library not loaded', pending: true };
  const cc = countryOf(place);
  const [lon, lat] = place.lonlat || [14.4, 50];
  try {
    const oh = new OpeningHours(value, { lat, lon, address: { country_code: cc || 'de', state: '' } }, { locale: 'en' });
    return { oh, warnings: oh.getWarnings() };
  } catch (e) {
    return { error: String(e).split('\n')[0] };
  }
}

/** טווחי הפתיחה שמתחילים ביום נתון (מה שגולש מהיום הקודם אחרי חצות לא נספר). */
export function dayIntervals(oh, day) {
  const from = startOfDay(day);
  const to = addDays(from, 1);
  const out = [];
  for (const [s, e, unknown, comment] of oh.getOpenIntervals(addDays(from, -1), addDays(from, 2))) {
    if (s <= from && e >= to) out.push({ allDay: true, start: from, end: e, unknown, comment });
    else if (s >= from && s < to) out.push({ start: s, end: e, unknown, comment });
  }
  return out;
}

export function formatIntervals(intervals, t) {
  if (!intervals.length) return t.closedAllDay;
  if (intervals.some((i) => i.allDay)) return t.open24h;
  return intervals.map((i) => {
    const endText = i.end - i.start >= DAY ? '24:00' : hhmm(i.end);
    return `${hhmm(i.start)}–${endText}`;
  }).join(', ');
}

/**
 * מצב השעות של מקום ברגע נתון:
 * { state: 'open'|'closed'|'unknown', today, nextChange, note, week: [{ label, text, isToday }] }
 */
export function hoursStatus(place, t, now = new Date()) {
  const parsed = place._hours || parseHours(place.opening_hours, place);
  if (!parsed.pending) place._hours = parsed;
  if (parsed.error) return { state: 'unknown', error: parsed.error, pending: parsed.pending };
  const { oh } = parsed;
  const local = wallClock(now, timezoneOf(place));
  const unknown = oh.getUnknown(local);
  const isOpen = oh.getState(local);
  const next = oh.getNextChange(local);
  const state = unknown ? 'unknown' : isOpen ? 'open' : 'closed';
  let note = '';
  if (state === 'open') note = next ? t.closesAt(hhmm(next), next - local < DAY ? '' : dayName(next, local, t)) : t.openAlways;
  else if (state === 'closed' && next) note = t.opensAt(hhmm(next), dayName(next, local, t));

  const today = formatIntervals(dayIntervals(oh, local), t);
  const monday = addDays(startOfDay(local), -((local.getDay() + 6) % 7));
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(monday, i);
    return { label: t.days[i], text: formatIntervals(dayIntervals(oh, d), t), isToday: sameDay(d, local) };
  });
  return { state, today, note, nextChange: next || null, week, comment: oh.getComment(local) || '' };
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function dayName(next, local, t) {
  if (sameDay(next, local)) return '';
  if (sameDay(next, addDays(local, 1))) return t.tomorrow;
  return t.days[(next.getDay() + 6) % 7];
}
