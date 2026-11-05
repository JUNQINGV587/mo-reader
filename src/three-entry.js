/* global window, document, ResizeObserver, Image */
import {
  AmbientLight, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color,
  DirectionalLight, DoubleSide, Fog, Group, HemisphereLight, MathUtils, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  OrthographicCamera, PCFSoftShadowMap, PerspectiveCamera, PlaneGeometry, PointLight, Points, PointsMaterial, AdditiveBlending,
  LinearFilter, Raycaster, RepeatWrapping, Scene, ShaderMaterial, SRGBColorSpace, Texture, Vector2, Vector3, WebGLRenderer,
} from 'three'

const PALETTES = {
  paper: {
    scene: 0x3a2a1f, wood: 0x8a6244, woodEdge: 0x5b3c29, back: 0x2a1c14,
    sky: 0xffe9c9, ground: 0x4a3324, fill: 0xffd8a8, dust: 0xf5dfb8,
    spines: [0x7a3f2d, 0x355b4e, 0x3c4568, 0x6d4a2c, 0x5b3b55, 0x7c6140],
  },
  light: {
    scene: 0xd8d3c8, wood: 0x8b6b4d, woodEdge: 0xc7b8a2, back: 0xb9b1a3,
    sky: 0xffffff, ground: 0xb8ad9e, fill: 0xfff4df, dust: 0xffffff,
    spines: [0x9a5a45, 0x4d7264, 0x55618a, 0x8b623e, 0x76506f, 0x9b7e57],
  },
  green: {
    scene: 0x1d2821, wood: 0x5d4937, woodEdge: 0x2f3a30, back: 0x162019,
    sky: 0xe8f1df, ground: 0x24352a, fill: 0xa9c49a, dust: 0xdcebcf,
    spines: [0x536b4c, 0x3f5c50, 0x5d6547, 0x7b5a3f, 0x4e4d69, 0x6e7050],
  },
  dark: {
    scene: 0x101312, wood: 0x44392f, woodEdge: 0x1e2521, back: 0x0d1110,
    sky: 0xd8e2dc, ground: 0x16201c, fill: 0x93a89d, dust: 0xb8c9bf,
    spines: [0x4b3a35, 0x2f4841, 0x394358, 0x574630, 0x48374c, 0x5a5140],
  },
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const damp = (value, target, lambda, dt) => MathUtils.lerp(value, target, 1 - Math.exp(-lambda * dt))

function hash(text) {
  let value = 0
  for (let index = 0; index < text.length; index += 1) value = (value * 31 + text.charCodeAt(index)) >>> 0
  return value
}

function titleOf(book) {
  return String(book?.name || book?.title || '未命名').trim()
}

function authorOf(book) {
  return String(book?.author || '').trim()
}

function wrap(ctx, text, x, y, maxWidth, lineHeight, maxLines = 3) {
  const chars = [...text]
  let line = ''
  let lines = 0
  for (const char of chars) {
    const next = line + char
    if (ctx.measureText(next).width > maxWidth && line) {
      ctx.fillText(line, x, y + lines * lineHeight)
      line = char
      lines += 1
      if (lines >= maxLines) return
    } else {
      line = next
    }
  }
  if (line && lines < maxLines) ctx.fillText(line, x, y + lines * lineHeight)
}

function coverCanvas(book, palette) {
  const canvas = document.createElement('canvas')
  canvas.width = 480
  canvas.height = 700
  const ctx = canvas.getContext('2d')
  const name = titleOf(book)
  const author = authorOf(book)
  const base = palette.spines[hash(name) % palette.spines.length]
  const color = new Color(base)
  const light = `#${color.clone().offsetHSL(0, -0.02, 0.18).getHexString()}`
  const dark = `#${color.clone().offsetHSL(0, 0, -0.16).getHexString()}`
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height)
  gradient.addColorStop(0, light)
  gradient.addColorStop(0.62, `#${color.getHexString()}`)
  gradient.addColorStop(1, dark)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.globalAlpha = 0.18
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 2
  for (let x = -canvas.height; x < canvas.width + canvas.height; x += 26) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x + canvas.height, canvas.height)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  ctx.fillStyle = 'rgba(255,248,232,.94)'
  ctx.fillRect(42, 74, 5, 170)
  ctx.font = '600 46px Georgia, "Noto Serif SC", serif'
  ctx.textBaseline = 'top'
  wrap(ctx, name, 68, 76, 350, 56, 4)
  ctx.font = '22px Georgia, "Noto Serif SC", serif'
  ctx.globalAlpha = 0.78
  wrap(ctx, author || '墨读藏书', 68, 590, 340, 30, 2)
  ctx.globalAlpha = 1
  ctx.font = '15px system-ui, sans-serif'
  ctx.fillText('MO READER', 68, 656)
  return canvas
}

function spineCanvas(book, palette) {
  const canvas = document.createElement('canvas')
  canvas.width = 96
  canvas.height = 640
  const ctx = canvas.getContext('2d')
  const name = titleOf(book)
  const base = palette.spines[hash(name) % palette.spines.length]
  const color = new Color(base)
  ctx.fillStyle = `#${color.clone().offsetHSL(0, 0, -0.05).getHexString()}`
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'rgba(255,245,225,.16)'
  ctx.fillRect(7, 0, 3, canvas.height)
  ctx.fillRect(canvas.width - 10, 0, 3, canvas.height)
  ctx.save()
  ctx.translate(canvas.width / 2 + 9, canvas.height / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.fillStyle = 'rgba(255,247,230,.94)'
  ctx.font = '600 25px Georgia, "Noto Serif SC", serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(name.slice(0, 18), 0, 0, 520)
  ctx.restore()
  return canvas
}

function makeTexture(canvas) {
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.generateMipmaps = false
  texture.anisotropy = 4
  return texture
}

function disposeObject(root) {
  root.traverse?.((object) => {
    object.geometry?.dispose?.()
    const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : []
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value && value.isTexture) value.dispose()
      }
      material.dispose?.()
    }
  })
}

