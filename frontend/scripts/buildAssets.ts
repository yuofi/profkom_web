/**
 * Build-only asset steps (no dependencies beyond Node's zlib):
 * - precompressed .gz copies next to text assets for nginx `gzip_static` (PF-23);
 * - block logos scaled down from their 1024 px sources at build time (PF-24).
 * Source files in the repository are never changed.
 */
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { deflateSync, gzipSync, inflateSync, constants } from "node:zlib";
import type { Plugin } from "vite";

const COMPRESSIBLE = /\.(js|mjs|css|html|svg|json|txt|map|webmanifest)$/;

/** Every compressible file of at least 1 kB in the output gets a `.gz` copy when it is smaller. */
export function precompress(): Plugin {
  let outDir = "dist";
  return {
    name: "profkom:precompress",
    apply: "build",
    configResolved(config) { outDir = resolve(config.root, config.build.outDir); },
    async closeBundle() {
      const walk = async (dir: string): Promise<string[]> => (await Promise.all(
        (await readdir(dir, { withFileTypes: true }).catch(() => [])).map(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]),
      )).flat();
      for (const file of await walk(outDir)) {
        if (!COMPRESSIBLE.test(file) || (await stat(file)).size < 1024) continue;
        const source = await readFile(file), packed = gzipSync(source, { level: constants.Z_BEST_COMPRESSION });
        if (packed.length < source.length) await writeFile(`${file}.gz`, packed);
      }
    },
  };
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Buffer) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const head = Buffer.alloc(8), tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);head.write(type, 4, "latin1");
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}
function paeth(a: number, b: number, c: number) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

type Image = { width: number; height: number; rgba: Uint8Array; color: Buffer[] };

/** 8-bit RGB/RGBA, non-interlaced PNG; anything else returns null and is used as is. */
export function decodePng(file: Buffer): Image | null {
  if (!file.subarray(0, 8).equals(SIGNATURE)) return null;
  let offset = 8, width = 0, height = 0, channels = 0;
  const data: Buffer[] = [], color: Buffer[] = [];
  while (offset < file.length) {
    const length = file.readUInt32BE(offset), type = file.toString("latin1", offset + 4, offset + 8);
    const body = file.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);height = body.readUInt32BE(4);
      const [depth, colorType, , , interlace] = body.subarray(8);
      if (depth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) return null;
      channels = colorType === 6 ? 4 : 3;
    } else if (type === "IDAT") data.push(body);
    else if (["sRGB", "gAMA", "cHRM", "iCCP"].includes(type)) color.push(file.subarray(offset, offset + 12 + length));
    offset += 12 + length;
  }
  if (!width || !channels) return null;
  const raw = inflateSync(Buffer.concat(data)), stride = width * channels;
  const pixels = new Uint8Array(stride * height), rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], row = y * stride, src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[row + x - channels] : 0, b = y ? pixels[row - stride + x] : 0;
      const c = x >= channels && y ? pixels[row - stride + x - channels] : 0;
      const value = raw[src + x];
      pixels[row + x] = (filter === 0 ? value : filter === 1 ? value + a : filter === 2 ? value + b
        : filter === 3 ? value + ((a + b) >> 1) : value + paeth(a, b, c)) & 0xff;
    }
  }
  for (let i = 0, j = 0; i < width * height; i++, j += channels)
    rgba.set([pixels[j], pixels[j + 1], pixels[j + 2], channels === 4 ? pixels[j + 3] : 255], i * 4);
  return { width, height, rgba, color };
}

