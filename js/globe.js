// 3D 地球：繪製、拖曳、縮放、國旗光暈、事件標記。
// 這個檔案只負責「畫」與「互動」，不放任何國家或船艦的內容。
const d3 = window.d3;
const topojson = window.topojson;

const MARKER_COLORS = { origin: '#4de3ff', battle: '#ffb347', event: '#9db4ff', fate: '#ff5a5a' };
const RAD = Math.PI / 180;

export class Globe {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.projection = d3.geoOrthographic().clipAngle(90).precision(0.4);
    this.path = d3.geoPath(this.projection, this.ctx);
    this.graticule = d3.geoGraticule().step([15, 15])();
    this.rotation = [-135, -28, 0];
    this.zoom = 1;
    this.insets = { left: 0, right: 0, bottom: 0 };
    this.center = null;
    this.countries = new Map();   // id -> { cfg, feature, flagImg, halo, alpha }
    this.markers = [];
    this.track = null;
    this.hoverCountry = null;
    this.selectedCountry = null;
    this.selectedAlpha = 0.5;
    this.hoverMarker = null;
    this.activeMarker = null;
    this.autoRotate = true;
    this.interactive = true;      // 是否允許懸停／點擊國家
    this.lastInteraction = 0;
    this.fly = null;
    this.handlers = {};
    this._bind();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  on(name, fn) { this.handlers[name] = fn; }
  _emit(name, ...args) { if (this.handlers[name]) this.handlers[name](...args); }

  // 載入兩種精細度的世界地圖：轉動時用粗的（快），停下來後用細的（漂亮）。
  async load(hiUrl, loUrl, countryConfigs) {
    const [hi, lo] = await Promise.all([hiUrl, loUrl].map(u => fetch(u).then(r => r.json())));
    const prep = world => ({
      land: topojson.merge(world, world.objects.countries.geometries),
      borders: topojson.mesh(world, world.objects.countries, (a, b) => a !== b),
      byId: new Map(topojson.feature(world, world.objects.countries).features.map(f => [String(f.id), f]))
    });
    this.hi = prep(hi); this.lo = prep(lo);
    for (const cfg of countryConfigs) {
      const feature = this.hi.byId.get(String(cfg.isoNumeric));
      if (!feature) { console.warn('找不到國家邊界', cfg.id, cfg.isoNumeric); continue; }
      const entry = { cfg, feature, featureLo: this.lo.byId.get(String(cfg.isoNumeric)) || feature, flagImg: null, halo: null, alpha: 0 };
      this.countries.set(cfg.id, entry);
      const img = new Image();
      img.onload = () => { entry.flagImg = img; entry.halo = makeHalo(img); };
      img.src = `assets/flags/${cfg.flag.file}`;
    }
    const all = [...this.countries.values()];
    this.hi.active = { type: 'FeatureCollection', features: all.map(e => e.feature) };
    this.lo.active = { type: 'FeatureCollection', features: all.map(e => e.featureLo) };
    this.baseLayer = document.createElement('canvas');
    this.activeLayer = document.createElement('canvas');
    requestAnimationFrame(t => this._frame(t));
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth; this.h = window.innerHeight; this.dpr = dpr;
    this.canvas.width = this.w * dpr; this.canvas.height = this.h * dpr;
    this._viewKey = null;
  }

  setInsets(insets) { this.insets = { left: 0, right: 0, bottom: 0, ...insets }; }

  setMarkers(markers, activeId = null) {
    this.markers = markers || [];
    this.activeMarker = activeId;
    this.track = this.markers.length > 1
      ? { type: 'LineString', coordinates: this.markers.map(m => [m.lon, m.lat]) }
      : null;
  }

  flyTo({ lon, lat, zoom }, ms = 1100) {
    const from = { r: this.rotation.slice(), z: this.zoom };
    const to = { r: [-lon, -lat, 0], z: zoom ?? this.zoom };
    // 走最短經度方向
    let dl = to.r[0] - from.r[0];
    dl = ((dl + 540) % 360) - 180;
    to.r[0] = from.r[0] + dl;
    this.fly = { from, to, start: performance.now(), ms };
  }

  zoomBy(f) { this.fly = null; this.zoom = clamp(this.zoom * f, 0.7, 8); }

