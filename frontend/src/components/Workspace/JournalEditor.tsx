import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Material, MaterialText } from "../../utils/api/contract";
import type { JournalBlock, JournalCover, JournalDocument, JournalSection } from "../../utils/api/journal";
import { materialsApi } from "../../utils/api/materials.api";
import { filesApi } from "../../utils/api/files.api";
import { userMessage } from "../../utils/api/messages";
import { fileMetadata } from "../../utils/filePolicy";
import { duplicateJournalBlock, duplicateJournalSection, journalBlockNames, journalHistoryChange, journalHistoryStep, journalId, journalSource, moveJournalItem, newJournalBlock, newJournalSection, parseJournalDraft, type JournalHistory } from "./journalEditorModel";
import s from "./JournalEditor.module.css";
import w from "./Workspace.module.css";

const JournalGuide = lazy(() => import("./JournalGuide").then(module => ({ default: module.JournalGuide })));
const blockTypes = Object.keys(journalBlockNames) as JournalBlock["type"][];
const textHint = "Поддерживается Markdown: **выделение**, списки, таблицы и [ссылки](адрес).";

export function JournalPreview({ material, source, title, onProblemSelect }: { material: Material; source: string; title: string; onProblemSelect?: (id: string | null) => void }) {
  const [attempt, setAttempt] = useState(0), [width, setWidth] = useState("full");
  const [result, setResult] = useState<{ key: string; content?: MaterialText; error?: unknown }>();
  const key = JSON.stringify([material.material_id, material.revision, source, attempt]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void materialsApi.preview(material.material_id, { expected_revision: material.revision, content: { format: "journal-v1", body: source } }, controller.signal).then(content => {
        if (!controller.signal.aborted) setResult({ key, content });
      }, error => { if (!controller.signal.aborted) setResult({ key, error }); });
    }, 350);
    return () => { clearTimeout(timer);controller.abort(); };
  }, [key, material.material_id, material.revision, source]);
  const current = result?.key === key ? result : undefined;
  return <section className={s.preview} aria-label="Предпросмотр всего журнала">
    <div className={s.toolbar}><strong>Так выглядит весь гайд</strong><label className={w.field}>Ширина предпросмотра<select value={width} onChange={event => setWidth(event.target.value)}><option value="full">По окну</option><option value="390">Телефон · 390 px</option><option value="768">Планшет · 768 px</option><option value="1280">Компьютер · 1280 px</option></select></label></div>
    {!current ? <p role="status">Проверяем оформление…</p> : current.error ? <div role="alert"><p>{userMessage(current.error)}</p><button className={w.button} type="button" onClick={() => setAttempt(attempt + 1)}>Повторить проверку</button></div> : current.content && <>
      {!!current.content.render?.diagnostics.length && <div role="alert" className={s.error}><strong>Перед публикацией исправьте замечания</strong><ul>{current.content.render.diagnostics.map((problem, index) => <li key={index}>{problem.message}{onProblemSelect && <> <button type="button" className={w.linkButton} aria-label={`Исправить: ${problem.message}`} onClick={() => onProblemSelect(problem.block_id)}>Исправить</button></>}</li>)}</ul><p>Черновик можно сохранить с замечаниями.</p></div>}
      <div className={s.previewScroll}><div className={s.previewCanvas} style={{ width: width === "full" ? "100%" : `${width}px` }}><Suspense fallback={<p role="status">Загружаем гайд…</p>}><JournalGuide content={current.content} materialId={`${material.material_id}-preview`} title={title} /></Suspense></div></div>
    </>}
  </section>;
}

