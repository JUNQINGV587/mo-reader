import { useEffect, useRef } from 'react'

const VERT = `
attribute vec2 a;
void main() { gl_Position = vec4(a, 0.0, 1.0); }
`

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;

float blob(vec2 p, vec2 c, float r) {
  return 1.0 - smoothstep(0.0, r, length(p - c));
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = uv;
  p.x *= uRes.x / uRes.y;
  float t = uTime * 0.06;

  // Match the S5 theme's CSS gradient: #E8ECF5 -> #F6E7EA -> #EAF3EC (135deg).
  float g = clamp((uv.x + uv.y) * 0.5, 0.0, 1.0);
  vec3 c0 = vec3(0.910, 0.925, 0.961);
  vec3 c1 = vec3(0.965, 0.906, 0.918);
  vec3 c2 = vec3(0.918, 0.953, 0.925);
  vec3 base = g < 0.5 ? mix(c0, c1, g * 2.0) : mix(c1, c2, (g - 0.5) * 2.0);

  float b1 = blob(p, vec2(0.52 + 0.07 * sin(t), 0.66 + 0.05 * cos(t * 1.3)), 0.42);
  float b2 = blob(p, vec2(0.26 + 0.06 * cos(t * 1.1), 0.28 + 0.05 * sin(t * 0.9)), 0.38);
  float b3 = blob(p, vec2(0.84 + 0.05 * sin(t * 0.8), 0.22 + 0.05 * cos(t * 1.2)), 0.30);

  vec3 col = base;
  col = mix(col, vec3(1.0, 0.624, 0.478), b1 * 0.14);
  col = mix(col, vec3(0.557, 0.647, 0.867), b2 * 0.12);
  col = mix(col, vec3(0.855, 0.808, 0.957), b3 * 0.10);

  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) * 0.012;
  gl_FragColor = vec4(col, 1.0);
}
`

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(log ?? 'shader compile failed')
  }
  return shader
}

function createProgram(gl: WebGLRenderingContext) {
  const program = gl.createProgram()!
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT))
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? 'program link failed')
  }
  return program
}

/** Fixed full-viewport WebGL gradient for the S5 "glass" theme. */
export function GlassCanvas() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      powerPreference: 'low-power',
      preserveDrawingBuffer: false,
    })
    if (!gl) return

    let program: WebGLProgram
    try {
      program = createProgram(gl)
    } catch {
      return
    }

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)

    const a = gl.getAttribLocation(program, 'a')
    gl.enableVertexAttribArray(a)
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0)

    const uRes = gl.getUniformLocation(program, 'uRes')
    const uTime = gl.getUniformLocation(program, 'uTime')
    gl.useProgram(program)

    let raf = 0
    const start = performance.now()
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.floor(canvas.clientWidth * dpr)
      const h = Math.floor(canvas.clientHeight * dpr)
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
        gl.viewport(0, 0, w, h)
      }
      gl.uniform2f(uRes, w, h)
      gl.uniform1f(uTime, reduce ? 0 : (now - start) / 1000)
      gl.clearColor(0.906, 0.925, 0.961, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    raf = requestAnimationFrame(draw)

    const onLost = (e: Event) => {
      e.preventDefault()
      cancelAnimationFrame(raf)
    }
    const onRestored = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(draw)
    }
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)

    return () => {
      cancelAnimationFrame(raf)
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [])

  return <canvas ref={ref} className="glass-bg" aria-hidden="true" />
}
