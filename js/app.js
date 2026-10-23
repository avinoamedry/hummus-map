// ניתוב, מצב ורינדור: רשימה (#/), מפה (#/map) ודף מקום (#/place/<slug>).
import { loadData, isPublished, photoUrl, DIET_FIELDS } from './data.js';
import { hoursStatus, hoursReady } from './hours.js';
import { t } from './i18n.js';

const $ = (sel) => document.querySelector(sel);
const app = $('#app');
const els = {
  list: $('#list'), status: $('#status'), search: $('#searchInput'), placePane: $('#placePane'),
  listPane: $('#listPane'), mapPane: $('#mapPane'), mapCard: $('#mapCard'), mapMessage: $('#mapMessage'),
  viewToggle: $('#viewToggle'), chipFilters: $('#chipFilters'), chipSaved: $('#chipSaved'),
  chipFul: $('#chipFul'), chipOpen: $('#chipOpen'), chipVegan: $('#chipVegan'),
  filtersDialog: $('#filtersDialog'), menuDialog: $('#menuDialog'), toast: $('#toast'), debugBanner: $('#debugBanner'),
};

const DEFAULT_CONFIG = {
  report_email: '',
  accent: '#B8461A',
  map_center: [12, 50],
  map_zoom: 3.6,
  data_url: 'data/hummus_app.gpkg',
};
const DISHES = { hummus: 'serves_hummus', ful: 'serves_ful', mushrooms: 'serves_mushrooms' };
const DIETS = { vegan: 'diet_vegan', vegetarian: 'diet_vegetarian', kosher: 'diet_kosher', halal: 'diet_halal', gluten_free: 'diet_gluten_free' };
const SAVED_KEY = 'hummusmap:saved';
const wide = window.matchMedia('(min-width: 900px)');

const state = {
  config: DEFAULT_CONFIG,
  places: [],
  byId: new Map(),
  bySlug: new Map(),
  filters: emptyFilters(),
  sort: 'score',
  userLoc: null,
  saved: loadSaved(),
  route: { name: 'list' },
  debug: false,
  lastListHash: '#/',
  mapApi: null,
  mapLoading: null,
  listScroll: 0,
};

function emptyFilters() {
  return { q: '', dish: new Set(), diet: new Set(), open: false, min: 0, city: '', saved: false };
}

// ---------- עזרים ----------
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

function displayName(p) {
  return p.name_en || p.name || p.name_he || '';
}

function address(p, withNeighbourhood = false) {
  const street = [p.addr_street, p.addr_housenumber].filter(Boolean).join(' ');
  let a = [p.addr_city, street].filter(Boolean).join(', ');
  if (withNeighbourhood && p.addr_neighbourhood) a += `${a ? ' · ' : ''}${p.addr_neighbourhood}`;
  return a;
}

const scoreText = (p) => (p.score !== null ? p.score.toFixed(1) : '–');

function dietBadges(p) {
  return DIET_FIELDS.filter((f) => p[f] === 'yes' || p[f] === 'only').map((f) => t.diet[f][p[f] === 'only' ? 1 : 0]);
}

function instagramUrl(v) {
  if (/^https?:\/\//i.test(v)) return v;
  const handle = v.replace(/^@/, '').replace(/^(www\.)?instagram\.com\//i, '').replace(/\/+$/, '');
  return `https://www.instagram.com/${encodeURIComponent(handle)}/`;
}
const websiteUrl = (v) => (/^https?:\/\//i.test(v) ? v : `https://${v}`);
const telUrl = (v) => `tel:${v.replace(/[^\d+]/g, '')}`;

function distanceKm([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

function loadSaved() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SAVED_KEY) || '[]').map(Number));
  } catch {
    return new Set();
  }
}
function storeSaved() {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify([...state.saved]));
  } catch { /* מצב פרטי או אחסון חסום: נשאר בזיכרון בלבד */ }
}

let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
}

