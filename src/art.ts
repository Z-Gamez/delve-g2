// game-icons.net silhouettes -> lens-ready portraits.
//
// The lens is 16 shades of green on black, where black is "off" and reads as
// see-through. A flat white silhouette blooms into a green blob, so each icon
// is lit with a top-down gradient, framed by a dim ring, and dithered to the
// 16 levels (the SDK's own 4-bit conversion is then lossless on top of it).

import { ICONS, type IconName } from './icons.gen'

const LEVELS = 16
const cache = new Map<string, Promise<Uint8Array>>()

export interface ArtOptions {
  size: number
  /** Dimmed: the fallen, or a spent subject. */
  dim?: boolean
}

export function portrait(name: IconName, opts: ArtOptions): Promise<Uint8Array> {
  const key = `${name}|${opts.size}|${opts.dim ? 1 : 0}`
  let hit = cache.get(key)
  if (!hit) {
    hit = render(name, opts)
    cache.set(key, hit)
  }
  return hit
}

async function render(name: IconName, opts: ArtOptions): Promise<Uint8Array> {
  const { size } = opts
  const icon = ICONS[name] ?? ICONS['dice-twenty-faces-twenty']
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('no 2d context')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, size, size)

  // Frame: a dim ring, so the portrait reads as a portrait, not a stray shape.
  ctx.strokeStyle = opts.dim ? '#1c1c1c' : '#3a3a3a'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2)
  ctx.stroke()

  const inset = size * 0.14
  const scale = (size - inset * 2) / Math.max(icon.w, icon.h)
  const top = opts.dim ? 90 : 245
  const bottom = opts.dim ? 45 : 140
  ctx.save()
  ctx.translate(inset + ((size - inset * 2) - icon.w * scale) / 2, inset + ((size - inset * 2) - icon.h * scale) / 2)
  ctx.scale(scale, scale)
  // Lit from above: the gradient runs top to bottom in icon space.
  const g2 = ctx.createLinearGradient(0, 0, 0, icon.h)
  g2.addColorStop(0, `rgb(${top},${top},${top})`)
  g2.addColorStop(1, `rgb(${bottom},${bottom},${bottom})`)
  ctx.fillStyle = g2
  for (const d of icon.d) ctx.fill(new Path2D(d))
  ctx.restore()

  const img = ctx.getImageData(0, 0, size, size)
  const px = new Float32Array(size * size)
  for (let i = 0; i < px.length; i++) px[i] = img.data[i * 4]
  dither(px, size, size)
  for (let i = 0; i < px.length; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = px[i]
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return toPng(canvas)
}

/** In-place Floyd–Steinberg onto LEVELS evenly spaced greys. */
function dither(px: Float32Array, width: number, height: number): void {
  const step = 255 / (LEVELS - 1)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const old = px[i]
      const q = Math.max(0, Math.min(255, Math.round(old / step) * step))
      px[i] = q
      const err = old - q
      if (x + 1 < width) px[i + 1] += (err * 7) / 16
      if (y + 1 < height) {
        if (x > 0) px[i + width - 1] += (err * 3) / 16
        px[i + width] += (err * 5) / 16
        if (x + 1 < width) px[i + width + 1] += err / 16
      }
    }
  }
}

async function toPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  )
  return new Uint8Array(await blob.arrayBuffer())
}

/** The same icon as inline SVG, for the phone. */
export function iconSvg(name: IconName, cls = ''): string {
  const icon = ICONS[name] ?? ICONS['dice-twenty-faces-twenty']
  return `<svg class="${cls}" viewBox="0 0 ${icon.w} ${icon.h}" aria-hidden="true">${icon.d.map(d => `<path fill="currentColor" d="${d}"/>`).join('')}</svg>`
}
