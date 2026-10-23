// רץ בכוונה גם עם TZ שונה (npm test מריץ עם TZ של המכונה; ראו גם TZ=America/New_York)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hoursStatus, countryOf, timezoneOf, parseHours, hoursReady } from '../js/hours.js';
import { t } from '../js/i18n.js';

await hoursReady;

const prague = [14.418658, 50.089096];
const brno = [16.610631, 49.191391];
const ostrava = [18.237022, 49.791274];
const place = (opening_hours, lonlat = prague, country = 'cz') => ({ opening_hours, lonlat, country });
const at = (iso) => new Date(iso);

test('country: the country field wins; coordinates are only a rough fallback', () => {
  assert.equal(countryOf({ lonlat: prague }), 'cz');
  assert.equal(timezoneOf({ lonlat: brno }), 'Europe/Prague');
  assert.equal(countryOf({ country: 'CZ', lonlat: ostrava }), 'cz');
  assert.equal(countryOf({ lonlat: [13.405, 52.52] }), 'de');
  assert.equal(countryOf({ lonlat: [16.37, 48.21] }), 'at');
  assert.equal(countryOf({ lonlat: [-60, 10] }), null);
  assert.equal(timezoneOf({ country: 'PT', lonlat: prague }), 'Europe/Lisbon');
});

test('Kafka "Mo-Su 09:00-18:00": open at 14:00 Prague, closed at 19:00', () => {
  const p = place('Mo-Su 09:00-18:00');
  const open = hoursStatus(p, t, at('2026-10-23T12:00:00Z')); // שישי 14:00 שעון פראג (UTC+2)
  assert.equal(open.state, 'open');
  assert.equal(open.note, 'closes at 18:00');
  assert.equal(open.today, '09:00–18:00');
  assert.equal(open.week.length, 7);
  assert.equal(open.week.find((d) => d.isToday).label, 'Friday');
  const closed = hoursStatus(p, t, at('2026-10-23T17:00:00Z'));
  assert.equal(closed.state, 'closed');
  assert.equal(closed.note, 'opens at 09:00 tomorrow');
});

test('FÉNIX overnight hours follow the OSM spec: a later day rule overrides the spill-over', () => {
  const p = place('Mo-Th 12:00-00:45; Fr 12:00-01:45; Sa 14:00-01:45; Su 14:00-23:45', brno);
  // שלישי 00:30: ההמשך של שני נשאר, כי שני ושלישי באותו כלל
  assert.equal(hoursStatus(p, t, at('2026-10-19T22:30:00Z')).state, 'open');
  // שבת 01:30: הכלל "Sa 14:00-01:45" דורס את כל יום שבת, כולל ההמשך של שישי.
  // זו התנהגות התקן; admin-check מציג את האזהרה כדי שהמנהל יתקן ל-"," אם זו לא הכוונה.
  const s = hoursStatus(p, t, at('2026-10-23T23:30:00Z'));
  assert.equal(s.state, 'closed');
  assert.equal(s.today, '14:00–00:00', 'and the Sunday rule cuts Saturday night at midnight');
  assert.equal(s.week[0].text, '12:00–00:45');
  assert.ok(parseHours(p.opening_hours, p).warnings.some((w) => w.includes('overwrites')));
});

test('Sayf "24/7"', () => {
  const s = hoursStatus(place('24/7'), t, at('2026-10-23T03:00:00Z'));
  assert.equal(s.state, 'open');
  assert.equal(s.note, 'Open 24/7');
  assert.equal(s.today, 'Open 24 hours');
  assert.ok(s.week.every((d) => d.text === 'Open 24 hours'));
});

test('Dobrá Čajovna PH rule uses Czech public holidays (28 October)', () => {
  const p = place('Mo-Fr 10:00-22:00; Sa 13:00-22:00; Su 13:00-22:00; PH 13:00-22:00', ostrava);
  const regularWed = hoursStatus(p, t, at('2026-10-21T09:00:00Z')); // רביעי רגיל 11:00
  assert.equal(regularWed.state, 'open');
  const holiday = hoursStatus(p, t, at('2026-10-28T10:00:00Z')); // יום העצמאות הצ'כי, 11:00 (UTC+1)
  assert.equal(holiday.state, 'closed');
  assert.equal(holiday.note, 'opens at 13:00');
  assert.equal(holiday.today, '13:00–22:00');
});

test('Mizlala is closed all Saturday; MUJ FALAFEL opens Thursday', () => {
  const mizlala = hoursStatus(place('Mo-Th 12:00-21:30; Fr 12:00-14:00; Su 12:00-21:00'), t, at('2026-10-24T10:00:00Z'));
  assert.equal(mizlala.state, 'closed');
  assert.equal(mizlala.today, 'Closed');
  assert.equal(mizlala.note, 'opens at 12:00 tomorrow');
  const muj = hoursStatus(place('Th-Su 10:30-17:00', [15.26595, 49.948577]), t, at('2026-10-20T10:00:00Z')); // שלישי
  assert.equal(muj.note, 'opens at 10:30 Thursday');
});

test('empty or invalid hours give state "unknown"', () => {
  assert.equal(hoursStatus(place(null), t).state, 'unknown');
  assert.equal(hoursStatus(place('Mo-Fr 25:00-26:00'), t).state, 'unknown');
  assert.ok(parseHours('sometimes, call first').error);
});
