// 照片載入。資料檔裡的圖片有三種寫法（擇一）：
//   { "wiki": "英文維基百科條目名稱" }      -> 自動取該條目的代表圖（僅限自由授權）
//   { "file": "維基共享資源檔名.jpg" }       -> 指定 Wikimedia Commons 上的某張圖
//   { "src": "assets/photos/xxx.jpg", "credit": "來源" } -> 放在專案內的圖
// 每張圖都可加 "caption"。
const API = 'https://en.wikipedia.org/w/api.php';
const cache = new Map();   // wiki title -> Promise<{thumb, full, page} | null>

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

export function photoHTML(image) {
  if (!image) return '';
  return `<figure class="photo" data-image="${esc(JSON.stringify(image))}">
    <div class="frame loading"></div>
    <figcaption>${esc(image.caption || '')}</figcaption>
  </figure>`;
}

export function galleryHTML(images) {
  if (!images || !images.length) return '';
  return `<div class="gallery">${images.map(photoHTML).join('')}</div>`;
}

export function thumbHTML(image) {
  if (!image) return '';
  return `<span class="thumb" data-thumb="${esc(JSON.stringify(image))}"></span>`;
}

async function fetchWiki(titles) {
  const need = titles.filter(t => !cache.has(t));
  if (need.length) {
    const url = `${API}?action=query&format=json&origin=*&redirects=1&prop=pageimages&piprop=thumbnail|original&pithumbsize=960&pilicense=free&pilimit=50&titles=${encodeURIComponent(need.join('|'))}`;
    const req = fetch(url).then(r => r.json()).then(j => {
      const q = j.query || {}, alias = new Map();
      for (const n of q.normalized || []) alias.set(n.from, n.to);
      for (const r of q.redirects || []) alias.set(r.from, r.to);
      const pages = new Map(Object.values(q.pages || {}).map(p => [p.title, p]));
      const out = new Map();
      for (const t of need) {
        let name = t; for (let i = 0; i < 3 && alias.has(name); i++) name = alias.get(name);
        const p = pages.get(name);
        out.set(t, p && p.thumbnail ? {
          thumb: p.thumbnail.source,
          full: (p.original && p.original.source) || p.thumbnail.source,
          page: `https://en.wikipedia.org/wiki/${encodeURIComponent(name.replace(/ /g, '_'))}`
        } : null);
      }
      return out;
    }).catch(() => new Map());
    for (const t of need) cache.set(t, req.then(m => m.get(t) || null));
  }
  return Promise.all(titles.map(t => cache.get(t)));
}

async function resolve(image) {
  if (image.src) return { thumb: image.src, full: image.src, credit: image.credit || '' };
  if (image.file) {
    const f = encodeURIComponent(image.file.replace(/ /g, '_'));
    return {
      thumb: `https://commons.wikimedia.org/wiki/Special:FilePath/${f}?width=960`,
      full: `https://commons.wikimedia.org/wiki/Special:FilePath/${f}?width=1920`,
      page: `https://commons.wikimedia.org/wiki/File:${f}`
    };
  }
  if (image.wiki) return (await fetchWiki([image.wiki]))[0];
  return null;
}

// 把容器裡所有的照片位置換成真正的圖片。
export async function hydrate(root, onOpen) {
  const figs = [...root.querySelectorAll('figure.photo[data-image]')];
  const thumbs = [...root.querySelectorAll('[data-thumb]')];
  const all = [...figs.map(f => JSON.parse(f.dataset.image)), ...thumbs.map(t => JSON.parse(t.dataset.thumb))];
  await fetchWiki(all.filter(i => i.wiki && !i.src && !i.file).map(i => i.wiki));   // 一次批次查詢

  for (const fig of figs) {
    const image = JSON.parse(fig.dataset.image);
    const frame = fig.querySelector('.frame'), cap = fig.querySelector('figcaption');
    const r = await resolve(image);
    const fail = () => { if (fig.parentElement && fig.parentElement.classList.contains('gallery')) fig.remove(); else frame.className = 'frame failed'; };
    if (!r) { fail(); continue; }
    const img = new Image();
    img.alt = image.caption || '';   // 注意：不要加 loading='lazy'，圖片還沒放進頁面時瀏覽器會一直不下載
    img.onload = () => { frame.className = 'frame'; frame.appendChild(img); };
    img.onerror = fail;
    img.src = r.thumb;
    frame.addEventListener('click', () => { if (img.complete && img.naturalWidth) onOpen(r.full, image.caption || ''); });
    const credit = r.page ? ` <a href="${r.page}" target="_blank" rel="noopener">圖片來源：Wikimedia</a>` : (r.credit ? ` 圖片來源：${esc(r.credit)}` : '');
    cap.innerHTML = esc(image.caption || '') + credit;
  }
  for (const el of thumbs) {
    const r = await resolve(JSON.parse(el.dataset.thumb));
    if (!r) continue;
    const img = new Image(); img.alt = '';
    img.onload = () => el.appendChild(img);
    img.src = r.thumb;
  }
}
