// 畫面流程：首頁 → 國家 → 艦種 → 艦級 → 單艦 → 事件。
// 目前位置完全由網址的 # 決定，例如 #/japan/yamato-class/yamato/leyte-gulf。
// 艦種選單的網址是 #/japan/type-battleship；艦級以下的網址不含艦種，舊連結因此不受影響。
// ESC 就是把網址往上退一層。這個檔案不放任何船艦內容，內容都在 data/ 裡。
// 版本號（index.html 裡 app.js?v=N 的 N）一路傳給其他模組，避免瀏覽器沿用舊的快取
const VERSION = new URL(import.meta.url).search;
const { Globe } = await import('./globe.js' + VERSION);
const { photoHTML, galleryHTML, thumbHTML, hydrate } = await import('./images.js' + VERSION);

const d3 = window.d3;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const TYPE_LABEL = { origin: '建造背景', battle: '作戰經歷', event: '重要事件', fate: '最終結局' };
// 艦種在網址中的代號與英文標籤。資料裡出現這張表以外的艦種時，直接用艦種名稱當代號。
const SHIP_TYPES = {
  '戰艦': ['battleship', 'BATTLESHIPS'], '戰鬥巡洋艦': ['battlecruiser', 'BATTLECRUISERS'],
  '航空母艦': ['carrier', 'AIRCRAFT CARRIERS'], '重巡洋艦': ['heavy-cruiser', 'HEAVY CRUISERS'],
  '輕巡洋艦': ['light-cruiser', 'LIGHT CRUISERS'], '鐵甲艦': ['ironclad', 'IRONCLADS'],
  '其他大型艦艇': ['other', 'OTHER VESSELS']
};
const HOME_VIEW = { lon: 135, lat: 28, zoom: 1 };

const el = {
  left: $('#panel-left'), right: $('#panel-right'), crumb: $('#breadcrumb'), home: $('#home-list'),
  back: $('#btn-back'), tip: $('#tooltip'), box: $('#lightbox'), boxImg: $('#lightbox-img'), boxCap: $('#lightbox-cap'),
  hint: document.querySelector('.hint')
};

const globe = new Globe($('#globe'));
window.__globe = globe;   // 方便在瀏覽器主控台除錯
let countries = [];
const classCache = new Map();

// ---------- 資料 ----------
async function loadClass(countryId, classId) {
  const key = `${countryId}/${classId}`;
  if (!classCache.has(key)) {
    classCache.set(key, fetch(`data/${key}.json`, { cache: 'no-cache' }).then(r => {
      if (!r.ok) throw new Error(`讀不到 data/${key}.json`);
      return r.json();
    }));
  }
  return classCache.get(key);
}

// ---------- 路由 ----------
function parseHash() {
  const [country, cls, ship, event] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { country, cls, ship, event };
}
function go(...parts) { location.hash = '#/' + parts.filter(Boolean).join('/'); }
// 艦級頁的上一層是艦種選單，但艦種不在艦級的網址裡，所以由 route() 記下該退回哪裡
let upPath = null;
function goUp() {
  if (upPath) return go(...upPath);
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (!parts.length) return;
  parts.pop();
  go(...parts);
}

// 依艦級在資料中出現的順序，把艦級分到各艦種
function groupTypes(classes) {
  const types = [];
  for (const c of classes) {
    let t = types.find(k => k.name === c.type);
    if (!t) {
      const [slug, en] = SHIP_TYPES[c.type] || [c.type, ''];
      types.push(t = { name: c.type, slug, en, classes: [] });
    }
    t.classes.push(c);
  }
  return types;
}

