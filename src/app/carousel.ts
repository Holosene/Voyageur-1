/**
 * The record and its images.
 *
 * The Golden Record lies at the bottom of the screen, seen from above and half out of frame. Its images stand above
 * it, each tied to the record by a thread. Turning the record (wheel, drag, arrow keys) scrolls them; at rest it
 * keeps turning at playback speed.
 *
 * The record is CSS 3D. Images and threads are projected in JS and drawn as flat 2D transforms: nested
 * preserve-3d layers were flattened by Safari, and this keeps rendering identical across browsers.
 */
import { urlLisible } from './res.ts';
import { t } from './i18n.ts';
import { platine } from './audio.ts';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Stable per-image pseudo-random value in [0, 1). */
const rnd = (i: number, k: number) => { const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return x - Math.floor(x); };

export interface CarouselItem { id: string; thumb: string; aspect: number; mine: boolean; label: string; title: string }

/** Record photograph (public/disque/, see CREDITS.md). */
const FACE = 'disque/verso-disque.jpg';
/** Idle rotation, in images per second. */
const IDLE_SPEED = 0.17;
/** Record tilt, in degrees. */
const TILT = 70;
/** CSS perspective of the stage, in px. */
const PERSPECTIVE = 1150;
/** Record angle on arrival, as a linear function of the welcome-screen record angle (degrees). */
const SPIN_A = -1, SPIN_B = 0;
/** Images arc slightly wider than the record, so more of them fit on screen. */
const CURVE = 1.6;
/** Thread thickness in px. A 1 px line is scaled down instead: CSS widths under 1 px vanish in Firefox. */
const THREAD_WIDTH = 0.45;

/**
 * Safari and Firefox compute SVG filters on the CPU every frame, which stuttered while the record spun.
 * There, the motion blur is rendered once per image at load time into an overlay canvas whose opacity is animated.
 */
const isChromium = /Chrome|Chromium|Edg\//.test(navigator.userAgent);

function horizontalBlur(img: HTMLImageElement) {
  const w = Math.max(1, Math.round(img.naturalWidth / 2)), h = Math.max(1, Math.round(img.naturalHeight / 2));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.className = 'flou-v';
  const g = cv.getContext('2d')!, N = 12, spread = w * 0.06;
  g.drawImage(img, 0, 0, w, h);
  // Running average of shifted copies: a motion smear rather than a Gaussian blur.
  for (let k = 0; k < N; k++) { const x = (k / (N - 1) - 0.5) * 2 * spread; g.globalAlpha = 1 / (k + 1); g.drawImage(img, x, 0, w, h); }
  return cv;
}

/** Record diameter whose edge passes exactly through both bottom corners of the viewport. */
function fitDisc(vw: number, vh: number, top: number) {
  const oy = vh * 0.3, a = TILT * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const reach = (D: number) => {   // half-width of the projected record at the bottom edge of the screen
    let best = 0;
    for (let k = 0; k <= 720; k++) {
      const t = (k / 720) * Math.PI, r = D / 2, x = r * Math.cos(t), y = r * Math.sin(t);
      const z = y * sa, f = PERSPECTIVE / (PERSPECTIVE - z);
      if (z >= PERSPECTIVE - 1) continue;
      const Y = oy + (top + y * ca - oy) * f;
      if (Y >= vh) best = Math.max(best, Math.abs(x * f));
    }
    return best;
  };
  let lo = vw * 0.3, hi = vw * 3;
  for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; if (reach(m) < vw / 2) lo = m; else hi = m; }
  return hi;
}

export class DiscCarousel {
  private root: HTMLElement;
  private body: HTMLElement;
  private faces: HTMLCanvasElement[];
  private cards: HTMLElement[] = [];
  private threads: HTMLElement[] = [];
  private dots: HTMLElement[] = [];
  private items: CarouselItem[] = [];
  private pos = 0;
  private vel = 0;
  private target: number | null = null;
  private running = false;
  private last = performance.now();
  private geo = { vw: 0, vh: 0, D: 0, R: 0, H: 0, step: 0.2 };
  onOpen: (i: number) => void = () => {};

