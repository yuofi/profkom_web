import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { MaterialText } from "../../utils/api/contract";
import type { JournalBlock, JournalCover, JournalRender } from "../../utils/api/journal";
import { apiUrl } from "../../utils/api";
import { MarkdownContent } from "./MarkdownContent";
import { guidePrefix } from "./guideEmbedPolicy";
import { checkedJournalRender } from "./journalPolicy";
import { isBackdropClick, useModalDialog } from "./useModalDialog";
import s from "./JournalGuide.module.css";

const GuideEmbeds = lazy(() => import("./GuideEmbeds").then(module => ({ default: module.GuideEmbeds })));
type ImageData = Extract<JournalCover, { kind: "image" }> | Extract<JournalBlock, { type: "image" }>;
type ReaderContext = { prefix: string; anchors: Readonly<Record<string, string>>; files: readonly string[]; render: JournalRender; printing: boolean };

function Body({ body, context }: { body: string; context: ReaderContext }) {
  return <div className={s.markdown}><MarkdownContent body={body} materialFiles sectionAnchors={context.anchors} materialFileIds={context.files} /></div>;
}

function ProtectedImage({ data, eager = false }: { data: ImageData; eager?: boolean }) {
  const [failed, setFailed] = useState(false);
  return failed ? <span className={s.imageFailure} role="img" aria-label={data.alt}>Изображение недоступно. {data.alt}</span>
    : <img src={apiUrl(`/api/files/${encodeURIComponent(data.file_id)}/content`)} alt={data.alt} width={data.width} height={data.height} loading={eager ? "eager" : "lazy"} decoding="async" onError={() => setFailed(true)} />;
}

function ImageDialog({ data, close }: { data: ImageData; close: () => void }) {
  const dialog = useModalDialog(), titleId = `${data.file_id}-zoom-label`;
  const [originalSize, setOriginalSize] = useState(false);
  return <dialog ref={dialog} className={s.dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault();close(); }} onClick={event => { if (isBackdropClick(event)) close(); }}>
    <header><p id={titleId}>{data.alt}</p><div className={s.zoomActions}><button type="button" aria-pressed={originalSize} onClick={() => setOriginalSize(value => !value)}>{originalSize ? "Уместить целиком" : "Масштаб 100%"}</button><button type="button" onClick={close}>Закрыть</button></div></header>
    <div className={s.zoomImage} data-original-size={originalSize || undefined} tabIndex={originalSize ? 0 : undefined} role={originalSize ? "region" : undefined} aria-label={originalSize ? "Изображение в полном размере: прокрутите для просмотра" : undefined}><ProtectedImage key={data.file_id} data={data} eager /></div>
    {data.caption && <p className={s.caption}>{data.caption}</p>}
  </dialog>;
}