const ICON = {
  bowl: (size, sw = 1.4) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" aria-hidden="true"><path d="M3 11h18a9 9 0 0 1-18 0z"/><path d="M8 14.5c2 1.2 6 1.2 8 0"/><circle cx="10" cy="7" r="1.2"/><circle cx="13.5" cy="6.5" r="1.2"/><circle cx="12" cy="8.8" r="1.2"/></svg>`,
  star: (size, fill) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" aria-hidden="true"><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.9L12 17.8 5.8 21l1.2-6.9-5-4.9 6.9-1z"/></svg>`,
  heart: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>',
  back: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
  pin: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/></svg>',
  phone: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>',
  instagram: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="0.8" fill="currentColor"/></svg>',
  web: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  dish: {
    hummus: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3 11h18a9 9 0 0 1-18 0z"/><path d="M8 14.5c2 1.2 6 1.2 8 0"/><circle cx="12" cy="7.5" r="1.3"/></svg>',
    ful: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3 11h18a9 9 0 0 1-18 0z"/><ellipse cx="9.5" cy="7.5" rx="1.6" ry="1.1"/><ellipse cx="14" cy="6.8" rx="1.6" ry="1.1"/><ellipse cx="12" cy="9" rx="1.6" ry="1.1"/></svg>',
    mushrooms: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3 11h18a9 9 0 0 1-18 0z"/><path d="M8 8a2 2 0 0 1 4 0zM12.5 7a2 2 0 0 1 4 0z"/><path d="M10 8v1.6M14.5 7v1.6"/></svg>',
  },
};

// ---------- סינון ----------
function visiblePlaces() {
  return state.places.filter((p) => state.debug || isPublished(p));
}

function matches(p, f, now) {
  if (f.q) {
    const hay = [p.name, p.name_he, p.name_en, p.addr_city].map(fold).join(' ');
    if (!fold(f.q).split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  for (const d of f.dish) if (!p[DISHES[d]]) return false;
  for (const d of f.diet) if (!['yes', 'only'].includes(p[DIETS[d]])) return false;
  if (f.min > 0 && !(p.score !== null && p.score >= f.min)) return false;
  if (f.city && p.addr_city !== f.city) return false;
  if (f.saved && !state.saved.has(p.place_id)) return false;
  if (f.open && hoursStatus(p, t, now).state !== 'open') return false;
  return true;
}

function filteredPlaces(f = state.filters) {
  const now = new Date();
  const out = visiblePlaces().filter((p) => matches(p, f, now));
  if (state.sort === 'distance' && state.userLoc) {
    out.sort((a, b) => (a.lonlat ? distanceKm(state.userLoc, a.lonlat) : Infinity) - (b.lonlat ? distanceKm(state.userLoc, b.lonlat) : Infinity));
  } else {
    out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || displayName(a).localeCompare(displayName(b)));
  }
  return out;
}

const filterCount = (f) => f.dish.size + f.diet.size + (f.open ? 1 : 0) + (f.min > 0 ? 1 : 0) + (f.city ? 1 : 0);

function filtersToQuery(f) {
  const q = new URLSearchParams();
  if (f.q) q.set('q', f.q);
  if (f.dish.size) q.set('dish', [...f.dish].join(','));
  if (f.diet.size) q.set('diet', [...f.diet].join(','));
  if (f.open) q.set('open', '1');
  if (f.min > 0) q.set('min', String(f.min));
  if (f.city) q.set('city', f.city);
  if (f.saved) q.set('saved', '1');
  if (state.debug) q.set('debug', '1');
  const s = q.toString();
  return s ? `?${s}` : '';
}

function queryToFilters(qs) {
  const q = new URLSearchParams(qs);
  const list = (k, allowed) => new Set((q.get(k) || '').split(',').filter((v) => v in allowed));
  return {
    q: q.get('q') || '',
    dish: list('dish', DISHES),
    diet: list('diet', DIETS),
    open: q.get('open') === '1',
    min: Math.min(5, Math.max(0, parseFloat(q.get('min')) || 0)),
    city: q.get('city') || '',
    saved: q.get('saved') === '1',
  };
}

// ---------- ניתוב ----------
function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  const place = path.match(/^\/place\/([^/]+)\/?$/);
  if (place) return { name: 'place', slug: decodeURIComponent(place[1]), qs };
  if (path.startsWith('/map')) return { name: 'map', qs };
  return { name: 'list', qs };
}

function setFilters(next, { push = false } = {}) {
  state.filters = next;
  const base = state.route.name === 'map' ? '#/map' : '#/';
  const hash = base + filtersToQuery(next);
  state.lastListHash = hash;
  if (location.hash !== hash && state.route.name !== 'place') {
    history[push ? 'pushState' : 'replaceState'](null, '', hash);
  }
  renderResults();
}

function onRoute() {
  const route = parseHash();
  const prev = state.route;
  state.route = route;
  if (new URLSearchParams(route.qs).get('debug') === '1') state.debug = true;
  if (route.name !== 'place') {
    state.filters = queryToFilters(route.qs);
    state.lastListHash = `${route.name === 'map' ? '#/map' : '#/'}${filtersToQuery(state.filters)}`;
  }
  app.dataset.view = route.name;
  els.placePane.hidden = route.name !== 'place';
  syncControls();

  if (route.name === 'place') {
    if (prev.name === 'list') state.listScroll = els.listPane.scrollTop;
    renderPlace(route.slug);
  } else {
    els.placePane.innerHTML = '';
    renderResults();
    if (prev.name === 'place') {
      els.listPane.scrollTop = state.listScroll;
      if (!wide.matches || route.name === 'list') els.search.focus({ preventScroll: true });
    }
  }
  const label = route.name === 'map' ? t.showList : t.showMap;
  els.viewToggle.setAttribute('aria-label', label);
  els.viewToggle.title = label;
  if (route.name === 'map' || wide.matches) ensureMap();
  if (route.name !== 'map') hideMapCard();
  state.mapApi?.resize();
}

// ---------- רינדור רשימה ----------
function hoursBadge(p, now, cls = '') {
  const h = hoursStatus(p, t, now);
  if (h.state === 'open') return `<span class="badge open ${cls}">${t.open}</span>`;
  if (h.state === 'closed') return `<span class="badge ${cls}">${t.closed}</span>`;
  return '';
}

function photoBlock(p, size, eager = false) {
  if (p.mainPhoto) {
    // התמונות הראשונות ברשימה נטענות מיד (LCP), השאר בטעינה עצלה
    const loading = eager ? 'fetchpriority="high"' : 'loading="lazy"';
    return `<img src="${esc(photoUrl(p.mainPhoto.url))}" alt="${esc(p.mainPhoto.caption || displayName(p))}" ${loading} decoding="async">`;
  }
  return ICON.bowl(size);
}

function cardHtml(p, now, index = 99) {
  const dishes = Object.keys(DISHES).filter((d) => p[DISHES[d]]).map((d) => `<span class="tag">${t.dishes[d]}</span>`).join('');
  const diets = dietBadges(p).map((d) => `<span class="diet">${esc(d)}</span>`).join('');
  return `<a class="card" href="#/place/${encodeURIComponent(p.slug)}" data-id="${p.place_id}">
  <div class="card-photo">${photoBlock(p, 64, index < 2)}${hoursBadge(p, now)}${isPublished(p) ? '' : `<span class="badge draft">${t.unpublished}</span>`}</div>
  <div class="card-body">
    <div class="card-head">
      <h2 class="card-name" dir="auto">${esc(displayName(p))}</h2>
      <div class="card-score" role="img" aria-label="${esc(t.scoreAria(scoreText(p)))}">${ICON.star(18, 'currentColor')}<span aria-hidden="true">${scoreText(p)}</span></div>
    </div>
    ${address(p) ? `<div class="addr" dir="auto">${esc(address(p))}</div>` : ''}
    ${dishes ? `<div class="tags">${dishes}</div>` : ''}
    ${diets ? `<div class="tags">${diets}</div>` : ''}
  </div>
</a>`;
}

function renderResults() {
  if (!state.places.length && !state.loaded) return;
  const items = filteredPlaces();
  const now = new Date();
  if (items.length) {
    els.list.innerHTML = items.map((p, i) => cardHtml(p, now, i)).join('');
  } else {
    els.list.innerHTML = `<p class="empty">${state.filters.saved && !state.saved.size ? t.noSaved : t.noResults}</p>`;
  }
  els.status.textContent = t.results(items.length);
  state.mapApi?.setPlaces(items, isPublished);
  if (state.selectedId && !items.some((p) => p.place_id === state.selectedId)) hideMapCard();
  syncControls();
}

function syncControls() {
  const f = state.filters;
  const n = filterCount(f);
  els.chipFilters.querySelector('span').textContent = t.filters(n);
  els.chipFilters.classList.toggle('on', n > 0);
  const set = (el, on) => { el.classList.toggle('on', on); el.setAttribute('aria-pressed', String(on)); };
  set(els.chipSaved, f.saved);
  set(els.chipFul, f.dish.has('ful'));
  set(els.chipOpen, f.open);
  set(els.chipVegan, f.diet.has('vegan'));
  if (document.activeElement !== els.search) els.search.value = f.q;
}

// ---------- דף מקום ----------
function renderPlace(slug) {
  const p = state.bySlug.get(slug);
  if (!state.loaded) {
    els.placePane.innerHTML = `<p class="loader">${t.loading}</p>`;
    return;
  }
  if (!p || (!state.debug && !isPublished(p))) {
    els.placePane.innerHTML = `<div class="sheet-body" style="margin-top:0"><p class="empty">${t.notFound}</p><a class="btn btn-accent" href="${esc(state.lastListHash)}">${t.backToList}</a></div>`;
    return;
  }
  const now = new Date();
  const h = hoursStatus(p, t, now);
  const saved = state.saved.has(p.place_id);
  const photos = p.photos.length
    ? p.photos.map((ph, i) => `<figure><img src="${esc(photoUrl(ph.url))}" alt="${esc(ph.caption || t.photo(i + 1, p.photos.length))}" ${i ? 'loading="lazy"' : ''} decoding="async">${ph.credit ? `<figcaption>${esc(ph.credit)}</figcaption>` : ''}</figure>`).join('')
    : `<div role="img" aria-label="${esc(t.noPhoto)}">${ICON.bowl(84, 1.3)}</div>`;
  const dots = p.photos.length > 1 ? `<div class="dots" aria-hidden="true">${p.photos.map((_, i) => `<span class="${i ? '' : 'on'}"></span>`).join('')}</div>` : '';
  const tiles = Object.keys(DISHES).filter((d) => p[DISHES[d]])
    .map((d) => `<div class="tile">${ICON.dish[d]}<span>${t.dishes[d]}</span></div>`).join('');
  const others = p.dishes.map((d) => `<span class="tag" dir="auto">${esc(d)}</span>`).join('');
  const diets = dietBadges(p).map((d) => `<span class="diet-lg">${esc(d)}</span>`).join('');
  // התווית לפי שפת הממשק; label_he בטבלת הקודים כולל הערות למנהל ולכן לא מוצג כמו שהוא בממשק האנגלי
  const kashrutLabel = p.kashrut ? t.kashrut[p.kashrut.code] || p.kashrut.label_en || p.kashrut.label_he : '';
  const kashrut = ['yes', 'only'].includes(p.diet_kosher) && (kashrutLabel || p.kashrut_body)
    ? `<p class="kashrut">${esc(kashrutLabel)}${kashrutLabel && p.kashrut_body ? '<br>' : ''}${p.kashrut_body ? `<span dir="auto">${esc(p.kashrut_body)}</span>` : ''}</p>`
    : '';
  const since = p.start_year ? t.since(p.start_year) : '';
  const sinceText = [since, p.tagline].filter(Boolean).join(', ');
  const hoursHtml = h.state === 'unknown'
    ? `<div class="hours-head"><h2 class="h2">${t.openingHours}</h2></div><p class="muted" style="margin:0">${t.hoursNA}</p>`
    : `<div class="hours-head"><h2 class="h2">${t.openingHours}</h2>${hoursBadge(p, now, 'static')}</div>
       <div class="today-row"><span>${t.today}</span><strong>${esc(h.today)}${h.note ? ` · ${esc(h.note)}` : ''}</strong></div>
       ${h.comment ? `<p class="muted small" style="margin:0" dir="auto">${esc(h.comment)}</p>` : ''}
       <button type="button" class="link-btn" id="weekBtn" aria-expanded="false" aria-controls="weekTable">${t.showWeek}</button>
       <table class="week" id="weekTable" hidden><tbody>${h.week.map((d) => `<tr class="${d.isToday ? 'today' : ''}"><td>${d.label}</td><td>${esc(d.text)}</td></tr>`).join('')}</tbody></table>`;
  const contact = [
    p.phone && `<a class="round-btn" href="${esc(telUrl(p.phone))}" aria-label="${t.phone}: ${esc(p.phone)}">${ICON.phone}</a>`,
    p.instagram && `<a class="round-btn" href="${esc(instagramUrl(p.instagram))}" target="_blank" rel="noopener" aria-label="${t.instagram}">${ICON.instagram}</a>`,
    p.website && `<a class="round-btn" href="${esc(websiteUrl(p.website))}" target="_blank" rel="noopener" aria-label="${t.website}">${ICON.web}</a>`,
  ].filter(Boolean).join('');
  const [lon, lat] = p.lonlat || [];
  const nav = p.lonlat ? `<a class="btn btn-accent" href="https://www.google.com/maps/dir/?api=1&amp;destination=${lat},${lon}" target="_blank" rel="noopener">${t.navigate}</a>` : '';
  const report = state.config.report_email
    ? `<a href="mailto:${esc(state.config.report_email)}?subject=${encodeURIComponent(t.reportSubject(displayName(p), p.place_id))}">${t.somethingWrong}</a>`
    : '';

  els.placePane.innerHTML = `
<div class="gallery-wrap">
  <div class="gallery" id="gallery" tabindex="0" aria-label="Photos">${photos}</div>${dots}
  <a class="float-btn back" href="${esc(state.lastListHash)}" id="backBtn" aria-label="${t.back}">${ICON.back}</a>
  <button type="button" class="float-btn save" id="saveBtn" aria-pressed="${saved}" aria-label="${saved ? t.unsave : t.save}">${ICON.heart}</button>
</div>
<div class="sheet-body">
  <div class="section">
    <div class="title-row">
      <h1 class="place-name" dir="auto" tabindex="-1" id="placeTitle">${esc(displayName(p))}</h1>
      <div class="score-box ${p.score === null ? 'none' : ''}" role="img" aria-label="${esc(t.scoreAria(scoreText(p)))}">
        <div class="num" aria-hidden="true">${ICON.star(18, '#FFFFFF')}${scoreText(p)}</div><div class="lbl" aria-hidden="true">${t.score}</div>
      </div>
    </div>
    ${p.name_he && !displayName(p).includes(p.name_he) ? `<div class="since" lang="he" dir="rtl">${esc(p.name_he)}</div>` : ''}
    ${address(p, true) ? `<div class="place-addr">${ICON.pin}<span dir="auto">${esc(address(p, true))}</span></div>` : ''}
    ${p.reviewer_note ? `<p class="quote" dir="auto">“${esc(p.reviewer_note)}”</p>` : ''}
    ${sinceText ? `<div class="since" dir="auto">${esc(sinceText)}</div>` : ''}
  </div>
  <div class="divider"></div>
  ${tiles || others ? `<div class="section" style="gap:14px"><h2 class="h2">${t.serving}</h2>${tiles ? `<div class="tiles">${tiles}</div>` : ''}${others ? `<div class="tags">${others}</div>` : ''}</div>` : ''}
  ${diets || kashrut ? `<div class="section" style="gap:12px"><h2 class="h2">${t.dietary}</h2>${diets ? `<div class="tags">${diets}</div>` : ''}${kashrut}</div>` : ''}
  <div class="divider"></div>
  <div class="section" style="gap:10px">${hoursHtml}</div>
  ${contact ? `<div class="contact">${contact}</div>` : ''}
  <div class="actions">${nav}<button type="button" class="btn btn-outline" id="shareBtn">${t.share}</button></div>
  <div class="foot">${report}<span class="attr">${t.attributionPlace.replace('OpenStreetMap', '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>')}</span></div>
</div>`;
  els.placePane.scrollTop = 0;
  document.title = `${displayName(p)} · ${t.appName}`;
  $('#placeTitle').focus({ preventScroll: true });

  $('#saveBtn').addEventListener('click', (e) => toggleSaved(p, e.currentTarget));
  $('#shareBtn').addEventListener('click', () => share(p));
  $('#backBtn').addEventListener('click', (e) => {
    if (state.cameFromApp) { e.preventDefault(); history.back(); }
  });
  $('#weekBtn')?.addEventListener('click', (e) => {
    const table = $('#weekTable');
    table.hidden = !table.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!table.hidden));
    e.currentTarget.textContent = table.hidden ? t.showWeek : t.hideWeek;
  });
  const gallery = $('#gallery');
  if (p.photos.length > 1) {
    gallery.addEventListener('scroll', () => {
      const i = Math.round(gallery.scrollLeft / gallery.clientWidth);
      els.placePane.querySelectorAll('.dots span').forEach((d, k) => d.classList.toggle('on', k === i));
    }, { passive: true });
  }
  if (wide.matches) ensureMap().then((api) => api?.focus(p));
}

function toggleSaved(p, btn) {
  if (state.saved.has(p.place_id)) state.saved.delete(p.place_id);
  else state.saved.add(p.place_id);
  storeSaved();
  const on = state.saved.has(p.place_id);
  btn.setAttribute('aria-pressed', String(on));
  btn.setAttribute('aria-label', on ? t.unsave : t.save);
  if (state.filters.saved) renderResults();
}

async function share(p) {
  const url = `${location.origin}${location.pathname}#/place/${encodeURIComponent(p.slug)}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: displayName(p), text: `${displayName(p)} · ${t.appName}`, url });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast(t.linkCopied);
  } catch {
    toast(`${t.copyFailed}: ${url}`);
  }
}