  constructor(root: HTMLElement, waiting = false) {
    this.root = root;
    if (waiting) { this.tiltNow = 90; this.setRise(0); this.waiting = true; document.body.classList.add('montee', 'sans-images'); }
    root.innerHTML = `
      <div class="plane">
        <div class="disc-edge"></div>
        <div class="disc-body">
          <canvas class="face recto"></canvas>
          <canvas class="face verso"></canvas>
        </div>
        <div class="disc-sheen"></div>
      </div>
      <div class="calque shadows"></div>
      <div class="calque cartes"><div class="ring"></div></div>`;
    this.body = root.querySelector('.disc-body') as HTMLElement;
    // Outside Chromium, speed blur falls back to CSS blur (GPU) instead of the directional SVG filter.
    if (!isChromium) document.documentElement.classList.add('flou-css');
    if (!document.getElementById('flou1')) document.body.insertAdjacentHTML('beforeend', `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${[2, 4.5, 8].map((d, i) => `<filter id="flou${i + 1}" x="-15%" y="0" width="130%" height="100%" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="0"/><feGaussianBlur stdDeviation="${d} 0"/></filter>`).join('')}</svg>`);
    this.faces = [...root.querySelectorAll('.face')] as HTMLCanvasElement[];
    // The face pixels are read back (findDisc), so the image must be same-origin readable.
    void urlLisible(FACE).then((u) => this.loadFace(0, u, true));
    let rz = 0; window.addEventListener('resize', () => { if (!rz) rz = requestAnimationFrame(() => { rz = 0; this.layout(); }); });

    window.addEventListener('wheel', (e) => {
      if (this.offscreen || document.body.classList.contains('viewing') || document.body.classList.contains('welcome') || (e.target as HTMLElement).closest('.settings')) return;
      e.preventDefault();
      this.dismissHint();
      const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? -e.deltaX : e.deltaY) * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      this.target = null; this.vel += d * this.gain() * (d < 0 ? 0.55 : 1);   // the record resists being turned backwards
      // A strong flick changes track forwards, or scratches backwards.
      const now = performance.now();
      const fade = Math.exp(-(now - this.burstAt) / 350); this.burstAt = now;
      this.burst = this.burst * fade + Math.max(0, d); this.burstRev = this.burstRev * fade + Math.max(0, -d);
      if (this.burst > 520 && now - this.tunedAt > 1200) { this.tunedAt = now; this.burst = 0; platine.tune(); }
      if (this.burstRev > 800 && now - this.tunedAt > 1200) { this.tunedAt = now; this.burstRev = 0; platine.scratch(); }
    }, { passive: false });

