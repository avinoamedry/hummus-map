import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import initSqlJs from 'sql.js';
import { parseGpkgPoint, prepareSqliteBytes, readGpkg, isPublished, photoUrl, DataError } from '../js/data.js';

const GPKG = new URL('../data/hummus_app.gpkg', import.meta.url);
const SQL = await initSqlJs();

// בונה GeoPackage Binary של נקודה עם מעטפה וסדר בתים לבחירה
function gpBlob(x, y, { envelope = 0, headerLE = true, wkbLE = true, empty = false } = {}) {
  const envSize = [0, 32, 48, 48, 64][envelope];
  const buf = new ArrayBuffer(8 + envSize + 21);
  const v = new DataView(buf);
  v.setUint8(0, 0x47); v.setUint8(1, 0x50); v.setUint8(2, 0);
  v.setUint8(3, (headerLE ? 1 : 0) | (envelope << 1) | (empty ? 16 : 0));
  v.setInt32(4, 4326, headerLE);
  for (let i = 0; i < envSize / 8; i++) v.setFloat64(8 + i * 8, 999, headerLE);
  const o = 8 + envSize;
  v.setUint8(o, wkbLE ? 1 : 0);
  v.setUint32(o + 1, 1, wkbLE);
  v.setFloat64(o + 5, x, wkbLE);
  v.setFloat64(o + 13, y, wkbLE);
  return new Uint8Array(buf);
}

test('Kafka Hummus Café decodes from the real GeoPackage', () => {
  const db = new SQL.Database(readFileSync(GPKG));
  const [[blob]] = db.exec("SELECT geom FROM hummus_places WHERE osm_id = 296454184")[0].values;
  assert.deepEqual(parseGpkgPoint(blob), [14.418658, 50.089096]);
});

test('envelope sizes 0/32/48/64 and both byte orders', () => {
  for (const envelope of [0, 1, 2, 3, 4]) {
    for (const headerLE of [true, false]) {
      for (const wkbLE of [true, false]) {
        assert.deepEqual(parseGpkgPoint(gpBlob(14.418658, 50.089096, { envelope, headerLE, wkbLE })), [14.418658, 50.089096],
          `envelope=${envelope} headerLE=${headerLE} wkbLE=${wkbLE}`);
      }
    }
  }
});

test('empty geometry and null give null; bad magic throws', () => {
  assert.equal(parseGpkgPoint(gpBlob(0, 0, { empty: true })), null);
  assert.equal(parseGpkgPoint(null), null);
  assert.throws(() => parseGpkgPoint(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])), DataError);
});

test('readGpkg returns places, kashrut codes and photos', () => {
  const { places, kashrutTypes, warnings } = readGpkg(SQL, readFileSync(GPKG));
  assert.equal(places.length, 24);
  assert.deepEqual(Object.keys(kashrutTypes).sort(), ['badatz', 'none', 'private', 'rabbanut', 'rabbanut_mehadrin', 'unknown']);
  const kafka = places.find((p) => p.slug === 'kafka-hummus-cafe');
  assert.deepEqual(kafka.lonlat, [14.418658, 50.089096]);
  assert.equal(isPublished(kafka), false, 'no score yet, so not published');
  assert.deepEqual(warnings, []);
});

test('a WAL-mode header is patched in memory and still reads', () => {
  const bytes = new Uint8Array(readFileSync(GPKG));
  bytes[18] = 2; bytes[19] = 2;
  const prepared = prepareSqliteBytes(bytes);
  assert.equal(prepared.wal, true);
  assert.equal(prepared.bytes[18], 1);
  const { places, warnings } = readGpkg(SQL, bytes);
  assert.equal(places.length, 24);
  assert.match(warnings[0], /WAL/);
});

test('a corrupt file raises a DataError instead of crashing', () => {
  assert.throws(() => readGpkg(SQL, new TextEncoder().encode('<html>404</html>')), DataError);
  const truncated = new Uint8Array(readFileSync(GPKG)).slice(0, 2048);
  assert.throws(() => readGpkg(SQL, truncated), DataError);
});

test('missing columns warn but places still load; bad diet values are dropped', () => {
  const db = new SQL.Database();
  db.run(`CREATE TABLE hummus_places (fid INTEGER PRIMARY KEY, geom BLOB, place_id INT, name TEXT, score REAL, serves_hummus BOOLEAN, diet_vegan TEXT);
          INSERT INTO hummus_places VALUES (1, NULL, 7, 'Test', 4.5, 1, 'limited');`);
  const { places, warnings } = readGpkg(SQL, db.export());
  assert.equal(places.length, 1);
  assert.equal(places[0].diet_vegan, null);
  assert.equal(isPublished(places[0]), true);
  assert.ok(warnings.some((w) => w.includes('"slug" is missing')));
  assert.ok(warnings.some((w) => w.includes('limited')));
  assert.ok(warnings.some((w) => w.includes('table "place_photos" is missing')));
});

test('photos: main first, then sort_order; url can be a file name or a full URL', () => {
  const db = new SQL.Database(readFileSync(GPKG));
  db.run(`INSERT INTO place_photos (photo_id, place_id, url, is_main, sort_order) VALUES
          (1, 1, 'b.jpg', 0, 2), (2, 1, 'https://example.org/a.jpg', 0, 1), (3, 1, 'main.webp', 1, 9)`);
  const kafka = readGpkg(SQL, db.export()).places.find((p) => p.place_id === 1);
  assert.deepEqual(kafka.photos.map((p) => p.url), ['main.webp', 'https://example.org/a.jpg', 'b.jpg']);
  assert.equal(kafka.mainPhoto.url, 'main.webp');
  assert.equal(photoUrl('main.webp'), 'photos/main.webp');
  assert.equal(photoUrl('photos/main.webp'), 'photos/main.webp');
  assert.equal(photoUrl('https://example.org/a.jpg'), 'https://example.org/a.jpg');
});
