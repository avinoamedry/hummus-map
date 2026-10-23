// טעינת GeoPackage עם sql.js, פענוח נקודות וצירוף תמונות וקודי כשרות.
// אין כאן גישה ל-DOM, כך שאפשר לבדוק את הקובץ גם ב-node.

export const PLACE_FIELDS = [
  'place_id', 'slug', 'name', 'name_he', 'name_en', 'addr_city', 'addr_street',
  'addr_housenumber', 'addr_neighbourhood', 'score', 'score_date', 'reviewer_note',
  'tagline', 'start_year', 'serves_hummus', 'serves_ful', 'serves_mushrooms',
  'dishes_other', 'diet_vegan', 'diet_vegetarian', 'diet_kosher', 'kashrut_type',
  'kashrut_body', 'kashrut_checked', 'diet_halal', 'diet_gluten_free', 'opening_hours',
  'phone', 'instagram', 'website', 'osm_type', 'osm_id', 'source', 'last_checked',
];
export const PHOTO_FIELDS = ['photo_id', 'place_id', 'url', 'is_main', 'sort_order', 'caption', 'credit', 'taken_date'];
export const DIET_FIELDS = ['diet_vegan', 'diet_vegetarian', 'diet_kosher', 'diet_halal', 'diet_gluten_free'];
export const DIET_VALUES = ['yes', 'no', 'only'];
const BOOL_FIELDS = ['serves_hummus', 'serves_ful', 'serves_mushrooms'];
// שדות רשות שהקוד מכיר אם המנהל יוסיף אותם (ראה CLAUDE.md סעיף 11)
const OPTIONAL_FIELDS = ['status', 'country', 'timezone'];

export class DataError extends Error {}

/**
 * מפענח GeoPackage Binary של נקודה ומחזיר [lon, lat], או null לגאומטריה ריקה/לא נקודה.
 * מבנה: 'GP', גרסה, flags, srs_id (4), מעטפה (0/32/48/64), ואחריהם WKB.
 */
