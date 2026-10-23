// בדיקות קצה-לקצה (CLAUDE.md סעיף 10). הרצה: python3 tests/make_fixture.py && npm run e2e
// ספריות ה-CDN מוגשות מ-node_modules, ואריחי המפה מוחלפים בסגנון ריק, כך שהבדיקה לא תלויה ברשת.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = join(ROOT, 'tests', 'screenshots');
await mkdir(SHOTS, { recursive: true });

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  const globalRoot = execSync('npm root -g').toString().trim();
  ({ chromium } = await import(pathToFileURL(join(globalRoot, 'playwright', 'index.mjs')).href));
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.jpg': 'image/jpeg', '.gpkg': 'application/octet-stream' };
const server = createServer(async (req, res) => {
  let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  if (path.endsWith('/')) path += 'index.html';
  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(0);
const BASE = `http://localhost:${server.address().port}/`;

const TEST_STYLE = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eeeae2' } }],
};

async function setupRoutes(context, { gpkg = 'tests/fixture.gpkg' } = {}) {
  await context.route('https://cdn.jsdelivr.net/npm/**', async (route) => {
    const m = new URL(route.request().url()).pathname.match(/^\/npm\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.+)$/);
    try {
      const file = join(ROOT, 'node_modules', m[1], m[2]);
      await route.fulfill({ body: await readFile(file), contentType: MIME[extname(file)] || 'text/plain', headers: { 'access-control-allow-origin': '*' } });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ body: '', contentType: 'text/css' }));
  await context.route('https://tiles.openfreemap.org/styles/**', (r) => r.fulfill({ json: TEST_STYLE, headers: { 'access-control-allow-origin': '*' } }));
  await context.route('https://tiles.openfreemap.org/fonts/**', (r) => r.fulfill({ status: 404 }));
  await context.route('**/data/hummus_app.gpkg*', async (r) => r.fulfill({ body: await readFile(join(ROOT, gpkg)) }));
  await context.route('**/data/config.json', (r) => r.fulfill({ json: { report_email: 'reports@example.org', accent: '#B8461A', map_center: [12, 50], map_zoom: 3.6 } }));
  await context.route('**/photos/test-*', async (r) => r.fulfill({ body: await readFile(join(ROOT, 'tests', 'photos', new URL(r.request().url()).pathname.split('/').pop())), contentType: 'image/jpeg' }));
}