    let drag: { x: number; y: number; p: number; t: number; moved: boolean; touch: boolean; lx: number; ly: number; acc: number } | null = null;
    root.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, p: this.pos, t: performance.now(), moved: false, touch: e.pointerType !== 'mouse', lx: e.clientX, ly: e.clientY, acc: 0 }; this.target = null; this.vel = 0; });
    window.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (e.pointerType === 'mouse' && !e.buttons) { drag = null; return; }   // button released outside the window
      const dx = e.clientX - drag.x;
      // On touch, vertical swipes also turn the record forwards, like a wheel.
      if (drag.touch) { drag.acc += (e.clientX - drag.lx) + Math.abs(e.clientY - drag.ly); drag.lx = e.clientX; drag.ly = e.clientY; }
      if (!drag.moved && (Math.abs(dx) > 6 || (drag.touch && Math.abs(e.clientY - drag.y) > 6))) { drag.moved = true; this.dismissHint(); }
      if (!drag.moved) return;
      const np = drag.touch ? drag.p + drag.acc / (this.geo.H * 1.7) : drag.p - dx / (this.geo.H * 1.7);
      const now = performance.now();
      this.vel = (np - this.pos) / Math.max(1, (now - drag.t) / 16.7) * 0.6; drag.t = now;
      this.pos = np;
    });
    window.addEventListener('pointercancel', () => { drag = null; });
    window.addEventListener('pointerup', () => {
      const moved = drag?.moved; drag = null;
      if (moved) { root.classList.add('dragged'); setTimeout(() => root.classList.remove('dragged'), 0); }
    });
    // Swallow the click that ends a drag.
    root.addEventListener('click', (e) => { if (root.classList.contains('dragged')) { e.stopPropagation(); e.preventDefault(); } }, true);
    this.layout();
  }

  setItems(items: CarouselItem[]) {
    this.items = items;
    const ring = this.root.querySelector('.ring') as HTMLElement, sh = this.root.querySelector('.shadows') as HTMLElement;
    ring.innerHTML = ''; sh.innerHTML = '';
    const delays = items.map(() => (Math.random() * 1.1).toFixed(2) + 's');   // staggered entrance
    this.threads = items.map((_, i) => { const s = document.createElement('div'); s.className = 'thread'; s.style.setProperty('--dl', delays[i]); sh.append(s); return s; });
    this.dots = items.map((_, i) => { const s = document.createElement('div'); s.className = 'anchor'; s.style.setProperty('--dl', delays[i]); sh.append(s); return s; });
    this.cards = items.map((it, i) => {
      const b = document.createElement('button');
      b.className = 'card' + (it.mine ? ' mine' : ''); b.style.setProperty('--dl', delays[i]);
      b.style.setProperty('--a', String(it.aspect));
      b.setAttribute('aria-label', it.label);
      b.dataset.src = it.thumb;
      b.innerHTML = '<span class="pic"></span>';
      b.style.setProperty('--r1', rnd(i, 1).toFixed(3));
      b.addEventListener('click', () => this.onOpen(i));
      b.addEventListener('pointerenter', () => { this.hoverTo[i] = 1; });
      b.addEventListener('pointerleave', () => { this.hoverTo[i] = 0; });
      // Keyboard focus brings the image to the centre; a click does not turn the record.
      b.addEventListener('focus', () => { if (b.matches(':focus-visible') && Math.abs(this.offset(i)) > 0.5) this.goTo(i); });
      ring.append(b);
      return b;
    });
    this.hover = items.map(() => 0); this.hoverTo = items.map(() => 0);
    this.layout();
    this.start();
  }

  goTo(i: number, instant = false) {
    if (!this.items.length) return;
    const t = this.pos + this.offset(i);
    if (instant || reduceMotion) { this.pos = t; this.target = null; } else this.target = t;
    this.vel = 0;
  }

  /** Wheel sensitivity is damped right after closing an image, then recovers over `ms`. */
  private calmUntil = 0;
  calm(ms = 1400) { this.calmUntil = performance.now() + ms; }
  private gain() {
    const left = Math.max(0, this.calmUntil - performance.now()) / 1400;
    return 0.0009 * (1 - 0.8 * left * left);
  }
  get index() { const n = this.items.length; return n ? ((Math.round(-this.pos) % n) + n) % n : 0; }
  flash(i: number) { const c = this.cards[i]; if (!c) return; c.classList.remove('new'); void c.offsetWidth; c.classList.add('new'); }
  step(d: number) { const n = this.items.length; this.goTo(((Math.round(-this.pos) + d) % n + n) % n); }

  /** Signed distance from image i to the centre, in average band steps. */
  private offset(i: number) {
    const n = this.items.length; if (!n || !this.xs.length) return 0;
    const avg = this.xsLen / n;
    let d = (-this.xs[i] / avg - this.pos) % n; if (d > n / 2) d -= n; if (d < -n / 2) d += n;
    return d;
  }

  private layout() {
    const vw = innerWidth, vh = innerHeight;
    const portrait = vh > vw * 1.2;
    // In portrait the record sits lower and larger, overflowing the bottom corners.
    const top = portrait ? vh * 1.04 : vh * 1.1;
    const D = fitDisc(vw, vh, top) * (portrait ? 1.3 : 1);
    const H = Math.round(Math.max(110, Math.min(vh * 0.31, vw * (portrait ? 0.46 : 0.265))));
    const R = D / 2 * 0.8;
    const step = (H * 1.4 + H * 0.22) / R;
    this.geo = { vw, vh, D, R, H, step };
    if (this.items.length) this.computeBand();
    const s = this.root.style;
    s.setProperty('--D', D + 'px'); s.setProperty('--H', H + 'px'); s.setProperty('--pad', '0px'); s.setProperty('--cap', '0px');
    s.setProperty('--tilt', this.tiltNow + 'deg');
    // While waiting, park the record exactly where the rise animation will start.
    if (this.waiting) this.setRise(D * 0.55);
    for (const pl of this.root.querySelectorAll<HTMLElement>('.plane, .calque')) { pl.style.left = vw / 2 + 'px'; pl.style.top = top + 'px'; }
    this.planeTop = top;
    const br = document.querySelector('.brand')?.getBoundingClientRect();
    this.ceil = br && br.height ? br.bottom + 8 : 84;   // images never rise above the title
    for (let i = 0; i < this.faces.length; i++) this.drawFace(i);
  }

  // Arrival from the welcome screen: the record, seen edge-on, tilts towards the viewer while spinning fast,
  // then slows down to its idle speed.
  private tiltNow = TILT;
  private tiltFrom = 0;
  private lastRate = -1; private burst = 0; private burstRev = 0; private burstAt = 0; private tunedAt = 0; private lastPos = 0;
  private waiting = false;
  private riseNow = 0;
  private setRise(px: number) { this.riseNow = px; this.root.style.setProperty('--rise', px.toFixed(1) + 'px'); }
  private boost = 0;
  private flat = false;
  private smoothSpeed = 0; private blurLevel = 0;

  arrive(spinDeg = 110, flat: { ang: number } | null = null) {
    if (reduceMotion) { this.waiting = false; this.tiltNow = TILT; this.setRise(0); this.layout(); document.body.classList.remove('montee', 'sans-images'); this.root.style.setProperty('--tilt', TILT + 'deg'); return; }
    this.waiting = false; this.tiltFrom = performance.now(); this.arrivedAt = performance.now();
    this.flat = !!flat;
    if (flat) {
      // The welcome-screen record landed here already tilted: take over at the same angle.
      this.tiltNow = TILT; this.root.style.setProperty('--tilt', TILT + 'deg'); this.setRise(0);
      const n = this.items.length || 1, a = (SPIN_A * flat.ang + SPIN_B) * Math.PI / 180 / Math.max(1e-3, this.geo.step);
      this.pos = a - Math.round(a / n) * n; this.lastPos = this.pos; this.target = null; this.place();
    }
    // Keep the angular speed the small record had when it disappeared.
    this.boost = Math.max(0, spinDeg * Math.PI / 180 / Math.max(1e-3, this.geo.step) - IDLE_SPEED);
  }

  // Until the visitor touches the record, a hint (a curved arrow and a caption) invites them to turn it.
  private arrivedAt = 0; private untouched = true; private hint: HTMLElement | null = null; private nextPulse = 0;

  private dismissHint() {
    if (!this.untouched) return;
    this.untouched = false;
    const el = this.hint; this.hint = null;
    if (el) { el.classList.remove('on'); setTimeout(() => el.remove(), 900); }
  }

  private showHint(now: number) {
    if (!this.untouched || reduceMotion) return;
    const visible = !this.offscreen && !document.body.classList.contains('viewing') && !document.body.classList.contains('welcome');
    if (!this.hint) {
      const touch = matchMedia('(hover: none)').matches;
      const el = document.createElement('div'); el.className = 'tourner-indice'; el.setAttribute('aria-hidden', 'true');
      el.innerHTML = `<svg viewBox="0 0 140 30"><path class="arc" d="M10 26 Q70 -2 130 26"/><path class="pointe" d="M124.8 18.6 L130 26 L121 26.8"/><circle class="bille" r="1.8" opacity="0"><animateMotion dur="1.6s" begin="indefinite" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines=".25 .1 .25 1" path="M10 26 Q70 -2 130 26"/><animate attributeName="opacity" dur="1.6s" begin="indefinite" fill="freeze" values="0;1;1;0" keyTimes="0;.12;.85;1"/></circle></svg>
        <span>${touch ? t({ en: 'Drag to turn the record', fr: 'Glissez pour tourner le disque' }) : t({ en: 'Scroll or drag to turn the record', fr: 'Faites défiler ou glissez pour tourner le disque' })}</span>`;
      document.body.append(el); this.hint = el;
      this.nextPulse = now + 1200;
    }
    this.hint.classList.toggle('on', visible);
    if (visible && now >= this.nextPulse) {
      this.nextPulse = now + 6500;
      for (const an of this.hint.querySelectorAll<SVGAnimationElement>('.bille > *')) { try { an.beginElement(); } catch { /* SMIL unsupported */ } }
    }
  }

  /** The record is hidden, or parked invisibly under the gallery: skip all work. */
  private get offscreen() { return this.root.hidden || this.root.classList.contains('repos'); }
  start() { if (this.running) return; this.running = true; this.last = performance.now(); requestAnimationFrame(this.frame); }

  private frame = (now: number) => {
    if (!this.running) return;
    const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
    const cl = document.body.classList;
    const hiddenByWelcome = cl.contains('welcome') && !cl.contains('prechauffe');
    if (!this.offscreen && !hiddenByWelcome) {
      if (this.target !== null) {
        const d = this.target - this.pos;
        this.pos += d * (1 - Math.pow(0.0005, dt));
        if (Math.abs(d) < 0.002) { this.pos = this.target; this.target = null; }
      } else {
        // Inertia: a forward throw coasts for a long time; braking or turning backwards decays faster, like a
        // platter held by hand. Damping is frame-rate independent.
        if (this.vel < 0) this.vel = Math.max(this.vel, -0.06);
        this.pos += this.vel * dt * 60; this.vel *= Math.pow(this.vel < 0 ? 0.008 : 0.04, dt);
        this.pos += this.boost * dt; this.boost *= Math.pow(0.45, dt);
        if (!reduceMotion) this.pos += IDLE_SPEED * dt;
      }
      if (this.tiltFrom) this.animateArrival(now);
      const v = (this.pos - this.lastPos) / Math.max(dt, 1e-3); this.lastPos = this.pos;   // images per second, positive = forwards
      // Speed blur: three fixed levels, so nothing is recomputed per frame.
      this.smoothSpeed += (Math.abs(v) - this.smoothSpeed) * Math.min(1, dt * 8);
      const level = this.smoothSpeed < 2.2 ? 0 : this.smoothSpeed < 4 ? 1 : this.smoothSpeed < 7 ? 2 : 3;
      if (level !== this.blurLevel) { this.root.classList.remove('flou-' + this.blurLevel); if (level) this.root.classList.add('flou-' + level); this.blurLevel = level; }
      // Playback rate follows the record: unchanged within a wide margin, then gradually faster and higher when
      // thrown forwards, slower and lower when held back.
      const r = v >= 0 ? 1 + 0.2 * Math.log2(1 + Math.max(0, v - 4) / 14) : 1 - 0.24 * (1 - Math.exp(-Math.max(0, -v - 0.8) / 2.4));
      const rate = Math.max(0.4, Math.min(2.4, r));
      if (!cl.contains('welcome') && Math.abs(rate - this.lastRate) > 0.002) { this.lastRate = rate; platine.setSpeed(rate); }
      this.place();
      if (this.untouched && !this.tiltFrom && !cl.contains('montee') && !cl.contains('sans-images') && this.arrivedAt && now - this.arrivedAt > 4200) this.showHint(now);
    }
    requestAnimationFrame(this.frame);
  };

  /** Tilt, rise and scale of the record during its arrival, then reveal of the images. */
  private animateArrival(now: number) {
    const s = (now - this.tiltFrom) / 1000, k = Math.exp(-s / 0.6);
    this.root.style.setProperty('--sc', (1 - 0.42 * Math.exp(-s / 0.45)).toFixed(4));
    if (!this.flat) {
      this.tiltNow = 90 + (TILT - 90) * (1 - k);
      this.root.style.setProperty('--tilt', this.tiltNow.toFixed(2) + 'deg');
      this.setRise(this.geo.D * 0.55 * k);
    }
    const cl = document.body.classList;
    if (s > 0.9 && cl.contains('montee')) cl.remove('montee');
    if (s > 1.8 && cl.contains('sans-images')) {
      cl.add('images-decalees'); cl.remove('sans-images');
      setTimeout(() => cl.remove('images-decalees'), 2800);
    }
    if (s > 5) { this.root.style.setProperty('--sc', '1'); this.tiltFrom = 0; this.tiltNow = TILT; this.root.style.setProperty('--tilt', TILT + 'deg'); this.setRise(0); }
  }

  /** Row of image i (0: low, 1: high), stable across layouts. */
  private row(i: number) { return (i + (rnd(i, 6) < 0.22 ? 1 : 0)) % 2; }
  private xs: number[] = [];
  private planeTop = 0;
  private ceil = 84;
  private hover: number[] = [];
  private hoverTo: number[] = [];
  private hs: number[] = [];
  private ws: number[] = [];
  private xsLen = 1;

  /** Positions along the band: two rows that may overlap horizontally, never within the same row. */
  private computeBand() {
    const n = this.items.length, H = this.geo.H, gap = H * 0.12;
    // Same area for every image, whatever its aspect ratio.
    this.hs = this.items.map((it) => H * Math.sqrt(1.2 / (it.aspect || 1.5)));
    this.hs.forEach((h, i) => this.cards[i]?.style.setProperty('--ch', h.toFixed(1) + 'px'));
    const w = (i: number) => this.hs[i] * (this.items[i].aspect || 1.5);
    this.ws = this.items.map((_, i) => w(i));
    const end = [-Infinity, -Infinity];
    this.xs = new Array(n);
    let x = 0;
    for (let i = 0; i < n; i++) {
      const r = this.row(i), half = w(i) / 2;
      x = i === 0 ? 0 : Math.max(x + (w(i - 1) / 2 + half) * 0.46, end[r] + gap + half);
      this.xs[i] = x; end[r] = x + half;
    }
    this.xsLen = Math.max(end[0], end[1]) + gap + w(0) / 2;
    this.geo.step = this.xsLen / n / this.geo.R;   // the record turns exactly as far as the band moves
  }

  /**
   * Offset of an image from the arc, along the arc's normal, so images on the sides drift towards the corners.
   * The high row moves out just enough never to touch its low-row neighbours.
   */
  private offsetOf(i: number, xi: number, ct: number, Rb: number, L: number): [number, number] {
    const H = this.geo.H, gap = H * 0.14;
    const Rc = Rb * CURVE, curve = (x: number): [number, number] => [x, (-Rb + (x * x) / (2 * Rc)) * ct];
    const normal = (x: number): [number, number] => { const sl = (x * ct) / Rc, k = Math.hypot(sl, 1); return [sl / k, -1 / k]; };
    const low = (j: number) => H * (0.3 + 0.18 * rnd(j, 1));
    const ni = normal(xi);
    let d = this.row(i) ? H * (0.6 + 0.18 * rnd(i, 1)) : low(i);
    if (this.row(i)) {
      const n = this.items.length, shift = xi - this.xs[i], ti: [number, number] = [-ni[1], ni[0]];
      const pi = curve(xi), ci: [number, number] = [pi[0], pi[1] - this.hs[i] / 2];
      for (let k = -4; k <= 4; k++) {
        const j = (i + k + n) % n;
        if (j === i || this.row(j)) continue;
        let xj = this.xs[j] + shift; xj -= Math.round((xj - xi) / L) * L;
        const pj = curve(xj), nj = normal(xj), lj = low(j);
        const cj: [number, number] = [pj[0] + nj[0] * lj, pj[1] + nj[1] * lj - this.hs[j] / 2];
        const dx = ci[0] - cj[0], dy = ci[1] - cj[1];
        const ext = (w: number, h: number, v: [number, number]) => w * Math.abs(v[0]) + h * Math.abs(v[1]);
        const need = (ext(this.ws[i], this.hs[i], ni) + ext(this.ws[j], this.hs[j], ni)) / 2 + gap - (dx * ni[0] + dy * ni[1]);
        const sepT = Math.abs(dx * ti[0] + dy * ti[1]) - (ext(this.ws[i], this.hs[i], ti) + ext(this.ws[j], this.hs[j], ti)) / 2;
        const s = 1 - Math.min(1, Math.max(0, (sepT - gap) / (H * 0.8)));   // ease the separation in as neighbours approach
        d = Math.max(d, need * s * s * (3 - 2 * s));
      }
    }
    return [ni[0] * d, -ni[1] * d];
  }

  /** Cancels the perspective enlargement of images on the sides, and shrinks them slightly towards the edges. */
  private sideScale(x: number, y: number, st: number) {
    const near = PERSPECTIVE / Math.max(200, PERSPECTIVE - y * st);
    const u = Math.min(1, Math.abs(x) / (this.geo.vw / 2));
    const near0 = PERSPECTIVE / Math.max(200, PERSPECTIVE + this.geo.R * 0.74 * st);
    return (1 - 0.28 * u * u) * near0 / near;
  }

  private place() {
    const { R, H, step, D } = this.geo, deg = 180 / Math.PI, n = this.items.length;
    if (!n) return;
    const spin = this.pos * step;   // record rotation in radians, clockwise
    this.body.style.setProperty('--spin', `${(spin * deg).toFixed(3)}deg`);
    const tilt = TILT * Math.PI / 180, ct = Math.cos(tilt), st = Math.sin(tilt);
    const X = this.xs, L = this.xsLen;
    const xpos = -this.pos * (L / n);
    // Same transform as the record plane (rise + tilt) under the stage perspective, done in 2D: every image faces
    // the viewer, so its screen footprint is just a translation and a scale.
    const Py = this.geo.vh * 0.3 - this.planeTop;
    const th0 = this.tiltNow * Math.PI / 180, cT = Math.cos(th0), sT = Math.sin(th0), rise = this.riseNow;
    const proj = (px: number, py: number, pz: number): [number, number, number] => {
      const Y = py * cT - pz * sT + rise, Z = py * sT + pz * cT, k = PERSPECTIVE / Math.max(PERSPECTIVE / 3, PERSPECTIVE - Z);
      return [px * k, Py + (Y - Py) * k, k];
    };
    const lim = this.geo.vw / 2 + H * 2.4;
    for (let i = 0; i < n; i++) {
      const c = this.cards[i], th = this.threads[i], dot = this.dots[i];
      let xi = X[i] - xpos; xi -= Math.round(xi / L) * L;
      if (c.dataset.src && Math.abs(xi) < lim * 1.8) {
        // Decode ahead of time and paint into a canvas: a hidden <img> may be re-decoded when shown again, which
        // flickered (a thread without its image).
        const img = new Image(), pic = c.querySelector('.pic')!; img.src = c.dataset.src; delete c.dataset.src;
        img.decode().then(() => {
          const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
          cv.getContext('2d')!.drawImage(img, 0, 0); pic.append(cv); if (!isChromium) pic.append(horizontalBlur(img)); c.dataset.pret = '1';
        }).catch(() => { c.dataset.pret = '1'; });
      }
      if (Math.abs(xi) > lim || !c.dataset.pret) {
        if (c.style.display !== 'none') { c.style.display = 'none'; th.style.display = 'none'; dot.style.display = 'none'; }
        continue;
      }
      if (c.style.display !== 'block') {
        c.style.display = 'block'; th.style.display = 'block'; dot.style.display = 'block';
      }
      this.hover[i] += (this.hoverTo[i] - this.hover[i]) * 0.18;
      const s = this.sideScale(xi, -R * 0.74 + (xi * xi) / (2 * R * 0.74 * CURVE), st) * (1 + 0.07 * this.hover[i]);
      const centred = Math.abs(xi) < (L / n) * 0.5;
      const Rb = R * 0.74, y = -Rb + (xi * xi) / (2 * Rb * CURVE);
      const [ox, oy] = this.offsetOf(i, xi, ct, Rb, L);
      // Perspective spreads side images apart; pull them back in.
      const comp = (PERSPECTIVE / Math.max(200, PERSPECTIVE + Rb * st)) / (PERSPECTIVE / Math.max(200, PERSPECTIVE - y * st));
      const x = (xi + ox) * comp;
      // Ceiling: an image that would rise above the title shrinks instead of sinking onto its neighbour.
      const f = PERSPECTIVE / Math.max(200, PERSPECTIVE - y * st), py0 = this.geo.vh * 0.3;
      const room = (this.planeTop + y * ct - py0) - (this.ceil - py0) / f;
      let sc = s;
      if (oy + this.hs[i] * sc > room) sc = Math.max(s * 0.6, (room - oy) / this.hs[i]);
      const lift = Math.max(0, Math.min(oy, room - this.hs[i] * sc));
      const [bx, bY, bk] = proj(x, y - lift * cT, lift * sT);   // bottom of the image: the thread's attachment
      c.style.transform = `translate(${bx.toFixed(2)}px, ${bY.toFixed(2)}px) scale(${(sc * bk).toFixed(4)})`;
      const zi = String(1000 + Math.round(y)); if (c.style.zIndex !== zi) c.style.zIndex = zi;
      // Not named "top": that class belongs to the top bar and its styles leaked onto the image.
      c.classList.toggle('au-centre', centred);
      // The thread runs from the image to a point fixed on the record, so it turns with it.
      const rq = (0.62 + 0.34 * rnd(i, 4)) * D / 2, aq = xi / R + (rnd(i, 5) - 0.5) * step * 0.8;
      const qx = rq * Math.sin(aq), qy = -rq * Math.cos(aq);
      const [ax, aY, ak] = proj(qx, qy, 0.5);
      const vx = bx - ax, vy = bY - aY, vl = Math.hypot(vx, vy) || 1;
      // A 1000 px tall, 1 px wide element mapped onto the segment.
      th.style.transform = `matrix(${(THREAD_WIDTH * vy / vl).toFixed(4)}, ${(-THREAD_WIDTH * vx / vl).toFixed(4)}, ${(vx / 1000).toFixed(5)}, ${(vy / 1000).toFixed(5)}, ${ax.toFixed(2)}, ${aY.toFixed(2)})`;
      dot.style.transform = `translate(${ax.toFixed(2)}px, ${aY.toFixed(2)}px) scale(${ak.toFixed(3)})`;
    }
  }

  // ─── Record faces ─────────────────────────────────────────────────────────────
  private photos: (HTMLImageElement | null)[] = [null, null];
  private crops: ([number, number, number, number] | null)[] = [null, null];

  private loadFace(k: number, src: string, centreOnHole = false) {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      this.photos[k] = img;
      let cr = findDisc(img);
      if (centreOnHole) {
        // Rotate around the groove centre (measured 8 px and 16 px off-centre at 2048 px), or the record wobbles.
        const u = img.naturalWidth / 2048, cx = img.naturalWidth / 2 + 8 * u, cy = img.naturalHeight / 2 + 16 * u;
        // The photo edge is not quite concentric with the hole: crop slightly inside for a perfect circle.
        const sd = Math.min(cr[2], cr[3], 2 * (img.naturalWidth / 2 - 16 * u)) * 0.984;
        cr = [cx - sd / 2, cy - sd / 2, sd, sd];
      }
      this.crops[k] = cr; this.drawFace(k);
    };
    img.onerror = () => this.drawFace(k);
    img.src = src;
  }

  private drawFace(k: number) {
    const c = this.faces[k], D = this.geo.D;
    // The back face is never visible: keep it tiny.
    const px = k === 1 ? 64 : Math.min(2048, Math.round(D * Math.min(devicePixelRatio || 1, 1.5)));
    if (c.width !== px) c.width = c.height = px;
    const g = c.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, px, px);
    g.save(); g.beginPath(); g.arc(px / 2, px / 2, px / 2, 0, Math.PI * 2); g.clip();
    const p = this.photos[k], cr = this.crops[k];
    if (p && cr) { g.imageSmoothingQuality = 'high'; g.drawImage(p, cr[0], cr[1], cr[2], cr[3], 0, 0, px, px); }
    else paintDisc(g, px, k === 1);
    g.restore();
  }
}

