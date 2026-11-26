/**
 * Page entry point.
 * Two views of the same images: the record (default, after the welcome sequence) and a gallery shuffled on every
 * opening. Clicking an image opens it in volume.
 */
import { t, traduirePage } from './i18n.ts';
import { chemin, donnee } from './res.ts';
import { loadArchives, loadBitmap, bitmapToRGBA, type Archive } from './data.ts';
import { bitmapToBlob } from './exports.ts';
import { Viewer } from './viewer.ts';
import { DiscCarousel } from './carousel.ts';
import { paintSpace, twinkle } from './space.ts';
import { prelude } from './prelude.ts';
import { welcome, spinNear, lastSpin, posePlat } from './welcome.ts';
import { outilRognage } from './rognage.ts';
import { platine } from './audio.ts';
import { refletIcones } from './reflet.ts';
import { loadSettings, buildSettingsPanel, type Settings } from './settings.ts';
import { lossFromTraces, detectAxis, type LossMap } from './loss.ts';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const stage = $('#stage'), grid = $('#grid'), viewerEl = $('#viewer'), status = $('#status');

type Item = { kind: 'archive'; id: string; a: Archive; aspect: number };

let items: Item[] = [];
let current = -1;
let currentBitmap: ImageBitmap | null = null;
const settings: Settings = loadSettings();
const viewer = new Viewer($<HTMLCanvasElement>('#scene'), settings);
viewer.autoMotion = settings.motion;
const lossCache = new Map<string, LossMap>();

// ─── Gallery ──────────────────────────────────────────────────────────────────
function thumbSrc(it: Item): string {
  return chemin(`thumbs/${it.id}.jpg`);
}

type Vue = 'grille' | 'disque';
let vue: Vue = (() => { try { return localStorage.getItem('voyageur-vue') === 'disque' ? 'disque' : 'grille'; } catch { return 'grille'; } })();
let carousel: DiscCarousel | null = null;
const vueBtn = $<HTMLButtonElement>('#vue-btn');
function setVue(v: Vue, garde = false) {
  vue = v;
  try { localStorage.setItem('voyageur-vue', v); } catch { /* storage unavailable */ }
  document.body.classList.toggle('vue-disque', v === 'disque');
  // `garde` keeps the other view during the cross-fade. A view at rest stays in the DOM, invisible, with its images
  // already decoded, so switching back is instant.
  if (v === 'grille') { grid.hidden = false; grid.classList.remove('repos'); if (!garde) stage.classList.add('repos'); } else { stage.hidden = false; stage.classList.remove('repos'); if (!garde) grid.classList.add('repos'); }
  vueBtn.setAttribute('aria-pressed', String(v === 'disque'));
  vueBtn.setAttribute('aria-label', v === 'disque' ? t({ en: 'Show the gallery', fr: 'Afficher la galerie' }) : t({ en: 'Show the record', fr: 'Afficher le disque' }));
  if (v === 'disque' && !carousel) { carousel = new DiscCarousel(stage, carouselArrive && document.body.classList.contains('welcome')); carousel.onOpen = (i) => open(i); }
  renderGrid();
}
let switching = false;
const DOUX = 'cubic-bezier(.2, .7, .2, 1)';
/** Decodes the on-screen thumbnails and shows them without their own fade, so the view cross-fade stays smooth. */
async function preparerVisibles() {
  const h = innerHeight, vis: HTMLElement[] = [];
  for (const c of grid.querySelectorAll<HTMLElement>('.cell')) { const r = c.getBoundingClientRect(); if (r.bottom > -40 && r.top < h + 40) vis.push(c); }
  const imgs = vis.map((c) => c.querySelector('img')!).filter(Boolean);
  await Promise.race([Promise.allSettled(imgs.map((im) => im.decode())), wait(250)]);
  for (const c of vis) { c.style.transition = 'none'; c.classList.add('in'); }
  void grid.offsetWidth;
  for (const c of vis) c.style.transition = '';
}
vueBtn.addEventListener('click', async () => {
  if (switching) return; switching = true;
  try {
    for (const a of grid.getAnimations()) a.cancel();
    grid.style.transition = 'none';   // the CSS opacity transition would otherwise replay at the end of the fade
    if (vue === 'disque') {
      // The gallery fades in over the record, which stays underneath.
      melanger();
      grid.style.opacity = '0';
      setVue('grille', true);
      scrollTo(0, 0);
      await preparerVisibles();
      await grid.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 750, easing: DOUX }).finished;
      grid.style.opacity = ''; void grid.offsetWidth;
      if ((vue as Vue) === 'grille') stage.classList.add('repos');
    } else {
      setVue('disque', true);
      await grid.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 650, easing: 'cubic-bezier(.4, 0, .2, 1)' }).finished;
      if ((vue as Vue) === 'disque') { grid.classList.add('repos'); scrollTo(0, 0); }
    }
  } catch { /* animation cancelled */ }
  finally { grid.style.transition = ''; switching = false; }
});

