import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import type { FileRef, Material, MaterialText } from "../../utils/api/contract";
import { materialsApi } from "../../utils/api/materials.api";
import { filesApi } from "../../utils/api/files.api";
import { userMessage } from "../../utils/api/messages";
import { getMaterialRoute } from "../../utils/routes";
import { fileMetadata } from "../../utils/filePolicy";
import { createClientId } from "../../utils/clientId";
import { MarkdownEditor } from "./MarkdownEditor";
import { FormattingMenu } from "./MarkdownTools";
import { Glyph } from "./WorkspaceUI";
import { useModalDialog, isBackdropClick } from "./useModalDialog";
import { useGuardedAction, useUnsavedChanges } from "./unsavedChangesHooks";
import { guideHeadingChoices, guideInsertFence, guideInsertHtml, guideInsertKinds, guideNavigationProblem, initialGuideInsert, type GuideHeadingChoice, type GuideInsertFields, type GuideInsertKind, type GuideTone } from "./guideInsertTemplates";
import s from "./GuideInsertEditor.module.css";
import w from "./Workspace.module.css";

const MaterialContent = lazy(() => import("./MaterialContent").then(module => ({ default: module.MaterialContent })));
const tones: { value: GuideTone; title: string }[] = [{ value: "neutral", title: "Спокойная" }, { value: "info", title: "Небесная" }, { value: "success", title: "Мятная" }, { value: "warning", title: "Персиковая" }];

/** The preview is compiled only while visible. A stale response never replaces newer source. */
export function GuideSourcePreview({ material, content, label = "Предпросмотр гайда", focusEmbedId }: { material: Material; content: MaterialText; label?: string; focusEmbedId?: string }) {
  const [attempt, setAttempt] = useState(0), [width, setWidth] = useState("full");
  const [result, setResult] = useState<{ key: string; value?: MaterialText; error?: unknown }>();
  const key = JSON.stringify([material.material_id, material.revision, content.format, content.body, attempt]);
  const generation = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (content.format === "markdown") return;
    const controller = new AbortController(), token = ++generation.current;
    const timer = setTimeout(() => {
      void materialsApi.preview(material.material_id, { expected_revision: material.revision, content: { format: content.format, body: content.body } }, controller.signal)
        .then(value => { if (!controller.signal.aborted && token === generation.current) setResult({ key, value }); }, error => { if (!controller.signal.aborted && token === generation.current) setResult({ key, error }); });
    }, 350);
    return () => { clearTimeout(timer);controller.abort(); };
  }, [key, material.material_id, material.revision, content.format, content.body]);
  const current = result?.key === key ? result : undefined;
  const compiled = content.format === "markdown" ? content : current?.value;
  const diagnostics = compiled?.render?.diagnostics ?? [];
  useEffect(() => {
    const container = scroll.current, token = generation.current;
    if (!focusEmbedId || !compiled || !container) return;
    // MaterialContent and the insert renderer both load lazily. Move just this viewport
    // once the requested insert exists, without scrolling the dialog or the page.
    let positioned = false;
    const position = () => {
      if (positioned || token !== generation.current || !container.isConnected) return;
      const target = [...container.querySelectorAll<HTMLElement>("[data-guide-embed]")].find(element => element.dataset.guideEmbed === focusEmbedId);
      if (!target) return;
      container.scrollTop = Math.max(0, container.scrollTop + target.getBoundingClientRect().top - container.getBoundingClientRect().top - 16);
      positioned = true;observer.disconnect();
    };
    const observer = new MutationObserver(position);
    observer.observe(container, { childList: true, subtree: true });position();
    return () => observer.disconnect();
  }, [compiled, focusEmbedId, key, width]);
  return <section className={s.preview} aria-label={label}>
    <div className={s.previewHeader}><strong>{label}</strong><label className={s.widthLabel}>Ширина<select value={width} onChange={event => setWidth(event.target.value)}><option value="full">По окну</option><option value="390">Телефон · 390 px</option><option value="768">Планшет · 768 px</option><option value="1280">Компьютер · 1280 px</option></select></label></div>
    {current?.error ? <div className={s.diagnostics} role="alert"><p>{userMessage(current.error)}</p><button type="button" className={w.button} onClick={() => setAttempt(attempt + 1)}>Повторить проверку</button></div> : !compiled ? <p role="status" className={s.hint}>Проверяем оформление…</p> : <>
      {!!diagnostics.length && <div className={s.diagnostics} role="alert"><strong>Исправьте вставки перед публикацией</strong><ul>{diagnostics.map((problem, index) => <li key={`${problem.block_id}-${problem.code}-${index}`}>Строка {problem.line}: {problem.message}</li>)}</ul><p>Исходник можно сохранить в черновике. Опубликованный гайд не изменится.</p></div>}
      <div ref={scroll} className={`${s.previewScroll} ${focusEmbedId ? s.focusedPreview : ""}`} data-guide-preview-scroll={focusEmbedId ? "insert" : "document"}><div className={s.previewCanvas} style={{ width: width === "full" ? "100%" : `${width}px` }}><Suspense fallback={<p role="status">Загружаем предпросмотр…</p>}><MaterialContent content={compiled} materialId={`${material.material_id}-preview`} showToc={false} /></Suspense></div></div>
    </>}
  </section>;
}