/** Locates the record in the photo: the largest region that stands out from the background sampled on the edges. */
function findDisc(img: HTMLImageElement): [number, number, number, number] {
  const s = 256, k = s / Math.max(img.naturalWidth, img.naturalHeight);
  const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!; g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  let br = 0, bg = 0, bb = 0, ne = 0;
  const addEdge = (x: number, y: number) => { const i = (y * w + x) * 4; br += d[i]; bg += d[i + 1]; bb += d[i + 2]; ne++; };
  for (let x = 0; x < w; x++) { addEdge(x, 0); addEdge(x, h - 1); }
  for (let y = 0; y < h; y++) { addEdge(0, y); addEdge(w - 1, y); }
  br /= ne; bg /= ne; bb /= ne;
  const rows = new Array(h).fill(0), cols = new Array(w).fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (Math.abs(d[i] - br) + Math.abs(d[i + 1] - bg) + Math.abs(d[i + 2] - bb) > 75) { rows[y]++; cols[x]++; }
  }
  const span = (a: number[], n: number) => { const m = Math.max(...a) * 0.08; let lo = 0, hi = n - 1; while (lo < n && a[lo] <= m) lo++; while (hi > 0 && a[hi] <= m) hi--; return [lo, hi]; };
  const [x0, x1] = span(cols, w), [y0, y1] = span(rows, h);
  const size = Math.max(x1 - x0, y1 - y0) + 1, cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;
  if (size < s * 0.3 || size > s * 1.05) { const m = Math.min(img.naturalWidth, img.naturalHeight); return [(img.naturalWidth - m) / 2, (img.naturalHeight - m) / 2, m, m]; }
  return [(cx - size / 2) / k, (cy - size / 2) / k, size / k, size / k];
}