export function parseGpkgPoint(blob) {
  if (!blob || blob.length < 8) return null;
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (bytes[0] !== 0x47 || bytes[1] !== 0x50) throw new DataError('geometry is not GeoPackage binary (missing "GP" magic)');
  const flags = bytes[3];
  if (flags & 0b10000) return null; // ביט 4: גאומטריה ריקה
  const envelopeCode = (flags >> 1) & 0b111;
  const envelopeSize = [0, 32, 48, 48, 64][envelopeCode];
  if (envelopeSize === undefined) throw new DataError(`invalid envelope code ${envelopeCode}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 8 + envelopeSize;
  const wkbLE = view.getUint8(o) === 1;
  let type = view.getUint32(o + 1, wkbLE);
  // EWKB/ISO: מסננים דגלי Z/M/SRID ונשארים עם הסוג הבסיסי
  const hasSrid = (type & 0x20000000) !== 0;
  type = (type & 0x0fffffff) % 1000;
  if (type !== 1) return null;
  o += 5 + (hasSrid ? 4 : 0);
  const x = view.getFloat64(o, wkbLE);
  const y = view.getFloat64(o + 8, wkbLE);
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return [x, y];
}

/**
 * מכין את הבתים לפתיחה: בודק שזה SQLite ומאפס את דגלי ה-WAL (בתים 18–19) בזיכרון.
 * sql.js עובד על עותק בזיכרון ולא רואה קבצי -wal, ולכן קריאה במצב rollback בטוחה יותר.
 */
export function prepareSqliteBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  const magic = 'SQLite format 3\u0000';
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic.charCodeAt(i)) throw new DataError('The data file is not a valid GeoPackage/SQLite file');
  }
  const wal = bytes[18] === 2 || bytes[19] === 2;
  if (wal) {
    bytes[18] = 1;
    bytes[19] = 1;
  }
  return { bytes, wal };
}

function tableColumns(db, table) {
  const res = db.exec(`PRAGMA table_info("${table}")`);
  return res.length ? res[0].values.map((r) => r[1]) : null;
}

function selectAll(db, table, wanted, warn) {
  const cols = tableColumns(db, table);
  if (!cols) {
    warn(`table "${table}" is missing`);
    return [];
  }
  for (const f of wanted) if (!cols.includes(f)) warn(`table "${table}": column "${f}" is missing`);
  const stmt = db.prepare(`SELECT * FROM "${table}"`);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function geometryColumn(db, table) {
  try {
    const res = db.exec(`SELECT column_name FROM gpkg_geometry_columns WHERE table_name = '${table}'`);
    if (res.length) return res[0].values[0][0];
  } catch { /* אין טבלת מטא-דאטה: ננסה את ברירת המחדל */ }
  return 'geom';
}

const toBool = (v) => v === 1 || v === true || v === '1' || (typeof v === 'string' && v.toLowerCase() === 'true');
const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const str = (v) => (blank(v) ? null : String(v).trim());

/** ממיר שורה גולמית מהטבלה לאובייקט מקום אחיד. */
export function normalizePlace(row, geomCol, warn) {
  const p = {};
  for (const f of [...PLACE_FIELDS, ...OPTIONAL_FIELDS]) p[f] = row[f] === undefined ? null : row[f];
  for (const f of Object.keys(p)) if (typeof p[f] === 'string') p[f] = str(p[f]);
  for (const f of BOOL_FIELDS) p[f] = toBool(p[f]);
  // כל מקום במפה מגיש חומוס כבסיס, בלי קשר לערך בשדה
  p.serves_hummus = true;
  p.score = blank(p.score) || Number.isNaN(Number(p.score)) ? null : Number(p.score);
  p.start_year = blank(p.start_year) ? null : parseInt(p.start_year, 10) || null;
  p.place_id = blank(p.place_id) ? null : Number(p.place_id);
  for (const f of DIET_FIELDS) {
    const v = p[f] ? p[f].toLowerCase() : null;
    if (v && !DIET_VALUES.includes(v)) warn(`place ${p.place_id} (${p.name}): ${f}="${p[f]}" is not yes/no/only, ignored`);
    p[f] = v && DIET_VALUES.includes(v) ? v : null;
  }
  p.dishes = (p.dishes_other || '').split(';').map((s) => s.trim()).filter(Boolean);
  p.lonlat = null;
  try {
    p.lonlat = parseGpkgPoint(row[geomCol]);
  } catch (e) {
    warn(`place ${p.place_id} (${p.name}): ${e.message}`);
  }
  if (!p.slug && p.place_id !== null) p.slug = String(p.place_id);
  p.photos = [];
  return p;
}

// ערכי status שמסתירים מקום מהאתר. כל ערך אחר, או שדה ריק, מפרסם אותו
export const HIDDEN_STATUSES = ['closed', 'hidden'];

/** כל מקום מתפרסם, גם בלי ציון, אלא אם status מסתיר אותו. */
export function isPublished(p) {
  return !(p.status && HIDDEN_STATUSES.includes(p.status.toLowerCase()));
}

/**
 * פותח את ה-GPKG ומחזיר { places, kashrutTypes, warnings, wal }.
 * SQL הוא אובייקט sql.js מאותחל (initSqlJs).
 */
export function readGpkg(SQL, buffer) {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const { bytes, wal } = prepareSqliteBytes(buffer);
  if (wal) warn('the GeoPackage header is in WAL mode; it was read in memory as a regular file. Make sure QGIS was closed before uploading.');
  let db;
  try {
    db = new SQL.Database(bytes);
    db.exec('SELECT count(*) FROM sqlite_master');
  } catch (e) {
    throw new DataError(`Could not open the data file: ${e.message}`);
  }
  try {
    const geomCol = geometryColumn(db, 'hummus_places');
    const places = selectAll(db, 'hummus_places', ['geom', ...PLACE_FIELDS], warn).map((r) => normalizePlace(r, geomCol, warn));
    const photos = selectAll(db, 'place_photos', PHOTO_FIELDS, warn);
    const kashrutTypes = Object.fromEntries(
      selectAll(db, 'kashrut_types', ['code', 'label_he'], warn)
        .filter((k) => !blank(k.code))
        .map((k) => [String(k.code).trim(), { code: String(k.code).trim(), label_he: str(k.label_he), label_en: str(k.label_en) }]),
    );

    const byId = new Map(places.filter((p) => p.place_id !== null).map((p) => [p.place_id, p]));
    for (const ph of photos) {
      const place = byId.get(Number(ph.place_id));
      if (!place || blank(ph.url)) continue;
      place.photos.push({ ...ph, url: String(ph.url).trim(), is_main: toBool(ph.is_main), sort_order: Number(ph.sort_order) || 0 });
    }
    for (const p of places) {
      p.photos.sort((a, b) => b.is_main - a.is_main || a.sort_order - b.sort_order);
      p.mainPhoto = p.photos.find((ph) => ph.is_main) || p.photos[0] || null;
      p.kashrut = p.kashrut_type ? kashrutTypes[p.kashrut_type] || null : null;
    }
    return { places, kashrutTypes, photos, warnings, wal };
  } finally {
    db.close();
  }
}

/** טעינה בדפדפן: מוריד את הקובץ ומפענח. */
export async function loadData(url, initSqlJs) {
  // ה-WASM וקובץ הנתונים נטענים במקביל
  const [SQL, buffer] = await Promise.all([
    initSqlJs({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/sql.js@1.14.2/dist/${f}` }),
    fetch(url, { cache: 'no-cache' }).then((res) => {
      if (!res.ok) throw new DataError(`Could not download the data file (${res.status})`);
      return res.arrayBuffer();
    }),
  ]);
  return readGpkg(SQL, buffer);
}

/** כתובת תמונה: שם קובץ בתיקיית photos/ או כתובת מלאה. */
export function photoUrl(url) {
  if (/^(https?:)?\/\//i.test(url) || url.startsWith('data:')) return url;
  return `photos/${url.replace(/^\/?(photos\/)?/, '')}`;
}
