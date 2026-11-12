import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent, Definition } from "mdast";
import type { GuideNode, MaterialText } from "../../utils/api/contract";
import type { JournalDocument, JournalRender } from "../../utils/api/journal";
import { guideHref, validGuideRender } from "./guideEmbedPolicy";
import { journalMarkdown } from "./journalMarkdown";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, fields: string) => Object.keys(value).sort().join(",") === fields.split(" ").sort().join(",");
const text = (value: unknown, max: number, required = false): value is string => typeof value === "string" && [...value].length <= max && (!required || !!value.trim());
const integer = (value: unknown, min: number, max: number) => Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
const identifier = /^[a-z][a-z0-9-]{0,63}$/;
const fileId = /^file-[A-Za-z0-9_-]{1,100}$/;
const byteLength = (value: string) => new TextEncoder().encode(value).length;
const list = (value: unknown, min: number, max: number): value is unknown[] => Array.isArray(value) && value.length >= min && value.length <= max;
const parser = unified().use(remarkParse).use(remarkGfm);
type References = { files: Set<string>; images: Set<string>; imageCount: number };

/** Only the format discriminant: malformed journal data must use the safe journal fallback. */
export const isJournalContent = (content: MaterialText | null | undefined) => content?.format === "journal-v1";

function markdown(body: string, sections: Set<string>, refs: References, legacy = false): boolean {
  const tree = parser.parse(body), definitions = new Map<string, Definition>();
  journalMarkdown({ source: body })(tree);
  const walk = (node: Root | RootContent, visit: (node: RootContent) => void) => {
    if (node.type !== "root") visit(node);
    if ("children" in node) node.children.forEach(child => walk(child as RootContent, visit));
  };
  walk(tree, node => { if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node); });
  let valid = true;
  const url = (value: string, image: boolean) => {
    if (value.startsWith("file:") && fileId.test(value.slice(5))) {
      refs.files.add(value.slice(5));
      if (image) { refs.images.add(value.slice(5));refs.imageCount++; }
      return;
    }
    if (image || !(value.startsWith("#") ? sections.has(value.slice(1)) || legacy && guideHref(value) : guideHref(value))) valid = false;
  };
  walk(tree, node => {
    if (node.type === "link" || node.type === "image") url(node.url, node.type === "image");
    if (node.type === "linkReference" || node.type === "imageReference") {
      const definition = definitions.get(node.identifier);
      if (definition) url(definition.url, node.type === "imageReference");
    }
    if (node.type === "code" && node.lang === "gallery") node.value.split("\n").filter(line => line.trim()).forEach(line => url(line.split("|", 1)[0].trim(), true));
  });
  return valid;
}

function validateDocument(value: unknown, refs: References): value is JournalDocument {
  if (!object(value) || !keys(value, "version eyebrow intro cover sections") || value.version !== 1 || !text(value.eyebrow, 120) || !text(value.intro, 1000) || !list(value.sections, 1, 20)) return false;
  const sections = new Set<string>(), ids = new Set<string>();
  for (const section of value.sections) {
    if (!object(section) || !keys(section, "id label title blocks") || typeof section.id !== "string" || !identifier.test(section.id) || ids.has(section.id) || !text(section.label, 120) || !text(section.title, 240, true) || !list(section.blocks, 1, 20)) return false;
    sections.add(section.id);ids.add(section.id);
  }
  const image = (item: Record<string, unknown>) => {
    if (typeof item.file_id !== "string" || !fileId.test(item.file_id) || !text(item.alt, 240, true) || !text(item.caption, 240) || !integer(item.width, 1, 4096) || !integer(item.height, 1, 4096)) return false;
    refs.files.add(item.file_id);refs.images.add(item.file_id);refs.imageCount++;return true;
  };
  const body = (value: unknown) => text(value, 8192) && markdown(value, sections, refs);
  if (!markdown(value.intro, sections, refs)) return false;
  if (value.cover !== null) {
    const cover = value.cover;
    if (!object(cover)) return false;
    if (cover.kind === "poster") {
      if (!keys(cover, "kind eyebrow title caption tone") || !text(cover.eyebrow, 120) || !text(cover.title, 240, true) || !text(cover.caption, 240) || !["yellow", "mint", "peach", "sky", "lilac"].includes(String(cover.tone))) return false;
    } else if (cover.kind !== "image" || !keys(cover, "kind file_id alt caption width height") || !image(cover)) return false;
  }
  let count = 0;
  for (const section of value.sections as Record<string, unknown>[]) {
    for (const block of section.blocks as unknown[]) {
      if (!object(block) || typeof block.id !== "string" || !identifier.test(block.id) || ids.has(block.id) || ++count > 60) return false;
      ids.add(block.id);
      switch (block.type) {
        case "text": if (!keys(block, "id type body") || !body(block.body)) return false;break;
        case "note": if (!keys(block, "id type tone title body") || !["neutral", "info", "success", "warning"].includes(String(block.tone)) || !text(block.title, 240) || !body(block.body)) return false;break;
        case "comparison": if (!keys(block, "id type before_label before after_label after") || !text(block.before_label, 120, true) || !text(block.after_label, 120, true) || !body(block.before) || !body(block.after)) return false;break;
        case "facts": if (!keys(block, "id type items") || !list(block.items, 2, 4) || !block.items.every(item => object(item) && keys(item, "label body") && text(item.label, 120, true) && body(item.body))) return false;break;
        case "steps": if (!keys(block, "id type items") || !list(block.items, 2, 6) || !block.items.every(item => object(item) && keys(item, "role title body") && text(item.role, 120) && text(item.title, 240, true) && body(item.body))) return false;break;
        case "image": if (!keys(block, "id type file_id alt caption width height collapsed") || typeof block.collapsed !== "boolean" || !image(block)) return false;break;
        case "disclosure": if (!keys(block, "id type title body") || !text(block.title, 240, true) || !body(block.body)) return false;break;
        case "switcher": {
          if (!keys(block, "id type title options") || !text(block.title, 240, true) || !list(block.options, 2, 4)) return false;
          const options = new Set<string>();
          for (const option of block.options) {
            if (!object(option) || !keys(option, "id label body") || typeof option.id !== "string" || !identifier.test(option.id) || options.has(option.id) || !text(option.label, 120, true) || !body(option.body)) return false;
            options.add(option.id);
          }
          break;
        }
        case "legacy": if (!keys(block, "id type body") || !text(block.body, 128 * 1024) || byteLength(block.body) > 128 * 1024) return false;break;
        default: return false;
      }
    }
  }
  return refs.imageCount <= 20;
}