async function route() {
  upPath = null;
  const r = parseHash();
  const country = countries.find(c => c.id === r.country);
  if (!country) return renderHome();

  const classes = await Promise.all((country.classes || []).map(id => loadClass(country.id, id).catch(() => null)));
  const cls = classes.find(c => c && c.id === r.cls);
  const ship = cls && cls.ships.find(s => s.id === r.ship);
  const event = ship && (ship.events || []).find(e => e.id === r.event);

  // 只有一種艦種的國家不顯示艦種選單，點進國家就直接列出艦級
  const types = groupTypes(classes.filter(Boolean));
  const multi = types.length > 1;
  const typeSlug = !cls && r.cls && r.cls.startsWith('type-') ? decodeURIComponent(r.cls.slice(5)) : null;
  const type = !multi ? null : cls ? types.find(t => t.name === cls.type) : types.find(t => t.slug === typeSlug);
  if (cls && !ship && type) upPath = [country.id, 'type-' + type.slug];

  globe.selectedCountry = country.id;
  globe.selectedAlpha = ship ? 0 : 0.55;   // 看單艦時收起國旗，避免蓋住事件標記
  globe.hoverCountry = null; el.tip.hidden = true;
  globe.interactive = false;
  globe.autoRotate = false;
  el.home.hidden = true;
  el.back.hidden = false;
  el.hint.textContent = '拖曳轉動地球 · 滾輪縮放';

  renderCrumb(country, type, cls, ship, event);

  if (ship) {
    renderShip(country, cls, ship, event);
    const markers = (ship.events || []).map(e => ({ id: e.id, lon: e.lon, lat: e.lat, label: e.title, type: e.type, date: e.date }));
    globe.setMarkers(markers, event ? event.id : null);
    if (event) { renderEvent(country, cls, ship, event); globe.flyTo({ lon: event.lon, lat: event.lat, zoom: Math.max(fitView(markers).zoom, 1.9) }); }
    else { el.right.hidden = true; if (markers.length) globe.flyTo(fitView(markers)); }
  } else {
    globe.setMarkers([]);
    el.right.hidden = true;
    if (cls) renderClass(country, cls);
    else if (multi && !type) renderTypes(country, types);
    else renderCountry(country, type ? type.classes : classes.filter(Boolean), type);
    globe.flyTo(country.focus);
  }
  layout();
}

function fitView(points) {
  const centroid = d3.geoCentroid({ type: 'MultiPoint', coordinates: points.map(p => [p.lon, p.lat]) });
  const spread = Math.max(...points.map(p => d3.geoDistance(centroid, [p.lon, p.lat])));
  const zoom = Math.max(1, Math.min(4.5, 0.8 / Math.sin(Math.min(spread * 1.25 + 0.1, Math.PI / 2))));
  return { lon: centroid[0], lat: centroid[1], zoom };
}

function layout() {
  const narrow = window.innerWidth <= 900;
  const leftOpen = !el.left.hidden, rightOpen = !el.right.hidden;
  globe.setInsets(narrow
    ? { bottom: leftOpen || rightOpen ? window.innerHeight * 0.52 : 0 }
    : { left: leftOpen ? 418 : 0, right: rightOpen ? 458 : 0 });
}

// ---------- 畫面 ----------
function renderHome() {
  globe.selectedCountry = null;
  globe.interactive = true;
  globe.autoRotate = true;
  globe.setMarkers([]);
  if (el.left.hidden === false) globe.flyTo(HOME_VIEW);
  el.left.hidden = true; el.right.hidden = true; el.back.hidden = true; el.home.hidden = false;
  el.crumb.innerHTML = '';
  el.hint.textContent = '拖曳轉動地球 · 滾輪縮放 · 點擊發光的國家';
  el.home.innerHTML = `<div class="label">目標清單 TARGETS</div>` + countries.map(c =>
    `<button data-go="${esc(c.id)}"><img src="assets/flags/${esc(c.flag.file)}" alt="">${esc(c.name)}</button>`).join('');
  layout();
}

function renderCrumb(country, type, cls, ship, event) {
  const items = [['', '全球'], [country.id, country.name]];
  if (type) items.push([`${country.id}/type-${type.slug}`, type.name]);
  if (cls) items.push([`${country.id}/${cls.id}`, cls.name]);
  if (ship) items.push([`${country.id}/${cls.id}/${ship.id}`, ship.name]);
  if (event) items.push([null, event.title]);
  el.crumb.innerHTML = items.map(([path, label], i) =>
    (i === items.length - 1 ? `<span>${esc(label)}</span>` : `<a href="#/${path}">${esc(label)}</a>`)).join('<span class="sep">▸</span>');
}

function setLeft(html) {
  el.left.innerHTML = html; el.left.hidden = false; el.left.scrollTop = 0;
  hydrate(el.left, openLightbox);
}

