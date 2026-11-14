// 檢查 data/ 內的資料是否符合 AGENTS.md 的格式。用法：node scripts/validate.mjs
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TYPES = ['origin', 'battle', 'event', 'fate'];
const need = (obj, keys, where) => keys.forEach(k => { if (obj[k] === undefined || obj[k] === '' || obj[k] === null) err(where, `缺少欄位 "${k}"`); });
const checkImage = (img, where) => {
  if (!img) return;
  if (!img.wiki && !img.file && !img.src) err(where, '圖片必須有 wiki、file 或 src 其中之一');
  if (img.src && !existsSync(join(root, img.src))) err(where, `找不到圖片檔 ${img.src}`);
  if (img.src && !img.credit) err(where, '使用 src 的圖片必須填 credit（來源與授權）');
  if (!img.caption) err(where, '圖片缺少 caption');
};

const { countries } = JSON.parse(readFileSync(join(root, 'data/countries.json'), 'utf8'));
const mapNames = new Set(JSON.parse(readFileSync(join(root, 'vendor/countries-50m.json'), 'utf8')).objects.countries.geometries.map(g => g.properties.name));
const seenCountry = new Set();
let nClass = 0, nShip = 0, nEvent = 0;

for (const c of countries) {
  const cw = `countries.json › ${c.id}`;
  need(c, ['id', 'isoNumeric', 'name', 'nameEn', 'navy', 'flag', 'focus', 'summary', 'classes'], cw);
  if (!ID.test(c.id || '')) err(cw, 'id 只能用小寫英數與連字號');
  if (seenCountry.has(c.id)) err(cw, 'id 重複'); seenCountry.add(c.id);
  if (c.flag && !existsSync(join(root, 'assets/flags', c.flag.file || ''))) err(cw, `找不到國旗檔 assets/flags/${c.flag && c.flag.file}`);
  if (c.flag) {
    need(c.flag, ['file', 'name', 'mode', 'field', 'center', 'size'], `${cw} › flag`);
    if (!['emblem', 'fill'].includes(c.flag.mode)) err(cw, 'flag.mode 必須是 emblem 或 fill');
    if (c.flag.mode === 'emblem' && !existsSync(join(root, 'assets/flags', c.flag.emblem || '-'))) err(cw, 'emblem 模式必須有 flag.emblem，且檔案要存在於 assets/flags/');
    if (c.flag.mode === 'emblem' && typeof c.flag.size !== 'number') err(cw, 'emblem 模式的 flag.size 是一個數字（徽記直徑，單位為度）');
    if (c.flag.mode === 'fill' && !(Array.isArray(c.flag.size) && c.flag.size.length === 2)) err(cw, 'fill 模式的 flag.size 是 [寬, 高]（單位為度）');
  }
  for (const t of [...(c.territory || []), ...(c.territoryCore || [])]) {
    if (typeof t === 'object' && t.outline) { if (!(Array.isArray(t.outline) && t.outline.length >= 3)) err(cw, 'territory 的 outline 需要至少 3 個點'); continue; }
    const name = typeof t === 'string' ? t : t.name;
    if (!mapNames.has(name)) err(cw, `territory 的 "${name}" 不在 vendor 世界地圖的國名中`);
    if (typeof t === 'object' && !(Array.isArray(t.clip) && t.clip.length >= 3)) err(cw, `territory 的 "${name}" 需要至少 3 個點的 clip`);
  }
  if ((c.territory || []).length && !c.territoryNote) err(cw, '有 territory 就必須寫 territoryNote');

  for (const classId of c.classes || []) {
    const file = `data/${c.id}/${classId}.json`;
    if (!existsSync(join(root, file))) { err(cw, `找不到 ${file}`); continue; }
    let cls;
    try { cls = JSON.parse(readFileSync(join(root, file), 'utf8')); } catch (e) { err(file, `JSON 格式錯誤：${e.message}`); continue; }
    nClass++;
    need(cls, ['id', 'name', 'nameEn', 'type', 'years', 'summary', 'ships'], file);
    if (cls.id !== classId) err(file, `id "${cls.id}" 必須與檔名 "${classId}" 相同`);
    checkImage(cls.image, `${file} › image`);
    const seenShip = new Set();
    for (const s of cls.ships || []) {
      const sw = `${file} › ${s.id}`;
      nShip++;
      need(s, ['id', 'name', 'nameEn', 'tagline', 'image', 'summary', 'specs', 'timeline', 'events', 'sources'], sw);
      if (!ID.test(s.id || '')) err(sw, 'id 只能用小寫英數與連字號');
      if (seenShip.has(s.id)) err(sw, 'id 重複'); seenShip.add(s.id);
      checkImage(s.image, `${sw} › image`);
      if (!(s.sources || []).length) err(sw, '至少要有一筆 sources');
      const evs = s.events || [];
      if (evs.length < 2) err(sw, '至少要有 2 個事件');
      if (!evs.some(e => e.type === 'origin')) err(sw, '必須有一個 type 為 origin 的建造背景事件');
      const seenEv = new Set();
      for (const e of evs) {
        const ew = `${sw} › ${e.id}`;
        nEvent++;
        need(e, ['id', 'type', 'title', 'date', 'place', 'lat', 'lon', 'summary', 'body', 'images'], ew);
        if (!ID.test(e.id || '')) err(ew, 'id 只能用小寫英數與連字號');
        if (seenEv.has(e.id)) err(ew, 'id 重複'); seenEv.add(e.id);
        if (!TYPES.includes(e.type)) err(ew, `type 必須是 ${TYPES.join(' / ')}`);
        if (typeof e.lat !== 'number' || e.lat < -90 || e.lat > 90) err(ew, 'lat 必須是 -90 到 90 的數字');
        if (typeof e.lon !== 'number' || e.lon < -180 || e.lon > 180) err(ew, 'lon 必須是 -180 到 180 的數字');
        if (!Array.isArray(e.body) || e.body.length < 2) err(ew, 'body 必須是至少 2 段的陣列');
        if (!Array.isArray(e.images) || e.images.length < 2) err(ew, 'images 至少要 2 張');
        (e.images || []).forEach((img, i) => checkImage(img, `${ew} › images[${i}]`));
      }
    }
  }
}

if (errors.length) { console.error(`發現 ${errors.length} 個問題：\n- ` + errors.join('\n- ')); process.exit(1); }
console.log(`資料檢查通過：${countries.length} 個國家、${nClass} 個艦級、${nShip} 艘艦、${nEvent} 個事件。`);
