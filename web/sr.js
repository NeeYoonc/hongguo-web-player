// GPU 实时超分（WebGL2）：Catmull-Rom 重建放大 + CAS 对比度自适应锐化。
//
// 设计要点（v2，修「打开就黑屏」）：
//   1. 不立刻隐藏视频：先保留 <video> 可见，等到真正把视频帧画到画布、并且
//      采样确认不是黑屏后，才隐藏视频（避免取帧失败时用户只看到黑画布）。
//   2. 自检 + 自愈：每 15 帧做一次健康检查（CPU 2D 参考亮度 vs WebGL 输出亮度）。
//      - 直接上传 <video> 拿到黑帧 → 自动切「2D 桥接」模式（先 drawImage 到 2D canvas
//        再上传纹理，绕开部分显卡/ANGLE 硬件解码视频直传纹理的兼容问题）
//      - 桥接仍黑 → 回调 onFail，由页面自动关闭超分并提示（绝不黑屏）
//   3. 暂停/拖动/元数据就绪时都会补画一帧，不会出现「暂停后画布空」。
//
// 用法（app.js 调用）：
//   HGSuperRes.enable(videoEl, canvasEl, { sharp: 0.7, onFail(reason) })  -> true/false
//   HGSuperRes.disable() / setSharp(0.7) / layout() / status()
(function (global) {
  'use strict';

  const VS = `#version 300 es
  in vec2 aPos;
  out vec2 vUv;
  void main() {
    vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
    gl_Position = vec4(aPos, 0.0, 1.0);
  }`;

  const FS_UP = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 fragColor;
  uniform sampler2D uTex;
  uniform vec2 uSrc;
  uniform vec2 uDst;

  float w(float x) {
    x = abs(x);
    if (x <= 1.0) return (1.5 * x - 2.5) * x * x + 1.0;
    if (x < 2.0) return ((-0.5 * x + 2.5) * x - 4.0) * x + 2.0;
    return 0.0;
  }

  void main() {
    vec2 texel = 1.0 / uSrc;
    vec2 pos = vUv * uSrc - 0.5;
    vec2 base = floor(pos);
    vec2 f = pos - base;
    vec4 acc = vec4(0.0);
    float sum = 0.0;
    for (int j = -1; j <= 2; j++) {
      float wy = w(float(j) - f.y);
      for (int i = -1; i <= 2; i++) {
        float wx = w(float(i) - f.x);
        vec2 uv = (base + vec2(float(i), float(j)) + 0.5) * texel;
        acc += texture(uTex, uv) * (wx * wy);
        sum += wx * wy;
      }
    }
    fragColor = acc / max(sum, 1e-4);
  }`;

  const FS_CAS = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 fragColor;
  uniform sampler2D uTex;
  uniform vec2 uSrc;
  uniform float uSharp;

  void main() {
    vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
    vec2 texel = 1.0 / uSrc;
    vec3 c = texture(uTex, uv).rgb;
    vec3 n = texture(uTex, uv + vec2(0.0, -texel.y)).rgb;
    vec3 s = texture(uTex, uv + vec2(0.0,  texel.y)).rgb;
    vec3 wv = texture(uTex, uv + vec2(-texel.x, 0.0)).rgb;
    vec3 e = texture(uTex, uv + vec2( texel.x, 0.0)).rgb;
    vec3 mn = min(min(min(n, s), min(wv, e)), c);
    vec3 mx = max(max(max(n, s), max(wv, e)), c);
    vec3 amp = (mx - mn) / max(mx, vec3(1e-4));
    vec3 wgt = clamp(1.0 - amp * 1.6, 0.0, 1.0);
    vec3 blur = (n + s + wv + e) * 0.25;
    vec3 outC = c + (c - blur) * uSharp * wgt;
    fragColor = vec4(clamp(outC, 0.0, 1.0), 1.0);
  }`;

  const state = {
    video: null,
    canvas: null,
    gl: null,
    progUp: null,
    progCas: null,
    vao: null,
    texSrc: null,
    texFbo: null,
    fbo: null,
    sharp: 0.7,
    frames: 0,
    goodFrames: 0,
    blackChecks: 0,
    strategy: 0,           // 0=直传 1=2D桥接 2=ImageBitmap 3=captureStream+VideoFrame 4=放弃
    reader: null,
    processor: null,
    stageLog: [],
    bitmapPending: false,
    bitmapOk: 0,
    bridge: null,
    bridgeCtx: null,
    error: '',
    failReason: '',
    onFail: null,
    onReady: null,
    readyFired: false,
    visible: false,
    lastVideoW: 0,
    lastVideoH: 0,
    lastGlMax: -1,
    lastCpuMax: -1,
    rvfc: 0,
    raf: 0,
    running: false,
  };

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('shader: ' + log);
    }
    return sh;
  }

  function makeProgram(gl, fs) {
    const vs = compile(gl, gl.VERTEX_SHADER, VS);
    const f = compile(gl, gl.FRAGMENT_SHADER, fs);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, f);
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(f);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  function initGL(video, canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');

    state.progUp = makeProgram(gl, FS_UP);
    state.progCas = makeProgram(gl, FS_CAS);

    const quad = new Float32Array([-1, -1, 3, -1, -1, 3]);
    state.vao = gl.createVertexArray();
    gl.bindVertexArray(state.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    state.texSrc = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, state.texSrc);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    state.texFbo = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, state.texFbo);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    state.fbo = gl.createFramebuffer();
    state.gl = gl;
    state.video = video;
    state.canvas = canvas;
    attachFbo();
    return gl;
  }

  // 把 texFbo 重新挂到 FBO 上（尺寸变化或重新 enable 时都必须调用）
  function attachFbo() {
    const gl = state.gl;
    if (!gl || !state.texFbo || !state.fbo || !state.canvas) return;
    const w = Math.max(1, state.canvas.width);
    const h = Math.max(1, state.canvas.height);
    gl.bindTexture(gl.TEXTURE_2D, state.texFbo);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, state.texFbo, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function layout() {
    const v = state.video;
    const canvas = state.canvas;
    if (!v || !canvas) return;
    // 画布被搬进 Document PiP 窗口时，尺寸由窗口决定，不按页面里的视频矩形算
    if (canvas.ownerDocument && canvas.ownerDocument !== document) return;
    if (canvas.closest && canvas.closest('#p-floatpip')) return;
    const box = v.getBoundingClientRect();
    const vw = v.videoWidth || 16;
    const vh = v.videoHeight || 9;
    if (!box.width || !box.height) return;

    const fit = Math.min(box.width / vw, box.height / vh);
    const cw = Math.max(1, Math.round(vw * fit));
    const ch = Math.max(1, Math.round(vh * fit));
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    canvas.style.left = Math.round((box.width - cw) / 2) + 'px';
    canvas.style.top = Math.round((box.height - ch) / 2) + 'px';

    const dpr = Math.min(global.devicePixelRatio || 1, 2);
    const outW = Math.max(1, Math.round(cw * dpr));
    const outH = Math.max(1, Math.round(ch * dpr));
    if (canvas.width !== outW || canvas.height !== outH) {
      canvas.width = outW;
      canvas.height = outH;
      attachFbo();
    }
    state.lastVideoW = vw;
    state.lastVideoH = vh;
  }

  // 2D 参考亮度：CPU 侧把视频画进 32x32 canvas，用于判断「视频本身是不是黑」
  const probe = { canvas: null, ctx: null };
  function cpuMax(video) {
    try {
      if (!probe.canvas) {
        probe.canvas = document.createElement('canvas');
        probe.canvas.width = 32;
        probe.canvas.height = 32;
        probe.ctx = probe.canvas.getContext('2d', { willReadFrequently: true });
      }
      probe.ctx.drawImage(video, 0, 0, 32, 32);
      const data = probe.ctx.getImageData(0, 0, 32, 32).data;
      let max = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > max) max = data[i];
        if (data[i + 1] > max) max = data[i + 1];
        if (data[i + 2] > max) max = data[i + 2];
      }
      return max;
    } catch (e) {
      return -1;
    }
  }

  function glMax() {
    const gl = state.gl;
    if (!gl) return 0;
    const w = state.canvas.width;
    const h = state.canvas.height;
    const px = new Uint8Array(4);
    let max = 0;
    const xs = [Math.max(0, (w >> 1) - 1), Math.max(0, (w >> 2) - 1), Math.max(0, (w * 3 >> 2) - 1)];
    const ys = [Math.max(0, (h >> 1) - 1), Math.max(0, (h >> 2) - 1), Math.max(0, (h * 3 >> 2) - 1)];
    for (const x of xs) {
      for (const y of ys) {
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        max = Math.max(max, px[0], px[1], px[2]);
      }
    }
    return max;
  }

  function showCanvas(show) {
    state.visible = show;
    if (state.video) state.video.style.opacity = show ? '0' : '';
    if (state.canvas) state.canvas.style.opacity = show ? '1' : '1';
  }

  function healthCheck() {
    const v = state.video;
    if (!v || !v.videoWidth) return;
    const cpu = cpuMax(v);
    const glv = glMax();
    state.lastCpuMax = cpu;
    state.lastGlMax = glv;
    if (cpu <= 8) return; // 视频本身是黑场/加载中，不判定
    if (glv > 4) {
      state.blackChecks = 0;
      state.goodFrames += 1;
      if (!state.visible) {
        showCanvas(true);
        if (!state.readyFired) {
          state.readyFired = true;
          if (typeof state.onReady === 'function') {
            try { state.onReady(); } catch (e) { /* 忽略 */ }
          }
        }
      }
      return;
    }
    // WebGL 输出全黑，但视频有内容 → 取帧失败
    state.blackChecks += 1;
    if (state.blackChecks < 2) return;
    state.blackChecks = 0;
    escalateStrategy();
  }

  function recordStage() {
    const gl = state.gl;
    const v = state.video;
    state.stageLog.push({
      stage: state.strategy,
      glError: gl ? gl.getError() : -1,
      vw: v ? v.videoWidth : 0,
      vh: v ? v.videoHeight : 0,
      ready: v ? v.readyState : 0,
      cw: state.canvas ? state.canvas.width : 0,
      ch: state.canvas ? state.canvas.height : 0,
      src: v ? String(v.currentSrc || '').slice(0, 32) : '',
      glMax: state.lastGlMax,
      cpuMax: state.lastCpuMax,
    });
  }

  function startFrameReader() {
    const v = state.video;
    if (!v || !global.MediaStreamTrackProcessor || typeof v.captureStream !== 'function') return false;
    try {
      const stream = v.captureStream();
      const track = stream.getVideoTracks()[0];
      if (!track) return false;
      state.processor = new global.MediaStreamTrackProcessor({ track: track });
      state.reader = state.processor.readable.getReader();
      pumpFrames();
      return true;
    } catch (e) {
      state.error = 'trackProcessor: ' + String((e && e.message) || e);
      return false;
    }
  }

  async function pumpFrames() {
    while (state.running && state.reader) {
      let res;
      try { res = await state.reader.read(); } catch (e) { state.error = String((e && e.message) || e); break; }
      if (!res || res.done) break;
      const frame = res.value;
      if (frame) {
        try { draw(frame); } catch (e) { state.error = String((e && e.message) || e); }
        try { frame.close(); } catch (e) { /* 忽略 */ }
      }
    }
  }

  function escalateStrategy() {
    recordStage();
    if (state.strategy < 3) {
      state.strategy += 1;
      state.error = '';
      state.blackChecks = 0;
      state.lastGlMax = -1;
      if (state.strategy === 3 && !startFrameReader()) {
        recordStage();
        state.strategy = 4;
      } else {
        return;
      }
    }
    // 三条通道都失败 → 交给页面自动关闭
    state.strategy = 4;
    let detail = '';
    try { detail = ' | ' + JSON.stringify(state.stageLog); } catch (e) { detail = ''; }
    state.failReason = '当前显卡/浏览器无法把视频帧交给 WebGL（已尝试 直传 / 2D桥接 / ImageBitmap / VideoFrame）' + detail;
    const cb = state.onFail;
    disable();
    if (typeof cb === 'function') {
      try { cb(state.failReason); } catch (e) { /* 忽略 */ }
    }
  }

  function uploadFrame(v, source) {
    const gl = state.gl;
    gl.bindTexture(gl.TEXTURE_2D, state.texSrc);
    if (source) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      return;
    }
    if (state.strategy === 1) {
      if (!state.bridge) {
        state.bridge = document.createElement('canvas');
        state.bridgeCtx = state.bridge.getContext('2d', { willReadFrequently: false });
      }
      if (state.bridge.width !== v.videoWidth || state.bridge.height !== v.videoHeight) {
        state.bridge.width = v.videoWidth;
        state.bridge.height = v.videoHeight;
      }
      state.bridgeCtx.drawImage(v, 0, 0, state.bridge.width, state.bridge.height);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, state.bridge);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
    }
  }

  function renderFrame() {
    const gl = state.gl;
    const v = state.video;
    if (!gl || !v || v.readyState < 2 || !v.videoWidth) return;

    // 策略 3：captureStream + MediaStreamTrackProcessor（VideoFrame 直接上传）
    if (state.strategy === 3) return;

    // 策略 2：走 createImageBitmap 异步取帧（另一条读帧通道，绕开 video 直传）
    if (state.strategy === 2) {
      if (state.bitmapPending) return;
      state.bitmapPending = true;
      if (typeof createImageBitmap !== 'function') { escalateStrategy(); state.bitmapPending = false; return; }
      createImageBitmap(v).then(function (bmp) {
        state.bitmapPending = false;
        if (!state.running) { try { bmp.close(); } catch (e) { /* 忽略 */ } return; }
        state.bitmapOk += 1;
        try { draw(bmp); } catch (e) { state.error = String((e && e.message) || e); }
        try { bmp.close(); } catch (e) { /* 忽略 */ }
      }).catch(function (e) {
        state.bitmapPending = false;
        state.error = 'createImageBitmap: ' + String((e && e.message) || e);
        escalateStrategy();
      });
      return;
    }

    if (v.videoWidth !== state.lastVideoW || v.videoHeight !== state.lastVideoH) layout();
    const outW = state.canvas.width;
    const outH = state.canvas.height;
    if (!outW || !outH) return;

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    uploadFrame(v);
    draw(null);
  }

  function draw(bitmapSource) {
    const gl = state.gl;
    const v = state.video;
    if (!gl || !v) return;
    if (bitmapSource) {
      if (v.videoWidth !== state.lastVideoW || v.videoHeight !== state.lastVideoH) layout();
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      uploadFrame(v, bitmapSource);
    }
    const outW = state.canvas.width;
    const outH = state.canvas.height;
    if (!outW || !outH) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, state.fbo);
    gl.viewport(0, 0, outW, outH);
    gl.useProgram(state.progUp);
    gl.bindTexture(gl.TEXTURE_2D, state.texSrc);
    gl.uniform1i(gl.getUniformLocation(state.progUp, 'uTex'), 0);
    gl.uniform2f(gl.getUniformLocation(state.progUp, 'uSrc'), v.videoWidth, v.videoHeight);
    gl.uniform2f(gl.getUniformLocation(state.progUp, 'uDst'), outW, outH);
    gl.bindVertexArray(state.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, outW, outH);
    gl.useProgram(state.progCas);
    gl.bindTexture(gl.TEXTURE_2D, state.texFbo);
    gl.uniform1i(gl.getUniformLocation(state.progCas, 'uTex'), 0);
    gl.uniform2f(gl.getUniformLocation(state.progCas, 'uSrc'), outW, outH);
    gl.uniform1f(gl.getUniformLocation(state.progCas, 'uSharp'), state.sharp);
    gl.bindVertexArray(state.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    state.frames += 1;
    if (state.frames % 15 === 0) {
      try { healthCheck(); } catch (e) { /* 忽略 */ }
    }
  }

  function schedule() {
    if (!state.running) return;
    const v = state.video;
    if (v && typeof v.requestVideoFrameCallback === 'function') {
      state.rvfc = v.requestVideoFrameCallback(function () {
        try { renderFrame(); } catch (e) { state.error = String((e && e.message) || e); }
        schedule();
      });
      return;
    }
    state.raf = global.requestAnimationFrame(function () {
      try { renderFrame(); } catch (e) { state.error = String((e && e.message) || e); }
      schedule();
    });
  }

  function stopLoops() {
    const v = state.video;
    if (v && state.rvfc && typeof v.cancelVideoFrameCallback === 'function') {
      try { v.cancelVideoFrameCallback(state.rvfc); } catch (e) { /* 忽略 */ }
    }
    if (state.raf) global.cancelAnimationFrame(state.raf);
    state.rvfc = 0;
    state.raf = 0;
  }

  function enable(video, canvas, opts) {
    if (!video || !canvas) return false;
    // 已在运行且对象没变：只更新锐度/回调，避免重复初始化把 FBO 弄坏
    if (state.running && state.gl && state.video === video && state.canvas === canvas) {
      state.sharp = opts && typeof opts.sharp === 'number' ? opts.sharp : state.sharp;
      if (opts && opts.onFail) state.onFail = opts.onFail;
      if (opts && opts.onReady) state.onReady = opts.onReady;
      layout();
      return true;
    }
    try {
      disable();
      initGL(video, canvas);
      state.sharp = opts && typeof opts.sharp === 'number' ? opts.sharp : 0.7;
      state.onFail = (opts && opts.onFail) || null;
      state.onReady = (opts && opts.onReady) || null;
      state.readyFired = false;
      state.strategy = 0;
      state.stageLog = [];
      state.reader = null;
      state.processor = null;
      state.bitmapPending = false;
      state.bitmapOk = 0;
      state.frames = 0;
      state.goodFrames = 0;
      state.blackChecks = 0;
      state.error = '';
      state.failReason = '';
      canvas.style.display = 'block';
      showCanvas(false); // 先别隐藏视频，等确认能画出来
      layout();
      state.running = true;
      renderFrame();
      schedule();
      return true;
    } catch (e) {
      state.error = String((e && e.message) || e);
      try { disable(); } catch (e2) { /* 忽略 */ }
      return false;
    }
  }

  function disable() {
    state.running = false;
    stopLoops();
    if (state.reader) {
      try { state.reader.cancel(); } catch (e) { /* 忽略 */ }
      state.reader = null;
    }
    state.processor = null;
    if (state.video) state.video.style.opacity = '';
    if (state.canvas) {
      state.canvas.style.display = 'none';
      state.canvas.style.opacity = '1';
    }
    state.visible = false;
    state.video = null;
    state.canvas = null;
    state.gl = null;
    state.progUp = null;
    state.progCas = null;
    state.vao = null;
    state.texSrc = null;
    state.texFbo = null;
    state.fbo = null;
    state.bridge = null;
    state.bridgeCtx = null;
  }

  global.HGSuperRes = {
    enable: enable,
    disable: disable,
    layout: layout,
    // 画中画窗口里画布尺寸由窗口决定（不走 layout 的视频矩形计算）
    setSurface: function (width, height) {
      if (!state.gl || !state.canvas) return;
      const cw = Math.max(1, Math.round(width));
      const ch = Math.max(1, Math.round(height));
      if (state.canvas.width === cw && state.canvas.height === ch) return;
      state.canvas.width = cw;
      state.canvas.height = ch;
      attachFbo();
    },
    setSharp: function (value) { state.sharp = Number(value) || 0; },
    status: function () {
      return {
        mode: state.gl ? 'webgl2' : 'off',
        strategy: state.strategy,
        bitmapOk: state.bitmapOk,
        width: state.canvas ? state.canvas.width : 0,
        height: state.canvas ? state.canvas.height : 0,
        frames: state.frames,
        goodFrames: state.goodFrames,
        visible: state.visible,
        glMax: state.lastGlMax,
        cpuMax: state.lastCpuMax,
        error: state.error,
        failReason: state.failReason,
        stageLog: state.stageLog,
        glError: state.gl ? state.gl.getError() : 0,
      };
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
