/**
 * End of the welcome sequence: the record is swallowed by a black hole.
 *
 * A purely optical distortion (point-mass gravitational lens, β = θ − θE²/θ): the centre opens into a black shadow
 * and the record stretches into an Einstein ring around it, without blur or shrinking. The stars are lensed the same
 * way in space.ts. WebGL 1; without it, `creerTrou` returns null and the welcome screen ends normally.
 */
import { fichier } from './res.ts';

export interface PoseTrou {
  cx: number; cy: number; R: number;   // record centre and radius on screen (CSS px)
  flip: number;                        // degrees: 0 = front face, 180 = back face
  spin: number;                        // degrees, same as --spin
  tE: number;                          // Einstein radius, in record radii
  ombre: number;                       // shadow radius, in record radii
  a: number;                           // overall opacity
}
export interface Trou { dessiner(p: PoseTrou): void; detruire(): void }

const VS = `attribute vec2 aXY; void main() { gl_Position = vec4(aXY, 0.0, 1.0); }`;
// Shader sources must stay ASCII.
const FS = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uRecto; uniform sampler2D uVerso;
uniform vec2 uView; uniform vec2 uC; uniform float uR; uniform float uCos; uniform float uSpin; uniform float uDpr;
uniform float uTE; uniform float uOmbre; uniform float uA;
vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
void main() {
  vec2 px = vec2(gl_FragCoord.x, uView.y - gl_FragCoord.y) / uDpr;
  vec2 p = (px - uC) / uR;
  float r2 = max(dot(p, p), 1e-6), r = sqrt(r2);
  // Lens equation, plus a slight swirl near the shadow.
  vec2 b = p * (1.0 + uTE * uTE / r2);
  b = rot(b, 0.35 * uTE * uTE / max(r2, 0.04));
  vec2 d = vec2(b.x, b.y / max(abs(uCos), 0.02));
  float rd = length(d);
  vec3 col = vec3(0.0); float a = 0.0;
  if (rd < 1.0) {
    vec2 e = uCos >= 0.0 ? rot(d, -uSpin) : rot(d, uSpin);
    col = (uCos >= 0.0 ? texture2D(uRecto, e * 0.5 + 0.5).rgb : texture2D(uVerso, e * 0.5 + 0.5).rgb) * 0.85;
    a = 1.0 - smoothstep(0.985, 1.0, rd);
  }
  // Opaque shadow: it also hides the stars behind it.
  float o = 1.0 - smoothstep(uOmbre * 0.97, uOmbre * 1.03, r);
  float ad = a * (1.0 - o);
  gl_FragColor = vec4(col * ad, ad + o) * uA;
}`;

async function bitmap(p: string) {
  const b = await fichier(p);
  if ('createImageBitmap' in window) return createImageBitmap(b);
  const img = new Image(); img.src = URL.createObjectURL(b); await img.decode(); return img;
}

export async function creerTrou(parent: HTMLElement): Promise<Trou | null> {
  const c = document.createElement('canvas');
  c.className = 'w-trou'; c.setAttribute('aria-hidden', 'true');
  const gl = c.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false }) as WebGLRenderingContext | null;
  if (!gl) return null;
  const sh = (t: number, src: string) => { const o = gl.createShader(t)!; gl.shaderSource(o, src); gl.compileShader(o); return o; };
  const prog = gl.createProgram()!; gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  let recto: ImageBitmap | HTMLImageElement, verso: ImageBitmap | HTMLImageElement;
  try { [recto, verso] = await Promise.all([bitmap('disque/recto-doux.webp'), bitmap('disque/verso-disque.jpg')]); } catch { return null; }
  gl.useProgram(prog);
  const tex = (unit: number, img: ImageBitmap | HTMLImageElement) => {
    const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
    // Mipmaps keep the texture compressed towards the centre from shimmering.
    const pot = (n: number) => (n & (n - 1)) === 0;
    if (pot(img.width) && pot(img.height)) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
    else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  };
  tex(0, recto); tex(1, verso);
  const U = (k: string) => gl.getUniformLocation(prog, k);
  gl.uniform1i(U('uRecto'), 0); gl.uniform1i(U('uVerso'), 1);
  const uView = U('uView'), uC = U('uC'), uR = U('uR'), uCos = U('uCos'), uSpin = U('uSpin'), uDpr = U('uDpr'), uTE = U('uTE'), uOmbre = U('uOmbre'), uA = U('uA');
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const l = gl.getAttribLocation(prog, 'aXY'); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 2, gl.FLOAT, false, 0, 0);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  parent.append(c);
  let dpr = 1;
  const taille = () => { dpr = Math.min(devicePixelRatio || 1, 1.5); c.width = Math.round(innerWidth * dpr); c.height = Math.round(innerHeight * dpr); gl.viewport(0, 0, c.width, c.height); };
  taille(); addEventListener('resize', taille);
  const r = Math.PI / 180;
  return {
    dessiner(p: PoseTrou) {
      gl.uniform2f(uView, c.width, c.height); gl.uniform1f(uDpr, dpr);
      gl.uniform2f(uC, p.cx, p.cy); gl.uniform1f(uR, p.R);
      gl.uniform1f(uCos, Math.cos(p.flip * r)); gl.uniform1f(uSpin, p.spin * r); gl.uniform1f(uTE, p.tE); gl.uniform1f(uOmbre, p.ombre); gl.uniform1f(uA, p.a);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    detruire() { removeEventListener('resize', taille); c.remove(); /* no loseContext(): it blocked the main thread for ~0.5 s */ },
  };
}
