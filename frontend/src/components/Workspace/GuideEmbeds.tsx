import { createElement, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useInRouterContext } from "react-router-dom";
import type { GuideNode, MaterialText } from "../../utils/api/contract";
import { apiUrl } from "../../utils/api";
import { MarkdownContent } from "./MarkdownContent";
import { guidePrefix, validGuideRender } from "./guideEmbedPolicy";
import s from "./GuideEmbeds.module.css";
type JournalOptions = { sectionAnchors: Readonly<Record<string, string>>; materialFileIds: readonly string[]; printing: boolean };

function GuideImage({ node, first }: { node: GuideNode; first: boolean }) {
  const [failed, setFailed] = useState(false), a = node.attrs;
  return failed ? <span role="img" aria-label={a.alt} className={s.imageFailure}>Изображение недоступно: {a.alt}</span> : <img src={apiUrl(`/api/files/${encodeURIComponent(a.src!.slice(5))}/content`)} alt={a.alt} width={a.width} height={a.height} loading={first ? "eager" : "lazy"} decoding="async" onError={() => setFailed(true)} />;
}
function GuideLink({ node, children, prefix, className }: { node: GuideNode; children: ReactNode; prefix: string; className: string }) {
  const router = useInRouterContext(), href = node.attrs.href!;
  if (href.startsWith("#")) return <a className={className} href={`#${prefix}-${href.slice(1)}`} onClick={() => { document.getElementById(`${prefix}-${href.slice(1)}`)?.focus({ preventScroll: true }); }}>{children}</a>;
  if (href.startsWith("/") && router) return <Link className={className} to={href}>{children}</Link>;
  return <a className={className} href={href} {...(href.startsWith("https:") ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{children}{href.startsWith("https:") && <span className={s.external} aria-label=" — внешний сайт, откроется в новой вкладке"> ↗</span>}</a>;
}
function DeferredDetails({ node, prefix, firstImage, journal, className }: { node: GuideNode; prefix: string; firstImage: GuideNode | undefined; journal: JournalOptions; className: string }) {
  const [open, setOpen] = useState(false);
  return <details className={className} open={open || journal.printing} onToggle={event => { if (!journal.printing) setOpen(event.currentTarget.open); }}>{node.children.filter(child => child.tag === "summary").map((child, index) => nodeView(child, index, prefix, firstImage, journal))}{(open || journal.printing) && node.children.filter(child => child.tag !== "summary").map((child, index) => nodeView(child, index, prefix, firstImage, journal))}</details>;
}
function nodeView(node: GuideNode, index: number, prefix: string, firstImage: GuideNode | undefined, journal?: JournalOptions): ReactNode {
  if (node.tag === "text") return node.text;
  const a = node.attrs, className = (a.classes ?? []).map(cls => s[cls]).join(" ");
  if (node.tag === "details" && journal) return <DeferredDetails key={index} node={node} prefix={prefix} firstImage={firstImage} journal={journal} className={className} />;
  const children = node.children.map((child, i) => nodeView(child, i, prefix, firstImage, journal));
  if (node.tag === "img") return <GuideImage key={`${index}-${a.src}`} node={node} first={node === firstImage} />;
  if (node.tag === "a") return <GuideLink key={index} node={node} className={className} prefix={prefix}>{children}</GuideLink>;
  if (node.tag === "table") return <div key={index} className={s.tableWrap} role="region" aria-label="Таблица в гайде" tabIndex={0}><table className={className}>{children}</table></div>;
  // Only explicitly constructed props reach a finite set of validated intrinsic elements.
  return createElement(journal && /^h[2-5]$/.test(node.tag) ? `h${Number(node.tag.slice(1)) + 1}` : node.tag, {
    key: index, className: className || undefined,
    ...(/^h[2-6]$/.test(node.tag) ? { id: `${prefix}-${a.anchor}`, tabIndex: -1 } : {}),
    ...(node.tag === "th" || node.tag === "td" ? { scope: a.scope, colSpan: a.colspan, rowSpan: a.rowspan } : {}),
    ...(node.tag === "ol" ? { start: a.start } : {}),
    ...(node.tag === "li" ? { value: a.value } : {}),
  }, ...children);
}
function Unavailable({ source, text }: { source: string; text?: string }) {
  return <section className={s.unavailable}><p>Вставка не прошла проверку. Редактору нужно проверить её перед публикацией.</p>{text ? <p className={s.fallbackText}>{text}</p> : <details><summary>Исходный текст вставки</summary><pre>{source}</pre></details>}</section>;
}

/** Server-compiled trees only. React never interprets an author's HTML. */
export function GuideEmbeds({ content, materialId, onReady, journal }: { content: MaterialText; materialId: string; onReady?: () => void; journal?: JournalOptions }) {
  // The lazy boundary resolves independently of its parent. Let the material build
  // its table of contents before this commit paints, avoiding a second layout jump.
  useLayoutEffect(() => { onReady?.(); }, [content, onReady]);
  const render = useMemo(() => validGuideRender(content.render) ? content.render : null, [content.render]);
  const blocks = useMemo(() => new Map(render?.blocks.map(block => [block.id, block])), [render]);
  const firstImage = useMemo(() => {
    const find = (nodes: GuideNode[]): GuideNode | undefined => { for (const node of nodes) { if (node.tag === "img") return node;const nested = find(node.children);if (nested) return nested; } };
    return find(render?.blocks.flatMap(block => block.nodes) ?? []);
  }, [render]);
  const prefix = guidePrefix(materialId);
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!journal || !root.current) return;
    const assign = () => {
      let ordinal = 0;
      root.current?.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6").forEach(heading => {
        if (!heading.closest("[data-guide-embed]")) { heading.id = `${prefix}-section-${++ordinal}`;heading.tabIndex = -1; }
      });
    };
    assign();const observer = new MutationObserver(assign);observer.observe(root.current, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [journal, prefix, content.body]);
  const markdown = <MarkdownContent body={content.body} materialFiles anchorPrefix={prefix} sectionAnchors={journal?.sectionAnchors} materialFileIds={journal?.materialFileIds} renderFence={(_language, meta, source) => {
    const id = /^id=([a-z][a-z0-9-]{0,63})$/.exec(meta)?.[1], block = id ? blocks.get(id) : undefined;
    if (!block || (block.source !== source && `${block.source}\n` !== source) || !block.nodes.length || render?.diagnostics.some(d => d.block_id === id || d.block_id === null)) return <Unavailable source={source} text={block?.text} />;
    return <div className={s.embed} data-guide-embed={id}>{block.nodes.map((node, i) => nodeView(node, i, prefix, firstImage, journal))}</div>;
  }} />;
  return journal ? <div ref={root}>{markdown}</div> : markdown;
}