function loadTexture(source, crossorigin = true) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    if (crossorigin) image.crossOrigin = 'anonymous'
    image.onload = () => {
      const texture = new Texture(image)
      texture.colorSpace = SRGBColorSpace
      texture.anisotropy = 4
      texture.needsUpdate = true
      resolve(texture)
    }
    image.onerror = () => reject(new Error('cover image failed'))
    image.src = source
  })
}

export function mountShelf(host, options = {}) {
  if (!host || typeof host.appendChild !== 'function') throw new Error('mountShelf requires a DOM host')
  const document = host.ownerDocument
  const window = document.defaultView
  const reduced = options.reducedMotion ?? Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  const state = {
    books: Array.isArray(options.books) ? options.books.slice() : [],
    theme: options.theme || 'paper',
    quality: options.quality || 'auto',
    ambience: options.ambience || 'full',
    selected: null,
    hovered: null,
    disposed: false,
  }
  let palette = PALETTES[state.theme] || PALETTES.paper
  let booksSignatureValue = booksSignature(state.books)

  const renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
  renderer.outputColorSpace = SRGBColorSpace
  renderer.setPixelRatio(clamp(window.devicePixelRatio || 1, 1, state.quality === 'low' ? 1.25 : 2))
  renderer.shadowMap.enabled = !reduced && state.quality !== 'low'
  renderer.shadowMap.type = PCFSoftShadowMap
  renderer.domElement.className = 'mr-shelf3d-canvas'
  renderer.domElement.setAttribute('aria-label', '3D 书架')
  renderer.domElement.style.touchAction = 'none'
  host.appendChild(renderer.domElement)

  const scene = new Scene()
  scene.background = new Color(palette.scene)
  scene.fog = new Fog(palette.scene, 18, 38)

  const camera = new PerspectiveCamera(36, 1, 0.1, 90)
  const shelf = new Group()
  scene.add(shelf)

  const hemi = new HemisphereLight(palette.sky, palette.ground, 1.7)
  scene.add(hemi)
  const ambient = new AmbientLight(0xffe9cf, 0.55)
  scene.add(ambient)
  const key = new DirectionalLight(0xffefd2, 3.2)
  key.position.set(6, 10, 8)
  key.castShadow = true
  key.shadow.mapSize.set(1024, 1024)
  key.shadow.camera.near = 1
  key.shadow.camera.far = 30
  key.shadow.camera.left = -9
  key.shadow.camera.right = 9
  key.shadow.camera.top = 10
  key.shadow.camera.bottom = -4
  key.shadow.bias = -0.0008
  scene.add(key)
  const fill = new DirectionalLight(palette.fill, 1.8)
  fill.position.set(-7, 5, 6)
  scene.add(fill)
  const glow = new PointLight(palette.fill, 34, 20, 2)
  glow.position.set(0, 3.6, 6.2)
  scene.add(glow)

  const raycaster = new Raycaster()
  const pointer = new Vector2()
  const bookMeshes = []
  const shelfParts = []
  const woodMaterials = []
  const darkMaterials = []
  let dust = null
  let dustGeometry = null
  let dustMaterial = null
  let totalHeight = 6
  let shelfWidth = 11
  let coverRun = 0
  let frameHandle = 0
  let lastFrame = 0
  const timers = new Set()
  const view = { yaw: 0, pitch: 0.055, camY: 3.2, targetYaw: 0, targetPitch: 0.055, targetCamY: 3.2, dist: 12, centerY: 3 }
  const drag = { active: false, id: null, x: 0, y: 0, yaw: 0, pitch: 0, moved: false }

  function later(fn, delay) {
    const timer = window.setTimeout(() => { timers.delete(timer); if (!state.disposed) fn() }, delay)
    timers.add(timer)
    return timer
  }

  function bookThickness(book) {
    return clamp(0.23 + titleOf(book).length * 0.008, 0.23, 0.48)
  }

  function makeBoard(geometry, material) {
    const mesh = new Mesh(geometry, material)
    mesh.castShadow = true
    mesh.receiveShadow = true
    shelf.add(mesh)
    shelfParts.push(mesh)
    return mesh
  }

  function buildShelf() {
    clearShelf()
    const books = state.books.slice(0, 48)
    if (!books.length) {
      totalHeight = 6
      shelfWidth = 11
      fitCamera()
      return
    }
    const rowCount = Math.max(1, Math.min(4, Math.ceil(books.length / 10)))
    const perRow = Math.ceil(books.length / rowCount)
    const rowHeight = 2.16
    const boardHeight = 0.13
    const shelfDepth = 1.5
    const bookHeight = 1.78
    const bookDepth = 0.98
    const baseY = 0.22
    totalHeight = baseY + rowCount * rowHeight + 0.28
    shelfWidth = clamp(perRow * 0.44 + 1.15, 5.2, 10.4)

    const wood = new MeshStandardMaterial({ color: palette.wood, roughness: 0.74, metalness: 0.03 })
    const edge = new MeshStandardMaterial({ color: palette.woodEdge, roughness: 0.82, metalness: 0.02 })
    const back = new MeshStandardMaterial({ color: palette.back, roughness: 0.92, metalness: 0 })
    woodMaterials.push(wood, edge)
    darkMaterials.push(back)

    for (let row = 0; row < rowCount; row += 1) {
      const rowY = baseY + row * rowHeight
      const board = makeBoard(new BoxGeometry(shelfWidth, boardHeight, shelfDepth), row % 2 === 0 ? wood : edge)
      board.position.set(0, rowY, 0)
      const rowBooks = books.slice(row * perRow, row * perRow + perRow).map((book, index) => ({ book, index }))
      if (!rowBooks.length) continue
      const gap = 0.045
      const raw = rowBooks.reduce((sum, item) => sum + bookThickness(item.book), 0) + gap * Math.max(0, rowBooks.length - 1)
      const factor = Math.min(1, (shelfWidth - 0.85) / raw)
      let cursor = -(raw * factor) / 2
      for (const item of rowBooks) {
        const width = bookThickness(item.book) * factor
        const book = item.book
        const spine = makeTexture(spineCanvas(book, palette))
        const cover = makeTexture(coverCanvas(book, palette))
        const base = palette.spines[hash(titleOf(book)) % palette.spines.length]
        const coverMaterial = new MeshStandardMaterial({ map: cover, color: 0xffffff, roughness: 0.58, metalness: 0.02 })
        const backMaterial = new MeshStandardMaterial({ color: new Color(base).offsetHSL(0, 0, -0.2), roughness: 0.8, metalness: 0 })
        const pageMaterial = new MeshStandardMaterial({ color: 0xe9dfc8, roughness: 0.92, metalness: 0 })
        const spineMaterial = new MeshStandardMaterial({ map: spine, color: 0xffffff, roughness: 0.64, metalness: 0.02 })
        const geometry = new BoxGeometry(width, bookHeight, bookDepth)
        const mesh = new Mesh(geometry, [coverMaterial, backMaterial, pageMaterial, pageMaterial, spineMaterial, pageMaterial])
        const x = cursor + width / 2
        cursor += width + gap * factor
        mesh.position.set(x, rowY + boardHeight / 2 + bookHeight / 2, 0.08)
        mesh.rotation.y = ((hash(String(book.id || book.bookId || book.name)) % 7) - 3) * 0.006
        mesh.castShadow = true
        mesh.receiveShadow = true
        mesh.userData = {
          book,
          baseX: x,
          baseY: mesh.position.y,
          baseZ: mesh.position.z,
          baseRotY: mesh.rotation.y,
          coverMaterial,
          spineMaterial,
          coverTexture: cover,
          spineTexture: spine,
          hover: 0,
          selected: false,
          opened: false,
          openAt: 0,
          coverOpenAt: 0,
          flapAngle: 0,
          flap: null,
          fan: null,
          pageMaterial,
          savedCoverMaterial: null,
        }
        shelf.add(mesh)
        bookMeshes.push(mesh)
      }
    }

    for (const x of [-shelfWidth / 2, shelfWidth / 2]) {
      const side = makeBoard(new BoxGeometry(0.16, totalHeight, shelfDepth), edge)
      side.position.set(x, totalHeight / 2, 0)
    }
    const backPanel = makeBoard(new BoxGeometry(shelfWidth, totalHeight, 0.09), back)
    backPanel.position.set(0, totalHeight / 2, -shelfDepth / 2 - 0.03)
    const top = makeBoard(new BoxGeometry(shelfWidth + 0.3, 0.16, shelfDepth + 0.14), edge)
    top.position.set(0, totalHeight - 0.04, 0)
    const plinth = makeBoard(new BoxGeometry(shelfWidth + 0.2, 0.22, shelfDepth + 0.1), edge)
    plinth.position.set(0, 0.08, 0)
    addDust()
    fitCamera()
    loadCovers()
  }

  function addDust() {
    if (dust) {
      shelf.remove(dust)
      dustGeometry?.dispose()
      dustMaterial?.dispose()
      dust = null
    }
    if (reduced || state.ambience !== 'full') return
    const count = state.quality === 'low' ? 24 : 60
    const positions = new Float32Array(count * 3)
    for (let index = 0; index < count; index += 1) {
      positions[index * 3] = (Math.random() - 0.5) * shelfWidth * 1.2
      positions[index * 3 + 1] = Math.random() * (totalHeight + 1.5)
      positions[index * 3 + 2] = (Math.random() - 0.5) * 2.8 + 0.5
    }
    dustGeometry = new BufferGeometry()
    dustGeometry.setAttribute('position', new BufferAttribute(positions, 3))
    dustMaterial = new PointsMaterial({
      color: palette.dust, size: 0.028, sizeAttenuation: true, transparent: true,
      opacity: 0.38, depthWrite: false, blending: AdditiveBlending,
    })
    dust = new Points(dustGeometry, dustMaterial)
    shelf.add(dust)
  }

  function fitCamera() {
    const fov = MathUtils.degToRad(camera.fov)
    const fitH = (totalHeight * 0.56 + 0.9) / Math.tan(fov / 2)
    const fitW = (shelfWidth * 0.62) / (Math.tan(fov / 2) * Math.max(0.4, camera.aspect))
    view.dist = Math.max(9.6, fitH, fitW) * 1.08
    view.centerY = totalHeight * 0.5
    view.camY = clamp(view.camY, totalHeight * 0.28, totalHeight * 0.76)
    view.targetCamY = view.camY
    view.targetYaw = clamp(view.targetYaw, -0.55, 0.55)
    updateCamera()
  }

  function updateCamera() {
    camera.position.set(
      Math.sin(view.yaw) * view.dist,
      view.camY + Math.sin(view.pitch) * view.dist * 0.24,
      Math.cos(view.yaw) * view.dist,
    )
    camera.lookAt(0, view.centerY, 0)
  }

  function resize() {
    const rect = host.getBoundingClientRect()
    const width = Math.max(1, Math.round(rect.width || 0))
    const height = Math.max(1, Math.round(rect.height || 0))
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    fitCamera()
  }

  function detachFlap(mesh) {
    const flap = mesh.userData.flap
    if (!flap) return
    mesh.remove(flap)
    flap.traverse((object) => {
      object.geometry?.dispose?.()
      const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : []
      for (const material of materials) material.dispose?.()
    })
    mesh.userData.flap = null
    mesh.userData.fan = null
  }

  function setBoxCoverOpen(mesh, open) {
    const materials = mesh.material
    if (!Array.isArray(materials) || !mesh.userData.pageMaterial) return
    if (open) {
      if (!mesh.userData.savedCoverMaterial) mesh.userData.savedCoverMaterial = materials[0]
      materials[0] = mesh.userData.pageMaterial
    } else if (mesh.userData.savedCoverMaterial) {
      materials[0] = mesh.userData.savedCoverMaterial
      mesh.userData.savedCoverMaterial = null
    }
  }

  function attachFlap(mesh) {
    if (mesh.userData.flap) return
    const params = mesh.geometry?.parameters || {}
    const thickness = params.width || 0.3
    const height = params.height || 1.7
    const depth = params.depth || 0.9
    const group = new Group()
    group.position.set(thickness / 2 + 0.004, 0, depth / 2)
    const coverMaterial = new MeshStandardMaterial({
      map: mesh.userData.coverMaterial.map, roughness: 0.58, metalness: 0.02, side: DoubleSide,
    })
    const pageMaterial = new MeshStandardMaterial({ color: 0xe9dfc8, roughness: 0.94, metalness: 0, side: DoubleSide })
    const cover = new Mesh(new PlaneGeometry(depth, height), coverMaterial)
    cover.rotation.y = Math.PI / 2
    cover.position.z = -depth / 2
    cover.castShadow = true
    group.add(cover)
    const fan = []
    for (let index = 1; index <= 2; index += 1) {
      const pivot = new Group()
      const page = new Mesh(new PlaneGeometry(depth * 0.97, height * 0.97), pageMaterial)
      page.rotation.y = Math.PI / 2
      page.position.z = -depth / 2
      pivot.add(page)
      group.add(pivot)
      fan.push(pivot)
    }
    group.rotation.y = 0
    mesh.add(group)
    mesh.userData.flap = group
    mesh.userData.fan = fan
    mesh.userData.flapAngle = 0
    mesh.userData.coverOpenAt = 0
    setBoxCoverOpen(mesh, true)
  }

  function projectToScreen(points, matrix) {
    const rect = host.getBoundingClientRect()
    const projected = points.map(([x, y, z]) => new Vector3(x, y, z).applyMatrix4(matrix).project(camera))
    const xs = projected.map((point) => (point.x * 0.5 + 0.5) * rect.width + rect.left)
    const ys = projected.map((point) => (-point.y * 0.5 + 0.5) * rect.height + rect.top)
    return {
      left: Math.min(...xs),
      top: Math.min(...ys),
      width: Math.max(1, Math.max(...xs) - Math.min(...xs)),
      height: Math.max(1, Math.max(...ys) - Math.min(...ys)),
    }
  }

  function coverScreenRect(mesh) {
    if (!mesh) return null
    mesh.updateMatrixWorld(true)
    const flapCover = mesh.userData.flap?.children?.[0]
    if (flapCover) {
      const size = flapCover.geometry?.parameters || {}
      const halfWidth = (size.width || 1) / 2
      const halfHeight = (size.height || 1) / 2
      return projectToScreen([
        [-halfWidth, halfHeight, 0], [halfWidth, halfHeight, 0],
        [-halfWidth, -halfHeight, 0], [halfWidth, -halfHeight, 0],
      ], flapCover.matrixWorld)
    }
    const params = mesh.geometry?.parameters || {}
    const thickness = params.width || 0.3
    const height = params.height || 1.7
    const depth = params.depth || 0.9
    return projectToScreen([
      [thickness / 2, height / 2, depth / 2], [thickness / 2, height / 2, -depth / 2],
      [thickness / 2, -height / 2, depth / 2], [thickness / 2, -height / 2, -depth / 2],
    ], mesh.matrixWorld)
  }

  function openNow(mesh) {
    if (!mesh || mesh.userData.opened) return
    mesh.userData.opened = true
    if (typeof options.onOpen === 'function') options.onOpen(mesh.userData.book, { rect: coverScreenRect(mesh) })
  }

  function clearSelection() {
    if (!state.selected) return
    const mesh = state.selected
    detachFlap(mesh)
    setBoxCoverOpen(mesh, false)
    mesh.userData.selected = false
    mesh.userData.opened = false
    mesh.userData.openAt = 0
    mesh.userData.coverOpenAt = 0
    mesh.userData.flapAngle = 0
    state.selected = null
  }

  function selectBook(mesh) {
    if (!mesh) return
    if (state.selected === mesh) { openNow(mesh); return }
    clearSelection()
    state.selected = mesh
    mesh.userData.selected = true
    mesh.userData.opened = false
    mesh.userData.coverOpenAt = performance.now() + (reduced ? 0 : 150)
    mesh.userData.openAt = performance.now() + (reduced ? 0 : 640)
    attachFlap(mesh)
    if (reduced) later(() => openNow(mesh), 0)
  }

  function pick(event) {
    const rect = renderer.domElement.getBoundingClientRect()
    pointer.x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1
    pointer.y = -((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1
    raycaster.setFromCamera(pointer, camera)
    return raycaster.intersectObjects(bookMeshes, false)[0]?.object || null
  }

  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return
    drag.active = true
    drag.id = event.pointerId
    drag.x = event.clientX
    drag.y = event.clientY
    drag.yaw = view.targetYaw
    drag.pitch = view.targetPitch
    drag.moved = false
    renderer.domElement.setPointerCapture?.(event.pointerId)
    renderer.domElement.style.cursor = 'grabbing'
  }

  function onPointerMove(event) {
    if (drag.active && drag.id === event.pointerId) {
      const dx = event.clientX - drag.x
      const dy = event.clientY - drag.y
      if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true
      view.targetYaw = clamp(drag.yaw + dx * 0.0045, -0.55, 0.55)
      view.targetPitch = clamp(drag.pitch - dy * 0.0018, -0.12, 0.22)
      return
    }
    const hit = pick(event)
    state.hovered = hit
    renderer.domElement.style.cursor = hit ? 'pointer' : 'grab'
  }

  function onPointerUp(event) {
    if (!drag.active || drag.id !== event.pointerId) return
    const wasMoved = drag.moved
    drag.active = false
    drag.id = null
    renderer.domElement.style.cursor = 'grab'
    if (wasMoved) return
    const hit = pick(event)
    if (hit) selectBook(hit)
    else clearSelection()
  }

  function onWheel(event) {
    event.preventDefault()
    view.targetCamY = clamp(view.targetCamY + event.deltaY * 0.0032, totalHeight * 0.26, totalHeight * 0.78)
  }

  function onContextLost(event) {
    event.preventDefault()
    options.onError?.(new Error('WebGL 上下文丢失，已切换到列表。'))
  }

  function frame(time) {
    if (state.disposed) return
    frameHandle = window.requestAnimationFrame(frame)
    const dt = Math.min(0.05, Math.max(0.001, (time - lastFrame) / 1000 || 0.016))
    lastFrame = time
    if (!reduced) {
      view.yaw = damp(view.yaw, view.targetYaw, 7, dt)
      view.pitch = damp(view.pitch, view.targetPitch, 7, dt)
      view.camY = damp(view.camY, view.targetCamY, 6, dt)
    } else {
      view.yaw = view.targetYaw
      view.pitch = view.targetPitch
      view.camY = view.targetCamY
    }
    updateCamera()
    for (const mesh of bookMeshes) {
      const data = mesh.userData
      const selected = state.selected === mesh
      const hovered = state.hovered === mesh && !selected
      const targetZ = data.baseZ + (selected ? 0.35 : hovered ? 0.06 : 0)
      const targetY = data.baseY + (selected ? 0.14 : 0)
      const targetScale = selected ? 1.05 : hovered ? 1.015 : 1
      const targetRotY = selected ? -Math.PI / 2 : data.baseRotY
      if (reduced) {
        mesh.position.z = targetZ
        mesh.position.y = targetY
        mesh.scale.setScalar(targetScale)
        mesh.rotation.y = targetRotY
      } else {
        mesh.position.z = damp(mesh.position.z, targetZ, 10, dt)
        mesh.position.y = damp(mesh.position.y, targetY, 10, dt)
        const scale = damp(mesh.scale.x, targetScale, 10, dt)
        mesh.scale.setScalar(scale)
        mesh.rotation.y = damp(mesh.rotation.y, targetRotY, 9, dt)
      }
      const flapTarget = selected && data.coverOpenAt && performance.now() >= data.coverOpenAt ? 0.62 : 0
      if (data.flap) {
        data.flapAngle = reduced ? flapTarget : damp(data.flapAngle || 0, flapTarget, 8, dt)
        data.flap.rotation.y = data.flapAngle
        if (data.fan) {
          data.fan.forEach((pivot, index) => { pivot.rotation.y = data.flapAngle * (0.34 + index * 0.22) })
        }
      }
      if (selected && data.openAt && !data.opened && performance.now() >= data.openAt) {
        openNow(mesh)
      }
    }
    if (dust) {
      dust.rotation.y = Math.sin(time * 0.00008) * 0.08
      dust.position.y = Math.sin(time * 0.00013) * 0.06
    }
    renderer.render(scene, camera)
  }

  async function loadCovers() {
    if (typeof options.coverLoader !== 'function') return
    const run = ++coverRun
    const list = bookMeshes.slice(0, 48)
    let cursor = 0
    const worker = async () => {
      while (cursor < list.length) {
        if (run !== coverRun || state.disposed) return
        const mesh = list[cursor]
        cursor += 1
        if (!mesh.userData.book?.coverUrl) continue
        try {
          const source = await options.coverLoader(mesh.userData.book)
          if (!source || run !== coverRun || state.disposed) continue
          const texture = await loadTexture(source)
          if (run !== coverRun || state.disposed) { texture.dispose(); return }
          const material = mesh.userData.coverMaterial
          const old = material.map
          material.map = texture
          material.color.set(0xffffff)
          material.needsUpdate = true
          old?.dispose()
        } catch {
          /* keep the procedural cover */
        }
      }
    }
    await Promise.all([worker(), worker(), worker()])
  }

  function booksSignature(list) {
    return list.map((book) => [book?.id || book?.bookId || book?.name || '', book?.name || book?.title || '', book?.unread || 0].join(':')).join('|')
  }

  function setBooks(books) {
    const list = Array.isArray(books) ? books.slice() : []
    const signature = booksSignature(list)
    if (signature === booksSignatureValue) return
    booksSignatureValue = signature
    state.books = list
    buildShelf()
  }

  function setTheme(theme) {
    if (!PALETTES[theme] || theme === state.theme) return
    state.theme = theme
    palette = PALETTES[theme]
    scene.background = new Color(palette.scene)
    scene.fog.color = new Color(palette.scene)
    hemi.color = new Color(palette.sky)
    hemi.groundColor = new Color(palette.ground)
    fill.color = new Color(palette.fill)
    glow.color = new Color(palette.fill)
    buildShelf()
  }

  function setQuality(quality) {
    state.quality = quality || 'auto'
    renderer.setPixelRatio(clamp(window.devicePixelRatio || 1, 1, state.quality === 'low' ? 1.25 : 2))
    renderer.shadowMap.enabled = !reduced && state.quality !== 'low'
    resize()
    if (dust) dust.visible = state.ambience === 'full' && state.quality !== 'low'
  }

  function setAmbience(mode) {
    state.ambience = ['full', 'paper', 'off'].includes(mode) ? mode : 'full'
    if (state.ambience === 'full') {
      if (!dust) addDust()
      if (dust) dust.visible = state.quality !== 'low'
      return
    }
    if (!dust) return
    shelf.remove(dust)
    dustGeometry?.dispose()
    dustMaterial?.dispose()
    dust = null
  }

  function focusBook(bookId) {
    const mesh = bookMeshes.find((item) => String(item.userData.book?.id || item.userData.book?.bookId) === String(bookId))
    if (mesh) selectBook(mesh)
  }

  renderer.domElement.addEventListener('pointerdown', onPointerDown)
  renderer.domElement.addEventListener('pointermove', onPointerMove)
  renderer.domElement.addEventListener('pointerup', onPointerUp)
  renderer.domElement.addEventListener('pointercancel', onPointerUp)
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false })
  renderer.domElement.addEventListener('webglcontextlost', onContextLost)
  const observer = new ResizeObserver(resize)
  observer.observe(host)
  resize()
  buildShelf()
  frameHandle = window.requestAnimationFrame(frame)

  function snapshot() {
    try {
      renderer.render(scene, camera)
      return renderer.domElement.toDataURL('image/png')
    } catch {
      return ''
    }
  }

  const shelfStats = () => ({
    dust: dust && dust.geometry?.attributes?.position ? dust.geometry.attributes.position.count : 0,
    ambience: state.ambience,
    quality: state.quality,
    books: bookMeshes.length,
  })
  host.__mrShelf = { stats: shelfStats }

  return {
    setBooks,
    setTheme,
    setQuality,
    setAmbience,
    focusBook,
    resize,
    snapshot,
    dispose() {
      if (state.disposed) return
      state.disposed = true
      coverRun += 1
      for (const timer of timers) window.clearTimeout(timer)
      timers.clear()
      window.cancelAnimationFrame(frameHandle)
      observer.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      renderer.domElement.removeEventListener('pointercancel', onPointerUp)
      renderer.domElement.removeEventListener('wheel', onWheel)
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
      clearShelf()
      dustGeometry?.dispose()
      dustMaterial?.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      if (host.__mrShelf && host.__mrShelf.stats === shelfStats) delete host.__mrShelf
    },
  }

  function clearShelf() {
    clearSelection()
    state.hovered = null
    for (const part of shelfParts) shelf.remove(part)
    for (const mesh of bookMeshes) shelf.remove(mesh)
    for (const part of shelfParts) disposeObject(part)
    for (const mesh of bookMeshes) disposeObject(mesh)
    shelfParts.length = 0
    bookMeshes.length = 0
    for (const material of woodMaterials) material.dispose()
    for (const material of darkMaterials) material.dispose()
    woodMaterials.length = 0
    darkMaterials.length = 0
    if (dust) {
      shelf.remove(dust)
      dustGeometry?.dispose()
      dustMaterial?.dispose()
      dust = null
    }
  }
}