export function GuideInsertEditor({ material, value, format, onChange, onFormatChange, disabled, onBusyChange }: {
  material: Material;
  value: string;
  format: MaterialText["format"];
  onChange: (value: string) => void;
  onFormatChange: (format: MaterialText["format"]) => void;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const canInsert = material.capabilities.includes("edit_html_material");
  return <div className={s.editor}>
    <MarkdownEditor name="body" label="Текст материала" value={value} onChange={onChange} rows={20} disabled={disabled} context="material"
      renderInsertTools={canInsert ? ({ insert }) => <GuideInsertTools material={material} source={value} format={format} disabled={disabled} onBusyChange={onBusyChange} onInsert={html => { onFormatChange("markdown-embeds-v1");insert(`\n\n${html}\n\n`); }} /> : undefined}
      renderPreview={() => <GuideSourcePreview material={material} content={{ format, body: value }} />} />
    {format === "markdown-embeds-v1" && <p className={s.hint}>Оформленные вставки включены. Обычный текст редактируется как раньше; код вставок обозначен <code>profkom-html id=…</code>. Проверка и предпросмотр не публикуют гайд.</p>}
  </div>;
}

function GuideInsertTools({ material, source, format, disabled, onInsert, onBusyChange }: {
  material: Material; source: string; format: MaterialText["format"]; disabled: boolean; onInsert: (source: string) => void; onBusyChange: (busy: boolean) => void;
}) {
  const [kind, setKind] = useState<GuideInsertKind | null>(null);
  const trigger = useRef<HTMLSpanElement>(null);
  const close = () => { setKind(null);queueMicrotask(() => trigger.current?.querySelector<HTMLButtonElement>("button")?.focus()); };
  return <span ref={trigger} className={s.insertTools}>
    <FormattingMenu label="Вставить оформленный блок" disabled={disabled} items={guideInsertKinds.map(item => ({ label: item.title, icon: <Glyph name={item.icon} />, action: () => setKind(item.kind) }))}><Glyph name="add" /><span>Вставить</span></FormattingMenu>
    {kind && <GuideInsertDialog key={kind} kind={kind} material={material} source={source} format={format} onClose={close} onBusyChange={onBusyChange} onInsert={insert => { onInsert(insert);setKind(null); }} />}
  </span>;
}

function GuideInsertDialog({ kind, material, source, format, onInsert, onClose, onBusyChange }: {
  kind: GuideInsertKind; material: Material; source: string; format: MaterialText["format"]; onInsert: (source: string) => void; onClose: () => void; onBusyChange: (busy: boolean) => void;
}) {
  const [fields, setFields] = useState(initialGuideInsert), [initial] = useState(initialGuideInsert);
  const [id] = useState(() => `embed-${createClientId()}`);
  const [mode, setMode] = useState<"fields" | "html">(kind === "html" ? "html" : "fields");
  const [customHtml, setCustomHtml] = useState<string | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [preview, setPreview] = useState(false), [confirmConvert, setConfirmConvert] = useState(format === "markdown-embeds-v1");
  const dialog = useModalDialog(), heading = useId(), scope = useId(), leave = useGuardedAction(scope);
  const spec = guideInsertKinds.find(item => item.kind === kind)!;
  const changed = JSON.stringify(fields) !== JSON.stringify(initial) || customHtml !== null;
  const patch = <K extends keyof GuideInsertFields>(key: K, value: GuideInsertFields[K]) => { setFields(current => ({ ...current, [key]: value }));setError(""); };
  useUnsavedChanges({ dirty: changed, busy, scope, label: "Новая вставка в гайд", discard: onClose });
  const setUploadBusy = (value: boolean) => { setBusy(value);onBusyChange(value); };
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  const generated = guideInsertHtml(kind, fields), html = customHtml ?? generated;
  const fence = guideInsertFence(id, html);
  const close = () => { if (!busy) leave(onClose); };
  const apply = () => {
    if (busy) return;
    if (!confirmConvert) { setError("Подтвердите включение оформленных вставок для этого гайда.");return; }
    if (mode === "fields") {
      const problem = kind === "button" ? !fields.title.trim() ? "Напишите текст кнопки." : guideNavigationProblem(fields.href)
        : kind === "image" ? !fields.fileId ? "Выберите и загрузите изображение." : !fields.alt.trim() ? "Добавьте описание изображения." : null
          : kind === "table" ? !fields.caption.trim() ? "Добавьте название таблицы." : fields.headers.some(value => !value.trim()) ? "Заполните заголовки столбцов." : null
            : ["panel", "faq", "steps"].includes(kind) && !fields.title.trim() ? "Добавьте заголовок вставки." : null;
      if (problem) { setError(problem);return; }
    }
    if (!html.trim()) { setError("Добавьте содержимое вставки.");return; }
    onInsert(fence);
  };
  return createPortal(<dialog ref={dialog} className={s.dialog} aria-labelledby={heading} onCancel={event => { event.preventDefault();close(); }} onClick={event => { if (isBackdropClick(event)) close(); }}>
    <header className={s.dialogHeader}><div><span className={s.eyebrow}>Оформление гайда</span><h2 id={heading}>{spec.title}</h2><p>{spec.description}</p></div><button type="button" className={`${w.button} ${w.iconButton} ${s.close}`} aria-label="Закрыть вставку" onClick={close} disabled={busy}><Glyph name="close" /></button></header>
    <div className={s.tabs} role="group" aria-label="Способ настройки вставки">
      {kind !== "html" && <button type="button" aria-pressed={mode === "fields"} className={w.button} disabled={customHtml !== null || busy} onClick={() => setMode("fields")}>Поля</button>}
      <button type="button" aria-pressed={mode === "html"} className={w.button} disabled={busy} onClick={() => setMode("html")}>HTML</button>
      <button type="button" aria-pressed={preview} className={w.button} onClick={() => setPreview(!preview)}>Предпросмотр вставки</button>
    </div>
    {customHtml !== null && kind !== "html" && <p className={s.hint}>HTML изменён вручную. Чтобы не потерять композицию, продолжайте редактировать код; исходные поля больше его не перезаписывают.</p>}
    <div className={`${s.dialogContent} ${preview ? s.withPreview : ""}`}>
      <div className={s.fields}>
        {mode === "html" ? <label className={w.field}>HTML вставки<textarea aria-label="HTML вставки" className={s.code} rows={15} value={html} disabled={busy} onChange={event => setCustomHtml(event.target.value)} spellCheck={false} /><small>Разрешены текст, ссылки, таблицы и файлы этого гайда. Используйте классы guide-card, guide-tone-info, guide-gradient-success, guide-grid-2. JavaScript и произвольные стили не поддерживаются.</small></label> : <>
          {["panel", "button", "steps", "faq"].includes(kind) && <label className={w.field}>{kind === "button" ? "Текст кнопки" : kind === "faq" ? "Вопрос" : "Заголовок"}<input value={fields.title} maxLength={300} onChange={event => patch("title", event.target.value)} disabled={busy} autoFocus /></label>}
          {["panel", "faq"].includes(kind) && <label className={w.field}>{kind === "faq" ? "Ответ" : "Текст"}<textarea rows={5} value={fields.text} onChange={event => patch("text", event.target.value)} disabled={busy} /></label>}
          {kind === "button" && <GuideLinkFields material={material} source={source} href={fields.href} onChange={value => patch("href", value)} />}
          {kind === "button" && <label className={s.check}><input type="checkbox" checked={fields.secondary} onChange={event => patch("secondary", event.target.checked)} />Кнопка с обводкой</label>}
          {kind === "table" && <GuideTableFields fields={fields} patch={patch} />}
          {kind === "image" && <GuideImageFields materialId={material.material_id} fields={fields} patch={patch} onBusy={setUploadBusy} />}
          {["steps", "columns"].includes(kind) && <div className={s.items}>{fields.items.map((item, index) => <fieldset key={index}><legend>{kind === "steps" ? "Шаг" : "Карточка"} {index + 1}</legend><label className={w.field}>Заголовок<input value={item.title} onChange={event => patch("items", fields.items.map((value, ordinal) => ordinal === index ? { ...value, title: event.target.value } : value))} /></label><label className={w.field}>Описание<textarea rows={3} value={item.text} onChange={event => patch("items", fields.items.map((value, ordinal) => ordinal === index ? { ...value, text: event.target.value } : value))} /></label>{fields.items.length > 2 && <button type="button" className={w.linkButton} onClick={() => patch("items", fields.items.filter((_, ordinal) => ordinal !== index))}>Удалить {kind === "steps" ? "шаг" : "карточку"} {index + 1}</button>}</fieldset>)}<button type="button" className={w.button} disabled={fields.items.length >= 6} onClick={() => patch("items", [...fields.items, { title: "", text: "" }])}>Добавить {kind === "steps" ? "шаг" : "карточку"}</button></div>}
          {["panel", "steps", "columns", "faq"].includes(kind) && <fieldset className={s.decoration}><legend>Оформление</legend><div className={s.tones}>{tones.map(tone => <button type="button" key={tone.value} className={`${s.tone} ${s[tone.value]}`} aria-pressed={fields.tone === tone.value} onClick={() => { patch("tone", tone.value);if (tone.value === "neutral") patch("gradient", false); }}>{tone.title}</button>)}</div><label className={s.check}><input type="checkbox" checked={fields.gradient} disabled={fields.tone === "neutral"} onChange={event => patch("gradient", event.target.checked)} />Мягкий градиент</label><label className={s.check}><input type="checkbox" checked={fields.compact} onChange={event => patch("compact", event.target.checked)} />Компактные отступы</label></fieldset>}
          {["button", "image"].includes(kind) && <label className={w.field}>Выравнивание<select value={fields.align} onChange={event => patch("align", event.target.value as GuideInsertFields["align"])}><option value="left">По левому краю</option><option value="center">По центру</option><option value="right">По правому краю</option></select></label>}
        </>}
        {format === "markdown" && <div className={s.conversion}><label className={s.check}><input type="checkbox" checked={confirmConvert} onChange={event => setConfirmConvert(event.target.checked)} />Включить оформленные вставки в этом гайде</label><p>Обычный Markdown сохранится. Блоки <code>profkom-html</code>, если они уже есть в тексте, начнут проходить проверку оформления. Изменение запишется при сохранении черновика.</p></div>}
        {error && <p className={s.error} role="alert">{error}</p>}
      </div>
      {preview && <GuideSourcePreview material={material} content={{ format: "markdown-embeds-v1", body: `${source}\n\n${fence}` }} label="Гайд с новой вставкой" focusEmbedId={id} />}
    </div>
    <footer className={s.actions}><p className={s.hint}>После вставки сохраните черновик и проверьте весь гайд.</p><button type="button" className={w.button} disabled={busy} onClick={close}>Отмена</button><button type="button" className={`${w.button} ${w.primary}`} disabled={busy} onClick={apply}>{busy ? "Загружаем изображение…" : "Вставить в гайд"}</button></footer>
  </dialog>, document.body);
}

function GuideLinkFields({ material, source, href, onChange }: { material: Material; source: string; href: string; onChange: (href: string) => void }) {
  const [destination, setDestination] = useState("url"), [headings, setHeadings] = useState<GuideHeadingChoice[]>([]), [headingFailure, setHeadingFailure] = useState(false);
  const guides = useQuery({ queryKey: ["materials", "insert-link"], queryFn: materialsApi.list, enabled: destination === "guide" });
  const savedRender = source === material.source_content?.body ? material.draft_content?.render ?? material.published_content?.render : undefined;
  useEffect(() => {
    if (destination !== "section") return;
    let current = true;
    void guideHeadingChoices(source, savedRender?.schema_version === 1 ? savedRender : undefined).then(result => { if (current) setHeadings(result); }, () => { if (current) setHeadingFailure(true); });
    return () => { current = false; };
  }, [destination, source, savedRender]);
  return <>
    <label className={w.field}>Куда ведёт кнопка<select value={destination} onChange={event => { setDestination(event.target.value);onChange(""); }}><option value="url">Сайт или раздел сайта</option><option value="guide">Другой гайд</option><option value="section">Раздел этого гайда</option></select></label>
    {destination === "url" && <label className={w.field}>Адрес<input type="text" inputMode="url" value={href} onChange={event => onChange(event.target.value)} placeholder="https://example.org или /blocks" /><small>Внешние ссылки открываются в новой вкладке.</small></label>}
    {destination === "guide" && <><label className={w.field}>Гайд<select value={href} onChange={event => onChange(event.target.value)} disabled={guides.isLoading || !!guides.error}><option value="">Выберите гайд…</option>{(!guides.error ? guides.data?.items ?? [] : []).filter(item => item.kind === "guide" && item.material_id !== material.material_id && item.published_content).map(item => <option key={item.material_id} value={getMaterialRoute(item.material_id)}>{item.title}</option>)}</select></label>{guides.isLoading && <p role="status">Загружаем доступные гайды…</p>}{guides.error && <div role="alert"><p>{userMessage(guides.error)}</p><button type="button" className={w.button} onClick={() => { void guides.refetch(); }}>Повторить список</button></div>}</>}
    {destination === "section" && <><label className={w.field}>Раздел<select value={href} onChange={event => onChange(event.target.value)}><option value="">Выберите заголовок…</option>{headings.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>{headingFailure ? <p role="alert">Не удалось прочитать заголовки. Можно указать якорь в поле адреса.</p> : !headings.length ? <p className={s.hint}>Добавьте заголовок в гайд. Заголовки оформленных вставок появятся после сохранения черновика.</p> : <p className={s.hint}>После перестановки разделов проверьте переход. Заголовки новых вставок появятся после сохранения черновика.</p>}</>}
  </>;
}

type PatchFields = <K extends keyof GuideInsertFields>(key: K, value: GuideInsertFields[K]) => void;
function GuideTableFields({ fields, patch }: { fields: GuideInsertFields; patch: PatchFields }) {
  return <>
    <label className={w.field}>Название таблицы<input value={fields.caption} onChange={event => patch("caption", event.target.value)} placeholder="Например: Что подготовить к встрече" /></label>
    <div className={s.row}><label className={w.field}>Столбцы<select value={fields.headers.length} onChange={event => { const count = Number(event.target.value);patch("headers", Array.from({ length: count }, (_, index) => fields.headers[index] ?? ""));patch("rows", fields.rows.map(row => Array.from({ length: count }, (_, index) => row[index] ?? ""))); }}>{[2, 3, 4, 5, 6].map(count => <option key={count}>{count}</option>)}</select></label><label className={w.field}>Строки<select value={fields.rows.length} onChange={event => patch("rows", Array.from({ length: Number(event.target.value) }, (_, index) => fields.rows[index] ?? fields.headers.map(() => "")))}>{Array.from({ length: 12 }, (_, index) => <option key={index}>{index + 1}</option>)}</select></label></div>
    <div className={s.tableScroll} tabIndex={0} role="region" aria-label="Ячейки таблицы"><table className={s.table}><thead><tr>{fields.headers.map((header, index) => <th key={index}><input value={header} aria-label={`Заголовок столбца ${index + 1}`} onChange={event => patch("headers", fields.headers.map((value, ordinal) => ordinal === index ? event.target.value : value))} /></th>)}</tr></thead><tbody>{fields.rows.map((row, index) => <tr key={index}>{fields.headers.map((_, column) => <td key={column}><input value={row[column] ?? ""} aria-label={`Строка ${index + 1}, столбец ${column + 1}`} onChange={event => patch("rows", fields.rows.map((values, ordinal) => ordinal === index ? values.map((value, cell) => cell === column ? event.target.value : value) : values))} /></td>)}</tr>)}</tbody></table></div>
  </>;
}

async function imageDimensions(file: File): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw Error("Не удалось прочитать размеры изображения.");
    const factor = Math.min(1, 1280 / image.naturalWidth, 4096 / image.naturalHeight);
    return { width: Math.max(1, Math.round(image.naturalWidth * factor)), height: Math.max(1, Math.round(image.naturalHeight * factor)) };
  } finally { URL.revokeObjectURL(url); }
}