// The gallery order is reshuffled every time the view opens.
let ordre = new Map<string, number>();
function melanger() {
  ordre = new Map(items.map((it) => [it.id, Math.floor(Math.random() * 1e6)]));
  for (const c of grid.querySelectorAll<HTMLElement>('.cell')) { c.style.order = String(rang(c.dataset.id!)); c.classList.remove('in'); }
  justifier();
}

/**
 * Justified layout: each row fills the full width, images in a row share one height close to --h and keep their
 * aspect ratio. Recomputed on every shuffle and resize.
 */
const sonde = document.createElement('span');
function justifier() {
  const cells = [...grid.querySelectorAll<HTMLElement>('.cell')];
  if (!cells.length) return;
  const cs = getComputedStyle(grid);
  const W = grid.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  if (W <= 0) return;
  const gap = parseFloat(cs.columnGap) || 6;
  sonde.style.cssText = 'position:absolute;visibility:hidden;width:0;height:var(--h)';
  if (!sonde.isConnected) grid.append(sonde);
  const H = sonde.offsetHeight || 160;
  const poser = (r: HTMLElement[], h: number) => { for (const c of r) { c.style.width = (+c.style.getPropertyValue('--a') * h).toFixed(2) + 'px'; c.style.height = h.toFixed(2) + 'px'; } };
  cells.sort((a, b) => +a.style.order - +b.style.order);
  const aspect = (c: HTMLElement) => +c.style.getPropertyValue('--a');
  // 0.5 px of slack so rounding never wraps a row.
  const hauteurPleine = (r: HTMLElement[]) => (W - gap * (r.length - 1) - 0.5) / r.reduce((t, c) => t + aspect(c), 0);
  const rangees: HTMLElement[][] = []; let r: HTMLElement[] = [], somme = 0;
  for (const c of cells) {
    r.push(c); somme += aspect(c);
    if (somme * H + gap * (r.length - 1) >= W) { rangees.push(r); r = []; somme = 0; }
  }
  // The last row is stretched if nearly full, otherwise merged into the previous one.
  if (r.length) { if (hauteurPleine(r) <= H * 1.5 || !rangees.length) rangees.push(r); else rangees[rangees.length - 1].push(...r); }
  for (const rg of rangees) poser(rg, hauteurPleine(rg));
}
let rzGrille = 0;
addEventListener('resize', () => { if (!rzGrille) rzGrille = requestAnimationFrame(() => { rzGrille = 0; justifier(); }); });
function rang(id: string) { let r = ordre.get(id); if (r === undefined) { r = Math.floor(Math.random() * 1e6); ordre.set(id, r); } return r; }

// Thumbnails reveal as they scroll into view, once decoded, staggered left to right.
const apparition = new IntersectionObserver((es) => {
  const arrivent = es.filter((e) => e.isIntersecting).map((e) => e.target as HTMLElement)
    .sort((a, b) => a.offsetTop - b.offsetTop || a.offsetLeft - b.offsetLeft);
  arrivent.forEach((c, k) => {
    apparition.unobserve(c);
    const img = c.querySelector('img')!;
    const montre = () => {
      c.style.transitionDelay = Math.min(k * 55, 330) + 'ms';
      c.classList.add('in');
      setTimeout(() => { c.style.transitionDelay = ''; }, 1300);
    };
    if (img.complete && img.naturalWidth) montre();
    else img.decode().then(montre, montre);
  });
}, { rootMargin: '0px 0px -6% 0px', threshold: 0.12 });

function renderGrid() {
  if (vue === 'disque') { renderDisc(); return; }
  construireGrille();
  for (const c of grid.querySelectorAll<HTMLElement>('.cell')) if (!c.classList.contains('in')) apparition.observe(c);
}
/** Builds the gallery once, even while hidden, so thumbnails are preloaded before the first switch. */
function construireGrille() {
  if (grid.querySelector('.cell') || !items.length) return;
  items.forEach((it, i) => {
    const b = document.createElement('button');
    b.className = 'cell'; b.dataset.id = it.id;
    b.style.setProperty('--a', String(it.aspect));
    b.style.order = String(rang(it.id));
    b.setAttribute('aria-label', t({ en: `Record image ${it.a.position}`, fr: `Image ${it.a.position} du disque` }));
    const img = document.createElement('img');
    // All 116 thumbnails (3.6 MB) load eagerly: any of them may land at the top after shuffling.
    img.src = thumbSrc(it); img.alt = ''; img.decoding = 'async';
    b.append(img);
    b.addEventListener('click', () => open(i));
    grid.append(b);
  });
  justifier();
}