const AMBIENCE_PALETTES = {
  paper: { ink: 0x453a2b, light: 0xfff1d3, dust: 0xd8c6a2 },
  light: { ink: 0x333834, light: 0xffffff, dust: 0xd8dad4 },
  green: { ink: 0x2f4436, light: 0xeaf6e3, dust: 0xc2dcc4 },
  dark: { ink: 0xdfe5e0, light: 0x93ab9c, dust: 0xa7bcae },
}

const AMBIENCE_VERTEX = [
  'varying vec2 vUv;',
  'void main() {',
  '  vUv = uv;',
  '  gl_Position = vec4(position.xy, 0.0, 1.0);',
  '}',
].join('\n')

const AMBIENCE_LIGHT_FRAGMENT = [
  'precision mediump float;',
  'varying vec2 vUv;',
  'uniform float uProgress;',
  'uniform vec3 uColor;',
  'uniform float uOpacity;',
  'void main() {',
  '  float band = smoothstep(0.46, 0.0, abs(vUv.y - uProgress));',
  '  float edge = smoothstep(0.0, 0.24, min(vUv.y, 1.0 - vUv.y));',
  '  gl_FragColor = vec4(uColor, band * uOpacity * edge);',
  '}',
].join('\n')

const AMBIENCE_SEAM_FRAGMENT = [
  'precision mediump float;',
  'varying vec2 vUv;',
  'uniform float uSeam;',
  'uniform float uSeamX;',
  'uniform vec3 uColor;',
  'void main() {',
  '  float band = smoothstep(0.18, 0.0, abs(vUv.x - uSeamX));',
  '  gl_FragColor = vec4(uColor, band * uSeam * 0.38);',
  '}',
].join('\n')

