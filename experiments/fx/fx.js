// Effects chain on real pixels. Parameter names and units follow Drift's look
// destinations (LOOK-HANDOFF.md §A: brightness, contrast, saturation, hue,
// invert, blur, pixelate, smear, tint + tint colour, bloom, recall,
// recall_depth), so looks could travel between the projects. Drift builds
// them as CSS layers over Street View, whose pixels can't be read; here they're
// shaders on Mapillary's readable pixels, which adds what Drift couldn't do:
// echo (true video feedback), a real recall memory, grain, posterize, instability.
//
// Per frame: scene → echo (feedback, ping-pong) → bloom (¼ size, blurred)
// → final grade to the screen. Every 2 s a small copy goes into the recall ring.

export const PARAMS = [
  // group, id, label, min, max, neutral, step
  ['Echo', 'echo', 'echo (feedback)', 0, 0.97, 0, 0.01],
  ['Echo', 'echo_trails', 'echo style: blend ↔ trails', 0, 1, 0, 1],
  ['Echo', 'echo_zoom', 'echo zoom', 0.9, 1.1, 1, 0.001],
  ['Echo', 'echo_rotate', 'echo rotate (°/frame)', -3, 3, 0, 0.01],
  ['Glow & memory', 'bloom', 'bloom', 0, 1, 0, 0.01],
  ['Glow & memory', 'recall', 'recall', 0, 1, 0, 0.01],
  ['Glow & memory', 'recall_depth', 'recall depth (now ↔ 30 s ago)', 0, 1, 1, 0.01],
  ['Colour', 'brightness', 'brightness', 0, 3, 1, 0.01],
  ['Colour', 'contrast', 'contrast', 0, 3, 1, 0.01],
  ['Colour', 'saturation', 'saturation', 0, 3, 1, 0.01],
  ['Colour', 'hue', 'hue (°)', 0, 360, 0, 1],
  ['Colour', 'tint', 'tint', 0, 1, 0, 0.01],
  ['Colour', 'invert', 'invert', 0, 1, 0, 0.01],
  ['Texture', 'blur', 'blur (px)', 0, 40, 0, 0.5],
  ['Texture', 'smear', 'smear', 0, 1, 0, 0.01],
  ['Texture', 'pixelate', 'pixelate (px)', 0, 40, 0, 1],
  ['Texture', 'posterize', 'posterize', 0, 1, 0, 0.01],
  ['Texture', 'grain', 'grain', 0, 1, 0, 0.01],
  ['Texture', 'instability', 'instability', 0, 1, 0, 0.01],
].map(([group, id, label, min, max, neutral, step]) => ({ group, id, label, min, max, neutral, step }));

export const neutralLook = () => ({
  ...Object.fromEntries(PARAMS.map((p) => [p.id, p.neutral])),
  tint_r: 1, tint_g: 0.55, tint_b: 0.2,
});

// Starting points, not a system: each is just a set of parameter values.
export const PRESETS = {
  clean: {},
  'sun trails': { echo: 0.9, echo_trails: 1, echo_zoom: 1.004, bloom: 0.6, contrast: 1.2 },
  spiral: { echo: 0.93, echo_zoom: 1.02, echo_rotate: 0.8, bloom: 0.3, saturation: 1.6 },
  memory: { recall: 0.6, recall_depth: 0.8, blur: 2, saturation: 0.6, tint: 0.3, tint_r: 0.6, tint_g: 0.75, tint_b: 1 },
  dream: { bloom: 0.8, blur: 4, smear: 0.4, tint: 0.4, brightness: 1.1, echo: 0.6 },
  broken: { pixelate: 10, posterize: 0.6, instability: 0.6, grain: 0.5, contrast: 1.5, hue: 40 },
};

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const ECHO = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uScene, uPrev;
uniform float uEcho, uTrails, uZoom, uRotate;
void main() {
  vec3 s = texture(uScene, vUv).rgb;
  vec2 c = vUv - 0.5;
  float a = uRotate;
  c = mat2(cos(a), -sin(a), sin(a), cos(a)) * c / uZoom;
  vec2 p = c + 0.5;
  vec3 prev = (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) ? vec3(0.0) : texture(uPrev, p).rgb;
  vec3 blended = mix(s, prev, uEcho);          // echo: the past dissolves into the present
  vec3 trails = max(s, prev * uEcho);           // trails: bright things leave streaks
  o = vec4(mix(blended, trails, uTrails), 1.0);
}`;

const BRIGHT = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc;
void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  o = vec4(c * smoothstep(0.6, 1.0, l), 1.0);
}`;

