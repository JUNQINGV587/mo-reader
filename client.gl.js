/* global window, document, ResizeObserver */

// DSH loads package-local dynamic chunks as classic scripts that must register
// a factory with the client module loader. This file is the lazy ambience
// chunk, so it ships pre-wrapped (no build step) and keeps mountAmbience as its
// single export.
window.__ModuleLoader__.load({
	id: '@local/mo-reader',
	chunk: 'client.gl.js',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

// Raw WebGL1 ambience for the reading page: paper tint, light, seam and dust.
// No three.js, no build step; the module is loaded lazily by client.js.

const PALETTES = {
  paper: { ink: [0.23, 0.16, 0.12], light: [1.0, 0.91, 0.79], dust: [0.96, 0.87, 0.72] },
  light: { ink: [0.42, 0.30, 0.22], light: [1.0, 0.96, 0.87], dust: [1.0, 1.0, 1.0] },
  green: { ink: [0.18, 0.27, 0.21], light: [0.66, 0.77, 0.60], dust: [0.86, 0.92, 0.81] },
  dark: { ink: [0.58, 0.66, 0.62], light: [0.85, 0.89, 0.86], dust: [0.72, 0.79, 0.75] },
}

const VERTEX = `
attribute vec2 aPosition;
attribute vec2 aUv;
varying vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`

const PAPER_FRAGMENT = `
precision mediump float;
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  vec4 paper = texture2D(uMap, vUv * vec2(2.0, 3.0));
  gl_FragColor = vec4(uColor * paper.rgb, uOpacity);
}
`

const LIGHT_FRAGMENT = `
precision mediump float;
uniform float uProgress;
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  float edge = smoothstep(0.0, 0.42, vUv.y) * smoothstep(1.0, 0.58, vUv.y);
  float band = exp(-pow((vUv.y - (0.12 + uProgress * 0.76)) / 0.24, 2.0));
  gl_FragColor = vec4(uColor, (0.28 + 0.72 * band) * edge * uOpacity);
}
`

const SEAM_FRAGMENT = `
precision mediump float;
uniform float uSeam;
uniform float uSeamX;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  float band = smoothstep(0.11, 0.0, abs(vUv.x - uSeamX));
  gl_FragColor = vec4(uColor, band * uSeam * 0.5);
}
`

const DUST_VERTEX = `
attribute vec2 aPosition;
uniform float uRotation;
uniform float uDpr;
varying float vAlpha;
void main() {
  float s = sin(uRotation);
  float c = cos(uRotation);
  vec2 p = vec2(aPosition.x * c - aPosition.y * s, aPosition.x * s + aPosition.y * c);
  vAlpha = 0.55 + 0.45 * sin(aPosition.x * 9.0 + aPosition.y * 7.0);
  gl_Position = vec4(p, 0.0, 1.0);
  gl_PointSize = 2.2 * uDpr;
}
`

const DUST_FRAGMENT = `
precision mediump float;
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
void main() {
  vec4 sprite = texture2D(uMap, gl_PointCoord);
  gl_FragColor = vec4(uColor, sprite.a * uOpacity * vAlpha);
}
`

const RECT_VERTEX = `
attribute vec2 aPosition;
uniform vec4 uRect;
varying vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition * uRect.zw + uRect.xy, 0.0, 1.0);
}
`

const AXIS_FRAGMENT = `
precision mediump float;
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uAxis;
uniform float uVelocity;
varying vec2 vUv;
void main() {
  vec4 paper = texture2D(uMap, vUv * vec2(2.0, 3.0));
  float edge = uAxis < 0.5 ? smoothstep(0.0, 0.55, vUv.y) : smoothstep(1.0, 0.45, vUv.y);
  float glow = 0.8 + min(0.2, abs(uVelocity) * 0.12);
  gl_FragColor = vec4(uColor * paper.rgb, (0.34 + 0.26 * edge) * uOpacity * glow);
}
`

function compile(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`ambience shader failed: ${log || 'unknown'}`)
  }
  return shader
}

function program(gl, vertexSource, fragmentSource) {
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
  const linked = gl.createProgram()
  gl.attachShader(linked, vertex)
  gl.attachShader(linked, fragment)
  gl.linkProgram(linked)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(linked, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(linked)
    gl.deleteProgram(linked)
    throw new Error(`ambience program failed: ${log || 'unknown'}`)
  }
  return linked
}