// ---------- מפה ----------
function ensureMap() {
  if (state.mapLoading) return state.mapLoading;
  const { config } = state;
  state.mapLoading = import('./map.js').then(({ createMap }) => {
    const css = getComputedStyle(document.documentElement);
    const api = createMap($('#map'), {
      center: config.map_center, zoom: config.map_zoom, t,
      accent: css.getPropertyValue('--accent').trim(), muted: css.getPropertyValue('--closed').trim(),
      onSelect: (id) => (id === null ? hideMapCard() : showMapCard(id)),
      onError: (e) => {
        console.error('[map] could not load', e);
        els.mapMessage.textContent = t.mapUnavailable;
        els.mapMessage.hidden = false;
      },
    });
    state.mapApi = api;
    if (api && state.loaded) api.setPlaces(filteredPlaces(), isPublished);
    return api;
  }).catch((e) => {
    console.error('[map] module failed', e);
    els.mapMessage.textContent = t.mapUnavailable;
    els.mapMessage.hidden = false;
    return null;
  });
  return state.mapLoading;
}

function showMapCard(id) {
  const p = state.byId.get(id);
  if (!p) return;
  state.selectedId = id;
  const now = new Date();
  els.mapCard.innerHTML = `<a href="#/place/${encodeURIComponent(p.slug)}">
    <div class="card-head"><h2 class="card-name" dir="auto">${esc(displayName(p))}</h2>
    <div class="card-score" role="img" aria-label="${esc(t.scoreAria(scoreText(p)))}">${ICON.star(18, 'currentColor')}<span aria-hidden="true">${scoreText(p)}</span></div></div>
    ${address(p) ? `<div class="addr" dir="auto">${esc(address(p))}</div>` : ''}
    <div>${hoursBadge(p, now, 'static')}</div>
  </a><button type="button" class="icon-btn" id="mapCardClose" aria-label="${t.close}">${ICON.close}</button>`;
  els.mapCard.hidden = false;
  $('#mapCardClose').addEventListener('click', () => { hideMapCard(); state.mapApi?.select(null); });
}

