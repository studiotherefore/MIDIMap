// Draws two 360° panoramas (equirectangular images) into one full-screen view
// and blends them per pixel. Each layer keeps its previous and current photo so
// frame changes can cut hard (stutter) or dissolve. Every photo is turned by its
// own compass angle, so both layers face the same real-world direction.

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vNdc;
void main() { vNdc = aPos; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vNdc;
out vec4 outColor;
uniform sampler2D uA0, uA1, uB0, uB1;  // 0 = previous photo, 1 = current photo
uniform float uAT, uBT;                // dissolve progress per layer, 0..1
uniform vec4 uYaw;                     // image-centre compass (radians): A prev, A cur, B prev, B cur
uniform mat3 uView;
uniform float uTanHalf, uAspect;
uniform int uMode;
uniform float uMix, uHasB;
const float PI = 3.14159265;

// World direction -> position in an equirectangular photo whose centre faces 'yaw'.
vec2 equi(vec3 d, float yaw) {
  float heading = atan(d.x, -d.z);
  float lat = asin(clamp(d.y, -1.0, 1.0));
  return vec2(fract(0.5 + (heading - yaw) / (2.0 * PI)), 0.5 - lat / PI);
}

vec3 layer(sampler2D prev, sampler2D cur, float yPrev, float yCur, float t, vec3 d) {
  return mix(texture(prev, equi(d, yPrev)).rgb, texture(cur, equi(d, yCur)).rgb, t);
}

vec3 blend(vec3 a, vec3 b, int m) {
  if (m == 1) return a + b - a * b;          // screen
  if (m == 2) return a * b;                  // multiply
  if (m == 3) return abs(a - b);             // difference
  if (m == 4) return min(a + b, vec3(1.0));  // add
  if (m == 5) return max(a, b);              // lighten
  if (m == 6) return min(a, b);              // darken
  if (m == 7) return a + b - 2.0 * a * b;    // exclusion
  return b;                                  // 0: crossfade
}

void main() {
  vec3 d = normalize(uView * vec3(vNdc.x * uTanHalf * uAspect, vNdc.y * uTanHalf, -1.0));
  vec3 a = layer(uA0, uA1, uYaw.x, uYaw.y, uAT, d);
  vec3 col = a;
  if (uHasB > 0.5) {
    vec3 b = layer(uB0, uB1, uYaw.z, uYaw.w, uBT, d);
    col = mix(a, blend(a, b, uMode), uMix);
  }
  outColor = vec4(col, 1.0);
}`;

export const BLEND_MODES = ['crossfade', 'screen', 'multiply', 'difference', 'add', 'lighten', 'darken', 'exclusion'];

export class PanoBlend {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false });
    if (!gl) throw new Error('This browser has no WebGL 2');
    this.gl = gl;
    this.prog = this._program(VERT, FRAG);
    this.u = {};
    for (const n of ['uA0', 'uA1', 'uB0', 'uB1', 'uAT', 'uBT', 'uYaw', 'uView', 'uTanHalf', 'uAspect', 'uMode', 'uMix', 'uHasB']) {
      this.u[n] = gl.getUniformLocation(this.prog, n);
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    // Per layer: [previous, current] textures, compass angles, and when the current one arrived.
    this.layers = {
      a: { tex: [this._texture(), this._texture()], yaw: [0, 0], since: 0, has: false },
      b: { tex: [this._texture(), this._texture()], yaw: [0, 0], since: 0, has: false },
    };
  }

  // Show a new photo on a layer; the previous one is kept for the dissolve.
  setImage(name, img, compassDeg) {
    const L = this.layers[name];
    const gl = this.gl;
    L.tex.reverse();
    L.yaw.reverse();
    gl.bindTexture(gl.TEXTURE_2D, L.tex[1]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
    L.yaw[1] = (compassDeg * Math.PI) / 180;
    if (!L.has) {
      // First photo on this layer: make "previous" the same, so there's nothing to dissolve from.
      gl.bindTexture(gl.TEXTURE_2D, L.tex[0]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
      L.yaw[0] = L.yaw[1];
      L.has = true;
    }
    L.since = performance.now();
  }

  clearLayer(name) {
    this.layers[name].has = false;
  }

  // view: { yaw, pitch, fov } in degrees; blend: { mode, mix }; dissolveMs: 0 = hard cut.
  render({ yaw, pitch, fov }, { mode, mix }, dissolveMs) {
    const gl = this.gl;
    const c = this.canvas;
    const w = Math.round(c.clientWidth * devicePixelRatio);
    const h = Math.round(c.clientHeight * devicePixelRatio);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog);

    const now = performance.now();
    const t = (L) => (dissolveMs > 0 ? Math.min(1, (now - L.since) / dissolveMs) : 1);
    const { a, b } = this.layers;
    [a.tex[0], a.tex[1], b.tex[0], b.tex[1]].forEach((tex, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    });
    gl.uniform1i(this.u.uA0, 0);
    gl.uniform1i(this.u.uA1, 1);
    gl.uniform1i(this.u.uB0, 2);
    gl.uniform1i(this.u.uB1, 3);
    gl.uniform1f(this.u.uAT, t(a));
    gl.uniform1f(this.u.uBT, t(b));
    gl.uniform4f(this.u.uYaw, a.yaw[0], a.yaw[1], b.yaw[0], b.yaw[1]);
    gl.uniformMatrix3fv(this.u.uView, false, viewMatrix(yaw, pitch));
    gl.uniform1f(this.u.uTanHalf, Math.tan((fov * Math.PI) / 360));
    gl.uniform1f(this.u.uAspect, w / h);
    gl.uniform1i(this.u.uMode, mode);
    gl.uniform1f(this.u.uMix, mix);
    gl.uniform1f(this.u.uHasB, b.has ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return a.has;
  }

  _texture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // No mipmaps: they'd show a seam where the panorama wraps round.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0]));
    return tex;
  }

  _program(vs, fs) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
}

// Camera → world rotation. yaw: degrees clockwise from north; pitch: degrees up.
// World axes: x = east, y = up, -z = north.
function viewMatrix(yawDeg, pitchDeg) {
  const y = (yawDeg * Math.PI) / 180;
  const p = (pitchDeg * Math.PI) / 180;
  const f = [Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p)];
  const r = [Math.cos(y), 0, Math.sin(y)];
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  return new Float32Array([...r, ...u, -f[0], -f[1], -f[2]]);
}