/** Controlled JSON is the only source of truth: reopening never recreates blocks. */
export function JournalEditor({ material, value, title, onChange, disabled, onBusyChange }: {
  material: Material; value: string; title: string; onChange: (value: string) => void; disabled: boolean; onBusyChange: (busy: boolean) => void;
}) {
  const [history, setHistory] = useState<JournalHistory>({ past: [], present: value, future: [] });
  // Replacing with the server's version is a new editing baseline, not an undo entry.
  if (history.present !== value) setHistory({ past: [], present: value, future: [] });
  const [cancelUpload, setCancelUpload] = useState<(() => void) | null>(null);
  const busyChanged = (busy: boolean, cancel?: () => void) => { setCancelUpload(() => cancel ?? null);onBusyChange(busy); };
  const [selected, setSelected] = useState("cover"), [view, setView] = useState<"edit" | "preview" | "source">("edit"), [addType, setAddType] = useState<JournalBlock["type"]>("text");
  const editorElement = useRef<HTMLElement>(null), [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => { if (focusRequest) editorElement.current?.querySelector<HTMLElement>('[data-journal-edit-fields] input:not(:disabled),[data-journal-edit-fields] textarea:not(:disabled),[aria-label="Исходник журнала"]')?.focus(); }, [focusRequest]);
  const parsed = parseJournalDraft(value), document = parsed.document;
  const readonly = disabled || !material.capabilities.includes("edit_html_material");
  const commitSource = (source: string) => { if (readonly) return;setHistory(journalHistoryChange(history, source));onChange(source); };
  const commit = (next: JournalDocument) => commitSource(journalSource(next));
  const undo = (redo = false) => { if (readonly) return;const next = journalHistoryStep(history, redo);setHistory(next);onChange(next.present); };
  const section = document?.sections.find(item => item.id === selected || item.blocks.some(block => block.id === selected));
  const block = section?.blocks.find(item => item.id === selected);
  const updateSection = (next: JournalSection) => { if (document) commit({ ...document, sections: document.sections.map(item => item.id === next.id ? next : item) }); };
  const count = document?.sections.reduce((total, item) => total + item.blocks.length, 0) ?? 0;
  const selectedIndex = section && document ? document.sections.indexOf(section) : -1;
  const controls = (kind: "раздел" | "блок", index: number, length: number, move: (delta: number) => void, duplicate: () => void, remove: () => void, duplicateDisabled: boolean) => <div className={s.actions}>
    <button type="button" className={w.button} disabled={readonly || index === 0} aria-label={`Переместить ${kind} вверх`} onClick={() => move(-1)}>↑</button><button type="button" className={w.button} disabled={readonly || index === length - 1} aria-label={`Переместить ${kind} вниз`} onClick={() => move(1)}>↓</button>
    <button type="button" className={w.button} disabled={readonly || duplicateDisabled} onClick={duplicate}>Дублировать {kind}</button><button type="button" className={`${w.button} ${w.danger}`} disabled={readonly || length <= 1} onClick={remove}>Удалить {kind}</button>
  </div>;
  return <section ref={editorElement} className={s.editor} aria-label="Редактор журнала" onKeyDown={event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) { event.preventDefault();undo(event.shiftKey); }
  }}>
    <div className={s.toolbar}><div className={s.tabs} role="group" aria-label="Режим журнала">{([["edit", "Редактирование"], ["preview", "Предпросмотр"], ["source", "Исходник"]] as const).map(([mode, label]) => <button type="button" key={mode} className={w.button} aria-pressed={view === mode} disabled={disabled} onClick={() => setView(mode)}>{label}</button>)}</div><div className={s.actions}><button className={w.button} type="button" disabled={readonly || !history.past.length} onClick={() => undo()}>Отменить</button><button className={w.button} type="button" disabled={readonly || !history.future.length} onClick={() => undo(true)}>Повторить</button></div></div>
    {/* ActionForm disables its entire fieldset during uploads. The cancellation
        control must live outside that fieldset, just like upload dialogs do. */}
    {cancelUpload && createPortal(<div className={s.uploadNotice} role="status"><span>Загружаем изображение в гайд…</span><button type="button" className={w.button} onClick={cancelUpload}>Отменить загрузку</button></div>, window.document.body)}
    {!material.capabilities.includes("edit_html_material") && <p className={s.hint}>Редактирование оформленных гайдов сейчас недоступно. Сохранённый журнал можно просмотреть.</p>}
    {view === "preview" ? <JournalPreview material={material} source={value} title={title} onProblemSelect={readonly ? undefined : id => { const exists = !!id && document?.sections.some(section => section.id === id || section.blocks.some(block => block.id === id));setSelected(exists ? id! : "cover");setView(exists ? "edit" : "source");setFocusRequest(current => current + 1); }} /> : view === "source" || !document ? <div className={s.panel}>{parsed.error && <p role="alert" className={s.error}>{parsed.error}</p>}<label className={w.field}>Исходник журнала<textarea aria-label="Исходник журнала" value={value} onChange={event => commitSource(event.target.value)} disabled={readonly} rows={24} spellCheck={false} className={s.code} /><small>Для переноса и сложных правок. Не удаляйте номера разделов и блоков: на них опираются ссылки. Можно отменить изменение.</small></label></div> : <div className={s.layout}>
      <nav className={s.outline} aria-label="Структура журнала"><button type="button" className={s.outlineButton} aria-current={!section ? "true" : undefined} disabled={disabled} onClick={() => setSelected("cover")}><strong>Обложка и вступление</strong></button>
        <ol>{document.sections.map((item, index) => <li key={item.id}><button type="button" className={s.outlineButton} aria-current={selected === item.id ? "true" : undefined} disabled={disabled} onClick={() => setSelected(item.id)}><span className={s.number}>{String(index + 1).padStart(2, "0")}</span>{" "}<strong>{item.title || "Раздел без названия"}</strong></button><ul>{item.blocks.map(part => <li key={part.id}><button type="button" className={s.outlineButton} aria-current={selected === part.id ? "true" : undefined} disabled={disabled} onClick={() => setSelected(part.id)}><span>{journalBlockNames[part.type]}</span>{" "}{"title" in part && part.title && <small>{part.title}</small>}</button></li>)}</ul></li>)}</ol>
        <button type="button" className={w.button} disabled={readonly || document.sections.length >= 20 || count >= 60} onClick={() => { const next = newJournalSection();commit({ ...document, sections: [...document.sections, next] });setSelected(next.id); }}>Добавить раздел</button>
      </nav>
      <div className={s.panel}><fieldset className={s.fields} disabled={readonly} data-journal-edit-fields>
        {!section ? <><h2>Обложка и вступление</h2><p className={s.hint}>Название берётся из поля «Название материала» выше. Здесь — короткое начало и обложка.</p><TextField label="Надпись над названием" value={document.eyebrow} onChange={eyebrow => commit({ ...document, eyebrow })} max={120} /><TextField label="Вступление" value={document.intro} onChange={intro => commit({ ...document, intro })} multiline max={1000} /><CoverFields cover={document.cover} materialId={material.material_id} onChange={cover => commit({ ...document, cover })} onBusyChange={busyChanged} /></> : <>
          <div className={s.sectionContext}>{String(selectedIndex + 1).padStart(2, "0")} / {section.title}</div>
          {!block ? <><h2>Раздел</h2><TextField label="Название раздела" value={section.title} onChange={title => updateSection({ ...section, title })} max={240} /><TextField label="Короткая подпись раздела" value={section.label} onChange={label => updateSection({ ...section, label })} max={120} /><label className={w.field}>Ссылка на раздел<input aria-label="Ссылка на раздел" readOnly value={`#${section.id}`} onFocus={event => event.target.select()} /><small>Сохранится при перестановке и переименовании раздела.</small></label>
            {controls("раздел", selectedIndex, document.sections.length, delta => commit({ ...document, sections: moveJournalItem(document.sections, selectedIndex, selectedIndex + delta) }), () => { const copy = duplicateJournalSection(section);commit({ ...document, sections: [...document.sections.slice(0, selectedIndex + 1), copy, ...document.sections.slice(selectedIndex + 1)] });setSelected(copy.id); }, () => { commit({ ...document, sections: document.sections.filter(item => item.id !== section.id) });setSelected("cover"); }, document.sections.length >= 20 || count + section.blocks.length > 60)}
          </> : <><h2>{journalBlockNames[block.type]}</h2><BlockFields key={block.id} block={block} materialId={material.material_id} onChange={next => updateSection({ ...section, blocks: section.blocks.map(item => item.id === next.id ? next : item) })} onBusyChange={busyChanged} />
            {controls("блок", section.blocks.indexOf(block), section.blocks.length, delta => updateSection({ ...section, blocks: moveJournalItem(section.blocks, section.blocks.indexOf(block), section.blocks.indexOf(block) + delta) }), () => { const copy = duplicateJournalBlock(block), index = section.blocks.indexOf(block);updateSection({ ...section, blocks: [...section.blocks.slice(0, index + 1), copy, ...section.blocks.slice(index + 1)] });setSelected(copy.id); }, () => { updateSection({ ...section, blocks: section.blocks.filter(item => item.id !== block.id) });setSelected(section.id); }, section.blocks.length >= 20 || count >= 60)}
            {document.sections.length > 1 && <label className={w.field}>Перенести в раздел<select value={section.id} disabled={readonly || section.blocks.length <= 1} onChange={event => commit({ ...document, sections: document.sections.map(item => item.id === section.id ? { ...item, blocks: item.blocks.filter(part => part.id !== block.id) } : item.id === event.target.value ? { ...item, blocks: [...item.blocks, block] } : item) })}>{document.sections.map(item => <option key={item.id} value={item.id} disabled={item.id !== section.id && item.blocks.length >= 20}>{item.title}</option>)}</select>{section.blocks.length <= 1 && <small>В разделе должен остаться хотя бы один блок.</small>}</label>}
          </>}
          <div className={s.add}><label className={w.field}>Новый блок<select value={addType} onChange={event => setAddType(event.target.value as JournalBlock["type"])}>{blockTypes.map(type => <option value={type} key={type}>{journalBlockNames[type]}</option>)}</select></label><button type="button" className={w.button} disabled={readonly || section.blocks.length >= 20 || count >= 60} onClick={() => { const next = newJournalBlock(addType);updateSection({ ...section, blocks: [...section.blocks, next] });setSelected(next.id); }}>Добавить блок</button></div>
        </>}
      </fieldset></div>
    </div>}
    <p className={s.hint}>Сохранение обновит только черновик. Читатели увидят изменения после отдельной публикации.</p>
  </section>;
}