function hideMapCard() {
  state.selectedId = null;
  els.mapCard.hidden = true;
}

// ---------- פאנל Filters ----------
function optHtml(name, value, label, checked) {
  return `<label class="opt"><input type="checkbox" name="${name}" value="${value}" ${checked ? 'checked' : ''}><span>${esc(label)}</span></label>`;
}

function openFilters() {
  const f = state.filters;
  $('#fDishes').innerHTML = Object.keys(DISHES).map((d) => optHtml('dish', d, t.dishes[d], f.dish.has(d))).join('');
  $('#fDiet').innerHTML = Object.entries(DIETS).map(([k, field]) => optHtml('diet', k, t.diet[field][0], f.diet.has(k))).join('');
  $('#fOpen').innerHTML = optHtml('open', '1', t.openNow, f.open);
  $('#fMin').value = f.min;
  $('#fMinOut').textContent = f.min ? f.min.toFixed(1) : '0';
  const cities = [...new Set(visiblePlaces().map((p) => p.addr_city).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $('#fCity').innerHTML = `<option value="">${t.anyCity}</option>${cities.map((c) => `<option ${c === f.city ? 'selected' : ''}>${esc(c)}</option>`).join('')}`;
  updateFilterPreview();
  els.filtersDialog.showModal();
}

function readFilterForm() {
  const form = $('#filtersForm');
  const checked = (name) => new Set([...form.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value));
  return {
    ...state.filters,
    dish: checked('dish'),
    diet: checked('diet'),
    open: checked('open').size > 0,
    min: parseFloat($('#fMin').value) || 0,
    city: $('#fCity').value,
  };
}

function updateFilterPreview() {
  const f = readFilterForm();
  $('#fMinOut').textContent = f.min ? f.min.toFixed(1) : '0';
  $('#fApply').textContent = t.showResults(filteredPlaces(f).length);
}

// ---------- אתחול ----------
function bindUi() {
  els.search.placeholder = t.search;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const v = t[el.dataset.i18n];
    if (typeof v === 'string') el.textContent = v;
  });
  els.chipFul.textContent = t.ful;
  els.chipOpen.textContent = t.openNow;
  els.chipVegan.textContent = t.vegan;
  els.chipSaved.setAttribute('aria-label', t.saved);
  $('#fClear').textContent = t.clearAll;
  $('#filtersTitle').textContent = t.filtersTitle;
  $('#menuTitle').textContent = t.appName;
  $('#aboutText').textContent = t.aboutText;
  $('#menuAttribution').innerHTML = t.attributionMap.replace('OpenStreetMap', '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>');

  let searchTimer;
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setFilters({ ...state.filters, q: els.search.value.trim() }), 150);
  });
  els.search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !wide.matches && state.route.name === 'map') els.search.blur();
  });
  const toggle = (key, value) => {
    const f = { ...state.filters, dish: new Set(state.filters.dish), diet: new Set(state.filters.diet) };
    if (key === 'dish' || key === 'diet') {
      if (f[key].has(value)) f[key].delete(value);
      else f[key].add(value);
    } else {
      f[key] = !f[key];
    }
    setFilters(f);
  };
  els.chipFul.addEventListener('click', () => toggle('dish', 'ful'));
  els.chipVegan.addEventListener('click', () => toggle('diet', 'vegan'));
  els.chipOpen.addEventListener('click', () => toggle('open'));
  els.chipSaved.addEventListener('click', () => toggle('saved'));
  els.chipFilters.addEventListener('click', openFilters);
  els.viewToggle.addEventListener('click', () => {
    const qs = filtersToQuery(state.filters);
    location.hash = state.route.name === 'map' ? `#/${qs}` : `#/map${qs}`;
  });

  const form = $('#filtersForm');
  form.addEventListener('input', updateFilterPreview);
  form.addEventListener('change', updateFilterPreview);
  $('#fClear').addEventListener('click', () => {
    form.querySelectorAll('input[type="checkbox"]').forEach((i) => { i.checked = false; });
    $('#fMin').value = 0;
    $('#fCity').value = '';
    updateFilterPreview();
  });
  els.filtersDialog.addEventListener('close', () => {
    if (els.filtersDialog.returnValue === 'apply') setFilters(readFilterForm());
  });
  els.filtersDialog.addEventListener('click', (e) => { if (e.target === els.filtersDialog) els.filtersDialog.close(); });

  $('#menuBtn').addEventListener('click', () => {
    $('#sortOptions').innerHTML = [['score', t.sortScore], ['distance', t.sortDistance]]
      .map(([v, l]) => `<label class="opt"><input type="radio" name="sort" value="${v}" ${state.sort === v ? 'checked' : ''}><span>${l}</span></label>`).join('');
    els.menuDialog.showModal();
  });
  els.menuDialog.addEventListener('click', (e) => { if (e.target === els.menuDialog) els.menuDialog.close(); });
  $('#sortOptions').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v === 'distance') {
      if (!navigator.geolocation) { toast(t.locationDenied); e.target.checked = false; return; }
      navigator.geolocation.getCurrentPosition((pos) => {
        state.userLoc = [pos.coords.longitude, pos.coords.latitude];
        state.sort = 'distance';
        renderResults();
      }, () => {
        toast(t.locationDenied);
        state.sort = 'score';
        els.menuDialog.querySelector('input[value="score"]').checked = true;
      }, { maximumAge: 300000, timeout: 10000 });
    } else {
      state.sort = 'score';
      renderResults();
    }
  });

  window.addEventListener('hashchange', () => {
    state.cameFromApp = parseHash().name === 'place' && state.route.name !== 'place';
    onRoute();
    if (state.route.name !== 'place') document.title = t.appName;
  });
  wide.addEventListener('change', () => {
    if (wide.matches) ensureMap();
    state.mapApi?.resize();
  });
  // שעות פתיחה משתנות עם הזמן: רענון כל דקה
  setInterval(() => {
    if (!state.loaded || document.hidden || els.filtersDialog.open) return;
    if (state.route.name === 'place') return;
    renderResults();
  }, 60000);
}

