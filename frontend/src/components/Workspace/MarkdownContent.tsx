import { createContext, useContext, type InputHTMLAttributes } from "react";
import type { Root, RootContent, ListItem } from "mdast";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { MarkdownCode } from "./MarkdownCode";
import { Gallery } from "../Gallery/Gallery";
import { ContactChip } from "../ContactChip/ContactChip";
import { apiUrl } from "../../utils/api";
import s from "./Workspace.module.css";
import md from "./MarkdownContent.module.css";
interface ChecklistPosition { offset: number; label: string }
const ChecklistContext = createContext<ChecklistPosition | null>(null);

/** Attach exact source positions while GFM's parser still distinguishes tasks from code and nested lists. */
function remarkChecklistPositions({ source }: { source: string }) {
  return (tree: Root) => {
    const text = (node: RootContent): string => "value" in node && typeof node.value === "string" ? node.value : "children" in node ? node.children.map(child => text(child as RootContent)).join("") : "";
    const visit = (node: Root | RootContent) => {
      if (node.type === "listItem" && typeof node.checked === "boolean") {
        const item = node as ListItem;
        const start = item.position?.start.offset;
        const end = item.position?.end.offset;
        if (start !== undefined && end !== undefined) {
          const marker = source.slice(start, end).match(/^([ \t]*(?:[-+*]|\d+[.)])[ \t]+\[)([ xX])\]/);
          if (marker) item.data = { ...item.data, hProperties: { ...item.data?.hProperties, "data-checklist-offset": start + marker[1].length, "data-checklist-label": item.children[0] ? text(item.children[0]) : "Пункт чеклиста" } };
        }
      }
      if ("children" in node) node.children.forEach(child => visit(child as RootContent));
    };
    visit(tree);
  };
}
function ChecklistCheckbox({ body, onChangeBody, busy, ...props }: InputHTMLAttributes<HTMLInputElement> & { body: string; onChangeBody?: (next: string) => void; busy?: boolean }) {
  const position = useContext(ChecklistContext);
  const enabled = !!position && !!onChangeBody && !busy;
  return <input {...props} disabled={!enabled} aria-label={position ? `${props.checked ? "Снять отметку" : "Отметить"}: ${position.label}` : "Пункт чеклиста"}
    onChange={() => { if (enabled && position && /[ xX]/.test(body[position.offset] ?? "")) onChangeBody?.(body.slice(0, position.offset) + (props.checked ? " " : "x") + body.slice(position.offset + 1)); }} />;
}
export interface MarkdownContentProps { body: string; onChecklistChange?: (nextBody: string) => void; checklistDisabled?: boolean }
export function MarkdownContent({ body, onChecklistChange, checklistDisabled = false }: MarkdownContentProps) {
  return (
    <div className={`${s.markdown} ${md.content}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkMath, [remarkChecklistPositions, { source: body }]]}
        rehypePlugins={[[rehypeKatex, { trust: false, strict: "error", maxExpand: 1000, maxSize: 20, macros: {} }]]}
        skipHtml
        // Files of a material are API addresses, checked on every request (decision 23).
        urlTransform={(url) => defaultUrlTransform(apiUrl(url))}
        components={{
          li: ({ node, children, ...props }) => {
            const offset = node?.properties["data-checklist-offset"], label = node?.properties["data-checklist-label"];
            const position = typeof offset === "number" ? { offset, label: String(label ?? "Пункт чеклиста") } : null;
            return <li {...props}><ChecklistContext.Provider value={position}>{children}</ChecklistContext.Provider></li>;
          },
          input: ({ node, ...props }) => { void node;return <ChecklistCheckbox {...props} body={body} onChangeBody={onChecklistChange} busy={checklistDisabled} />; },
          table: ({ children }) => <div className={md.tableWrap} tabIndex={0} role="region" aria-label="Таблица Markdown"><table>{children}</table></div>,
          pre: ({ children, node }) => {
            const extension = node?.children.some(
              (n) =>
                n.type === "element" &&
                n.tagName === "code" &&
                Array.isArray(n.properties.className) &&
                n.properties.className.some(
                  (c) => c === "language-gallery" || c === "language-chip",
                ),
            );
            return extension ? <div>{children}</div> : <pre>{children}</pre>;
          },
          code: ({ className, children }) =>
            className === "language-gallery" ? (
              <Gallery
                initialContent={String(children).replace(/\n$/, "")}
                mode="view"
              />
            ) : className === "language-chip" ? (
              <ContactChip
                initialContent={String(children).replace(/\n$/, "")}
                mode="view"
              />
            ) : (
              <MarkdownCode className={className} source={String(children)} />
            ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