function countryHead(country) {
  return `
    <p class="eyebrow">${esc(country.nameEn)}</p>
    <div class="country-head">
      <img src="assets/flags/${esc(country.flag.file)}" alt="${esc(country.flag.name)}">
      <div><h2>${esc(country.name)}</h2><div class="meta">${esc(country.navy)}<br>${esc(country.flag.name)}</div></div>
    </div>`;
}

function renderTypes(country, types) {
  setLeft(`
    ${countryHead(country)}
    <p>${esc(country.summary)}</p>
    <h3>艦種 TYPES</h3>
    <ul class="card-list">${types.map(t => `<li><button class="card" data-go="${esc(country.id)}/type-${esc(t.slug)}">
      ${thumbHTML(t.classes[0].image)}
      <div><strong>${esc(t.name)}</strong><span>${t.en ? esc(t.en) + ' · ' : ''}${t.classes.length} 個艦級 · ${t.classes.reduce((n, c) => n + c.ships.length, 0)} 艘</span></div>
    </button></li>`).join('')}</ul>`);
}

function renderCountry(country, classes, type) {
  const cards = classes.length
    ? `<ul class="card-list">${classes.map(c => `<li><button class="card" data-go="${esc(country.id)}/${esc(c.id)}">
        ${thumbHTML(c.image)}
        <div><strong>${esc(c.name)}</strong><span>${esc(c.type)} · ${esc(c.years)} · ${c.ships.length} 艘</span></div>
      </button></li>`).join('')}</ul>`
    : `<div class="empty">此國家的艦級資料建置中。</div>`;
  setLeft(type ? `
    <p class="eyebrow">${esc(country.name)} · ${esc(country.navy)}</p>
    <h2>${esc(type.name)}${type.en ? `<small>${esc(type.en)}</small>` : ''}</h2>
    <div class="meta">${classes.length} 個艦級 · ${classes.reduce((n, c) => n + c.ships.length, 0)} 艘</div>
    <h3>艦級 CLASSES</h3>
    ${cards}` : `
    ${countryHead(country)}
    <p>${esc(country.summary)}</p>
    <h3>艦級 CLASSES</h3>
    ${cards}`);
}

function renderClass(country, cls) {
  setLeft(`
    <p class="eyebrow">${esc(country.name)} · ${esc(cls.type)}</p>
    <h2>${esc(cls.name)}<small>${esc(cls.nameEn)}</small></h2>
    <div class="meta">${esc(cls.years)}</div>
    ${photoHTML(cls.image)}
    ${paras(cls.summary)}
    <h3>同級艦 SHIPS</h3>
    <ul class="card-list">${cls.ships.map(s => `<li><button class="card" data-go="${esc(country.id)}/${esc(cls.id)}/${esc(s.id)}">
      ${thumbHTML(s.image)}
      <div><strong>${esc(s.name)}</strong><span>${esc(s.nameEn)} · ${esc(s.tagline || '')}</span></div>
    </button></li>`).join('')}</ul>`);
}

