import { createContext, lazy, Suspense, useContext, useEffect, useState, type ComponentProps, type InputHTMLAttributes, type ReactNode } from "react";
import type { Root, RootContent, ListItem } from "mdast";
import ReactMarkdown, { defaultUrlTransform, type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { ContactChip } from "../ContactChip/ContactChip";
import { UserChip } from "./UserChip";
import type { UserRef } from "../../utils/api/contract";
import { apiUrl } from "../../utils/api";
import s from "./Workspace.module.css";
import md from "./MarkdownContent.module.css";
// Formulas, highlighting and galleries load only for a document that uses them.
const MarkdownCode = lazy(() => import("./MarkdownCode").then(module => ({ default: module.MarkdownCode })));
const MarkdownCodeBlock = lazy(() => import("./MarkdownCode").then(module => ({ default: module.MarkdownCodeBlock })));
const Gallery = lazy(() => import("../Gallery/Gallery").then(module => ({ default: module.Gallery })));
type MathPlugins = typeof import("./markdownMath");
let mathPlugins: MathPlugins | undefined, mathLoading: Promise<MathPlugins> | undefined;
const loadMath = () => mathLoading ??= import("./markdownMath").then(module => (mathPlugins = module), failure => { mathLoading = undefined;throw failure; });
/** remark-math changes the parse only where `$` occurs, so other documents parse exactly as before. */
function useMath(needed: boolean) {
  const [loaded, setLoaded] = useState(mathPlugins);
  useEffect(() => {
    if (!needed || loaded) return;
    let live = true;
    loadMath().then(module => { if (live) setLoaded(module); }, () => { /* The source stays readable as text. */ });
    return () => { live = false; };
  }, [needed, loaded]);
  return needed ? loaded ?? mathPlugins : undefined;
}
const plainLabel = (language?: string) => !language || ["text", "txt", "plaintext"].includes(language.toLowerCase()) ? "Текст" : language;
function PlainCodeBlock({ language, children }: { language?: string; children: ReactNode }) {
  const label = plainLabel(language);
  return <figure className={md.codeBlock} aria-label={`Блок кода: ${label}`}><figcaption className={md.codeLanguage}>{label}</figcaption><pre>{children}</pre></figure>;
}
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
          // The marker must be this item's own: a link definition such as `[x]: /url` may come first.
          if (marker && (marker[2] !== " ") === item.checked) item.data = { ...item.data, hProperties: { ...item.data?.hProperties, "data-checklist-offset": start + marker[1].length, "data-checklist-label": item.children[0] ? text(item.children[0]) : "Пункт чеклиста" } };
        }
      }
      if ("children" in node) node.children.forEach(child => visit(child as RootContent));
    };
    visit(tree);
  };
}
/** Fence metadata is data, never HTML; only an explicit guide renderer consumes it. */
function remarkFenceMetadata() {
  return (tree: Root) => {
    const visit = (node: Root | RootContent) => {
      if (node.type === "code" && node.lang === "profkom-html") node.data = { ...node.data, hProperties: { ...node.data?.hProperties, "data-fence-meta": node.meta ?? "" } };
      if ("children" in node) node.children.forEach(child => visit(child as RootContent));
    };
    visit(tree);
  };
}
function ChecklistCheckbox({ body, onMark, busy, pending, ...props }: InputHTMLAttributes<HTMLInputElement> & { body: string; onMark?: (offset: number, checked: boolean) => void; busy?: boolean; pending?: readonly number[] }) {
  const position = useContext(ChecklistContext);
  const saving = !!position && !!pending?.includes(position.offset);
  const enabled = !!position && !!onMark && !busy && !saving;
  return <input {...props} disabled={!enabled} aria-busy={saving || undefined} aria-label={position ? `${props.checked ? "Снять отметку" : "Отметить"}: ${position.label}` : "Пункт чеклиста"}
    onChange={() => { if (enabled && position && /[ xX]/.test(body[position.offset] ?? "")) onMark?.(position.offset, !props.checked); }} />;
}
/** What a render needs inside the custom elements; read from context so that the element
 * types below stay the same across renders and a checkbox is never remounted mid-click. */
