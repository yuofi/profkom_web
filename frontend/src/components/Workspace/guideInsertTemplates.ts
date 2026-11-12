import type { GuideNode, GuideRender } from "../../utils/api/contract";
import type { IconName } from "../icons";
import { guideHref } from "./guideEmbedPolicy";

export type GuideInsertKind = "panel" | "button" | "table" | "image" | "steps" | "columns" | "faq" | "html";
export type GuideTone = "neutral" | "info" | "success" | "warning";
export interface GuideInsertFields {
  title: string;
  text: string;
  tone: GuideTone;
  gradient: boolean;
  compact: boolean;
  href: string;
  secondary: boolean;
  caption: string;
  headers: string[];
  rows: string[][];
  items: { title: string; text: string }[];
  fileId: string;
  alt: string;
  width: number;
  height: number;
  align: "left" | "center" | "right";
  html: string;
}
export const guideInsertKinds: { kind: GuideInsertKind; title: string; description: string; icon: IconName }[] = [
  { kind: "panel", title: "Плашка", description: "Совет, важное замечание или цветной акцент", icon: "space_dashboard" },
  { kind: "button", title: "Кнопка-ссылка", description: "Сайт, другой гайд или раздел этого гайда", icon: "share" },
  { kind: "table", title: "Таблица", description: "Сравнение, расписание и краткие данные", icon: "fact_check" },
  { kind: "image", title: "Изображение", description: "Фотография или схема с подписью", icon: "image" },
  { kind: "steps", title: "Шаги", description: "Понятная последовательность действий", icon: "pending_actions" },
  { kind: "columns", title: "Колонки", description: "Две карточки рядом, на телефоне — друг под другом", icon: "layers" },
  { kind: "faq", title: "Вопрос и ответ", description: "Ответ раскрывается по нажатию", icon: "expand_more" },
  { kind: "html", title: "HTML", description: "Своя композиция из разрешённых элементов", icon: "edit_document" },
];
export const initialGuideInsert = (): GuideInsertFields => ({
  title: "Полезно знать", text: "Добавьте короткое пояснение для читателей.", tone: "info", gradient: false, compact: false,
  href: "", secondary: false, caption: "", headers: ["Что подготовить", "Зачем"], rows: [["", ""], ["", ""]],
  items: [{ title: "Первый шаг", text: "С чего начать" }, { title: "Следующий шаг", text: "Что сделать дальше" }],
  fileId: "", alt: "", width: 960, height: 640, align: "center",
  html: '<section class="guide-card guide-tone-info">\n  <h3>Полезно знать</h3>\n  <p>Добавьте свой текст.</p>\n</section>',
});
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const paragraphs = (text: string) => text.split(/\n\s*\n/).filter(line => line.trim()).map(line => `<p>${escape(line).replaceAll("\n", "<br>")}</p>`).join("\n");

/** Visual fields generate source only. The server compiler remains the publishing boundary. */
export function guideInsertHtml(kind: GuideInsertKind, fields: GuideInsertFields): string {
  const decoration = `guide-card guide-${fields.gradient && fields.tone !== "neutral" ? "gradient" : "tone"}-${fields.tone}${fields.compact ? " guide-compact" : ""}`;
  switch (kind) {
    case "panel": return `<section class="${decoration}">\n<h3>${escape(fields.title)}</h3>\n${paragraphs(fields.text)}\n</section>`;
    case "button": return `<p class="guide-align-${fields.align}"><a class="guide-button${fields.secondary ? " guide-button-secondary" : ""}" href="${escape(fields.href)}">${escape(fields.title)}</a></p>`;
    case "table": return `<table class="guide-compact">\n<caption>${escape(fields.caption)}</caption>\n<thead><tr>${fields.headers.map(title => `<th scope="col">${escape(title)}</th>`).join("")}</tr></thead>\n<tbody>\n${fields.rows.map(row => `<tr>${fields.headers.map((_, index) => `<td>${escape(row[index] ?? "")}</td>`).join("")}</tr>`).join("\n")}\n</tbody>\n</table>`;
    case "image": return `<figure class="guide-align-${fields.align}">\n<img src="file:${escape(fields.fileId)}" alt="${escape(fields.alt)}" width="${fields.width}" height="${fields.height}">\n${fields.caption ? `<figcaption>${escape(fields.caption)}</figcaption>\n` : ""}</figure>`;
    case "steps": return `<section class="${decoration}">\n<h3>${escape(fields.title)}</h3>\n<ol>\n${fields.items.map(item => `<li><strong>${escape(item.title)}</strong>${paragraphs(item.text)}</li>`).join("\n")}\n</ol>\n</section>`;
    case "columns": return `<div class="guide-grid-2">\n${fields.items.map(item => `<section class="${decoration}"><h3>${escape(item.title)}</h3>${paragraphs(item.text)}</section>`).join("\n")}\n</div>`;
    case "faq": return `<details class="${decoration}">\n<summary>${escape(fields.title)}</summary>\n${paragraphs(fields.text)}\n</details>`;
    case "html": return fields.html;
  }
}

export function guideInsertFence(id: string, html: string): string {
  // The outer fence must survive a code sample containing backticks in manual HTML.
  const length = Math.max(2, ...Array.from(html.matchAll(/`+/g), match => match[0].length)) + 1;
  const fence = "`".repeat(length);
  return `${fence}profkom-html id=${id}\n${html}\n${fence}`;
}

export function guideNavigationProblem(value: string): string | null {
  if (!value.trim()) return "Укажите, куда ведёт кнопка.";
  if (guideHref(value)) return null;
  return "Используйте https://, путь раздела сайта (например, /blocks) или выберите раздел гайда.";
}

export interface GuideHeadingChoice { value: string; label: string }
/** Parse Markdown, rather than treating headings inside fences as real section targets. */
export async function guideHeadingChoices(source: string, render?: GuideRender | null): Promise<GuideHeadingChoice[]> {
  const [{ unified }, { default: remarkParse }] = await Promise.all([import("unified"), import("remark-parse")]);
  const tree = unified().use(remarkParse).parse(source);
  const choices: GuideHeadingChoice[] = [];
  type TextNode = { type?: string; value?: string; children?: TextNode[]; depth?: number };
  const plain = (node: TextNode): string => node.value ?? node.children?.map(plain).join("") ?? "";
  const walk = (node: TextNode) => {
    if (node.type === "heading") choices.push({ value: `#section-${choices.length + 1}`, label: plain(node) || "Раздел" });
    node.children?.forEach(walk);
  };
  walk(tree);
  const text = (node: GuideNode): string => node.tag === "text" ? node.text : node.children.map(text).join("");
  for (const block of render?.blocks ?? []) {
    let ordinal = 0;
    const visit = (node: GuideNode) => {
      if (/^h[2-6]$/.test(node.tag)) choices.push({ value: `#${block.id}-heading-${++ordinal}`, label: text(node) || "Раздел вставки" });
      node.children.forEach(visit);
    };
    block.nodes.forEach(visit);
  }
  return choices;
}