function ImageFigure({ data, eager = false, printing }: { data: ImageData; eager?: boolean; printing: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return <figure className={s.figure}>
    <button type="button" className={s.imageButton} aria-label={`Увеличить изображение: ${data.alt}`} onClick={() => setExpanded(true)}><ProtectedImage key={data.file_id} data={data} eager={eager || printing} /><span aria-hidden="true" className={s.zoomHint}>Увеличить ↗</span></button>
    {data.caption && <figcaption>{data.caption}</figcaption>}
    {expanded && !printing && <ImageDialog data={data} close={() => setExpanded(false)} />}
  </figure>;
}

/** Keep closed content out of the tree: native details alone still downloads images. */
function Disclosure({ title, children, printing, image = false }: { title: string; children: ReactNode; printing: boolean; image?: boolean }) {
  const [open, setOpen] = useState(false);
  return <details className={`${s.disclosure} ${image ? s.screenshot : ""}`} open={open || printing} onToggle={event => { if (!printing) setOpen(event.currentTarget.open); }}>
    <summary>{title}</summary>{(open || printing) && <div className={s.disclosureBody}>{children}</div>}
  </details>;
}

function Switcher({ block, context }: { block: Extract<JournalBlock, { type: "switcher" }>; context: ReaderContext }) {
  const [selected, select] = useState(block.options[0].id), buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const active = block.options.some(option => option.id === selected) ? selected : block.options[0].id;
  // Author-controlled IDs contain no colon. Keep internal controls in a separate
  // namespace so sections named "title" or "example-tab-first" stay valid.
  const base = `${context.prefix}:${block.id}`, titleId = `${base}:title`;
  return <section className={s.switcher} aria-labelledby={titleId} data-journal-switcher>
    <h3 id={titleId} className={s.exampleLabel}>{block.title}</h3>
    <div className={s.tabs} role="tablist" aria-labelledby={titleId}>
      {block.options.map((option, index) => <button key={option.id} ref={node => { buttons.current[index] = node; }} type="button" role="tab" id={`${base}:tab:${option.id}`} aria-controls={`${base}:panel:${option.id}`} aria-selected={active === option.id} tabIndex={active === option.id ? 0 : -1} onClick={() => select(option.id)} onKeyDown={event => {
        let target: number | undefined;
        if (event.key === "ArrowRight") target = (index + 1) % block.options.length;
        if (event.key === "ArrowLeft") target = (index - 1 + block.options.length) % block.options.length;
        if (event.key === "Home") target = 0;
        if (event.key === "End") target = block.options.length - 1;
        if (target !== undefined) { event.preventDefault();select(block.options[target].id);buttons.current[target]?.focus(); }
      }}>{option.label}</button>)}
    </div>
    {block.options.map(option => <div key={option.id} id={`${base}:panel:${option.id}`} role="tabpanel" aria-labelledby={`${base}:tab:${option.id}`} hidden={!context.printing && active !== option.id} tabIndex={0} className={s.examplePanel}>
      {(context.printing || active === option.id) && <><h4 className={s.printLabel}>{option.label}</h4><Body body={option.body} context={context} /></>}
    </div>)}
  </section>;
}

function Block({ block, context }: { block: JournalBlock; context: ReaderContext }) {
  switch (block.type) {
    case "text": return <Body body={block.body} context={context} />;
    case "note": return <aside className={`${s.note} ${s[`tone-${block.tone}`]}`}>{block.title && <h3>{block.title}</h3>}<Body body={block.body} context={context} /></aside>;
    case "comparison": return <div className={s.comparison}><div className={s.before}><p className={s.smallLabel}>{block.before_label}</p><Body body={block.before} context={context} /></div><div className={s.after}><p className={s.smallLabel}>{block.after_label}</p><Body body={block.after} context={context} /></div></div>;
    case "facts": return <div className={s.facts}>{block.items.map((item, index) => <section key={index}><h3>{item.label}</h3><Body body={item.body} context={context} /></section>)}</div>;
    case "steps": return <ol className={s.steps}>{block.items.map((item, index) => <li key={index}><p className={s.stepRole}><span aria-hidden="true">{String(index + 1).padStart(2, "0")} / </span>{item.role}</p><h3>{item.title}</h3><Body body={item.body} context={context} /></li>)}</ol>;
    case "image": return block.collapsed ? <Disclosure title={block.caption || block.alt} printing={context.printing} image><ImageFigure data={block} printing={context.printing} /></Disclosure> : <ImageFigure data={block} printing={context.printing} />;
    case "disclosure": return <Disclosure title={block.title} printing={context.printing}><Body body={block.body} context={context} /></Disclosure>;
    case "switcher": return <Switcher block={block} context={context} />;
    case "legacy": {
      const render = context.render.legacy.find(entry => entry.block_id === block.id)!.render;
      return <div className={s.legacy}><Suspense fallback={<p role="status">Подготавливаем вставку…</p>}><GuideEmbeds content={{ format: "markdown-embeds-v1", body: block.body, render }} materialId={`${context.prefix}-${block.id}`} journal={{ sectionAnchors: context.anchors, materialFileIds: context.files, printing: context.printing }} /></Suspense></div>;
    }
  }
}

export interface JournalGuideProps { content: MaterialText; materialId: string; title: string; description?: string; showToc?: boolean }

/** A small finite reader: selection, disclosure and zoom change local UI only. */
export function JournalGuide({ content, materialId, title, description, showToc = true }: JournalGuideProps) {
  const render = useMemo(() => checkedJournalRender(content), [content]);
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true)), after = () => setPrinting(false);
    window.addEventListener("beforeprint", before);window.addEventListener("afterprint", after);
    return () => { window.removeEventListener("beforeprint", before);window.removeEventListener("afterprint", after); };
  }, []);
  const prefix = guidePrefix(materialId);
  const anchors = useMemo(() => Object.fromEntries(render?.document?.sections.map(section => [section.id, `${prefix}-${section.id}`]) ?? []), [render, prefix]);
  if (!render?.document) return <article className={`${s.journal} ${s.unavailable}`}><h1>{title}</h1><p role="alert">Оформление гайда не прошло проверку. Редактору нужно проверить черновик и опубликовать его заново.</p>{description && <p>{description}</p>}</article>;
  const { document } = render, context: ReaderContext = { prefix, anchors, files: render.file_ids, render, printing };
  return <article className={s.journal} aria-labelledby={`${prefix}:title`} data-journal-guide>
    <div className={s.masthead}><span className={s.mark} aria-hidden="true">П</span><span>Профком · База знаний</span></div>
    <header className={`${s.hero} ${document.cover ? "" : s.noCover}`}>
      <div>{document.eyebrow && <p className={s.eyebrow}>{document.eyebrow}</p>}<h1 id={`${prefix}:title`}>{title}</h1>{document.intro ? <div className={s.intro}><Body body={document.intro} context={context} /></div> : description ? <p className={s.intro}>{description}</p> : null}</div>
      {document.cover?.kind === "poster" && <div className={`${s.poster} ${s[`poster-${document.cover.tone}`]}`}><span>{document.cover.eyebrow}</span><strong>{document.cover.title}</strong><small>{document.cover.caption}</small></div>}
      {document.cover?.kind === "image" && <div className={s.coverImage}><ImageFigure data={document.cover} eager printing={printing} /></div>}
    </header>
    {showToc && <nav className={s.toc} aria-label="Содержание материала"><ol>{document.sections.map((section, index) => <li key={section.id}><a href={`#${anchors[section.id]}`} onClick={() => { window.document.getElementById(anchors[section.id])?.focus({ preventScroll: true }); }}><span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>{section.title}</a></li>)}</ol></nav>}
    {document.sections.map((section, index) => <section key={section.id} className={s.chapter} aria-labelledby={anchors[section.id]} data-journal-section={section.id}>
      <header><p className={s.chapterIndex}><span aria-hidden="true">{String(index + 1).padStart(2, "0")}{section.label && " / "}</span>{section.label}</p><h2 id={anchors[section.id]} tabIndex={-1}>{section.title}</h2></header>
      <div className={s.chapterBody}>{section.blocks.map(block => <Block key={block.id} block={block} context={context} />)}</div>
    </section>)}
  </article>;
}
