// PF-03: cold loads of one origin; records the protocol of every response and the timings.
// Only the given origin is reachable: every other request (VK, fonts, analytics) is aborted.
// Usage: node h2_probe.mjs <origin> <out.json> [runs=5] [latencyMs=0] [cpu=1] [paths=/auth]
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { chromium } from "/Users/aleksmozhuhin/Documents/profkom_web/.local/env/tracker-node/node_modules/playwright/index.mjs";
const [origin, out, runs = "5", latency = "0", cpu = "1", paths = "/auth"] = process.argv.slice(2);
const loopback = /^https:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf03-probe-"));
const ctx = await chromium.launchPersistentContext(dir, {
  executablePath: "/Applications/Yandex.app/Contents/MacOS/Yandex", headless: true,
  viewport: { width: 1280, height: 900 }, locale: "ru-RU", timezoneId: "Europe/Moscow",
  ignoreHTTPSErrors: loopback,   // a self-signed local stand only; never for the real site
  args: ["--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-networking",
    "--disable-component-update", "--disable-domain-reliability", "--no-pings", "--disable-default-apps"] });
const blocked = [];
await ctx.route("**/*", (r) => { const u = r.request().url();
  if (u.startsWith(origin + "/") || u.startsWith("data:") || u.startsWith("blob:")) return r.continue();
  blocked.push(u.slice(0, 80)); return r.abort(); });
const page = await ctx.newPage(); const cdp = await ctx.newCDPSession(page);
await cdp.send("Network.enable");
await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
if (Number(latency) > 0) await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: Number(latency), downloadThroughput: 2_500_000, uploadThroughput: 1_000_000 });
if (Number(cpu) > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(cpu) });
const rows = [];
for (const p of paths.split(",")) for (let i = 0; i < Number(runs); i++) {
  await cdp.send("Network.clearBrowserCache");
  await page.goto("about:blank");
  await page.goto(origin + p, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);
  const m = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0];
    const res = performance.getEntriesByType("resource").filter((e) => e.name.startsWith(location.origin));
    const assets = res.filter((e) => !e.name.includes("/api/"));
    const protocols = {}; for (const e of [n, ...res]) protocols[e.nextHopProtocol || "?"] = (protocols[e.nextHopProtocol || "?"] || 0) + 1;
    return { doc: n.nextHopProtocol, protocols, dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd),
      assets: assets.length, lastAssetEnd: Math.round(Math.max(0, ...assets.map((e) => e.responseEnd))),
      api: res.length - assets.length };
  });
  rows.push({ path: p, run: i + 1, ...m });
  console.log(`${p} #${i + 1} doc=${m.doc} protocols=${JSON.stringify(m.protocols)} dcl=${m.dcl} load=${m.load} assets=${m.assets} lastAssetEnd=${m.lastAssetEnd} api=${m.api}`);
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
for (const p of paths.split(",")) { const r = rows.filter((x) => x.path === p);
  console.log(`MEDIAN ${p}: dcl=${median(r.map((x) => x.dcl))} load=${median(r.map((x) => x.load))} lastAssetEnd=${median(r.map((x) => x.lastAssetEnd))}`); }
fs.writeFileSync(out, JSON.stringify({ origin, latency, cpu, rows, blocked: [...new Set(blocked)] }, null, 1));
console.log(`blocked ${blocked.length} requests to other origins`);
await ctx.close(); fs.rmSync(dir, { recursive: true, force: true });