function TextField({ label, value, onChange, multiline = false, max = 240, markdown = false }: { label: string; value: string; onChange: (value: string) => void; multiline?: boolean; max?: number; markdown?: boolean }) {
  const id = useId();
  return <label className={w.field} htmlFor={id}>{label}{multiline ? <textarea id={id} aria-label={label} rows={6} value={value} maxLength={max} onChange={event => onChange(event.target.value)} /> : <input id={id} aria-label={label} value={value} maxLength={max} onChange={event => onChange(event.target.value)} />}{markdown && <small>{textHint}</small>}</label>;
}
function CoverFields({ cover, materialId, onChange, onBusyChange }: { cover: JournalCover | null; materialId: string; onChange: (value: JournalCover | null) => void; onBusyChange: (busy: boolean, cancel?: () => void) => void }) {
  return <><label className={w.field}>Обложка<select value={cover?.kind ?? "none"} onChange={event => onChange(event.target.value === "none" ? null : event.target.value === "poster" ? { kind: "poster", eyebrow: "В двух словах", title: "", caption: "", tone: "yellow" } : { kind: "image", file_id: "", alt: "", caption: "", width: 1280, height: 720 })}><option value="none">Без обложки</option><option value="poster">Цветная карточка</option><option value="image">Изображение</option></select></label>
    {cover?.kind === "poster" && <><TextField label="Надпись на обложке" value={cover.eyebrow} onChange={eyebrow => onChange({ ...cover, eyebrow })} max={120} /><TextField label="Главная мысль обложки" value={cover.title} onChange={title => onChange({ ...cover, title })} /><TextField multiline label="Подпись обложки" value={cover.caption} onChange={caption => onChange({ ...cover, caption })} /><label className={w.field}>Цвет обложки<select value={cover.tone} onChange={event => onChange({ ...cover, tone: event.target.value as typeof cover.tone })}><option value="yellow">Жёлтый</option><option value="mint">Мятный</option><option value="peach">Персиковый</option><option value="sky">Небесный</option><option value="lilac">Сиреневый</option></select></label></>}
    {cover?.kind === "image" && <ImageFields value={cover} materialId={materialId} onChange={value => onChange({ ...cover, ...value })} onBusyChange={onBusyChange} />}
  </>;
}
function BlockFields({ block, materialId, onChange, onBusyChange }: { block: JournalBlock; materialId: string; onChange: (value: JournalBlock) => void; onBusyChange: (busy: boolean, cancel?: () => void) => void }) {
  const body = (label: string, value: string, onChange: (value: string) => void) => <TextField label={label} value={value} onChange={onChange} multiline max={8192} markdown />;
  switch (block.type) {
    case "text": return body("Текст блока", block.body, value => onChange({ ...block, body: value }));
    case "legacy": return <><p className={s.hint}>Исходный Markdown и HTML-вставки сохранены целиком. Сложное оформление редактируется здесь; проверяйте результат в предпросмотре.</p><TextField label="Исходник прежних вставок" value={block.body} onChange={body => onChange({ ...block, body })} multiline max={131072} /></>;
    case "note": return <><TextField label="Заголовок плашки" value={block.title} onChange={title => onChange({ ...block, title })} /><label className={w.field}>Оформление плашки<select value={block.tone} onChange={event => onChange({ ...block, tone: event.target.value as typeof block.tone })}><option value="neutral">Спокойное</option><option value="info">Информация · небесное</option><option value="success">Подсказка · мятное</option><option value="warning">Внимание · персиковое</option></select></label>{body("Текст плашки", block.body, value => onChange({ ...block, body: value }))}</>;
    case "comparison": return <><TextField label="Левая подпись" value={block.before_label} onChange={before_label => onChange({ ...block, before_label })} max={120} />{body("Левая часть сравнения", block.before, before => onChange({ ...block, before }))}<TextField label="Правая подпись" value={block.after_label} onChange={after_label => onChange({ ...block, after_label })} max={120} />{body("Правая часть сравнения", block.after, after => onChange({ ...block, after }))}</>;
    case "facts": return <>{block.items.map((item, index) => <fieldset className={s.item} key={index}><legend>Карточка {index + 1}</legend><TextField label={`Подпись карточки ${index + 1}`} value={item.label} onChange={label => onChange({ ...block, items: block.items.map((value, ordinal) => ordinal === index ? { ...value, label } : value) })} max={120} />{body(`Текст карточки ${index + 1}`, item.body, body => onChange({ ...block, items: block.items.map((value, ordinal) => ordinal === index ? { ...value, body } : value) }))}<ItemControls index={index} length={block.items.length} minimum={2} onMove={to => onChange({ ...block, items: moveJournalItem(block.items, index, to) })} onDelete={() => onChange({ ...block, items: block.items.filter((_, ordinal) => ordinal !== index) })} /></fieldset>)}<button type="button" className={w.button} disabled={block.items.length >= 4} onClick={() => onChange({ ...block, items: [...block.items, { label: "", body: "" }] })}>Добавить карточку</button></>;
    case "steps": return <>{block.items.map((item, index) => <fieldset className={s.item} key={index}><legend>Шаг {index + 1}</legend><TextField label={`Кто делает шаг ${index + 1}`} value={item.role} onChange={role => onChange({ ...block, items: block.items.map((value, ordinal) => ordinal === index ? { ...value, role } : value) })} max={120} /><TextField label={`Название шага ${index + 1}`} value={item.title} onChange={title => onChange({ ...block, items: block.items.map((value, ordinal) => ordinal === index ? { ...value, title } : value) })} />{body(`Описание шага ${index + 1}`, item.body, body => onChange({ ...block, items: block.items.map((value, ordinal) => ordinal === index ? { ...value, body } : value) }))}<ItemControls index={index} length={block.items.length} minimum={2} onMove={to => onChange({ ...block, items: moveJournalItem(block.items, index, to) })} onDelete={() => onChange({ ...block, items: block.items.filter((_, ordinal) => ordinal !== index) })} /></fieldset>)}<button type="button" className={w.button} disabled={block.items.length >= 6} onClick={() => onChange({ ...block, items: [...block.items, { role: "", title: "", body: "" }] })}>Добавить шаг</button></>;
    case "image": return <><ImageFields value={block} materialId={materialId} onChange={value => onChange({ ...block, ...value })} onBusyChange={onBusyChange} /><label className={s.checkbox}><input type="checkbox" checked={block.collapsed} onChange={event => onChange({ ...block, collapsed: event.target.checked })} />Показывать по нажатию «Посмотреть пример»</label></>;
    case "disclosure": return <><TextField label="Название подробностей" value={block.title} onChange={title => onChange({ ...block, title })} />{body("Скрытый текст", block.body, body => onChange({ ...block, body }))}</>;
    case "switcher": return <><TextField label="Название набора примеров" value={block.title} onChange={title => onChange({ ...block, title })} />{block.options.map((option, index) => <fieldset className={s.item} key={option.id}><legend>Вариант {index + 1}</legend><TextField label={`Название варианта ${index + 1}`} value={option.label} onChange={label => onChange({ ...block, options: block.options.map(value => value.id === option.id ? { ...value, label } : value) })} max={120} />{body(`Текст варианта ${index + 1}`, option.body, body => onChange({ ...block, options: block.options.map(value => value.id === option.id ? { ...value, body } : value) }))}<ItemControls index={index} length={block.options.length} minimum={2} onMove={to => onChange({ ...block, options: moveJournalItem(block.options, index, to) })} onDelete={() => onChange({ ...block, options: block.options.filter(value => value.id !== option.id) })} /></fieldset>)}<button type="button" className={w.button} disabled={block.options.length >= 4} onClick={() => onChange({ ...block, options: [...block.options, { id: journalId("option"), label: "", body: "" }] })}>Добавить вариант</button></>;
  }
}
function ItemControls({ index, length, minimum, onMove, onDelete }: { index: number; length: number; minimum: number; onMove: (to: number) => void; onDelete: () => void }) {
  return <div className={s.actions}><button className={w.button} type="button" disabled={index === 0} aria-label="Передвинуть элемент вверх" onClick={() => onMove(index - 1)}>↑</button><button className={w.button} type="button" disabled={index === length - 1} aria-label="Передвинуть элемент вниз" onClick={() => onMove(index + 1)}>↓</button><button className={w.button} type="button" disabled={length <= minimum} onClick={onDelete}>Удалить элемент</button></div>;
}