export function validJournalDocument(value: unknown): value is JournalDocument {
  return validateDocument(value, { files: new Set(), images: new Set(), imageCount: 0 });
}

const equivalent = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => equivalent(value, right[index]));
  if (object(left) && object(right)) return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right, key) && equivalent(left[key], right[key]));
  return false;
};

/** Validate the finite tree, all deferred branches and source equality before React sees it. */
export function checkedJournalRender(content: MaterialText): JournalRender | null {
  const render: unknown = content.render;
  if (!isJournalContent(content) || typeof content.body !== "string" || byteLength(content.body) > 256 * 1024 || !object(render) || !keys(render, "schema_version policy_version source_hash document legacy diagnostics file_ids image_file_ids") || render.schema_version !== 2 || render.policy_version !== 1 || typeof render.source_hash !== "string" || !/^[a-f0-9]{64}$/.test(render.source_hash)) return null;
  const refs: References = { files: new Set(), images: new Set(), imageCount: 0 };
  if (!validateDocument(render.document, refs) || !list(render.legacy, 0, 60) || !list(render.diagnostics, 0, 100) || render.diagnostics.length || !list(render.file_ids, 0, 512) || !render.file_ids.every(id => typeof id === "string" && fileId.test(id)) || !list(render.image_file_ids, 0, 512) || !render.image_file_ids.every(id => typeof id === "string" && fileId.test(id))) return null;
  try {
    if (byteLength(JSON.stringify(render)) > 512 * 1024 || !equivalent(JSON.parse(content.body), render.document)) return null;
  } catch { return null; }
  const legacy = render.document.sections.flatMap(section => section.blocks).filter(block => block.type === "legacy");
  if (legacy.length !== render.legacy.length) return null;
  const visited = new Set<string>();
  for (const entry of render.legacy) {
    if (!object(entry) || !keys(entry, "block_id render") || typeof entry.block_id !== "string" || visited.has(entry.block_id) || !legacy.some(block => block.id === entry.block_id) || !validGuideRender(entry.render) || entry.render.diagnostics.length) return null;
    visited.add(entry.block_id);
    const block = legacy.find(block => block.id === entry.block_id)!;
    if (!markdown(block.body, new Set(render.document.sections.map(section => section.id)), refs, true)) return null;
    entry.render.file_ids.forEach(id => refs.files.add(id));
    const images = (nodes: GuideNode[]) => nodes.forEach(node => {
      if (node.tag === "img") { refs.imageCount++;refs.files.add(node.attrs.src!.slice(5));refs.images.add(node.attrs.src!.slice(5)); }
      images(node.children);
    });
    entry.render.blocks.forEach(block => images(block.nodes));
  }
  const files = render.file_ids, images = render.image_file_ids;
  if (refs.imageCount > 20 || [...refs.files].some(id => !files.includes(id)) || [...refs.images].some(id => !images.includes(id)) || images.some(id => !files.includes(id))) return null;
  return render as unknown as JournalRender;
}