function ambiencePaperCanvas(document) {
  const size = 512
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  for (let index = 0; index < 900; index += 1) {
    const x = Math.random() * size
    const y = Math.random() * size
    const length = 8 + Math.random() * 26
    const angle = Math.random() * Math.PI
    ctx.strokeStyle = 'rgba(255,255,255,' + (0.03 + Math.random() * 0.05).toFixed(3) + ')'
    ctx.lineWidth = 0.6 + Math.random() * 0.8
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length)
    ctx.stroke()
  }
  for (let index = 0; index < 1400; index += 1) {
    ctx.fillStyle = 'rgba(255,255,255,' + (0.02 + Math.random() * 0.06).toFixed(3) + ')'
    ctx.fillRect(Math.random() * size, Math.random() * size, 1, 1)
  }
  for (let index = 0; index < 18; index += 1) {
    const x = Math.random() * size
    const y = Math.random() * size
    const radius = 40 + Math.random() * 90
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius)
    gradient.addColorStop(0, 'rgba(255,255,255,0.035)')
    gradient.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fill()
  }
  return canvas
}

function ambienceDustSprite(document) {
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 32
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16)
  gradient.addColorStop(0, 'rgba(255,255,255,0.9)')
  gradient.addColorStop(0.45, 'rgba(255,255,255,0.35)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 32, 32)
  return canvas
}