function titleOf(it: Item) {
  return `${String(it.a.position).padStart(3, '0')} — ${it.a.titre_fr || it.a.titre_en}`;
}

let disqueRempli = '';   // rebuilding the record would replay the cards' entrance
function renderDisc() {
  const cle = items.map((it) => it.id).join(',');
  if (!carousel || cle === disqueRempli) return;
  disqueRempli = cle;
  carousel.setItems(items.map((it) => ({
    id: it.id, thumb: thumbSrc(it), aspect: it.aspect, mine: false,
    label: t({ en: `Record image ${it.a.position}`, fr: `Image ${it.a.position} du disque` }),
    title: titleOf(it),
  })));
}

// ─── Viewer ───────────────────────────────────────────────────────────────────
let carouselArrive = false;   // the record waits, edge-on and hidden, for the welcome sequence to end
let focused = -1;             // open image, -1 when none
let moving = 0;               // transitions in flight

function showViewer() {
  document.body.classList.add('viewing');
  if (viewerEl.hidden) { viewerEl.hidden = false; viewer.start(); }
}

/** Opens image i, closing the current one first. */
async function open(i: number, rotate = false) {
  if (moving > 0 || !items.length) return;
  i = (i + items.length) % items.length;
  if (i === focused) return;
  const prev = focused;
  if (rotate) carousel?.goTo(i);
  if (prev >= 0 && !viewerEl.hidden) {
    platine.effet('disparition', 0, 0, 1, 0.9);
    moving++; try { await viewer.vanish(); } finally { moving--; }
  }
  await enter(i, 0);
}

const FADE = 450;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Shows image i in volume, in front of the record. */
async function enter(i: number, delay: number) {
  moving++;
  focused = current = i;
  const it = items[i];
  try {
    const bmp = await loadBitmap(it.a.fichier_decode);
    if (delay) await wait(delay);
    if (focused !== i) return;
    const old = currentBitmap; currentBitmap = bmp;
    viewer.resetView();
    viewer.resetFly();
    // Everything is computed before showing, so the entrance never stutters.
    await showImage(bmp, true, it);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    showViewer();
    viewerEl.classList.add('on');
    platine.effet('apparition', 0, 0, 1, 1.0);   // timed with the splats condensing, not with the click
    if (old && old !== bmp) old.close();
  } catch (e) { say(t({ en: 'This image cannot be displayed.', fr: 'Cette image ne peut pas s’afficher.' })); console.error(e); if (focused === i) focused = current = -1; }
  finally { moving--; }
}

/** Hides the open image. With `swap`, another image is about to replace it. */
async function leave(swap = false) {
  moving++;
  if (!swap) { focused = -1; document.body.classList.remove('viewing'); }
  await viewer.vanish();
  viewerEl.classList.remove('on');
  await wait(FADE);
  viewer.clear();
  if (!swap && focused < 0) { current = -1; viewerEl.hidden = true; viewer.stop(); }
  moving--;
}

function closeViewer(byScroll = false) {
  if (moving > 0 || focused < 0) return;
  const i = focused;
  platine.effet('disparition', 0, 0, 1, 0.9);
  leave().then(() => {
    if (byScroll) return;   // the record keeps the wheel's momentum
    if (vue !== 'disque') (grid.children[i] as HTMLElement | undefined)?.focus({ preventScroll: true });
  });
}

/** Scan direction of an image (measured once): splats, grooves and gold material follow it. */
const axisCache = new Map<string, 'v' | 'h'>();
async function axisOf(it: Item, bmp: ImageBitmap): Promise<'v' | 'h'> {
  let a = axisCache.get(it.id);
  if (!a) { a = detectAxis(await bitmapToRGBA(bmp, 512)); axisCache.set(it.id, a); }
  return a;
}

/** Signal-loss map estimated from the decoding artefacts (streaks, scan lines, dropouts). */
async function lossOf(it: Item, bmp: ImageBitmap): Promise<LossMap> {
  let m = lossCache.get(it.id);
  if (m) return m;
  m = lossFromTraces(await bitmapToRGBA(bmp), await axisOf(it, bmp));
  lossCache.set(it.id, m);
  return m;
}

async function showImage(bmp: ImageBitmap, appear: boolean, it: Item) {
  if (!viewer.ok) { const f = $<HTMLImageElement>('#fallback'); f.hidden = false; f.src = ''; bitmapToBlobUrl(bmp).then((u) => { f.src = u; }); return; }
  let loss: LossMap | null = null;
  try { loss = await lossOf(it, bmp); } catch (e) { console.warn('loss map unavailable', e); }
  if (items[current]?.id !== it.id) return;
  const axis = await axisOf(it, bmp);
  if (items[current]?.id !== it.id) return;
  viewer.setImage(bmp, appear, axis, loss, it.id);
}
async function bitmapToBlobUrl(bmp: ImageBitmap) { return URL.createObjectURL(await bitmapToBlob(bmp, 2000, 'image/png')); }