interface MarkdownState { body: string; onMark?: (offset: number, checked: boolean) => void; busy: boolean; pending?: readonly number[]; mentionUsers?: UserRef[]; renderFence?: MarkdownContentProps["renderFence"]; materialFiles?: boolean; anchorPrefix?: string }
const MarkdownStateContext = createContext<MarkdownState>({ body: "", busy: false });
const materialFileUrl = (url: string) => /^file:file-[A-Za-z0-9_-]{1,100}$/.test(url) ? `/api/files/${encodeURIComponent(url.slice(5))}/content` : url;
function MarkdownLink({ node, href, children, ...props }: ComponentProps<"a"> & ExtraProps) {
  void node;
  const { mentionUsers, anchorPrefix } = useContext(MarkdownStateContext);
  const profile = mentionUsers !== undefined && href?.match(/^\/contacts\/([1-9][0-9]*)$/);
  if (profile) {
    const user = mentionUsers?.find(person => person.user_id !== null && String(person.user_id) === profile[1]);
    return <UserChip className={md.mention} user={user ?? {user_id:null,display_name:"Недоступный участник",avatar_url:null}} interactive={!!user} />;
  }
  // Material headings are scoped to their reader/preview. Resolve author-facing
  // anchors there without changing links in task comments or to other pages.
  const scoped = anchorPrefix && /^#(?:section-[1-9]\d{0,4}|[a-z][a-z0-9-]{0,63}-heading-[1-9]\d{0,3})$/.test(href ?? "");
  const target = scoped ? `${anchorPrefix}-${href!.slice(1)}` : null;
  return <a {...props} href={target ? `#${target}` : href} onClick={target ? event => {
    props.onClick?.(event);
    if (!event.defaultPrevented && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.button === 0) document.getElementById(target)?.focus({ preventScroll: true });
  } : props.onClick}>{children}</a>;
}
function MarkdownInput({ node, ...props }: ComponentProps<"input"> & ExtraProps) {
  void node;
  const { body, onMark, busy, pending } = useContext(MarkdownStateContext);
  return <ChecklistCheckbox {...props} body={body} onMark={onMark} busy={busy} pending={pending} />;
}
const components: Components = {
  a: MarkdownLink,
  li: ({ node, children, ...props }) => {
    const offset = node?.properties["data-checklist-offset"], label = node?.properties["data-checklist-label"];
    const position = typeof offset === "number" ? { offset, label: String(label ?? "Пункт чеклиста") } : null;
    return <li {...props}><ChecklistContext.Provider value={position}>{children}</ChecklistContext.Provider></li>;
  },
  input: MarkdownInput,
  table: ({ children }) => <div className={md.tableWrap} tabIndex={0} role="region" aria-label="Таблица Markdown"><table>{children}</table></div>,
  pre: function MarkdownPre({ children, node }) {
    const { renderFence } = useContext(MarkdownStateContext);
    const extension = node?.children.some(
      (n) =>
        n.type === "element" &&
        n.tagName === "code" &&
        Array.isArray(n.properties.className) &&
        n.properties.className.some(
          (c) => c === "language-gallery" || c === "language-chip",
        ),
    );
    const codeNode = node?.children.find(child => child.type === "element" && child.tagName === "code");
    const names = codeNode?.type === "element" && Array.isArray(codeNode.properties.className) ? codeNode.properties.className : [];
    const language = names.find(name => typeof name === "string" && name.startsWith("language-"));
    const name = typeof language === "string" ? language.slice("language-".length) : undefined;
    if (name === "profkom-html" && renderFence && codeNode?.type === "element") {
      const source = codeNode.children.map(child => child.type === "text" ? child.value : "").join("");
      const rendered = renderFence(name, String(codeNode.properties["data-fence-meta"] ?? ""), source);
      if (rendered !== undefined) return rendered;
    }
    return extension ? <div>{children}</div> : plainLabel(name) === "Текст" ? <PlainCodeBlock>{children}</PlainCodeBlock>
      : <Suspense fallback={<PlainCodeBlock language={name}>{children}</PlainCodeBlock>}><MarkdownCodeBlock language={name}>{children}</MarkdownCodeBlock></Suspense>;
  },
  code: function MarkdownCodeElement({ className, children }) {
    const { materialFiles } = useContext(MarkdownStateContext);
    const source = String(children).replace(/\n$/, "");
    const gallery = materialFiles ? source.split("\n").map(line => { const divider = line.indexOf("|");return divider < 0 ? materialFileUrl(line.trim()) : `${materialFileUrl(line.slice(0, divider).trim())}${line.slice(divider)}`; }).join("\n") : source;
    return className === "language-gallery" ? (
      <Suspense fallback={null}><Gallery
        initialContent={gallery}
        mode="view"
      /></Suspense>
    ) : className === "language-chip" ? (
      <ContactChip
        initialContent={String(children).replace(/\n$/, "")}
        mode="view"
      />
    ) : className?.startsWith("language-") ? (
      <Suspense fallback={<code className={className}>{String(children)}</code>}><MarkdownCode className={className} source={String(children)} /></Suspense>
    ) : <code className={className}>{String(children)}</code>;
  },
};
/** A checklist mark is one source offset (a string index of `body`, in UTF-16 code units as
 * micromark counts them): the reader command flips that marker only. */
export interface MarkdownContentProps { body: string; onChecklistToggle?: (offset: number, checked: boolean) => void; checklistDisabled?: boolean; checklistPending?: readonly number[]; mentionUsers?: UserRef[]; renderFence?: (language: string, meta: string, source: string) => ReactNode; materialFiles?: boolean; anchorPrefix?: string }
export function MarkdownContent({ body, onChecklistToggle, checklistDisabled = false, checklistPending, mentionUsers, renderFence, materialFiles = false, anchorPrefix }: MarkdownContentProps) {
  const needsMath = body.includes("$"), math = useMath(needsMath);
  // Until formulas load, a marker inside $$…$$ would look like a task: no marks meanwhile.
  const marksBusy = checklistDisabled || (needsMath && !math);
  return (
    <div className={`${s.markdown} ${md.content}`}><MarkdownStateContext.Provider value={{ body, onMark: onChecklistToggle, busy: marksBusy, pending: checklistPending, mentionUsers, renderFence, materialFiles, anchorPrefix }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, ...(renderFence ? [remarkFenceMetadata] : []), ...(math ? [math.remarkMath] : []), [remarkChecklistPositions, { source: body }]]}
        rehypePlugins={math ? [[math.rehypeKatex, { trust: false, strict: "error", maxExpand: 1000, maxSize: 20, macros: {} }]] : []}
        skipHtml
        // Files of a material are API addresses, checked on every request (decision 23).
        urlTransform={(url) => defaultUrlTransform(apiUrl(materialFiles ? materialFileUrl(url) : url))}
        components={components}
      >
        {body}
      </ReactMarkdown>
    </MarkdownStateContext.Provider></div>
  );
}
