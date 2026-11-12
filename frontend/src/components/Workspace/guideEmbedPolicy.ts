import type { GuideNode, GuideRender } from "../../utils/api/contract";

export const guideClasses = ["guide-card", "guide-grid-2", "guide-grid-3", "guide-tone-neutral", "guide-tone-info", "guide-tone-success", "guide-tone-warning", "guide-gradient-info", "guide-gradient-success", "guide-gradient-warning", "guide-button", "guide-button-secondary", "guide-compact", "guide-align-left", "guide-align-center", "guide-align-right"] as const;
const tags = new Set("section div p span h2 h3 h4 h5 h6 br hr strong em s mark small sub sup blockquote pre code ul ol li dl dt dd table caption thead tbody tfoot tr th td details summary a figure figcaption img".split(" "));
const identifier = /^[a-z][a-z0-9-]{0,63}$/;
const anchor = /^(?:section-[1-9]\d{0,4}|[a-z][a-z0-9-]{0,63}-heading-[1-9]\d{0,3})$/;
const file = /^file:file-[A-Za-z0-9_-]{1,100}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, low: number, high: number) => Number.isInteger(value) && Number(value) >= low && Number(value) <= high;
const unsafeCharacters = (value: string) => [...value].some(character => { const code = character.charCodeAt(0);return code <= 32 || code >= 127 && code <= 159 || character === "\\"; });

/** Defence in depth: never pass a supplied URL, tag or property straight into React. */
export function guideHref(href: string): boolean {
  if (href.length > 2048 || unsafeCharacters(href)) return false;
  if (href.startsWith("#")) return anchor.test(href.slice(1));
  let decoded: string;
  try { decoded = decodeURIComponent(href); } catch { return false; }
  if (unsafeCharacters(decoded) || /%[0-9a-f]{2}/i.test(decoded)) return false;
  if (href.startsWith("/")) {
    if (decoded.startsWith("//")) return false;
    const path = new URL(decoded, "https://guide.invalid").pathname.toLowerCase();
    return !/^\/(?:api|_storage)(?:\/|$)/.test(path) && !/%(?:2f|5c|2e)/i.test(decoded);
  }
  try { const url = new URL(href);return url.protocol === "https:" && !!url.hostname && !url.username && !url.password; } catch { return false; }
}

function validNode(value: unknown, depth: number, budget: { nodes: number; images: number }): value is GuideNode {
  if (!object(value) || Object.keys(value).sort().join() !== "attrs,children,tag,text" || typeof value.tag !== "string" || typeof value.text !== "string" || !object(value.attrs) || !Array.isArray(value.children)) return false;
  const { tag, attrs: a, children } = value;
  if (tag === "text") return !children.length && !Object.keys(a).length && value.text.length <= 32768;
  if (!tags.has(tag) || value.text !== "" || depth > 12 || ++budget.nodes > 1500) return false;
  const allowed = new Set(["classes"]);
  if (tag === "a") allowed.add("href");
  if (tag === "img") ["src", "alt", "width", "height"].forEach(key => allowed.add(key));
  if (/^h[2-6]$/.test(tag)) allowed.add("anchor");
  if (tag === "th" || tag === "td") ["colspan", "rowspan"].forEach(key => allowed.add(key));
  if (tag === "th") allowed.add("scope");
  if (tag === "ol") allowed.add("start");
  if (tag === "li") allowed.add("value");
  if (Object.keys(a).some(key => !allowed.has(key))) return false;
  if (a.classes !== undefined && (!Array.isArray(a.classes) || a.classes.length > 8 || a.classes.some(cls => !guideClasses.includes(cls)))) return false;
  if (tag === "a" && (typeof a.href !== "string" || !guideHref(a.href))) return false;
  if (/^h[2-6]$/.test(tag) && (typeof a.anchor !== "string" || !anchor.test(a.anchor))) return false;
  if (tag === "img" && (++budget.images > 20 || typeof a.src !== "string" || !file.test(a.src) || typeof a.alt !== "string" || !a.alt.trim() || a.alt.length > 500 || !integer(a.width, 1, 4096) || !integer(a.height, 1, 4096))) return false;
  if (a.scope !== undefined && !["row", "col", "rowgroup", "colgroup"].includes(String(a.scope))) return false;
  if (["colspan", "rowspan"].some(key => a[key] !== undefined && !integer(a[key], 1, 20))) return false;
  if (["start", "value"].some(key => a[key] !== undefined && !integer(a[key], -999, 9999))) return false;
  if (["img", "br", "hr"].includes(tag) && children.length) return false;
  return children.every(child => validNode(child, depth + 1, budget));
}

export function validGuideRender(value: unknown): value is GuideRender {
  if (!object(value) || value.schema_version !== 1 || value.policy_version !== 1 || typeof value.source_hash !== "string" || !/^[a-f0-9]{64}$/.test(value.source_hash) || !Array.isArray(value.blocks) || value.blocks.length > 20 || !Array.isArray(value.diagnostics) || value.diagnostics.length > 100 || !Array.isArray(value.file_ids) || value.file_ids.some(id => typeof id !== "string" || !file.test(`file:${id}`))) return false;
  const budget = { nodes: 0, images: 0 };
  return value.blocks.every(block => {
    if (!object(block) || typeof block.id !== "string" || !identifier.test(block.id) || typeof block.source !== "string" || block.source.length > 32768 || typeof block.text !== "string" || !Array.isArray(block.nodes)) return false;
    const before = { ...budget };
    return block.nodes.every(node => validNode(node, 1, budget)) && budget.nodes - before.nodes <= 300 && budget.images - before.images <= 4;
  }) && value.diagnostics.every(item => object(item) && (item.block_id === null || typeof item.block_id === "string") && integer(item.line, 0, 2000000) && typeof item.code === "string" && typeof item.message === "string");
}

export const guidePrefix = (materialId: string) => `guide-${encodeURIComponent(materialId).replace(/%/g, "_")}`;