function paperCanvas(document) {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  ctx.fillStyle = '#f5efe3'
  ctx.fillRect(0, 0, 256, 256)
  for (let index = 0; index < 9000; index += 1) {
    const alpha = Math.random() * 0.05
    ctx.fillStyle = `rgba(90,70,50,${alpha})`
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 1, 1)
  }
  ctx.strokeStyle = 'rgba(120,95,70,.055)'
  ctx.lineWidth = 1
  for (let index = 0; index < 70; index += 1) {
    const y = Math.random() * 256
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(256, y + Math.random() * 6 - 3)
    ctx.stroke()
  }
  return canvas
}

function dustSprite(document) {
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 32
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.4, 'rgba(255,255,255,.8)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 32, 32)
  return canvas
}

function dustCountFor(quality) {
  if (quality === 'low') return 60
  if (quality === 'high') return 220
  return 140
}

function mountAmbience(host, options = {}) {
  if (!host || typeof host.appendChild !== 'function') throw new Error('mountAmbience requires a DOM host')
  const document = host.ownerDocument
  const window = document.defaultView
  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value))
  const damp = (current, target, lambda, dt) => current + (target - current) * (1 - Math.exp(-lambda * dt / 1000))

  const state = {
    theme: options.theme || 'paper',
    quality: options.quality || 'auto',
    ambience: options.ambience || 'full',
    still: Boolean(options.reducedMotion),
    paused: false,
    disposed: false,
    frames: 0,
    ema: 0,
    frame: 0,
    lastTime: 0,
    progress: 0.5,
    targetProgress: 0.5,
    seam: 0,
    targetSeam: 0,
    seamX: 0.5,
    dpr: 1,
    axisTop: 0,
    axisBottom: 0,
    axesVisible: false,
    scroll: 0,
    velocity: 0,
  }
  let palette = PALETTES[state.theme] || PALETTES.paper

  const canvas = document.createElement('canvas')
  canvas.className = 'mr-ambience-canvas'
  canvas.setAttribute('aria-hidden', 'true')
  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'low-power',
  })
  if (!gl) throw new Error('WebGL is unavailable')
  host.appendChild(canvas)

  const paperProgram = program(gl, VERTEX, PAPER_FRAGMENT)
  const lightProgram = program(gl, VERTEX, LIGHT_FRAGMENT)
  const seamProgram = program(gl, VERTEX, SEAM_FRAGMENT)
  const dustProgram = program(gl, DUST_VERTEX, DUST_FRAGMENT)
  const axisProgram = program(gl, RECT_VERTEX, AXIS_FRAGMENT)

  const quad = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 0, 1,
    1, -1, 1, 1,
    -1, 1, 0, 0,
    -1, 1, 0, 0,
    1, -1, 1, 1,
    1, 1, 1, 0,
  ]), gl.STATIC_DRAW)

  const paperTexture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, paperTexture)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, paperCanvas(document))
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  const dustTexture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, dustTexture)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, dustSprite(document))
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  let dustBuffer = null
  let dustCount = 0
  let dustPositions = null
  let dustSpeeds = null

  function rebuildDust(count) {
    dustCount = state.still || state.ambience !== 'full' ? 0 : count
    if (dustBuffer) gl.deleteBuffer(dustBuffer)
    dustBuffer = null
    dustPositions = null
    dustSpeeds = null
    if (!dustCount) return
    dustPositions = new Float32Array(dustCount * 2)
    dustSpeeds = new Float32Array(dustCount)
    for (let index = 0; index < dustCount; index += 1) {
      dustPositions[index * 2] = Math.random() * 2 - 1
      dustPositions[index * 2 + 1] = Math.random() * 2 - 1
      dustSpeeds[index] = 0.00004 + Math.random() * 0.00008
    }
    dustBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, dustBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, dustPositions, gl.DYNAMIC_DRAW)
  }

  function size() {
    state.dpr = clamp(window.devicePixelRatio || 1, 1, state.quality === 'low' ? 1.25 : 2)
    const width = Math.max(1, Math.round((host.clientWidth || 1) * state.dpr))
    const height = Math.max(1, Math.round((host.clientHeight || 1) * state.dpr))
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    gl.viewport(0, 0, width, height)
  }

  function setupQuad(linked) {
    const position = gl.getAttribLocation(linked, 'aPosition')
    const uv = gl.getAttribLocation(linked, 'aUv')
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 16, 0)
    if (uv >= 0) {
      gl.enableVertexAttribArray(uv)
      gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8)
    }
  }

  function drawAxis(rect, axis) {
    gl.useProgram(axisProgram)
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    const position = gl.getAttribLocation(axisProgram, 'aPosition')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 16, 0)
    gl.uniform4f(gl.getUniformLocation(axisProgram, 'uRect'), rect[0], rect[1], rect[2], rect[3])
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, paperTexture)
    gl.uniform1i(gl.getUniformLocation(axisProgram, 'uMap'), 0)
    gl.uniform3fv(gl.getUniformLocation(axisProgram, 'uColor'), palette.ink)
    gl.uniform1f(gl.getUniformLocation(axisProgram, 'uOpacity'), 0.5)
    gl.uniform1f(gl.getUniformLocation(axisProgram, 'uAxis'), axis)
    gl.uniform1f(gl.getUniformLocation(axisProgram, 'uVelocity'), state.velocity)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  function draw() {
    if (state.disposed) return
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    if (state.ambience === 'off') return

    gl.useProgram(paperProgram)
    setupQuad(paperProgram)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, paperTexture)
    gl.uniform1i(gl.getUniformLocation(paperProgram, 'uMap'), 0)
    gl.uniform3fv(gl.getUniformLocation(paperProgram, 'uColor'), palette.ink)
    gl.uniform1f(gl.getUniformLocation(paperProgram, 'uOpacity'), 0.14)
    gl.drawArrays(gl.TRIANGLES, 0, 6)

    if (state.axesVisible && state.axisTop > 0) drawAxis([0, 1 - state.axisTop * 2, 1, state.axisTop * 2], 0)
    if (state.axesVisible && state.axisBottom > 0) drawAxis([0, -1, 1, state.axisBottom * 2], 1)

    if (state.ambience === 'full') {
      gl.useProgram(lightProgram)
      setupQuad(lightProgram)
      gl.uniform1f(gl.getUniformLocation(lightProgram, 'uProgress'), state.progress)
      gl.uniform3fv(gl.getUniformLocation(lightProgram, 'uColor'), palette.light)
      gl.uniform1f(gl.getUniformLocation(lightProgram, 'uOpacity'), 0.13 * (1 + Math.min(0.5, Math.abs(state.velocity) * 0.1)))
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }

    gl.useProgram(seamProgram)
    setupQuad(seamProgram)
    gl.uniform1f(gl.getUniformLocation(seamProgram, 'uSeam'), state.seam)
    gl.uniform1f(gl.getUniformLocation(seamProgram, 'uSeamX'), state.seamX)
    gl.uniform3fv(gl.getUniformLocation(seamProgram, 'uColor'), palette.ink)
    gl.drawArrays(gl.TRIANGLES, 0, 6)

    if (dustCount && dustBuffer) {
      gl.useProgram(dustProgram)
      const position = gl.getAttribLocation(dustProgram, 'aPosition')
      gl.bindBuffer(gl.ARRAY_BUFFER, dustBuffer)
      gl.enableVertexAttribArray(position)
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
      gl.uniform1f(gl.getUniformLocation(dustProgram, 'uRotation'), state.dustRotation || 0)
      gl.uniform1f(gl.getUniformLocation(dustProgram, 'uDpr'), state.dpr)
      gl.uniform1f(gl.getUniformLocation(dustProgram, 'uOpacity'), 0.2 * (1 + Math.min(0.4, Math.abs(state.velocity) * 0.08)))
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, dustTexture)
      gl.uniform1i(gl.getUniformLocation(dustProgram, 'uMap'), 0)
      gl.uniform3fv(gl.getUniformLocation(dustProgram, 'uColor'), palette.dust)
      gl.drawArrays(gl.POINTS, 0, dustCount)
    }
  }

  const stats = { frames: 0, ema: 0, paused: false, mode: state.ambience, quality: state.quality }
  host.__mrAmbience = stats

  function tick(now) {
    if (state.disposed || state.paused) return
    const dt = state.lastTime ? Math.min(64, now - state.lastTime) : 16
    state.lastTime = now
    state.progress = damp(state.progress, state.targetProgress, 6, dt)
    state.seam = damp(state.seam, state.targetSeam, 7, dt)
    if (dustCount && dustPositions && dustSpeeds) {
      for (let index = 0; index < dustCount; index += 1) {
        dustPositions[index * 2 + 1] -= dustSpeeds[index] * dt
        dustPositions[index * 2] += Math.sin(now * 0.00012 + index) * 0.000012 * dt
        if (dustPositions[index * 2 + 1] < -1) {
          dustPositions[index * 2 + 1] = 1
          dustPositions[index * 2] = Math.random() * 2 - 1
        }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, dustBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, dustPositions, gl.DYNAMIC_DRAW)
      state.dustRotation = Math.sin(now * 0.00005) * 0.004
    }
    draw()
    state.frames += 1
    stats.frames = state.frames
    state.ema = state.ema ? state.ema * 0.92 + dt * 0.08 : dt
    stats.ema = Math.round(state.ema * 100) / 100
    if (state.quality === 'auto' && state.frames === 90 && state.ema > 20) degrade()
    state.frame = window.requestAnimationFrame(tick)
  }

  function start() {
    if (state.disposed || state.paused || state.still || state.ambience === 'off') return
    if (state.frame) return
    state.lastTime = 0
    state.frame = window.requestAnimationFrame(tick)
  }

  function stop() {
    if (state.frame) window.cancelAnimationFrame(state.frame)
    state.frame = 0
  }

  function degrade() {
    state.quality = 'low'
    stats.quality = 'low'
    size()
    rebuildDust(dustCountFor('low'))
    draw()
  }

  function setAmbience(mode) {
    state.ambience = ['full', 'paper', 'off'].includes(mode) ? mode : 'full'
    stats.mode = state.ambience
    if (state.ambience === 'off') {
      state.paused = true
      stats.paused = true
      stop()
    }
    rebuildDust(dustCountFor(state.quality))
    draw()
    if (state.ambience !== 'off' && !state.paused && !state.still) start()
  }

  function setTheme(theme) {
    if (!PALETTES[theme] || theme === state.theme) return
    state.theme = theme
    palette = PALETTES[theme]
    draw()
  }

  function setQuality(quality) {
    state.quality = ['auto', 'high', 'low'].includes(quality) ? quality : 'auto'
    stats.quality = state.quality
    size()
    rebuildDust(dustCountFor(state.quality))
    draw()
  }

  function setProgress(value) {
    state.targetProgress = clamp(Number(value) || 0, 0, 1)
  }

  function setScroll(progress, velocity, axes) {
    state.scroll = clamp(Number(progress) || 0, 0, 1)
    state.velocity = clamp(Number(velocity) || 0, -6, 6)
    const viewport = Math.max(1, host.clientHeight || 1)
    state.axesVisible = Boolean(axes?.visible)
    state.axisTop = state.axesVisible ? clamp(axes.top / viewport, 0, 1) : 0
    state.axisBottom = state.axesVisible ? clamp(axes.bottom / viewport, 0, 1) : 0
    if (state.still) draw()
  }

  function setSeam(value, seamX = 0.5) {
    state.targetSeam = clamp(Number(value) || 0, 0, 1)
    state.seamX = clamp(seamX, 0, 1)
  }

  function pause() {
    if (state.paused) return
    state.paused = true
    stats.paused = true
    stop()
  }

  function resume() {
    if (!state.paused) return
    if (state.disposed || state.still || state.ambience === 'off') return
    state.paused = false
    stats.paused = false
    start()
  }

  const onLost = (event) => {
    event.preventDefault()
    host.dataset.ambienceError = 'lost'
    stop()
  }
  canvas.addEventListener('webglcontextlost', onLost)
  const onVisibility = () => {
    if (document.hidden) {
      state.paused = true
      stats.paused = true
      stop()
    } else if (!state.still && state.ambience !== 'off') {
      state.paused = false
      stats.paused = false
      start()
    }
  }
  document.addEventListener('visibilitychange', onVisibility)
  const observer = new ResizeObserver(() => { size(); draw() })
  observer.observe(host)

  size()
  rebuildDust(dustCountFor(state.quality))
  draw()
  start()

  return {
    setTheme,
    setQuality,
    setAmbience,
    setProgress,
    setScroll,
    setSeam,
    pause,
    resume,
    dispose() {
      if (state.disposed) return
      state.disposed = true
      stop()
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      canvas.removeEventListener('webglcontextlost', onLost)
      rebuildDust(0)
      gl.deleteBuffer(quad)
      gl.deleteTexture(paperTexture)
      gl.deleteTexture(dustTexture)
      gl.deleteProgram(paperProgram)
      gl.deleteProgram(lightProgram)
      gl.deleteProgram(seamProgram)
      gl.deleteProgram(dustProgram)
      gl.deleteProgram(axisProgram)
      canvas.remove()
      if (host.__mrAmbience === stats) delete host.__mrAmbience
    },
  }
}

		exports.mountAmbience = mountAmbience;
		return module.exports;
	},
});