  // ---------- 互動 ----------
  _bind() {
    const c = this.canvas;
    let drag = null;
    const pointers = new Map();
    let pinch = null;

    c.addEventListener('pointerdown', e => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      this.lastInteraction = performance.now();
      this.fly = null;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: this.zoom };
        drag = null;
      } else {
        drag = { x: e.clientX, y: e.clientY, r: this.rotation.slice(), moved: false };
      }
    });
    c.addEventListener('pointermove', e => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        this.zoom = clamp(pinch.z * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d, 0.7, 8);
        return;
      }
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; c.classList.add('dragging'); this._setHover(null, null, e); }
        if (drag.moved) {
          const k = 180 / Math.PI / this.radius;
          this.rotation = [drag.r[0] + dx * k, clamp(drag.r[1] - dy * k, -88, 88), 0];
          this.lastInteraction = performance.now();
        }
        return;
      }
      if (e.pointerType === 'mouse') this._hoverAt(e);
    });
    const end = e => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (drag) {
        const wasDrag = drag.moved;
        drag = null; c.classList.remove('dragging');
        if (!wasDrag && e.type === 'pointerup') this._clickAt(e);
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', e => { if (!drag) this._setHover(null, null, e); });
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.zoomBy(Math.exp(-e.deltaY * 0.0012));
      this.lastInteraction = performance.now();
    }, { passive: false });
  }

  _pick(e) {
    const x = e.clientX, y = e.clientY;
    // 先找事件標記
    let best = null, bestD = 16;
    for (const m of this.markers) {
      if (!m._xy) continue;
      const d = Math.hypot(m._xy[0] - x, m._xy[1] - y);
      if (d < bestD) { best = m; bestD = d; }
    }
    if (best) return { marker: best };
    if (!this.interactive || !this.center) return {};
    if (Math.hypot(x - this.center[0], y - this.center[1]) > this.radius) return {};
    const ll = this.projection.invert([x, y]);
    if (!ll || isNaN(ll[0])) return {};
    for (const [id, entry] of this.countries) {
      if (d3.geoContains(entry.feature, ll)) return { country: id };
    }
    return {};
  }

  _hoverAt(e) {
    const hit = this._pick(e);
    this._setHover(hit.country || null, hit.marker || null, e);
  }

  _setHover(country, marker, e) {
    const changed = country !== this.hoverCountry || (marker && marker.id) !== (this.hoverMarker && this.hoverMarker.id);
    this.hoverCountry = country; this.hoverMarker = marker;
    this.canvas.classList.toggle('pointing', !!(country || marker));
    if (changed || country || marker) this._emit('hover', { country, marker, x: e.clientX, y: e.clientY });
  }

  _clickAt(e) {
    const hit = this._pick(e);
    if (hit.marker) this._emit('markerclick', hit.marker);
    else if (hit.country) this._emit('countryclick', hit.country);
  }

  // ---------- 繪製 ----------
  _frame(t) {
    const { ctx, w, h, dpr } = this;
    // 視角動畫
    if (this.fly) {
      const k = Math.min(1, (t - this.fly.start) / this.fly.ms);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      const { from, to } = this.fly;
      this.rotation = [0, 1, 2].map(i => from.r[i] + (to.r[i] - from.r[i]) * e);
      this.zoom = from.z + (to.z - from.z) * e;
      if (k >= 1) this.fly = null;
    } else if (this.autoRotate && !this.hoverCountry && t - this.lastInteraction > 4000) {
      this.rotation[0] += 0.035;
    }

    // 版面：面板打開時把地球移到剩下的空間中央
    const ins = this.insets;
    const availW = w - ins.left - ins.right, availH = h - ins.bottom;
    const target = [ins.left + availW / 2, availH / 2 + 12];
    const baseR = Math.max(120, Math.min(availW, availH - 110) * 0.46);
    if (!this.center) { this.center = target.slice(); this.baseR = baseR; }
    this.center[0] += (target[0] - this.center[0]) * 0.12;
    this.center[1] += (target[1] - this.center[1]) * 0.12;
    this.baseR += (baseR - this.baseR) * 0.12;
    if (Math.abs(target[0] - this.center[0]) + Math.abs(target[1] - this.center[1]) + Math.abs(baseR - this.baseR) < 0.5) { this.center = target.slice(); this.baseR = baseR; }
    const R = this.radius = this.baseR * this.zoom;
    const [cx, cy] = this.center;
    this.projection.scale(R).translate([cx, cy]).rotate(this.rotation);

    // 底圖（球體、網格、陸地）只在視角改變時重畫，其餘時間直接貼上快取。
    const key = [cx, cy, R, this.rotation[0], this.rotation[1]].map(v => v.toFixed(2)).join(',');
    const moving = key !== this._viewKey;
    this._viewKey = key;
    this.moving = moving;
    if (moving || this._layersAreLo) { this._renderLayers(moving ? this.lo : this.hi); this._layersAreLo = moving; }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w * dpr, h * dpr);
    ctx.drawImage(this.baseLayer, 0, 0);
    if (this.interactive) {   // 有資料的國家：緩慢呼吸的亮光
      ctx.globalAlpha = 0.65 + 0.35 * Math.sin(t / 900);
      ctx.drawImage(this.activeLayer, 0, 0);
      ctx.globalAlpha = 1;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.clip();

    // 國旗光暈
    for (const [id, entry] of this.countries) {
      const targetA = id === this.hoverCountry ? 1 : (id === this.selectedCountry ? this.selectedAlpha : 0);
      entry.alpha += (targetA - entry.alpha) * 0.09;
      if (entry.alpha > 0.01) this._drawFlag(entry);
    }

    // 事件航跡與標記
    this._drawMarkers(t);
    ctx.restore();

    this._drawMarkerLabels();
    requestAnimationFrame(tt => this._frame(tt));
  }

  _renderLayers(geo) {
    const { w, h, dpr } = this, R = this.radius, [cx, cy] = this.center;
    for (const c of [this.baseLayer, this.activeLayer]) {
      if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
    }
    const ctx = this.baseLayer.getContext('2d');
    const path = d3.geoPath(this.projection, ctx);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 外圈光暈
    const glow = ctx.createRadialGradient(cx, cy, R * 0.96, cx, cy, R * 1.22);
    glow.addColorStop(0, 'rgba(47,155,255,0.30)');
    glow.addColorStop(0.35, 'rgba(47,155,255,0.08)');
    glow.addColorStop(1, 'rgba(47,155,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.22, 0, 7); ctx.fill();

    // 球體
    const body = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.05, cx, cy, R);
    body.addColorStop(0, '#06203d'); body.addColorStop(0.6, '#020d1c'); body.addColorStop(1, '#00050c');
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fill();

    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.clip();
    // 經緯網格
    ctx.beginPath(); path(this.graticule);
    ctx.strokeStyle = 'rgba(47,155,255,0.07)'; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.strokeStyle = 'rgba(70,170,255,0.30)'; ctx.lineWidth = 0.6; ctx.stroke();
    // 陸地
    ctx.beginPath(); path(geo.land);
    ctx.fillStyle = 'rgba(30,120,230,0.10)'; ctx.fill();
    ctx.strokeStyle = 'rgba(47,155,255,0.16)'; ctx.lineWidth = 4; ctx.stroke();
    ctx.strokeStyle = 'rgba(110,195,255,0.85)'; ctx.lineWidth = 0.8; ctx.stroke();
    ctx.beginPath(); path(geo.borders);
    ctx.strokeStyle = 'rgba(70,160,255,0.22)'; ctx.lineWidth = 0.5; ctx.stroke();
    ctx.restore();

    // 球緣
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7);
    ctx.shadowColor = '#2f9bff'; ctx.shadowBlur = 22;
    ctx.strokeStyle = 'rgba(124,200,255,0.9)'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.shadowBlur = 0;

    // 有資料的國家
    const a = this.activeLayer.getContext('2d');
    const apath = d3.geoPath(this.projection, a);
    a.setTransform(dpr, 0, 0, dpr, 0, 0);
    a.clearRect(0, 0, w, h);
    a.save();
    a.beginPath(); a.arc(cx, cy, R, 0, 7); a.clip();
    a.beginPath(); apath(geo.active);
    a.fillStyle = 'rgba(60,170,255,0.20)'; a.fill();
    a.strokeStyle = 'rgba(170,225,255,0.9)'; a.lineWidth = 1.1; a.stroke();
    a.restore();
  }

  _visible(lon, lat) {
    const c = [-this.rotation[0], -this.rotation[1]];
    return d3.geoDistance([lon, lat], c) < Math.PI / 2 - 0.02;
  }

  _drawFlag(entry) {
    const { ctx } = this;
    const { flag } = entry.cfg;
    const img = entry.flagImg;
    if (!img) return;
    const [lon, lat] = flag.center;
    if (!this._visible(lon, lat)) return;
    const [x, y] = this.projection([lon, lat]);
    const fw = flag.width * RAD * this.radius;
    const fh = fw * img.height / img.width;
    const a = entry.alpha;
    const shape = this.moving ? entry.featureLo : entry.feature;

    // 1) 向外暈開的光：模糊後的國旗，愈外圍愈淡
    if (entry.halo) {
      const s = Math.max(fw * 2.6, 190);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.95 * a;
      ctx.drawImage(entry.halo, x - s / 2, y - s / 2, s, s);
      ctx.restore();
    }
    // 2) 領土內：清楚的國旗
    ctx.save();
    ctx.beginPath(); this.path(shape); ctx.clip();
    ctx.globalAlpha = 0.92 * a;
    ctx.drawImage(img, x - fw / 2, y - fh / 2, fw, fh);
    ctx.restore();
    // 3) 發光的國界
    ctx.save();
    ctx.beginPath(); this.path(shape);
    ctx.shadowColor = '#bfe4ff'; ctx.shadowBlur = 14;
    ctx.strokeStyle = `rgba(225,242,255,${0.95 * a})`; ctx.lineWidth = 1.4; ctx.stroke();
    ctx.restore();
  }

  _drawMarkers(t) {
    const { ctx } = this;
    if (this.track) {
      ctx.beginPath(); this.path(this.track);
      ctx.setLineDash([5, 6]); ctx.lineDashOffset = -t / 60;
      ctx.strokeStyle = 'rgba(160,215,255,0.6)'; ctx.lineWidth = 1.1; ctx.stroke();
      ctx.setLineDash([]);
    }
    this.markers.forEach((m, i) => {
      if (!this._visible(m.lon, m.lat)) { m._xy = null; return; }
      const [x, y] = m._xy = this.projection([m.lon, m.lat]);
      const color = MARKER_COLORS[m.type] || MARKER_COLORS.event;
      const active = m.id === this.activeMarker, hover = this.hoverMarker && this.hoverMarker.id === m.id;
      const ph = ((t / 1600) + i * 0.27) % 1;
      ctx.beginPath(); ctx.arc(x, y, 6 + ph * 20, 0, 7);
      ctx.strokeStyle = hexA(color, (1 - ph) * 0.7); ctx.lineWidth = 1.2; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, active || hover ? 7 : 4.5, 0, 7);
      ctx.shadowColor = color; ctx.shadowBlur = 14; ctx.fillStyle = color; ctx.fill(); ctx.shadowBlur = 0;
      if (active) {
        ctx.beginPath(); ctx.arc(x, y, 12, 0, 7);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2; ctx.stroke();
      }
    });
  }

  _drawMarkerLabels() {
    const { ctx } = this;
    ctx.font = '12px "Noto Sans TC","Microsoft JhengHei",sans-serif';
    ctx.textBaseline = 'middle';
    this.markers.forEach((m, i) => {
      if (!m._xy) return;
      const [x, y] = m._xy;
      const label = `${i + 1}  ${m.label}`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(2,12,26,0.82)';
      ctx.fillRect(x + 12, y - 10, tw + 12, 20);
      ctx.strokeStyle = hexA(MARKER_COLORS[m.type] || '#9db4ff', 0.7); ctx.lineWidth = 1;
      ctx.strokeRect(x + 12.5, y - 9.5, tw + 11, 19);
      ctx.fillStyle = '#e4f2ff';
      ctx.fillText(label, x + 18, y + 0.5);
    });
  }
}

// 把國旗做成一張「模糊且向外淡出」的貼圖，懸停時疊在地球上當光暈。
function makeHalo(img) {
  const S = 512;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  const fw = S / 2.6 * 1.25, fh = fw * img.height / img.width;
  try { g.filter = 'blur(22px)'; } catch (e) { /* 舊版瀏覽器沒有 filter 就不模糊 */ }
  g.drawImage(img, (S - fw) / 2, (S - fh) / 2, fw, fh);
  g.filter = 'none';
  g.globalCompositeOperation = 'destination-in';
  const grad = g.createRadialGradient(S / 2, S / 2, S * 0.08, S / 2, S / 2, S / 2);
  grad.addColorStop(0, 'rgba(0,0,0,1)'); grad.addColorStop(0.45, 'rgba(0,0,0,0.55)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad; g.fillRect(0, 0, S, S);
  return c;
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