let sayTimer = 0;
function say(msg: string) { status.textContent = msg; clearTimeout(sayTimer); sayTimer = window.setTimeout(() => { status.textContent = ''; }, 4000); }

// ─── Debug tools (?debug): R toggles the settings panel, C the crop tool ─────
const setBtn = $('#settings-btn'), setPanel = $('#settings');
const modeTest = new URLSearchParams(location.search).has('debug');
if (modeTest) outilRognage();
window.addEventListener('keydown', (e) => {
  if (!modeTest || e.repeat || e.key.toLowerCase() !== 'r' || e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest('input, textarea, select')) return;
  const on = document.body.classList.toggle('reglages');
  if (!on) { setPanel.hidden = true; setBtn.setAttribute('aria-expanded', 'false'); }
});
setBtn.addEventListener('click', () => { setPanel.hidden = !setPanel.hidden; setBtn.setAttribute('aria-expanded', String(!setPanel.hidden)); });
buildSettingsPanel(setPanel, settings, (k) => {
  viewer.look = settings; viewer.autoMotion = settings.motion;
  if ((k === 'step' || k === 'density' || k === 'trichrome' || k === 'matter') && currentBitmap && !viewerEl.hidden) viewer.rebuild(currentBitmap);
});

// ─── Events ───────────────────────────────────────────────────────────────────
// Scrolling closes the open image and hands the momentum to the record.
viewerEl.addEventListener('wheel', (e) => {
  if (e.ctrlKey || (e.target as HTMLElement).closest('.settings')) return;
  if (focused >= 0) {
    e.preventDefault();
    closeViewer(true); carousel?.calm();
  }
}, { passive: false });
// A click (not a drag) away from the image closes it.
let tap: [number, number] | null = null;
viewerEl.addEventListener('pointerdown', (e) => { tap = [e.clientX, e.clientY]; });
viewerEl.addEventListener('pointerup', (e) => {
  if (!tap || (e.target as HTMLElement).closest('button, .settings')) { tap = null; return; }
  const moved = Math.hypot(e.clientX - tap[0], e.clientY - tap[1]); tap = null;
  const b = Viewer.rectFor(items[focused]?.aspect ?? 1.5), m = 24;
  const outside = e.clientX < b.left - m || e.clientX > b.left + b.width + m || e.clientY < b.top - m || e.clientY > b.top + b.height + m;
  if (moved < 5 && outside) closeViewer();
});
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input,select')) return;
  if (document.body.classList.contains('welcome')) return;   // the welcome sequence handles its own keys
  if (viewerEl.hidden) {
    if (vue !== 'disque' || !carousel) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); carousel.step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); carousel.step(-1); }
    else if (e.key === 'Enter' && !(e.target as HTMLElement).closest('button,a')) open(carousel.index);
    return;
  }
  if (e.key === 'Escape') closeViewer();
  else if (e.key === 'ArrowRight' && focused >= 0) open(focused + 1, true);
  else if (e.key === 'ArrowLeft' && focused >= 0) open(focused - 1, true);
});
// ─── Start-up ─────────────────────────────────────────────────────────────────
traduirePage();
paintSpace(); twinkle();
spinNear($('.brand .disc'));
refletIcones('.vue-btn, .settings-btn');
// Story → welcome → record, unless ?image or ?entrer skips straight to the interface.
const params = new URLSearchParams(location.search);
if (!params.has('image') && !params.has('entrer')) {
  vue = 'disque'; carouselArrive = true;
  prelude().then(() => welcome()).then(() => {
    for (const el of document.querySelectorAll<HTMLElement>('body > header, body > main')) el.inert = false;
    carousel?.arrive(lastSpin, posePlat);
  });
} else { document.body.classList.remove('welcome'); platine.play('musiques'); }
(async () => {
  try {
    const [archives, aspects] = await Promise.all([loadArchives(),
      donnee<Record<string, number>>('thumbs/aspects.json', {})]);   // aspect ratios after cropping
    items = archives.map((a) => ({ kind: 'archive' as const, id: a.id, a, aspect: aspects[a.id] ?? (a.orientation ? 364 / 540 : 540 / 364) }));
    for (let k = items.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [items[k], items[j]] = [items[j], items[k]]; }   // Fisher-Yates shuffle
    setVue(vue);
    setTimeout(construireGrille, 1500);   // build the gallery after the record's entrance
    const q = params.get('image');
    if (q) { const i = items.findIndex((x) => x.id === q); if (i >= 0) open(i); }
  } catch (e) { console.error(e); say(t({ en: 'The collection could not be loaded.', fr: 'La collection n’a pas pu se charger.' })); }
})();
