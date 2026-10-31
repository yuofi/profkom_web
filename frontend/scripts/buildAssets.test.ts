import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import type { ResolvedConfig } from "vite";
import { transform } from "lightningcss";
import { decodePng, downscale, encodePng, precompress, smallTeamLogos } from "./buildAssets";

const frontend = resolve(__dirname, "..");
let dir: string | undefined;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true });dir = undefined; });
// Vite's hooks are functions here (no { handler } objects).
type Hook = (...args: unknown[]) => unknown;
const hook = (plugin: object, name: string) => (plugin as Record<string, Hook>)[name];

it("PF-24: a logo is scaled down by area with its transparent edge kept in colour", () => {
  const size = 64, rgba = new Uint8Array(size * size * 4);
  // Left half opaque red, right half fully transparent black.
  for (let y = 0; y < size; y++) for (let x = 0; x < size / 2; x++) rgba.set([255, 0, 0, 255], (y * size + x) * 4);
  const decoded = decodePng(encodePng({ width: size, height: size, rgba, color: [] }))!;
  expect(decoded.rgba).toEqual(rgba);
  const small = downscale(decoded, 5);
  expect([small.width, small.height]).toEqual([5, 5]);
  const pixel = (x: number) => [...small.rgba.subarray(x * 4, x * 4 + 4)];
  expect(pixel(1)).toEqual([255, 0, 0, 255]);
  expect(pixel(4)[3]).toBe(0);
  // The column across the edge is half covered: still pure red (not darkened), half transparent.
  expect(pixel(2).slice(0, 3)).toEqual([255, 0, 0]);expect(Math.abs(pixel(2)[3] - 127.5)).toBeLessThan(1);
});

it("PF-24: the build ships a 192 px copy of a block logo and leaves the source alone", async () => {
  const id = join(frontend, "src/assets/team-logos/hr.png"), source = await readFile(id);
  const emitted: { name: string; source: Buffer }[] = [];
  const code = await hook(smallTeamLogos(), "load").call({ emitFile: (file: { name: string; source: Buffer }) => { emitted.push(file);return "ref1"; } }, id);
  expect(code).toBe('export default "__VITE_ASSET__ref1__"');
  expect(emitted[0].name).toBe("hr.png");
  const png = decodePng(emitted[0].source)!;
  expect([png.width, png.height]).toEqual([192, 192]);
  expect(emitted[0].source.length).toBeLessThan(source.length / 3);
  expect((await readFile(id)).equals(source)).toBe(true);
  // Other images are left to Vite.
  expect(await hook(smallTeamLogos(), "load").call({}, join(frontend, "public/nf-mobile-capy.webp"))).toBeNull();
});

it("PF-23: text assets of 1 kB and more get a .gz copy that nginx can send as is", async () => {
  dir = await mkdtemp(join(tmpdir(), "profkom-precompress-"));
  await mkdir(join(dir, "dist/assets"), { recursive: true });
  const script = "export const value = 1;\n".repeat(200);
  await writeFile(join(dir, "dist/assets/index-abc.js"), script);
  await writeFile(join(dir, "dist/assets/tiny-abc.js"), "export {};\n");
  await writeFile(join(dir, "dist/assets/logo-abc.png"), Buffer.alloc(4096));
  const plugin = precompress();
  hook(plugin, "configResolved")({ root: dir, build: { outDir: "dist" } } as unknown as ResolvedConfig);
  await hook(plugin, "closeBundle")();
  expect(gunzipSync(await readFile(join(dir, "dist/assets/index-abc.js.gz"))).toString()).toBe(script);
  await expect(readFile(join(dir, "dist/assets/tiny-abc.js.gz"))).rejects.toThrow();
  await expect(readFile(join(dir, "dist/assets/logo-abc.png.gz"))).rejects.toThrow();
});

it("PF-23: nginx sends the precompressed copies of static files only", async () => {
  const conf = await readFile(join(frontend, "nginx.conf"), "utf8");
  const blocks = [...conf.matchAll(/location ([^{]+)\{([^}]*)\}/g)].map(([, name, body]) => [name.trim(), body] as const);
  const statics = blocks.filter(([name]) => ["/", "/assets/", "~ ^/assets/.*\\.mjs$"].includes(name));
  expect(statics).toHaveLength(3);
  for (const [, body] of statics) expect(body).toMatch(/gzip_static on;/);
  for (const [, body] of blocks.filter(([name]) => name === "/api/" || name === "= /_storage")) expect(body).not.toMatch(/gzip/);
  expect(conf).not.toMatch(/http2/);
});

it("PF-03/PF-11: every rule of a CSS module is scoped by its own class, so a merged chunk styles nothing else", async () => {
  // Small chunks are merged into the entry (experimentalMinChunkSize): a bare `img { … }` of
  // the 404 page then reached every image of the site. Lightning CSS "pure" modules refuse a
  // rule without a local class or id.
  const modules = (await readdir(join(frontend, "src"), { recursive: true })).filter(file => file.endsWith(".module.css"));
  expect(modules.length).toBeGreaterThan(50);
  const unscoped: string[] = [];
  for (const file of modules) {
    const filename = join(frontend, "src", file);
    try { transform({ filename, code: await readFile(filename), cssModules: { pattern: "[name]_[local]_[hash]", pure: true } }); }
    catch (error) { const { message, loc } = error as { message: string; loc?: { line: number } };unscoped.push(`${file}:${loc?.line ?? "?"} ${message}`); }
  }
  expect(unscoped).toEqual([]);
  expect(() => transform({ filename: "Bare.module.css", code: Buffer.from(".page { color: red; }\nimg { width: 55%; }\n"), cssModules: { pure: true } })).toThrow(/class or ID/);
});