function renderShip(country, cls, ship, event) {
  const base = `${country.id}/${cls.id}/${ship.id}`;
  const specs = Object.entries(ship.specs || {}).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  const events = (ship.events || []).map((e, i) => `<li><button class="event-item t-${esc(e.type)} ${event && event.id === e.id ? 'active' : ''}" data-go="${esc(base)}/${esc(e.id)}">
      <strong>${i + 1}. ${esc(e.title)}</strong><span>${esc(TYPE_LABEL[e.type] || '')} · ${esc(e.date)} · ${esc(e.place)}</span>
    </button></li>`).join('');
  // 只是切換事件時不重畫左側，避免捲軸跳回頂端
  if (el.left.dataset.ship === base && !el.left.hidden) {
    el.left.querySelectorAll('.event-item').forEach(b => b.classList.toggle('active', !!event && b.dataset.go === `${base}/${event.id}`));
    return;
  }
  setLeft(`
    <p class="eyebrow">${esc(country.name)} · ${esc(cls.name)}</p>
    <h2>${esc(ship.name)}<small>${esc(ship.nameEn)}</small></h2>
    <div class="meta">${esc(ship.tagline || '')}</div>
    ${photoHTML(ship.image)}
    ${paras(ship.summary)}
    <h3>諸元 SPECIFICATIONS</h3>
    <dl class="specs">${specs}</dl>
    <h3>地圖事件 EVENTS</h3>
    <p class="lead">點擊下方項目或地圖上的光點，查看詳細內容。</p>
    <ul class="event-list">${events}</ul>
    <h3>簡歷 SERVICE RECORD</h3>
    <ol class="timeline">${(ship.timeline || []).map(t => `<li><time>${esc(t.date)}</time>${esc(t.text)}</li>`).join('')}</ol>
    ${ship.sources && ship.sources.length ? `<h3>參考資料 SOURCES</h3><ul class="sources">${ship.sources.map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`).join('')}</ul>` : ''}`);
  el.left.dataset.ship = base;
}

function renderEvent(country, cls, ship, event) {
  el.right.innerHTML = `
    <span class="badge t-${esc(event.type)}">${esc(TYPE_LABEL[event.type] || '事件')}</span>
    <h2>${esc(event.title)}</h2>
    <div class="meta">${esc(event.date)}<br>${esc(event.place)}（${fmtCoord(event.lat, event.lon)}）</div>
    <p class="lead">${esc(event.summary)}</p>
    ${paras(event.body)}
    ${event.images && event.images.length ? `<h3>影像 IMAGES</h3>${galleryHTML(event.images)}` : ''}`;
  el.right.hidden = false; el.right.scrollTop = 0;
  hydrate(el.right, openLightbox);
}

function paras(v) { return (Array.isArray(v) ? v : [v]).filter(Boolean).map(p => `<p>${esc(p)}</p>`).join(''); }
function fmtCoord(lat, lon) {
  return `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
}

// ---------- 燈箱 ----------
function openLightbox(src, caption) { el.boxImg.src = src; el.boxCap.textContent = caption; el.box.hidden = false; }
function closeLightbox() { el.box.hidden = true; el.boxImg.removeAttribute('src'); }
el.box.addEventListener('click', closeLightbox);

// ---------- 事件繫結 ----------
document.addEventListener('click', e => {
  const b = e.target.closest('[data-go]');
  if (b) go(...b.dataset.go.split('/'));
});
el.back.addEventListener('click', goUp);
$('#btn-zoom-in').addEventListener('click', () => globe.zoomBy(1.35));
$('#btn-zoom-out').addEventListener('click', () => globe.zoomBy(1 / 1.35));
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!el.box.hidden) closeLightbox(); else goUp();
});
window.addEventListener('hashchange', () => { if (parseHash().ship !== (el.left.dataset.ship || '').split('/')[2]) delete el.left.dataset.ship; route(); });
window.addEventListener('resize', layout);

globe.on('countryclick', id => go(id));
globe.on('markerclick', m => { const r = parseHash(); go(r.country, r.cls, r.ship, m.id); });
globe.on('hover', ({ country, marker, x, y }) => {
  if (marker) el.tip.innerHTML = `<b>${esc(marker.label)}</b>${esc(TYPE_LABEL[marker.type] || '')} · ${esc(marker.date || '')}`;
  else if (country) {
    const c = countries.find(k => k.id === country);
    el.tip.innerHTML = `<b>${esc(c.name)}</b>${esc(c.navy)}${c.territoryNote ? `<br>顯示範圍：${esc(c.territoryNote)}` : ''}<br>點擊進入`;
  } else { el.tip.hidden = true; return; }
  el.tip.hidden = false; el.tip.style.left = x + 'px'; el.tip.style.top = y + 'px';
});

// ---------- 啟動 ----------
(async function init() {
  countries = (await (await fetch('data/countries.json', { cache: 'no-cache' })).json()).countries;
  await globe.load('vendor/countries-50m.json', 'vendor/countries-110m.json', countries);
  route();
})().catch(err => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<div class="panel panel-left"><h2>載入失敗</h2><p>${esc(err.message)}</p><p class="lead">若是在自己電腦上直接點兩下開啟 index.html，請改用本機伺服器（見 README）。</p></div>`);
});