function dustCountFor(quality) {
  return quality === 'low' ? 48 : quality === 'high' ? 120 : 88
}

export function mountAmbience(host, options = {}) {
  if (!host || typeof host.appendChild !== 'function') throw new Error('mountAmbience requires a DOM host')
  const document = host.ownerDocument
  const window = document.defaultView
  const clampValue = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value))
  const dampValue = (current, target, lambda, dt) => current + (target - current) * (1 - Math.exp(-lambda * dt / 1000))
  const state = {
    theme: options.theme || 'paper',
    quality: options.quality || 'auto',
    ambience: options.ambience || 'full',
    still: Boolean(options.reducedMotion),
    paused: false,
    disposed: false,
    frames: 0,
    ema: 0,
  }
  let palette = AMBIENCE_PALETTES[state.theme] || AMBIENCE_PALETTES.paper

  const renderer = new WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'low-power' })
  renderer.setClearAlpha(0)
  renderer.setPixelRatio(clampValue(window.devicePixelRatio || 1, 1, state.quality === 'low' ? 1.25 : 2))
  renderer.domElement.className = 'mr-ambience-canvas'
  renderer.domElement.setAttribute('aria-hidden', 'true')
  host.appendChild(renderer.domElement)

  const scene = new Scene()
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
  camera.position.z = 1

  const paperTexture = ambiencePaperCanvas(document)
  const paperMaterial = new MeshBasicMaterial({
    color: new Color(palette.ink),
    map: paperTexture ? new CanvasTexture(paperTexture) : null,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  })
  if (paperMaterial.map) {
    paperMaterial.map.wrapS = paperMaterial.map.wrapT = RepeatWrapping
    paperMaterial.map.repeat.set(2, 3)
  }
  const paper = new Mesh(new PlaneGeometry(2, 2), paperMaterial)
  scene.add(paper)

  const lightMaterial = new ShaderMaterial({
    uniforms: {
      uProgress: { value: 0.5 },
      uColor: { value: new Color(palette.light) },
      uOpacity: { value: 0.16 },
    },
    vertexShader: AMBIENCE_VERTEX,
    fragmentShader: AMBIENCE_LIGHT_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  })
  const light = new Mesh(new PlaneGeometry(2, 2), lightMaterial)
  light.position.z = 0.01
  scene.add(light)

  const seamMaterial = new ShaderMaterial({
    uniforms: {
      uSeam: { value: 0 },
      uSeamX: { value: 0.5 },
      uColor: { value: new Color(palette.ink) },
    },
    vertexShader: AMBIENCE_VERTEX,
    fragmentShader: AMBIENCE_SEAM_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  })
  const seam = new Mesh(new PlaneGeometry(2, 2), seamMaterial)
  seam.position.z = 0.02
  scene.add(seam)

  const dustSprite = ambienceDustSprite(document)
  const dustMaterial = new PointsMaterial({
    color: new Color(palette.dust),
    size: 2.2,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    map: dustSprite ? new CanvasTexture(dustSprite) : null,
  })
  let dustGeometry = null
  let dustPositions = null
  let dustSpeeds = null
  let dust = null

  function rebuildDust(count) {
    if (dust) {
      scene.remove(dust)
      dustGeometry?.dispose()
      dust = null
    }
    dustGeometry = null
    dustPositions = null
    dustSpeeds = null
    if (state.still || state.ambience !== 'full' || count <= 0) return
    dustPositions = new Float32Array(count * 3)
    dustSpeeds = new Float32Array(count)
    for (let index = 0; index < count; index += 1) {
      dustPositions[index * 3] = Math.random() * 2 - 1
      dustPositions[index * 3 + 1] = Math.random() * 2 - 1
      dustPositions[index * 3 + 2] = 0
      dustSpeeds[index] = 0.00004 + Math.random() * 0.00008
    }
    dustGeometry = new BufferGeometry()
    dustGeometry.setAttribute('position', new BufferAttribute(dustPositions, 3))
    dust = new Points(dustGeometry, dustMaterial)
    scene.add(dust)
  }

  const stats = { frames: 0, ema: 0, paused: false, mode: state.ambience, quality: state.quality }
  host.__mrAmbience = stats

  let frameHandle = 0
  let lastTime = 0
  let targetProgress = 0.5
  let progress = 0.5
  let targetSeam = 0
  let seamStrength = 0

  function size() {
    const width = Math.max(1, host.clientWidth || 1)
    const height = Math.max(1, host.clientHeight || 1)
    renderer.setSize(width, height, false)
  }

  function renderOnce() {
    renderer.render(scene, camera)
  }

  function degrade() {
    state.quality = 'low'
    stats.quality = 'low'
    renderer.setPixelRatio(clampValue(window.devicePixelRatio || 1, 1, 1.25))
    size()
    rebuildDust(dustCountFor('low'))
    renderOnce()
  }

  function tick(now) {
    if (state.disposed || state.paused) return
    const dt = lastTime ? Math.min(64, now - lastTime) : 16
    lastTime = now
    progress = dampValue(progress, targetProgress, 6, dt)
    seamStrength = dampValue(seamStrength, targetSeam, 7, dt)
    lightMaterial.uniforms.uProgress.value = progress
    seamMaterial.uniforms.uSeam.value = seamStrength
    if (dust && dustPositions && dustSpeeds) {
      for (let index = 0; index < dustSpeeds.length; index += 1) {
        const offset = index * 3
        dustPositions[offset + 1] -= dustSpeeds[index] * dt
        dustPositions[offset] += Math.sin((now * 0.00012) + index) * 0.000012 * dt
        if (dustPositions[offset + 1] < -1) {
          dustPositions[offset + 1] = 1
          dustPositions[offset] = Math.random() * 2 - 1
        }
      }
      dust.geometry.attributes.position.needsUpdate = true
      dust.rotation.z = Math.sin(now * 0.00005) * 0.004
    }
    renderer.render(scene, camera)
    state.frames += 1
    stats.frames = state.frames
    state.ema = state.ema ? state.ema * 0.92 + dt * 0.08 : dt
    stats.ema = Math.round(state.ema * 100) / 100
    if (state.quality === 'auto' && state.frames === 90 && state.ema > 20) degrade()
    frameHandle = window.requestAnimationFrame(tick)
  }

  function start() {
    if (state.disposed || state.paused || state.still || state.ambience === 'off') return
    if (frameHandle) return
    lastTime = 0
    frameHandle = window.requestAnimationFrame(tick)
  }

  function stop() {
    if (frameHandle) window.cancelAnimationFrame(frameHandle)
    frameHandle = 0
  }

  function applyAmbience() {
    const mode = state.ambience
    paper.visible = mode !== 'off'
    light.visible = mode === 'full'
    seam.visible = mode !== 'off'
    stats.mode = mode
    if (mode === 'full') {
      if (!dust) rebuildDust(dustCountFor(state.quality))
    } else {
      rebuildDust(0)
    }
    renderOnce()
  }

  function setAmbience(mode) {
    state.ambience = ['full', 'paper', 'off'].includes(mode) ? mode : 'full'
    if (state.ambience === 'off') {
      state.paused = true
      stats.paused = true
      stop()
    }
    applyAmbience()
    if (state.ambience !== 'off' && !state.paused && !state.still) start()
  }

  function setTheme(theme) {
    if (!AMBIENCE_PALETTES[theme] || theme === state.theme) return
    state.theme = theme
    palette = AMBIENCE_PALETTES[theme]
    paperMaterial.color = new Color(palette.ink)
    lightMaterial.uniforms.uColor.value = new Color(palette.light)
    seamMaterial.uniforms.uColor.value = new Color(palette.ink)
    dustMaterial.color = new Color(palette.dust)
    renderOnce()
  }

  function setQuality(quality) {
    state.quality = ['auto', 'high', 'low'].includes(quality) ? quality : 'auto'
    stats.quality = state.quality
    renderer.setPixelRatio(clampValue(window.devicePixelRatio || 1, 1, state.quality === 'low' ? 1.25 : 2))
    size()
    rebuildDust(dustCountFor(state.quality))
    renderOnce()
  }

  const onLost = (event) => {
    event.preventDefault()
    host.dataset.ambienceError = 'lost'
  }
  renderer.domElement.addEventListener('webglcontextlost', onLost)
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
  const observer = new ResizeObserver(() => { size(); renderOnce() })
  observer.observe(host)

  size()
  rebuildDust(dustCountFor(state.quality))
  applyAmbience()
  renderOnce()
  start()

  return {
    setTheme,
    setQuality,
    setAmbience,
    setProgress(value) {
      targetProgress = clampValue(Number(value) || 0, 0, 1)
    },
    setSeam(value, seamX = 0.5) {
      targetSeam = clampValue(Number(value) || 0, 0, 1)
      seamMaterial.uniforms.uSeamX.value = clampValue(seamX, 0, 1)
    },
    pause() {
      if (state.paused) return
      state.paused = true
      stats.paused = true
      stop()
    },
    resume() {
      if (!state.paused) return
      if (state.disposed || state.still || state.ambience === 'off') return
      state.paused = false
      stats.paused = false
      start()
    },
    dispose() {
      if (state.disposed) return
      state.disposed = true
      stop()
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      renderer.domElement.removeEventListener('webglcontextlost', onLost)
      rebuildDust(0)
      paperTexture?.dispose?.()
      paperMaterial.dispose()
      lightMaterial.dispose()
      seamMaterial.dispose()
      dustMaterial.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      if (host.__mrAmbience === stats) delete host.__mrAmbience
    },
  }
}

