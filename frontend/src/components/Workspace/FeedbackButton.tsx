import { useEffect, useId, useRef, useState } from "react";
import { useLocation, Link } from "react-router-dom";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { isActiveSession, useSession } from "../../utils/session";
import { supportApi, type FeedbackInput, type FeedbackReceipt } from "../../utils/api/support.api";
import { fieldMessage, userMessage } from "../../utils/api/messages";
import { canRetainData, normalizeApiError } from "../../utils/api/request";
import { clearDiagnostics, recordDiagnostic, snapshotDiagnostics } from "../../utils/diagnostics";
import { useConfirmedNavigation, useGuardedAction, useUnsavedChanges } from "./unsavedChangesHooks";
import { Glyph } from "./WorkspaceUI";
import { getTaskRoute } from "../../utils/routes";
import { createClientId } from "../../utils/clientId";
import { FileButton } from "./FileButton";
import s from "./Workspace.module.css";
import l from "./WorkspaceLayout.module.css";
import f from "./FeedbackButton.module.css";

function BugIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="7" y="7" width="10" height="14" rx="5" /><path d="M9 7V5a3 3 0 0 1 6 0v2M3 10h4m10 0h4M3 15h4m10 0h4M5 21l3-3m8 0 3 3M12 8v12" /></svg>; }
export function FeedbackProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false), [diagnostics, setDiagnostics] = useState<FeedbackInput["diagnostics"]>(null);
  const location = useLocation();
  const { session } = useSession();
  useEffect(() => { clearDiagnostics(); }, [session?.user_id]);
  const start = () => { setDiagnostics(snapshotDiagnostics(location.pathname));setOpen(true); };
  useEffect(() => { recordDiagnostic("navigation", "route_open", location.pathname); }, [location.pathname]);
  useEffect(() => {
    const failure = () => recordDiagnostic("error", "unhandled_error", window.location.pathname);
    const click = (event: MouseEvent) => { if ((event.target as Element | null)?.closest?.("button,[role=button]")) recordDiagnostic("action", "button_click", window.location.pathname); };
    window.addEventListener("error", failure);window.addEventListener("unhandledrejection", failure);document.addEventListener("click", click);
    return () => { window.removeEventListener("error", failure);window.removeEventListener("unhandledrejection", failure);document.removeEventListener("click", click); };
  }, []);
  return <>{children}<button type="button" className={f.trigger} aria-label="Сообщить об ошибке или предложить улучшение" title="Сообщить об ошибке или предложить улучшение" onClick={start}><BugIcon /></button>{open && <FeedbackForm diagnostics={diagnostics} onClose={() => setOpen(false)} />}</>;
}
type FieldErrors = Partial<Record<"title" | "body" | "contact" | "screenshot", string>>;
const SCREENSHOT_LIMIT = 2 * 1024 * 1024;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const BROKEN_SCREENSHOT = "Изображение повреждено или это не PNG. Выберите другой файл или уберите его.";
/** A PNG of the allowed size: the server rechecks every chunk, the form the cheap part (GL-03). */
async function screenshotProblem(file: File) {
  if (file.size > SCREENSHOT_LIMIT) return "Изображение больше 2 МиБ. Уменьшите его или выберите другое.";
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const png = PNG_SIGNATURE.every((byte, index) => head[index] === byte) && String.fromCharCode(...head.slice(12, 16)) === "IHDR";
  return png ? "" : BROKEN_SCREENSHOT;
}
/** A refusal of the submitted fields, shown at the field it concerns. */
function refusedFields(failure: unknown, screenshot: boolean): FieldErrors {
  const e = normalizeApiError(failure), errors: FieldErrors = {};
  if (e.status === 413) return screenshot ? { screenshot: "Изображение слишком большое. Уменьшите его или уберите." } : {};
  if (e.status !== 422 || !Array.isArray(e.fields.errors)) return errors;
  for (const item of e.fields.errors as { loc?: unknown[] }[]) {
    const name = item?.loc?.[1];
    if (name === "screenshot") errors.screenshot = BROKEN_SCREENSHOT;
    else if (name === "title" || name === "body") errors[name] = /too_short|missing/.test(String((item as { type?: unknown }).type)) ? "Заполните поле." : fieldMessage(item);
    else if (name === "contact") errors.contact = fieldMessage(item);
  }
  return errors;
}
function refusalText(failure: unknown) {
  const e = normalizeApiError(failure);
  if (e.status === 429) return "Слишком много обращений подряд. Подождите минуту и отправьте снова.";
  if (e.status === 413) return "Обращение слишком большое. Сократите описание.";
  if (e.status === 409 && e.code === "feedback_duplicate_key") return "Номер запроса уже занят другим обращением. Отправьте снова — будет выдан новый номер.";
  return userMessage(failure);
}
function FeedbackForm({ diagnostics, onClose }: { diagnostics: FeedbackInput["diagnostics"]; onClose: () => void }) {
  const { session } = useSession(), scope = useId(), leave = useGuardedAction(scope), navigate = useConfirmedNavigation(), dialog = useRef<HTMLDivElement>(null), restore = useRef<HTMLElement | null>(null);
  const canTrack = isActiveSession(session) && !session?.password_change_required;
  const context = useQuery({ queryKey: ["supportContext"], queryFn: supportApi.context, enabled: isActiveSession(session) && !session?.password_change_required });
  const [kind, setKind] = useState<"bug" | "feature">("bug"), [title, setTitle] = useState(""), [body, setBody] = useState(""), [contact, setContact] = useState(""), [include, setInclude] = useState(true), [screenshot, setScreenshot] = useState<string | null>(null), [screenshotName, setScreenshotName] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [result, setResult] = useState<FeedbackReceipt | null>(null), [fields, setFields] = useState<FieldErrors>({});
  // Set only while the last attempt may have been stored (no answer, 5xx): the retry then
  // repeats the same payload under the same key; a definite refusal opens the form again.
  const [attempted, setAttempted] = useState(false);
  const payload = useRef<FeedbackInput | null>(null), nonce = useRef<string | null>(null), titleId = useId(), fileInput = useRef<HTMLInputElement>(null);
  const errorId = (name: keyof FieldErrors) => fields[name] ? `${scope}-${name}-error` : undefined;
  const fieldError = (name: keyof FieldErrors) => fields[name] && <span id={errorId(name)} className={s.fieldError}>{fields[name]}</span>;
  const edited = (name: keyof FieldErrors) => setFields(current => { if (!current[name]) return current;const next = { ...current };delete next[name];return next; });
  const locked = busy || attempted;
  useUnsavedChanges({ scope, dirty: !result && !!(title || body || contact || screenshot), busy, label: "Обращение в поддержку" });
  const close = () => leave(onClose);
  useEffect(() => { restore.current = document.activeElement as HTMLElement;dialog.current?.querySelector<HTMLInputElement>("input[name=feedback-title]")?.focus();return () => { if (restore.current?.isConnected) restore.current.focus(); }; }, []);
  const clearScreenshot = () => { setScreenshot(null);setScreenshotName("");edited("screenshot");if (fileInput.current) fileInput.current.value = ""; };
  const loadScreenshot = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    const problem = file.type === "image/png" ? await screenshotProblem(file).catch(() => BROKEN_SCREENSHOT) : "Выберите изображение в формате PNG.";
    if (problem) { setFields(current => ({ ...current, screenshot: problem }));setBusy(false);if (fileInput.current) fileInput.current.value = "";return; }
    const reader = new FileReader();
    reader.onload = () => { setScreenshot(String(reader.result));setScreenshotName(file.name);edited("screenshot");setBusy(false); };
    reader.onerror = () => { setFields(current => ({ ...current, screenshot: "Не удалось прочитать изображение." }));setBusy(false); };
    reader.readAsDataURL(file);
  };
  const send = async () => {
    if (busy) return;
    setError("");
    if (!attempted) {
      const empty: FieldErrors = { ...(!title.trim() && { title: "Заполните поле." }), ...(!body.trim() && { body: "Заполните поле." }) };
      if (empty.title || empty.body) { setFields(current => ({ ...current, ...empty }));return; }
    }
    setBusy(true);
    try {
      nonce.current ??= createClientId();
      payload.current ??= { kind, title: title.trim(), body: body.trim(), contact: contact.trim() || null, idempotency_key: nonce.current, diagnostics: include ? diagnostics : null, screenshot };
    }
    catch (failure) { setError(userMessage(failure));setBusy(false);return; }
    try { setAttempted(true);setResult(await supportApi.submit(payload.current)); }
    catch (failure) {
      if (canRetainData(failure)) setError(`${userMessage(failure)} Повторная отправка использует тот же номер запроса.`);
      else {
        // 4xx: nothing was stored under this key (the same payload is refused the same way),
        // so the fields open for a fix and the next attempt gets a fresh key (GL-03).
        payload.current = null;nonce.current = null;setAttempted(false);
        const refused = refusedFields(failure, !!screenshot);setFields(refused);
        setError(Object.keys(refused).length ? "Исправьте отмеченные поля." : refusalText(failure));
      }
    }
    finally { setBusy(false); }
  };
  return createPortal(<div className={f.overlay} onClick={event => { if (event.target === event.currentTarget && !busy) close(); }}>
    <div ref={dialog} className={`${f.dialog} ${s.page} ${l.controls}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault();event.stopPropagation();if (!busy) close(); }
      if (event.key === "Tab") { const nodes = [...dialog.current!.querySelectorAll<HTMLElement>("button:not(:disabled),a[href],input:not(:disabled):not([hidden]),textarea:not(:disabled),select:not(:disabled),summary")];const first = nodes[0], last = nodes.at(-1);if (event.shiftKey && document.activeElement === first) { event.preventDefault();last?.focus(); }else if (!event.shiftKey && document.activeElement === last) { event.preventDefault();first?.focus(); } }
    }}>
      <header className={f.header}><h2 id={titleId}>Обращение в поддержку</h2><button type="button" className={s.button} aria-label="Закрыть обращение" disabled={busy} onClick={close}><Glyph name="close" /></button></header>
      {result ? <div className={s.stack}><p role="status">{result.task_key ? `Создан тикет ${result.task_key}` : "Обращение сохранено. Тикет появится после подключения очереди поддержки."}</p>{result.task_id && canTrack && <Link to={getTaskRoute(result.task_id)} onClick={onClose}>Открыть тикет</Link>}<p className={s.muted}>Номер обращения: {result.report_id}</p><button className={s.button} onClick={onClose}>Готово</button></div> : <form className={s.stack} noValidate onSubmit={event => { event.preventDefault();void send(); }}>
        <label className={s.field}>Тип обращения<select value={kind} disabled={locked} onChange={event => setKind(event.target.value as typeof kind)}><option value="bug">Ошибка</option><option value="feature">Предложение</option></select></label>
        <label className={s.field}>Кратко о проблеме<input name="feedback-title" value={title} maxLength={240} required disabled={locked} aria-invalid={!!fields.title || undefined} aria-describedby={errorId("title")} onChange={event => { setTitle(event.target.value);edited("title"); }} />{fieldError("title")}</label>
        <label className={s.field}>Описание<textarea value={body} rows={7} maxLength={16000} required disabled={locked} aria-invalid={!!fields.body || undefined} aria-describedby={errorId("body")} onChange={event => { setBody(event.target.value);edited("body"); }} placeholder="Что вы сделали, что ожидали и что произошло?" />{fieldError("body")}</label>
        {!canTrack && <label className={s.field}>Контакт для ответа — необязательно<input value={contact} maxLength={300} disabled={locked} aria-invalid={!!fields.contact || undefined} aria-describedby={errorId("contact")} onChange={event => { setContact(event.target.value);edited("contact"); }} />{fieldError("contact")}</label>}
        <label className={f.option}><input type="checkbox" checked={include} disabled={locked} onChange={event => setInclude(event.target.checked)} />Приложить техническую диагностику</label>
        {include && <details className={s.details}><summary>Что будет приложено</summary><p className={s.muted}>Версия, маршрут, размер окна и последние действия/коды ошибок. Значения полей, пароли и содержимое запросов не собираются. Хранение — 90 дней.</p><pre className={f.diagnostics}>{JSON.stringify(diagnostics, null, 2)}</pre></details>}
        {window.location.hostname !== "test.profcom-cmc.online" && <div className={s.field}><span>Изображение экрана — по желанию, PNG до 2 МиБ</span><FileButton label="Выбрать изображение" fileName={screenshotName} accept="image/png" disabled={locked} inputRef={fileInput} invalid={!!fields.screenshot} describedBy={errorId("screenshot")} onChange={event => void loadScreenshot(event.currentTarget.files?.[0])} />{fieldError("screenshot")}</div>}
        {screenshot && <><img className={f.preview} src={screenshot} alt="Предварительный просмотр приложения к обращению" /><button type="button" className={s.button} disabled={locked} onClick={clearScreenshot}>Убрать изображение</button></>}
        {error && <p role="alert" className={s.error}>{error}</p>}
        <button type="submit" className={`${s.button} ${s.primary}`} disabled={busy}>{busy ? "Отправляем…" : attempted ? "Повторить отправку" : "Отправить обращение"}</button>
        {(context.data?.can_configure || context.data?.can_triage) && <Link to="/support" onClick={event => { event.preventDefault();navigate("/support", onClose); }}>Управление поддержкой сайта</Link>}
        {canTrack && !context.data?.can_configure && !context.data?.can_triage && <Link to="/support" onClick={event => { event.preventDefault();navigate("/support", onClose); }}>Мои обращения</Link>}
      </form>}
    </div>
  </div>, document.body);
}