async function loadConfig() {
  try {
    const res = await fetch('data/config.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    return { ...DEFAULT_CONFIG, ...(await res.json()) };
  } catch (e) {
    console.warn('[config] using defaults:', e.message);
    return DEFAULT_CONFIG;
  }
}

async function main() {
  state.debug = new URLSearchParams(location.search).get('debug') === '1';
  bindUi();
  els.status.textContent = t.loading;
  state.config = await loadConfig();
  if (/^#[0-9a-f]{3,8}$/i.test(state.config.accent || '')) document.documentElement.style.setProperty('--accent', state.config.accent);
  onRoute();
  try {
    const { places, warnings } = await loadData(state.config.data_url, window.initSqlJs);
    warnings.forEach((w) => console.warn('[data]', w));
    state.places = places.filter((p) => p.place_id !== null);
    state.byId = new Map(state.places.map((p) => [p.place_id, p]));
    state.bySlug = new Map(state.places.map((p) => [p.slug, p]));
    state.loaded = true;
    console.info(`[data] ${places.length} places loaded, ${places.filter(isPublished).length} published`, places);
  } catch (e) {
    console.error('[data] could not load places:', e);
    state.loaded = true;
    els.status.textContent = '';
    els.list.innerHTML = `<p class="empty">${t.loadError}</p>`;
    return;
  }
  if (state.debug) {
    els.debugBanner.textContent = t.debug;
    els.debugBanner.hidden = false;
  }
  onRoute();
  hoursReady.then(() => {
    state.places.forEach((p) => { delete p._hours; });
    if (state.route.name === 'place') renderPlace(state.route.slug);
    else renderResults();
  });
}

// נגיש לבדיקות ולדיבאג בקונסול
window.hummus = { state };

main();