export function mountCurl(host, options = {}) {
  const { canvas, width, height, direction = 1, duration = 680, onDone, onError } = options
  if (!host || !canvas) throw new Error('mountCurl requires a host and a page canvas')
  const pageWidth = Math.max(1, Number(width) || canvas.width || 1)
  const pageHeight = Math.max(1, Number(height) || canvas.height || 1)
  const aspect = pageWidth / pageHeight
  const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.setSize(pageWidth, pageHeight, false)
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = SRGBColorSpace
  const dom = renderer.domElement
  dom.className = 'mr-curl-overlay'
  dom.style.width = '100%'
  dom.style.height = '100%'
  host.appendChild(dom)

  const scene = new Scene()
  const camera = new OrthographicCamera(-aspect, aspect, 1, -1, 0.1, 10)
  camera.position.z = 3
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.generateMipmaps = false
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    uniforms: {
      uMap: { value: texture },
      uProgress: { value: 0 },
      uDirection: { value: direction < 0 ? -1 : 1 },
      uAspect: { value: aspect },
      uFade: { value: 1 },
    },
    vertexShader: `
      uniform float uProgress;
      uniform float uDirection;
      uniform float uAspect;
      varying vec2 vUv;
      varying float vShade;
      void main() {
        vUv = uv;
        vec3 p = position;
        float front = uDirection > 0.0 ? 1.0 - uProgress * 1.22 : uProgress * 1.22 - 0.22;
        float d = (uv.x - front) * uDirection;
        vShade = 1.0;
        if (d > 0.30) {
          p.x = -100.0;
        } else if (d > 0.0) {
          float t = d / 0.30;
          float angle = t * 1.5708;
          float radius = 0.30 * uAspect;
          float frontX = (front - 0.5) * 2.0 * uAspect;
          p.x = frontX + uDirection * sin(angle) * radius;
          p.z = (1.0 - cos(angle)) * radius * 0.9;
          vShade = 0.70 + 0.30 * cos(angle);
        }
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform float uFade;
      varying vec2 vUv;
      varying float vShade;
      void main() {
        vec4 color = texture2D(uMap, vUv);
        gl_FragColor = vec4(color.rgb * vShade, color.a * uFade);
      }
    `,
  })
  const geometry = new PlaneGeometry(2 * aspect, 2, 120, 24)
  const mesh = new Mesh(geometry, material)
  scene.add(mesh)

  let disposed = false
  let frame = 0
  const started = performance.now()
  const finish = (reason = 'done') => {
    if (disposed) return
    disposed = true
    cancelAnimationFrame(frame)
    try { renderer.dispose() } catch {}
    try { geometry.dispose() } catch {}
    try { material.dispose() } catch {}
    try { texture.dispose() } catch {}
    dom.remove()
    onDone?.()
  }
  const tick = () => {
    if (disposed) return
    const raw = Math.min(1, Math.max(0, (performance.now() - started) / duration))
    const eased = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2
    material.uniforms.uProgress.value = eased
    material.uniforms.uFade.value = 1 - Math.max(0, (eased - 0.88) / 0.12)
    renderer.render(scene, camera)
    if (raw >= 1) { finish('end'); return }
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
  const onLost = (event) => {
    event.preventDefault()
    if (disposed) return
    disposed = true
    cancelAnimationFrame(frame)
    try { renderer.dispose() } catch {}
    dom.remove()
    onError?.(new Error('WebGL context lost'))
  }
  dom.addEventListener('webglcontextlost', onLost, { once: true })
  return {
    dispose() {
      if (disposed) return
      disposed = true
      cancelAnimationFrame(frame)
      try { renderer.dispose() } catch {}
      try { geometry.dispose() } catch {}
      try { material.dispose() } catch {}
      try { texture.dispose() } catch {}
      dom.remove()
    },
  }
}

export const VERSION = '0.1.0'