/** Area average over premultiplied alpha, so transparent edges keep their colour. */
export function downscale(image: Image, size: number): Image {
  const { width, height, rgba } = image;
  if (width <= size && height <= size) return image;
  const scale = Math.max(width, height) / size;
  const outW = Math.max(1, Math.round(width / scale)), outH = Math.max(1, Math.round(height / scale));
  const weights = (from: number, to: number) => Array.from({ length: to }, (_, i) => {
    const start = (i * from) / to, end = ((i + 1) * from) / to, taps: [number, number][] = [];
    for (let s = Math.floor(start); s < Math.ceil(end); s++) taps.push([s, Math.min(end, s + 1) - Math.max(start, s)]);
    return taps;
  });
  const premultiplied = new Float64Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const alpha = rgba[i * 4 + 3] / 255;
    premultiplied.set([rgba[i * 4] * alpha, rgba[i * 4 + 1] * alpha, rgba[i * 4 + 2] * alpha, alpha], i * 4);
  }
  const columns = weights(width, outW), rows = weights(height, outH);
  const wide = new Float64Array(outW * height * 4);
  for (let y = 0; y < height; y++) columns.forEach((taps, x) => {
    const total = taps.reduce((sum, [, w]) => sum + w, 0);
    for (const [s, w] of taps) for (let k = 0; k < 4; k++) wide[(y * outW + x) * 4 + k] += (premultiplied[(y * width + s) * 4 + k] * w) / total;
  });
  const out = new Uint8Array(outW * outH * 4);
  rows.forEach((taps, y) => {
    const total = taps.reduce((sum, [, w]) => sum + w, 0);
    for (let x = 0; x < outW; x++) {
      const px = [0, 0, 0, 0];
      for (const [s, w] of taps) for (let k = 0; k < 4; k++) px[k] += (wide[(s * outW + x) * 4 + k] * w) / total;
      const alpha = px[3], at = (y * outW + x) * 4;
      out[at + 3] = Math.round(alpha * 255);
      for (let k = 0; k < 3; k++) out[at + k] = alpha > 0 ? Math.min(255, Math.round(px[k] / alpha)) : 0;
    }
  });
  return { width: outW, height: outH, rgba: out, color: image.color };
}

/** RGBA PNG with the smallest per-row filter (sum of absolute differences heuristic). */
export function encodePng({ width, height, rgba, color }: Image): Buffer {
  const stride = width * 4, raw = Buffer.alloc((stride + 1) * height), candidate = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    let best = Infinity;
    for (let filter = 0; filter < 5; filter++) {
      let cost = 0;
      for (let x = 0; x < stride; x++) {
        const at = y * stride + x, value = rgba[at];
        const a = x >= 4 ? rgba[at - 4] : 0, b = y ? rgba[at - stride] : 0, c = x >= 4 && y ? rgba[at - stride - 4] : 0;
        const byte = (filter === 0 ? value : filter === 1 ? value - a : filter === 2 ? value - b
          : filter === 3 ? value - ((a + b) >> 1) : value - paeth(a, b, c)) & 0xff;
        candidate[x] = byte;cost += byte < 128 ? byte : 256 - byte;
      }
      if (cost < best) { best = cost;raw[y * (stride + 1)] = filter;candidate.copy(raw, y * (stride + 1) + 1); }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);header.writeUInt32BE(height, 4);header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), ...color,
    chunk("IDAT", deflateSync(raw, { level: constants.Z_BEST_COMPRESSION })), chunk("IEND", Buffer.alloc(0))]);
}

/** Block logos are drawn at 24–58 px (174 px on 3x phones): the build ships 192 px copies. */
export function smallTeamLogos(size = 192): Plugin {
  return {
    name: "profkom:small-team-logos",
    apply: "build",
    enforce: "pre",
    async load(id) {
      if (!/[\\/]src[\\/]assets[\\/]team-logos[\\/][^\\/?]+\.png$/.test(id)) return null;
      const source = await readFile(id), image = decodePng(source);
      if (!image) return null;
      const small = encodePng(downscale(image, size));
      if (small.length >= source.length) return null;
      const reference = this.emitFile({ type: "asset", name: basename(id), source: small });
      return `export default "__VITE_ASSET__${reference}__"`;
    },
  };
}