function GuideImageFields({ materialId, fields, patch, onBusy }: { materialId: string; fields: GuideInsertFields; patch: PatchFields; onBusy: (busy: boolean) => void }) {
  const [file, setFile] = useState<FileRef | null>(null), [error, setError] = useState(""), [progress, setProgress] = useState<number | null>(null);
  const [natural, setNatural] = useState({ width: 960, height: 640 });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  return <>
    <label className={w.field}>Файл изображения<input aria-label="Файл изображения" type="file" accept=".png,.jpg,.jpeg,.webp" disabled={progress !== null} onChange={async event => {
      const chosen = event.target.files?.[0];event.target.value = "";
      if (!chosen) return;
      const controller = new AbortController();abort.current?.abort();abort.current = controller;
      setError("");setProgress(0);onBusy(true);
      try {
        const metadata = fileMetadata("material", chosen);
        if (!["image/png", "image/jpeg", "image/webp"].includes(metadata.mime_type)) throw Error("Выберите изображение PNG, JPEG или WebP.");
        const size = await imageDimensions(chosen);
        if (controller.signal.aborted) return;
        const uploaded = await filesApi.upload(chosen, { owner_kind: "material", owner_id: materialId, purpose: "material" }, percent => { if (!controller.signal.aborted) setProgress(percent); }, controller.signal);
        if (controller.signal.aborted) return;
        setFile(uploaded);setNatural(size);patch("fileId", uploaded.file_id);patch("width", size.width);patch("height", size.height);
      } catch (failure) { if (!controller.signal.aborted) setError(userMessage(failure)); }
      finally { if (!controller.signal.aborted) { setProgress(null);onBusy(false); } }
    }} /><small>PNG, JPEG или WebP, до 20 МиБ. Файл доступен по тем же правилам, что и гайд.</small></label>
    {progress !== null && <div className={s.row}><p role="status">Загрузка: {progress}%</p><button type="button" className={w.button} onClick={() => { abort.current?.abort();setProgress(null);onBusy(false); }}>Отменить загрузку</button></div>}
    {error && <p className={s.error} role="alert">{error}</p>}
    {file && <p className={s.hint}>Загружено: {file.name}</p>}
    <label className={w.field}>Описание изображения<input value={fields.alt} maxLength={500} onChange={event => patch("alt", event.target.value)} placeholder="Что изображено — для тех, кто не видит картинку" /></label>
    <label className={w.field}>Подпись под изображением<input value={fields.caption} onChange={event => patch("caption", event.target.value)} placeholder="Необязательно" /></label>
    <label className={w.field}>Размер<select value={fields.width <= 320 ? "small" : fields.width <= 640 ? "medium" : "large"} onChange={event => { const width = Math.min(natural.width, event.target.value === "small" ? 320 : event.target.value === "medium" ? 640 : natural.width);patch("width", width);patch("height", Math.max(1, Math.round(natural.height * width / natural.width))); }}><option value="small">Небольшой · до 320 px</option><option value="medium">Средний · до 640 px</option><option value="large">По ширине гайда</option></select></label>
  </>;
}