type ImageValue = { file_id: string; alt: string; caption: string; width: number; height: number };
function ImageFields({ value, materialId, onChange, onBusyChange }: { value: ImageValue; materialId: string; onChange: (value: ImageValue) => void; onBusyChange: (busy: boolean, cancel?: () => void) => void }) {
  const [upload, setUpload] = useState<{ controller: AbortController; progress: number } | null>(null), [error, setError] = useState("");
  // A cancelled/unmounted upload cannot change either the source or the busy guard.
  useEffect(() => () => { upload?.controller.abort(); }, [upload?.controller]);
    return <>
    <label className={w.field}>Файл изображения<input aria-label="Файл изображения" type="file" accept=".png,.jpg,.jpeg,.webp" onChange={async event => {
      const file = event.target.files?.[0];event.target.value = "";if (!file || upload) return;
      const controller = new AbortController();setUpload({ controller, progress: 0 });setError("");onBusyChange(true, () => { controller.abort();setUpload(null);onBusyChange(false); });
      let url: string | undefined;
      try {
        const metadata = fileMetadata("material", file);if (!["image/png", "image/jpeg", "image/webp"].includes(metadata.mime_type)) throw Error("Выберите PNG, JPEG или WebP.");
        url = URL.createObjectURL(file);const image = new Image();image.src = url;await image.decode();
        if (!image.naturalWidth || !image.naturalHeight) throw Error("Не удалось прочитать изображение.");
        if (controller.signal.aborted) return;
        const result = await filesApi.upload(file, { owner_kind: "material", owner_id: materialId, purpose: "material" }, progress => { if (!controller.signal.aborted) setUpload({ controller, progress }); }, controller.signal);
        if (controller.signal.aborted) return;
        const factor = Math.min(1, 1280 / image.naturalWidth, 4096 / image.naturalHeight);
        // Update all image fields atomically; partial callbacks can overwrite each other.
        onChange({ ...value, file_id: result.file_id, width: Math.max(1, Math.round(image.naturalWidth * factor)), height: Math.max(1, Math.round(image.naturalHeight * factor)) });
      } catch (failure) { if (!controller.signal.aborted) setError(userMessage(failure)); }
      finally { if (url) URL.revokeObjectURL(url);if (!controller.signal.aborted) { setUpload(null);onBusyChange(false); } }
    }} /><small>PNG, JPEG или WebP, до 20 МиБ. Файл будет привязан к этому гайду.</small></label>
    {upload && <p role="status">Загрузка: {upload.progress}%</p>}
    {error && <p role="alert" className={s.error}>{error}</p>}{value.file_id && <p className={s.hint}>Изображение сохранено. Его можно проверить в предпросмотре.</p>}
    <TextField label="Описание изображения" value={value.alt} onChange={alt => onChange({ ...value, alt })} max={240} /><TextField multiline label="Подпись под изображением" value={value.caption} onChange={caption => onChange({ ...value, caption })} />
    <div className={s.actions}><label className={w.field}>Ширина<input type="number" min={1} max={4096} value={value.width} onChange={event => onChange({ ...value, width: Number(event.target.value) })} /></label><label className={w.field}>Высота<input type="number" min={1} max={4096} value={value.height} onChange={event => onChange({ ...value, height: Number(event.target.value) })} /></label></div>
  </>;
}