const results = [];
async function check(name, fn) {
  if (process.env.VERBOSE) console.log('…', name);
  try {
    await fn();
    results.push(['ok', name]);
  } catch (e) {
    results.push(['FAIL', name, e.message.split('\n').slice(0, 14).join(' | ')]);
  }
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
// שישי 23.10.2026, 10:30 שעון פראג
const FIXED_TIME = new Date('2026-10-23T08:30:00Z');

for (const width of [390, 1280]) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  await setupRoutes(context);
  context.setDefaultTimeout(10000);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('requestfailed', (r) => errors.push(`requestfailed ${r.url()} ${r.failure()?.errorText}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.clock.install({ time: FIXED_TIME });
  const W = `[${width}px]`;
  const cards = () => page.locator('#list .card');
  const names = async () => (await page.locator('#list .card-name').allTextContents());
  const waitNames = (expected) => page.waitForFunction((exp) => JSON.stringify([...document.querySelectorAll('#list .card-name')].map((e) => e.textContent).sort()) === JSON.stringify(exp), [...expected].sort());

  await check(`${W} list loads with published places only, sorted by score`, async () => {
    await page.goto(BASE);
    await cards().first().waitFor();
    assert.equal(await cards().count(), 8);
    const n = await names();
    assert.equal(n[0], 'Kafka Hummus Café');
    assert.ok(!n.includes('Leyaly'), 'unpublished place hidden');
    assert.equal(await page.locator('#status').textContent(), '8 places');
    await page.screenshot({ path: join(SHOTS, `list-${width}.png`) });
  });

  await check(`${W} card shows photo, Open/Closed badge, tags and diet badges`, async () => {
    const kafka = cards().first();
    assert.equal(await kafka.locator('img').getAttribute('src'), 'photos/test-kafka-1.jpg');
    assert.equal(await kafka.locator('.badge.open').textContent(), 'Open');
    assert.deepEqual(await kafka.locator('.tag').allTextContents(), ['Hummus', 'Ful', 'Mushrooms']);
    assert.deepEqual(await kafka.locator('.diet').allTextContents(), ['Vegan']);
    const mizlala = page.locator('.card', { hasText: 'Mizlala' });
    assert.equal(await mizlala.locator('.badge').first().textContent(), 'Closed');
    assert.deepEqual(await mizlala.locator('.diet').allTextContents(), ['100% Vegan', 'Vegetarian', 'Kosher']);
    const elEmir = page.locator('.card', { hasText: 'El Emir' });
    assert.equal(await elEmir.locator('.badge').count(), 0, 'no hours, no badge');
    assert.equal(await page.locator('.card', { hasText: 'Sayf' }).locator('svg').first().count(), 1, 'placeholder bowl icon');
  });

  await check(`${W} search ignores case and diacritics, and finds Hebrew names`, async () => {
    await page.fill('#searchInput', 'CAJOVNA');
    await waitNames(['Dobrá Čajovna']);
    await page.fill('#searchInput', 'מזללה');
    await waitNames(['Mizlala מזללה']);
    await page.fill('#searchInput', 'brno');
    await waitNames(['Falafelo', 'FÉNIX Lounge restaurace']);
    assert.match(page.url(), /q=brno/);
    await page.fill('#searchInput', 'zzzz');
    await page.waitForSelector('#list .empty');
    await page.fill('#searchInput', '');
    await page.waitForFunction(() => document.querySelectorAll('#list .card').length === 8);
  });

  await check(`${W} chips: Ful, Vegan, Open now, and Filters (n) count`, async () => {
    await page.click('#chipFul');
    assert.deepEqual((await names()).sort(), ['Dobrá Čajovna', 'Falafelo', 'Kafka Hummus Café']);
    assert.equal(await page.locator('#chipFilters span').textContent(), 'Filters (1)');
    assert.equal(await page.locator('#chipFul').getAttribute('aria-pressed'), 'true');
    await page.click('#chipVegan');
    assert.equal(await cards().count(), 3);
    assert.equal(await page.locator('#chipFilters span').textContent(), 'Filters (2)');
    await page.click('#chipFul');
    await page.click('#chipVegan');
    await page.click('#chipOpen');
    assert.deepEqual((await names()).sort(), ['Dobrá Čajovna', 'Kafka Hummus Café', 'Sayf']);
    await page.click('#chipOpen');
    assert.equal(await cards().count(), 8);
    assert.equal(await page.locator('#chipFilters span').textContent(), 'Filters');
  });

  await check(`${W} Filters panel: min score, city, kosher, clear all`, async () => {
    await page.click('#chipFilters');
    await page.locator('#fMin').fill('4');
    assert.equal(await page.locator('#fApply').textContent(), 'Show 3 places');
    await page.screenshot({ path: join(SHOTS, `filters-${width}.png`) });
    await page.click('#fApply');
    await waitNames(['Kafka Hummus Café', 'Mizlala מזללה', 'Dobrá Čajovna']);
    assert.deepEqual(await names(), ['Kafka Hummus Café', 'Mizlala מזללה', 'Dobrá Čajovna'], 'sorted by score');
    await page.click('#chipFilters');
    await page.locator('#fMin').fill('0');
    await page.selectOption('#fCity', 'Brno');
    await page.click('#fApply');
    await waitNames(['FÉNIX Lounge restaurace', 'Falafelo']);
    await page.click('#chipFilters');
    await page.click('#fClear');
    await page.locator('label.opt', { hasText: 'Kosher' }).click();
    await page.click('#fApply');
    await waitNames(['Mizlala מזללה']);
    await page.click('#chipFilters');
    await page.click('#fClear');
    await page.click('#fApply');
    await page.waitForFunction(() => document.querySelectorAll('#list .card').length === 8);
  });

  await check(`${W} filter state lives in the URL and a shared link restores it`, async () => {
    await page.goto(`${BASE}#/?dish=ful&min=4`);
    await page.reload();
    await cards().first().waitFor();
    assert.deepEqual(await names(), ['Kafka Hummus Café', 'Dobrá Čajovna']);
    assert.equal(await page.locator('#chipFilters span').textContent(), 'Filters (2)');
    assert.equal(await page.locator('#chipFul').getAttribute('aria-pressed'), 'true');
  });

  await check(`${W} place page from a direct link matches the design blocks`, async () => {
    await page.goto(`${BASE}#/place/kafka-hummus-cafe`);
    await page.reload();
    await page.locator('#placeTitle').waitFor();
    const pane = page.locator('#placePane');
    assert.equal(await pane.locator('h1').textContent(), 'Kafka Hummus Café');
    assert.match(await pane.locator('.score-box').textContent(), /4\.6\s*Moody's score/);
    assert.equal(await pane.locator('.place-addr').textContent(), 'Praha, Široká 64/12 · Staré Město');
    assert.equal(await pane.locator('.quote').textContent(), '“Silky, warm and generous with the tahini.”');
    assert.equal(await pane.locator('.since').last().textContent(), 'Hummus since 2019, just off the Old Town Square');
    assert.deepEqual(await pane.locator('.tile span').allTextContents(), ['Hummus', 'Ful', 'Mushrooms']);
    assert.deepEqual(await pane.locator('.tags .tag').allTextContents(), ['Shakshuka', 'Sabich']);
    assert.equal(await pane.locator('.gallery img').count(), 2);
    assert.match(await pane.locator('.today-row').textContent(), /Today\s*09:00–18:00 · closes at 18:00/);
    assert.equal(await pane.locator('#weekTable').isVisible(), false);
    await pane.locator('#weekBtn').click();
    assert.equal(await pane.locator('#weekTable tr').count(), 7);
    assert.equal(await pane.locator('#weekTable tr.today td').first().textContent(), 'Friday');
    assert.equal(await pane.locator('a[aria-label="Instagram"]').getAttribute('href'), 'https://www.instagram.com/kafkahummus/');
    assert.equal(await pane.locator('a[aria-label="Website"]').getAttribute('href'), 'https://kafkahummus.cz');
    assert.equal(await pane.locator('a[aria-label^="Phone"]').getAttribute('href'), 'tel:+420123456789');
    assert.equal(await pane.locator('a', { hasText: 'Navigate' }).getAttribute('href'), 'https://www.google.com/maps/dir/?api=1&destination=50.089096,14.418658');
    const mail = await pane.locator('a', { hasText: 'Something wrong' }).getAttribute('href');
    assert.equal(decodeURIComponent(mail), 'mailto:reports@example.org?subject=Something wrong: Kafka Hummus Café (place_id 1)');
    assert.match(await pane.locator('.foot').textContent(), /© OpenStreetMap contributors/);
    await page.screenshot({ path: join(SHOTS, `place-${width}.png`), fullPage: false });
    await pane.screenshot({ path: join(SHOTS, `place-full-${width}.png`) });
  });

  await check(`${W} Share copies the link when Web Share is not available`, async () => {
    await page.evaluate(() => { navigator.share = undefined; });
    await page.click('#shareBtn');
    await page.locator('#toast', { hasText: 'Link copied' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${BASE}#/place/kafka-hummus-cafe`);
  });

  await check(`${W} kosher details and 100% badge on the Mizlala page`, async () => {
    await page.goto(`${BASE}#/place/mizlala`);
    await page.locator('#placeTitle').waitFor();
    const pane = page.locator('#placePane');
    assert.deepEqual(await pane.locator('.diet-lg').allTextContents(), ['100% Vegan', 'Vegetarian', 'Kosher']);
    assert.match(await pane.locator('.kashrut').textContent(), /Private \/ alternative supervision\s*Chabad Prague/);
    assert.match(await pane.locator('.today-row').textContent(), /12:00–14:00 · opens at 12:00/);
  });

  await check(`${W} Saved: heart, Saved chip, survives reload`, async () => {
    await page.goto(`${BASE}#/place/falafelo`);
    await page.locator('#saveBtn').click();
    assert.equal(await page.locator('#saveBtn').getAttribute('aria-pressed'), 'true');
    await page.locator('#backBtn').click();
    await page.click('#chipSaved');
    assert.deepEqual(await names(), ['Falafelo']);
    await page.reload();
    await cards().first().waitFor();
    assert.deepEqual(await names(), ['Falafelo']);
    await page.click('#chipSaved');
  });

  await check(`${W} back button returns to the list with its filters`, async () => {
    await page.goto(`${BASE}#/?dish=ful`);
    await cards().first().waitFor();
    await cards().first().click();
    await page.locator('#placeTitle').waitFor();
    await page.locator('#backBtn').click();
    await page.waitForFunction(() => location.hash === '#/?dish=ful');
    assert.equal(await cards().count(), 3);
  });

  await check(`${W} unknown and unpublished places show "not found"; ?debug=1 shows all`, async () => {
    await page.goto(`${BASE}#/place/no-such-place`);
    await page.locator('#placePane .empty').waitFor();
    await page.goto(`${BASE}#/place/leyaly`);
    await page.reload();
    await page.locator('#placePane .empty').waitFor();
    await page.goto(`${BASE}?debug=1#/`);
    await page.waitForFunction(() => document.querySelectorAll('#list .card').length === 24);
    assert.equal(await page.locator('#debugBanner').isVisible(), true);
    await page.goto(`${BASE}?debug=1#/place/leyaly`);
    await page.locator('#placeTitle').waitFor();
    assert.match(await page.locator('#placePane').textContent(), /Hours not available|Opening hours/);
  });

  await check(`${W} map: markers follow the filters, marker click opens the bottom card`, async () => {
    await page.goto(`${BASE}#/${width === 390 ? 'map' : ''}?dish=ful`);
    await page.reload();
    if (width === 390) {
      assert.equal(await page.locator('#list').isVisible(), false);
      assert.equal(await page.locator('#searchInput').isVisible(), true, 'top bar floats over the map');
    }
    await page.waitForFunction(() => window.hummus.state.mapApi?.map?.getLayer('points'), null, { timeout: 15000 });
    const count = async () => page.evaluate(async () => (await window.hummus.state.mapApi.map.getSource('places').getData()).features.length);
    assert.equal(await count(), 3);
    if (width === 390) await page.click('#chipFul');
    else await page.click('#chipFul');
    await page.waitForFunction(async () => (await window.hummus.state.mapApi.map.getSource('places').getData()).features.length === 8);
    const attribution = await page.locator('.maplibregl-ctrl-attrib').textContent();
    assert.match(attribution, /OpenFreeMap.*OpenMapTiles.*OpenStreetMap/);
    // מתקרבים לקפקא ולוחצים על הסמן
    const pt = await page.evaluate(async () => {
      const { map } = window.hummus.state.mapApi;
      map.jumpTo({ center: [14.418658, 50.089096], zoom: 16 });
      await new Promise((r) => map.once('idle', r));
      const p = map.project([14.418658, 50.089096]);
      const r = map.getCanvas().getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    });
    await page.mouse.click(pt.x, pt.y);
    await page.locator('#mapCard', { hasText: 'Kafka Hummus Café' }).waitFor();
    await page.screenshot({ path: join(SHOTS, `map-${width}.png`) });
    await page.locator('#mapCard a').click();
    await page.locator('#placeTitle', { hasText: 'Kafka' }).waitFor();
  });

  if (width === 390) {
    await check(`${W} map button toggles between list and map`, async () => {
      await page.goto(`${BASE}#/`);
      await cards().first().waitFor();
      await page.click('#viewToggle');
      await page.waitForFunction(() => document.querySelector('#viewToggle').getAttribute('aria-label') === 'Show list');
      assert.match(page.url(), /#\/map/);
      await page.click('#viewToggle');
      await page.waitForFunction(() => location.hash === '#/');
      await cards().first().waitFor({ state: 'visible' });
    });
  }

  await check(`${W} no horizontal scroll and no console errors`, async () => {
    await page.goto(`${BASE}#/`);
    await page.reload();
    await cards().first().waitFor();
    if (width > 900) await page.waitForFunction(() => window.hummus.state.mapApi?.map?.loaded());
    await page.waitForTimeout(500);
    errors.length = 0;
    await page.reload();
    await cards().first().waitFor();
    await page.waitForTimeout(1500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(overflow, 0);
    const relevant = errors.filter((e) => !/fonts|glyph|pbf|404|Failed to load resource/i.test(e));
    assert.deepEqual(relevant, []);
  });

  await context.close();
}

await check('[390px] a corrupt GeoPackage shows a clear message', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await setupRoutes(context, { gpkg: 'index.html' });
  context.setDefaultTimeout(10000);
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.goto(BASE);
  await page.locator('#list .empty', { hasText: 'could not be loaded' }).waitFor();
  assert.ok(logs.some((l) => /not a valid GeoPackage/.test(l)));
  await context.close();
});

await check('[390px] a GeoPackage saved in WAL mode still loads in the browser', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  context.setDefaultTimeout(10000);
  await setupRoutes(context, { gpkg: 'tests/fixture-wal.gpkg' });
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.goto(BASE);
  await page.waitForFunction(() => document.querySelectorAll('#list .card').length === 8);
  assert.ok(logs.some((l) => /WAL mode/.test(l)), 'WAL warning logged to the console');
  await context.close();
});

await check('[1280px] admin-check.html lists data problems', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(10000);
  await setupRoutes(context);
  const page = await context.newPage();
  await page.goto(`${BASE}admin-check.html`);
  await page.locator('#issues tr').first().waitFor();
  const text = await page.locator('#issues').textContent();
  assert.match(text, /Safir.*שעות לא תקינות/s);
  assert.match(text, /FÉNIX.*דורס את ההמשך/s);
  assert.equal(await page.locator('#issues tr', { hasText: 'FÉNIX' }).filter({ hasText: 'דורס' }).count(), 1);
  assert.match(await page.locator('#candidates').textContent(), /Leyaly/);
  assert.match(await page.locator('#summary').textContent(), /8מוצגים באתר/);
  await page.screenshot({ path: join(SHOTS, 'admin-check.png'), fullPage: true });
  await context.close();
});

await browser.close();
server.close();
for (const [s, n, e] of results) console.log(`${s === 'ok' ? 'ok  ' : 'FAIL'} ${n}${e ? `\n     ${e}` : ''}`);
const failed = results.filter((r) => r[0] !== 'ok').length;
console.log(`\n${results.length - failed} passed, ${failed} failed. Screenshots: tests/screenshots/`);
process.exit(failed ? 1 : 0);