/** Placeholder until the photo loads: a painted gold record (grooves, label, hole). */
function paintDisc(g: CanvasRenderingContext2D, px: number, back: boolean) {
  const r = px / 2;
  g.translate(r, r);
  const base = g.createRadialGradient(-r * 0.25, -r * 0.3, r * 0.05, 0, 0, r);
  base.addColorStop(0, back ? '#d9c27f' : '#f3dc9c'); base.addColorStop(0.45, '#c9a256'); base.addColorStop(0.85, '#8d6a2c'); base.addColorStop(1, '#5d4419');
  g.fillStyle = base; g.fillRect(-r, -r, px, px);
  let seed = back ? 11 : 7; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  if (!back) for (let rr = r * 0.36; rr < r * 0.975; rr += Math.max(1, px / 900)) {
    g.strokeStyle = `rgba(${rand() > 0.5 ? '40,28,8' : '255,240,200'},${(0.04 + rand() * 0.07).toFixed(3)})`;
    g.lineWidth = Math.max(0.6, px / 1800);
    g.beginPath(); g.arc(0, 0, rr, 0, Math.PI * 2); g.stroke();
  }
  g.fillStyle = '#a07d39'; g.beginPath(); g.arc(0, 0, r * (back ? 0.9 : 0.33), 0, Math.PI * 2); g.fill();
  g.fillStyle = '#050505'; g.beginPath(); g.arc(0, 0, r * 0.04, 0, Math.PI * 2); g.fill();
}
