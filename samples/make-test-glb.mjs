// Writes samples/star-test.glb: a yellow five-point star (plain material color) standing on a plate with a red / blue
// checker texture (an embedded PNG), and a small green cube (a second material). For checking model previews: colors,
// a texture, several materials. Run: node samples/make-test-glb.mjs
import { writeFileSync } from 'node:fs'
import { deflateSync, crc32 } from 'node:zlib'
import { fileURLToPath } from 'node:url'

// ---------- a small PNG (RGB, filter 0 rows) ----------
const png = (w, h, pixel) => {
  const rows = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y)
      const o = y * (w * 3 + 1) + 1 + x * 3
      rows[o] = r
      rows[o + 1] = g
      rows[o + 2] = b
    }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}
const checker = png(64, 64, (x, y) => ((x >> 3) + (y >> 3)) % 2 ? [220, 40, 40] : [40, 70, 220])

// ---------- geometry: flat-shaded triangles (positions, normals, optional uvs) ----------
const mesh = () => ({ p: [], n: [], uv: [] })
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = v => {
  const l = Math.hypot(...v) || 1
  return v.map(x => x / l)
}
const tri = (m, a, b, c, uvs) => {
  const n = unit(cross(sub(b, a), sub(c, a)))
  m.p.push(...a, ...b, ...c)
  m.n.push(...n, ...n, ...n)
  if (uvs) m.uv.push(...uvs.flat())
}
const quad = (m, a, b, c, d, uvs) => {
  tri(m, a, b, c, uvs && [uvs[0], uvs[1], uvs[2]])
  tri(m, a, c, d, uvs && [uvs[0], uvs[2], uvs[3]])
}

// the star: outline in the XY plane (standing up), extruded along Z, lifted above the plate
const star = mesh()
const outline = []
for (let i = 0; i < 10; i++) {
  const r = i % 2 ? 0.42 : 1
  const a = Math.PI / 2 + (i * Math.PI) / 5
  outline.push([r * Math.cos(a), 1.15 + r * Math.sin(a)])
}
const D = 0.15
for (let i = 0; i < 10; i++) {
  const [x0, y0] = outline[i]
  const [x1, y1] = outline[(i + 1) % 10]
  tri(star, [0, 1.15, D], [x0, y0, D], [x1, y1, D]) // front
  tri(star, [0, 1.15, -D], [x1, y1, -D], [x0, y0, -D]) // back
  quad(star, [x0, y0, D], [x0, y0, -D], [x1, y1, -D], [x1, y1, D]) // side
}

// the plate: a thin box, its top textured with the checker
const plate = mesh()
const S = 1.6
const T = 0.08
const top = [[-S, 0, S], [S, 0, S], [S, 0, -S], [-S, 0, -S]]
quad(plate, ...top, [[0, 0], [2, 0], [2, 2], [0, 2]])
quad(plate, [-S, -T, -S], [S, -T, -S], [S, -T, S], [-S, -T, S], [[0, 0], [0, 0], [0, 0], [0, 0]])
for (let i = 0; i < 4; i++) {
  const a = top[i]
  const b = top[(i + 1) % 4]
  quad(plate, [a[0], -T, a[2]], [b[0], -T, b[2]], b, a, [[0, 0], [0, 0], [0, 0], [0, 0]])
}

// a small green cube beside the star
const cube = mesh()
const box = (m, cx, cy, cz, h) => {
  const v = (x, y, z) => [cx + x * h, cy + y * h, cz + z * h]
  quad(m, v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1))
  quad(m, v(1, -1, -1), v(-1, -1, -1), v(-1, 1, -1), v(1, 1, -1))
  quad(m, v(-1, 1, 1), v(1, 1, 1), v(1, 1, -1), v(-1, 1, -1))
  quad(m, v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1))
  quad(m, v(1, -1, 1), v(1, -1, -1), v(1, 1, -1), v(1, 1, 1))
  quad(m, v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1), v(-1, 1, -1))
}
box(cube, 1.05, 0.3, 0.6, 0.3)

// ---------- glTF: one buffer, an accessor per attribute ----------
const bins = []
let offset = 0
const views = []
const accessors = []
const add = (floats, type, minmax) => {
  const buf = Buffer.from(new Float32Array(floats).buffer)
  views.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target: 34962 })
  bins.push(buf)
  offset += buf.length
  const comps = type === 'VEC3' ? 3 : 2
  const acc = { bufferView: views.length - 1, componentType: 5126, count: floats.length / comps, type }
  if (minmax) {
    acc.min = [0, 1, 2].map(k => Math.min(...floats.filter((_, i) => i % 3 === k)))
    acc.max = [0, 1, 2].map(k => Math.max(...floats.filter((_, i) => i % 3 === k)))
  }
  accessors.push(acc)
  return accessors.length - 1
}
const primitive = (m, material) => ({
  attributes: { POSITION: add(m.p, 'VEC3', true), NORMAL: add(m.n, 'VEC3'), ...(m.uv.length ? { TEXCOORD_0: add(m.uv, 'VEC2') } : {}) },
  material,
})
const meshes = [
  { name: 'star', primitives: [primitive(star, 0)] },
  { name: 'plate', primitives: [primitive(plate, 1)] },
  { name: 'cube', primitives: [primitive(cube, 2)] },
]
// the texture's PNG, 4-byte aligned after the vertex data
views.push({ buffer: 0, byteOffset: offset, byteLength: checker.length })
bins.push(checker)
offset += checker.length
const json = {
  asset: { version: '2.0', generator: 'claude-file-pane samples/make-test-glb.mjs' },
  scene: 0,
  scenes: [{ nodes: [0, 1, 2] }],
  nodes: meshes.map((_, i) => ({ mesh: i, name: meshes[i].name })),
  meshes,
  materials: [
    { name: 'yellow', pbrMetallicRoughness: { baseColorFactor: [1, 0.82, 0.1, 1], metallicFactor: 0, roughnessFactor: 0.45 } },
    { name: 'checker', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.8 } },
    { name: 'green', pbrMetallicRoughness: { baseColorFactor: [0.1, 0.8, 0.25, 1], metallicFactor: 0, roughnessFactor: 0.5 } },
  ],
  textures: [{ source: 0, sampler: 0 }],
  samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 10497, wrapT: 10497 }],
  images: [{ bufferView: views.length - 1, mimeType: 'image/png' }],
  bufferViews: views,
  accessors,
  buffers: [{ byteLength: 0 }],
}
const pad = (b, fill) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)])
const bin = pad(Buffer.concat(bins), 0)
json.buffers[0].byteLength = bin.length
const text = pad(Buffer.from(JSON.stringify(json)), 0x20)
const header = Buffer.alloc(12)
header.write('glTF', 0, 'latin1')
header.writeUInt32LE(2, 4)
header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8)
const head = (len, type) => {
  const b = Buffer.alloc(8)
  b.writeUInt32LE(len, 0)
  b.write(type, 4, 'latin1')
  return b
}
const out = process.argv[2] ?? fileURLToPath(new URL('./star-test.glb', import.meta.url)) // the helper test passes its temp folder
writeFileSync(out, Buffer.concat([header, head(text.length, 'JSON'), text, head(bin.length, 'BIN\0'), bin]))
console.log(`wrote ${out} (${12 + 16 + text.length + bin.length} bytes)`)
