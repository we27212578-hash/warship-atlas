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
      world,
      land: topojson.merge(world, world.objects.countries.geometries),
      borders: topojson.mesh(world, world.objects.countries, (a, b) => a !== b),
      byId: new Map(topojson.feature(world, world.objects.countries).features.map(f => [String(f.id), f])),
      byName: new Map(topojson.feature(world, world.objects.countries).features.map(f => [f.properties.name, f]))
    });
    this.hi = prep(hi); this.lo = prep(lo);
    // 把「歷史領土」清單（現今國名）合併成一塊，另外處理只取一部分的國家
    const group = (geo, cfg, list) => {
      const names = new Set((list || []).filter(t => typeof t === 'string'));
      const geoms = geo.world.objects.countries.geometries.filter(g => names.has(g.properties.name) && String(g.id) !== String(cfg.isoNumeric));
      const partials = (list || []).filter(t => typeof t === 'object' && t.clip).map(t => {
        const ring = t.clip.concat([t.clip[0]]);
        let clip = { type: 'Polygon', coordinates: [ring] };
        if (d3.geoArea(clip) > 2 * Math.PI) clip = { type: 'Polygon', coordinates: [ring.slice().reverse()] };   // d3 要求順時針
        return { feature: geo.byName.get(t.name), clip };
      }).filter(p => p.feature);
      // outline：只畫外框的海域範圍（例如由許多小島組成的託管地）
      const outlines = (list || []).filter(t => typeof t === 'object' && t.outline).map(t => {
        const ring = t.outline.concat([t.outline[0]]);
        let poly = { type: 'Polygon', coordinates: [ring] };
        if (d3.geoArea(poly) > 2 * Math.PI) poly = { type: 'Polygon', coordinates: [ring.slice().reverse()] };
        return poly;
      });
      // line：不封閉的虛線（例如勢力範圍線）
      const lines = (list || []).filter(t => typeof t === 'object' && t.line).map(t => ({ type: 'LineString', coordinates: t.line }));
      return { ext: geoms.length ? topojson.merge(geo.world, geoms) : null, partials, outlines, lines };
    };
    // territoryCore：與本土同樣濃度；territory：較淡（除非 territoryStyle 為 solid）
    const territory = (geo, cfg) => ({ solid: group(geo, cfg, cfg.territoryCore), dim: group(geo, cfg, cfg.territory) });
    const loadImg = (file, done) => { const img = new Image(); img.onload = () => done(img); img.src = `assets/flags/${file}`; };
    for (const cfg of countryConfigs) {
      const feature = this.hi.byId.get(String(cfg.isoNumeric));
      if (!feature) { console.warn('找不到國家邊界', cfg.id, cfg.isoNumeric); continue; }
      const entry = {
        cfg, feature, featureLo: this.lo.byId.get(String(cfg.isoNumeric)) || feature,
        terHi: territory(this.hi, cfg), terLo: territory(this.lo, cfg),
        flagImg: null, emblemImg: null, layer: null, layerKey: '', alpha: 0
      };
      this.countries.set(cfg.id, entry);
      loadImg(cfg.flag.file, img => { entry.flagImg = img; entry.layerKey = ''; });
      if (cfg.flag.emblem) loadImg(cfg.flag.emblem, img => { entry.emblemImg = img; });
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

    // 國旗：懸停或選取中的國家
    for (const [id, entry] of this.countries) {
      const targetA = id === this.hoverCountry ? 1 : (id === this.selectedCountry ? this.selectedAlpha : 0);
      entry.alpha += (targetA - entry.alpha) * 0.09;
      if (entry.alpha > 0.01) this._drawFlag(entry, t);
      else if (entry.layer) { entry.layer.width = entry.layer.height = 0; entry.layer = null; entry.layerKey = ''; }   // 釋放記憶體
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

  // 國旗分兩種畫法（由 countries.json 的 flag.mode 決定）：
  //   emblem：整片領土塗上國旗底色，中央放徽記，徽記向外放射光芒
  //   fill  ：整面國旗置中鋪滿本土，其餘領土塗上代表色
  // 領土的填色比較耗時，所以畫在各國自己的快取圖層上，視角不變就不重畫。
  _drawFlag(entry, t) {
    const { ctx, dpr } = this;
    const flag = entry.cfg.flag, a = entry.alpha;
    const key = `${this._viewKey}|${this.moving ? 'lo' : 'hi'}|${!!entry.flagImg}`;
    if (entry.layerKey !== key) { this._renderFlagLayer(entry); entry.layerKey = key; }

    const [lon, lat] = flag.center;
    const shown = this._visible(lon, lat);
    const [x, y] = shown ? this.projection([lon, lat]) : [0, 0];
    const k = RAD * this.radius;
    const size = Array.isArray(flag.size) ? flag.size : [flag.size, flag.size];
    const glow = flag.glow || '#ffffff';
    const layer = () => {
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = a;
      ctx.drawImage(entry.layer, 0, 0); ctx.restore();
    };

    // 以國旗中心當地的「東」與「南」為座標軸，圖案就會固定在地表上，不會隨視角歪斜
    const frame = shown ? this._localFrame(lon, lat) : null;
    const local = draw => { ctx.save(); ctx.transform(frame.a, frame.b, frame.c, frame.d, x, y); draw(); ctx.restore(); };

    if (flag.mode === 'emblem') {
      layer();
      if (!shown || !entry.emblemImg) return;
      const r = Math.max(size[0] * k / 2, 16);
      local(() => {
        this._drawRays(0, 0, r * 1.08, r * 2.1, glow, a, t, 24);
        ctx.globalAlpha = a;
        ctx.shadowColor = glow; ctx.shadowBlur = 10 + 6 * Math.sin(t / 600);
        ctx.drawImage(entry.emblemImg, -r, -r, r * 2, r * 2);
      });
    } else {
      if (shown) { const r = flag.spill ? flag.spill * 1.7 / 2 * k * (entry.flagImg ? entry.flagImg.height / entry.flagImg.width : 0.6) * 0.8 : Math.max(Math.min(size[0], size[1]) * k / 2, 14); local(() => this._drawRays(0, 0, r * 0.9, r * (flag.spill ? 1.9 : 2.3), glow, a * 0.8, t, 32)); }
      layer();
    }
  }

  // 傳回把「當地東、南方向的 1 像素」對應到螢幕的 2x2 矩陣（正對鏡頭時是單位矩陣）
  _localFrame(lon, lat) {
    const az = d3.geoAzimuthalEquidistant().rotate([-lon, -lat]).scale(180 / Math.PI).translate([0, 0]);
    const o = this.projection([lon, lat]), d = 0.5, k = d * RAD * this.radius;
    const e = this.projection(az.invert([d, 0])), s = this.projection(az.invert([0, d]));
    return { a: (e[0] - o[0]) / k, b: (e[1] - o[1]) / k, c: (s[0] - o[0]) / k, d: (s[1] - o[1]) / k };
  }

  // 把國旗切成小三角形逐片貼到球面上：國旗的上方永遠朝北，靠近地球邊緣時會跟著地表一起縮短
  _drawFlagOnSphere(g, img, lon, lat, size, n) {
    const az = d3.geoAzimuthalEquidistant().rotate([-lon, -lat]).scale(180 / Math.PI).translate([0, 0]);
    const aspect = img.width / img.height;
    // size 是 [寬, 高] 時等比例放大到蓋滿；是 { width } 時整面國旗以該寬度完整呈現（單位：度）
    const W = Array.isArray(size) ? Math.max(size[0], size[1] * aspect) : size.width, H = W / aspect;
    const nx = n, ny = Math.max(4, Math.round(n / aspect));
    const pts = [];
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
      const ll = az.invert([(i / nx - 0.5) * W, (j / ny - 0.5) * H]);
      const vis = this._visible(ll[0], ll[1]);
      pts.push({ u: i / nx * img.width, v: j / ny * img.height, p: vis ? this.projection(ll) : null });
    }
    const tri = (A, B, C) => {
      if (!A.p || !B.p || !C.p) return;
      // 解出把圖片座標 (u,v) 對應到螢幕座標的仿射轉換
      const det = (B.u - A.u) * (C.v - A.v) - (C.u - A.u) * (B.v - A.v);
      if (!det) return;
      const m11 = ((B.p[0] - A.p[0]) * (C.v - A.v) - (C.p[0] - A.p[0]) * (B.v - A.v)) / det;
      const m12 = ((B.p[1] - A.p[1]) * (C.v - A.v) - (C.p[1] - A.p[1]) * (B.v - A.v)) / det;
      const m21 = ((C.p[0] - A.p[0]) * (B.u - A.u) - (B.p[0] - A.p[0]) * (C.u - A.u)) / det;
      const m22 = ((C.p[1] - A.p[1]) * (B.u - A.u) - (B.p[1] - A.p[1]) * (C.u - A.u)) / det;
      const cx = (A.p[0] + B.p[0] + C.p[0]) / 3, cy = (A.p[1] + B.p[1] + C.p[1]) / 3;
      const grow = q => { const dx = q[0] - cx, dy = q[1] - cy, l = Math.hypot(dx, dy) || 1; return [q[0] + dx / l * 0.8, q[1] + dy / l * 0.8]; };   // 稍微放大避免接縫
      const a = grow(A.p), b = grow(B.p), c = grow(C.p);
      g.save();
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(c[0], c[1]); g.closePath(); g.clip();
      g.transform(m11, m12, m21, m22, A.p[0] - m11 * A.u - m21 * A.v, A.p[1] - m12 * A.u - m22 * A.v);
      g.drawImage(img, 0, 0);
      g.restore();
    };
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const q = j * (nx + 1) + i;
      tri(pts[q], pts[q + 1], pts[q + nx + 1]);
      tri(pts[q + 1], pts[q + nx + 2], pts[q + nx + 1]);
    }
  }

  _renderFlagLayer(entry) {
    const { w, h, dpr } = this, R = this.radius, [cx, cy] = this.center;
    if (!entry.layer) entry.layer = document.createElement('canvas');
    const c = entry.layer;
    if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const g = c.getContext('2d'), path = d3.geoPath(this.projection, g);
    const flag = entry.cfg.flag, field = flag.field || '#2f9bff';
    const core = this.moving ? entry.featureLo : entry.feature;
    const ter = this.moving ? entry.terLo : entry.terHi;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.save();
    g.beginPath(); g.arc(cx, cy, R, 0, 7); g.clip();

    // 本土太小的國家：國旗先以圓形範圍鋪在國界外，愈往外愈淡，上面再疊領土與清楚的本土
    const spill = flag.mode !== 'emblem' && flag.spill && entry.flagImg && this._visible(flag.center[0], flag.center[1]);
    const flagSize = flag.mode === 'emblem' ? null : (flag.spill ? { width: flag.spill * 1.7 } : flag.size);
    if (spill) {
      // 國旗四邊都要在碰到邊緣之前淡到完全透明，才不會看到一塊長方形貼在地圖上。
      // 畫兩層：下層是模糊且範圍較大的國旗，上層是清楚但範圍較小的國旗，疊起來就是「愈往外愈模糊、愈淡」。
      const img = entry.flagImg, [lon, lat] = flag.center;
      const sc = this._scratch || (this._scratch = document.createElement('canvas'));
      if (sc.width !== c.width || sc.height !== c.height) { sc.width = c.width; sc.height = c.height; }
      const sg = sc.getContext('2d');
      const [sx, sy] = this.projection([lon, lat]), f = this._localFrame(lon, lat);
      const hw = flagSize.width / 2 * RAD * R, hh = hw * img.height / img.width;
      const pass = (solidTo, fadeTo, blurPx) => {
        sg.setTransform(dpr, 0, 0, dpr, 0, 0); sg.globalCompositeOperation = 'source-over'; sg.clearRect(0, 0, w, h);
        this._drawFlagOnSphere(sg, img, lon, lat, flagSize, this.moving ? 8 : 16);
        sg.globalCompositeOperation = 'destination-in';
        sg.save(); sg.transform(f.a, f.b, f.c, f.d, sx, sy);
        const edge = (fadeTo - solidTo) / (2 * fadeTo);
        for (const [gx, gy] of [[hw * fadeTo, 0], [0, hh * fadeTo]]) {   // 先淡左右兩邊，再淡上下兩邊
          const grad = sg.createLinearGradient(-gx, -gy, gx, gy);
          grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(edge, 'rgba(0,0,0,1)');
          grad.addColorStop(1 - edge, 'rgba(0,0,0,1)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
          sg.fillStyle = grad; sg.fillRect(-hw * 6, -hw * 6, hw * 12, hw * 12);
        }
        sg.restore();
        g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
        if (blurPx) { try { g.filter = `blur(${blurPx}px)`; } catch (e) { /* 不支援就只淡出不模糊 */ } }
        g.drawImage(sc, 0, 0); g.restore();
      };
      pass(0.3, 0.98, Math.max(3, hh * 0.09) * dpr);
      pass(0.25, 0.72, 0);
    }

    // 本土以外的歷史領土：國旗底色。核心領土與本土同濃度，其餘稍微透明
    const fillGroup = (grp, alpha) => {
      g.fillStyle = field; g.globalAlpha = alpha;
      if (grp.ext) { g.beginPath(); path(grp.ext); g.fill(); }
      for (const p of grp.partials) {
        g.save(); g.beginPath(); path(p.feature); g.clip();
        g.beginPath(); path(p.clip); g.fill(); g.restore();
      }
    };
    fillGroup(ter.dim, flag.territoryStyle === 'solid' ? 0.9 : 0.5);
    fillGroup(ter.solid, 0.9);

    // 本土
    g.globalAlpha = 0.9;
    if (flag.mode === 'emblem' || !entry.flagImg) { g.beginPath(); path(core); g.fill(); }
    else {
      const img = entry.flagImg, [lon, lat] = flag.center;
      g.save(); g.beginPath(); path(core); g.clip();
      g.fillRect(cx - R, cy - R, R * 2, R * 2);   // 國旗蓋不到的離島先墊底色
      g.globalAlpha = 0.96;
      this._drawFlagOnSphere(g, img, lon, lat, flagSize, this.moving ? 8 : 16);
      g.restore();
    }

    // 發光的外框
    g.globalAlpha = 1;
    g.shadowColor = flag.glow || '#bfe4ff'; g.shadowBlur = 16;
    g.strokeStyle = 'rgba(235,246,255,0.95)'; g.lineWidth = 1.3;
    g.beginPath(); path(core);
    for (const grp of [ter.solid, ter.dim]) if (grp.ext) path(grp.ext);
    g.stroke();
    for (const grp of [ter.solid, ter.dim]) for (const o of grp.outlines) {
      g.beginPath(); path(o);
      g.fillStyle = field; g.globalAlpha = 0.07; g.fill();
      g.globalAlpha = 1; g.setLineDash([7, 5]); g.stroke(); g.setLineDash([]);
    }
    for (const grp of [ter.solid, ter.dim]) for (const l of grp.lines) {
      g.save(); g.beginPath(); path(l);
      const short = l.coordinates.length < 3;
      g.strokeStyle = field; g.lineWidth = short ? 3.2 : 2.2; g.lineCap = 'round'; g.shadowColor = field; g.shadowBlur = 10; g.setLineDash(short ? [] : [9, 6]); g.stroke();
      g.restore();
    }
    g.shadowBlur = 6;
    for (const grp of [ter.solid, ter.dim]) for (const p of grp.partials) {   // 手繪範圍：國界與手繪線各畫一次
      g.save(); g.beginPath(); path(p.clip); g.clip(); g.beginPath(); path(p.feature); g.stroke(); g.restore();
      g.save(); g.beginPath(); path(p.feature); g.clip(); g.beginPath(); path(p.clip); g.stroke(); g.restore();
    }
    g.restore();
  }

  // 從 (x, y) 向外放射的光芒：像鏡頭對著強光時的星芒。
  // 中心一圈柔和的光暈，外加許多粗細、長短、亮度都不同的細光絲，各自緩慢閃爍。
  _drawRays(x, y, r0, r1, color, alpha, t, n) {
    const { ctx } = this;
    const rnd = (i, k) => { const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return v - Math.floor(v); };
    const span = r1 - r0;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(x, y);

    // 光暈
    const halo = ctx.createRadialGradient(0, 0, r0 * 0.55, 0, 0, r0 + span * 0.85);
    halo.addColorStop(0, hexA(color, 0.55 * alpha)); halo.addColorStop(0.35, hexA(color, 0.22 * alpha)); halo.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(0, 0, r0 + span * 0.85, 0, 7); ctx.fill();

    // 光絲：長度分成幾級，每級共用一個漸層
    ctx.rotate(t / 26000);
    const count = n * 4, levels = [0.45, 0.8, 1.25, 1.9, 2.9];
    const grads = levels.map(m => {
      const g = ctx.createLinearGradient(r0 * 0.8, 0, r0 + span * m, 0);
      g.addColorStop(0, hexA(color, 0.9)); g.addColorStop(0.35, hexA(color, 0.45)); g.addColorStop(1, hexA(color, 0));
      return g;
    });
    for (let i = 0; i < count; i++) {
      const h = rnd(i, 1);
      const lv = h < 0.4 ? 0 : h < 0.7 ? 1 : h < 0.88 ? 2 : h < 0.97 ? 3 : 4;   // 多數短、少數特別長
      const len = span * levels[lv];
      const half = Math.max(0.5, r0 * (0.006 + 0.016 * rnd(i, 2)));
      const flicker = 0.7 + 0.3 * Math.sin(t / (500 + 900 * rnd(i, 3)) + i);
      ctx.save();
      ctx.rotate((i + rnd(i, 4) * 0.9) * 2 * Math.PI / count);
      ctx.globalAlpha = alpha * (0.25 + 0.75 * rnd(i, 5)) * flicker;
      ctx.fillStyle = grads[lv];
      ctx.beginPath(); ctx.moveTo(r0 * 0.8, -half); ctx.lineTo(r0 + len, 0); ctx.lineTo(r0 * 0.8, half); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
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

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