const BLUR = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uStep;
void main() {
  float w[5] = float[](0.227, 0.194, 0.122, 0.054, 0.016);
  vec3 c = texture(uSrc, vUv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    c += texture(uSrc, vUv + uStep * float(i) * 1.5).rgb * w[i];
    c += texture(uSrc, vUv - uStep * float(i) * 1.5).rgb * w[i];
  }
  o = vec4(c, 1.0);
}`;

const COPY = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc;
void main() { o = vec4(texture(uSrc, vUv).rgb, 1.0); }`;

const FINAL = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc, uBloom, uRecall;
uniform vec2 uRes;
uniform float uTime, uHasRecall;
uniform float uBrightness, uContrast, uSaturation, uHue, uInvert, uBlur, uPixelate, uSmear;
uniform float uTint, uBloomAmt, uRecallAmt, uPosterize, uGrain, uInstability;
uniform vec3 uTintColour;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 hueRotate(vec3 c, float deg) {
  float a = radians(deg);
  vec3 k = vec3(0.57735);
  return c * cos(a) + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cos(a));
}

void main() {
  vec2 uv = vUv;
  // instability: the frame jumps and shivers now and then
  float tick = floor(uTime * 12.0);
  if (hash(vec2(tick, 3.0)) < uInstability * 0.5) {
    uv += (vec2(hash(vec2(tick, 1.0)), hash(vec2(tick, 2.0))) - 0.5) * 0.06 * uInstability;
    uv.x += sin(uv.y * 80.0 + uTime * 20.0) * 0.004 * uInstability;
  }
  if (uPixelate > 1.0) {
    vec2 px = uPixelate / uRes;
    uv = (floor(uv / px) + 0.5) * px;
  }
  // blur (disc) and smear (sideways streak, like Drift's axis-split residue)
  vec3 col = vec3(0.0);
  float total = 0.0;
  for (int i = 0; i < 16; i++) {
    float f = float(i) / 15.0 - 0.5;
    float ang = float(i) * 2.39996;
    vec2 disc = vec2(cos(ang), sin(ang)) * sqrt(float(i) / 16.0) * uBlur;
    vec2 streak = vec2(f * uSmear * 80.0, f * uSmear * 6.0);
    col += texture(uSrc, uv + (disc + streak) / uRes).rgb;
    total += 1.0;
  }
  col /= total;

  col += texture(uBloom, uv).rgb * uBloomAmt * 2.0;
  if (uHasRecall > 0.5) {
    vec3 r = texture(uRecall, uv).rgb;
    col = mix(col, 1.0 - (1.0 - col) * (1.0 - r), uRecallAmt);   // screen the memory in
  }

  col *= uBrightness;
  col = (col - 0.5) * uContrast + 0.5;
  col = mix(vec3(luma(col)), col, uSaturation);
  col = hueRotate(col, uHue);
  // tint like a 'color' blend: keep the picture's lightness, take the tint's colour
  vec3 tinted = uTintColour * (luma(col) / max(luma(uTintColour), 0.05));
  col = mix(col, tinted, uTint);
  col = mix(col, 1.0 - col, uInvert);
  if (uPosterize > 0.0) {
    float levels = mix(16.0, 2.0, uPosterize);
    col = floor(col * levels + 0.5) / levels;
  }
  col += (hash(uv * uRes + fract(uTime) * 100.0) - 0.5) * uGrain * 0.35;
  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

const RECALL_SLOTS = 15;       // 15 memories, one every 2 s = 30 s
const RECALL_EVERY_MS = 2000;

export class FxChain {
  constructor(gl) {
    this.gl = gl;
    this.progs = { echo: this._program(ECHO), bright: this._program(BRIGHT), blur: this._program(BLUR), copy: this._program(COPY), final: this._program(FINAL) };
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.buf = buf;
    this.size = [-1, -1]; // nothing allocated yet: the first resize() always builds the images
    this.pingpong = 0;
    this.recallAt = 0;
    this.recallCount = 0;
    this.recallNext = 0;
  }

  // Off-screen images, rebuilt when the screen size changes.
  resize(w, h) {
    w = Math.max(1, w);
    h = Math.max(1, h);
    if (this.size[0] === w && this.size[1] === h) return;
    this.size = [w, h];
    const t = (tw, th) => this._target(tw, th);
    this.scene = t(w, h);
    this.echo = [t(w, h), t(w, h)];
    const bw = Math.max(1, w >> 2);
    const bh = Math.max(1, h >> 2);
    this.bloom = [t(bw, bh), t(bw, bh)];
    this.recall = Array.from({ length: RECALL_SLOTS }, () => t(w >> 1, h >> 1));
    this.recallCount = 0;
    this.recallNext = 0;
  }

  // Where the scene should be drawn this frame.
  get sceneTarget() {
    return this.scene;
  }

  render(p, now) {
    const gl = this.gl;
    const [w, h] = this.size;

    // 1. echo: this frame + the previous output, zoomed and turned
    const prev = this.echo[this.pingpong];
    const out = this.echo[1 - this.pingpong];
    this.pingpong = 1 - this.pingpong;
    this._pass(this.progs.echo, out, { uScene: this.scene.tex, uPrev: prev.tex }, {
      uEcho: p.echo, uTrails: p.echo_trails, uZoom: p.echo_zoom, uRotate: (p.echo_rotate * Math.PI) / 180,
    });

    // 2. bloom: bright parts, shrunk and blurred
    if (p.bloom > 0) {
      const [b0, b1] = this.bloom;
      this._pass(this.progs.bright, b0, { uSrc: out.tex });
      this._pass(this.progs.blur, b1, { uSrc: b0.tex }, { uStep: [1 / b0.w, 0] });
      this._pass(this.progs.blur, b0, { uSrc: b1.tex }, { uStep: [0, 1 / b0.h] });
    }

    // 3. recall: keep a small copy every 2 s
    if (now - this.recallAt > RECALL_EVERY_MS) {
      this.recallAt = now;
      this._pass(this.progs.copy, this.recall[this.recallNext], { uSrc: out.tex });
      this.recallNext = (this.recallNext + 1) % RECALL_SLOTS;
      this.recallCount = Math.min(RECALL_SLOTS, this.recallCount + 1);
    }
    let recallTex = this.recall[0].tex;
    if (this.recallCount) {
      const back = Math.round(p.recall_depth * (this.recallCount - 1));
      recallTex = this.recall[(this.recallNext - 1 - back + RECALL_SLOTS * 2) % RECALL_SLOTS].tex;
    }

    // 4. final grade to the screen
    this._pass(this.progs.final, null, { uSrc: out.tex, uBloom: this.bloom[0].tex, uRecall: recallTex }, {
      uRes: [w, h], uTime: now / 1000, uHasRecall: this.recallCount ? 1 : 0,
      uBrightness: p.brightness, uContrast: p.contrast, uSaturation: p.saturation, uHue: p.hue,
      uInvert: p.invert, uBlur: p.blur, uPixelate: p.pixelate, uSmear: p.smear,
      uTint: p.tint, uTintColour: [p.tint_r, p.tint_g, p.tint_b], uBloomAmt: p.bloom, uRecallAmt: p.recall,
      uPosterize: p.posterize, uGrain: p.grain, uInstability: p.instability,
    }, [w, h]);
  }

  _pass(prog, target, textures, uniforms = {}, screenSize = null) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(prog.aPos);
    gl.vertexAttribPointer(prog.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    const [vw, vh] = target ? [target.w, target.h] : screenSize;
    gl.viewport(0, 0, vw, vh);
    let unit = 0;
    for (const [name, tex] of Object.entries(textures)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(prog.loc(name), unit++);
    }
    for (const [name, v] of Object.entries(uniforms)) {
      const loc = prog.loc(name);
      if (Array.isArray(v)) (v.length === 2 ? gl.uniform2fv : gl.uniform3fv).call(gl, loc, v);
      else gl.uniform1f(loc, v);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _target(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h };
  }

  _program(fs) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const cache = new Map();
    return {
      p,
      aPos: gl.getAttribLocation(p, 'aPos'),
      loc: (n) => (cache.has(n) ? cache.get(n) : cache.set(n, gl.getUniformLocation(p, n)).get(n)),
    };
  }
}
