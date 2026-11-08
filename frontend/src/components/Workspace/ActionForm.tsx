import { editorShortcut } from "../../utils/editorShortcuts";
import { Suspense, lazy, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useFormik, type FormikProps } from "formik";
import { z } from "zod";
import { ApiError, normalizeApiError } from "../../utils/api/request";
import { fieldMessage, isStale, userMessage } from "../../utils/api/messages";
import { ErrorDetail } from "./WorkspaceUI";
import s from "./Workspace.module.css";
import type { Values } from "./formValues";
import { RecipientPicker } from "./RecipientPicker";
import { EntityPicker, type EntityKind, type EntityOption } from "./EntityPicker";
import { advanceOwn, recordOwnChange, useOwnRevisions } from "./ownRevisions";
import { useUnsavedChanges } from "./unsavedChangesHooks";
// The editor stays in its own chunk: forms without a markdown field do not load it.
const MarkdownEditor = lazy(() => import("./MarkdownEditor").then((module) => ({ default: module.MarkdownEditor })));
export interface Field {
  name: string;
  label: string;
  type?:
    | "text"
    | "textarea"
    | "select"
    | "multi"
    | "number"
    | "datetime-local"
    | "email"
    | "url"
    | "password"
    | "markdown"
    /** A yes/no mark: its value is "true" or "false". */
    | "checkbox";
  /** A function makes the field required depending on the other values. */
  required?: boolean | ((values: Values) => boolean);
  value?: string | string[];
  options?: EntityOption[];
  /** Explicit entity metadata selects the search-first picker; ordinary enum fields stay native. */
  entity?: EntityKind;
  loading?: boolean;
  placeholder?: string;
  hint?: string;
  /** The height of a markdown field in lines. */
  rows?: number;
  min?: number;
  max?: number;
  whenSelected?: { name: string; value: string };
  /** Shown only while this holds for the current values; a hidden field is not validated. */
  visibleWhen?: (values: Values) => boolean;
  /** A field whose change also sets other fields: given the values after its change, the values to set in one step. */
  onChangeValues?: (values: Values) => Values;
  onSelectionChange?: (values: string[]) => void;
  /** A multiple choice of people asks before removing saved ones; marks need not. */
  confirmRemoval?: boolean;
  /** Short fields of one group share a row (dates, hours and evaluation, yes/no criteria); a new group starts a new row. */
  compact?: string;
  /** A plain text field rewrites what is typed, e.g. into capitals; the value stays editable as usual. */
  normalize?: (value: string) => string;
}
type Refresh = () => unknown | Promise<unknown>;
/**
 * A form that replaces a versioned record says what refreshes it after a conflict (A-TSK-5).
 * `record` names the server counter behind `revision`: own saves of the forms of one record
 * move each other's baseline (A-FE-2). `rebaseKey` does the same for a combined `revisionKey`.
 */
type Versioning =
  | { revision?: number; revisionKey?: string; onConflict: Refresh; record?: string; rebaseKey?: (key: string) => string }
  | { revision?: undefined; revisionKey?: undefined; onConflict?: undefined; record?: undefined; rebaseKey?: undefined };

const isRequired = (field: Field, values: Values) =>
  typeof field.required === "function" ? field.required(values) : !!field.required;

const visible = (field: Field, values: Values) =>
  (!field.whenSelected ||
    (Array.isArray(values[field.whenSelected.name]) &&
      (values[field.whenSelected.name] as string[]).includes(
        field.whenSelected.value,
      ))) &&
  (!field.visibleWhen || field.visibleWhen(values));

const savedValues = (fields: Field[]): Values =>
  Object.fromEntries(fields.map((f) => [f.name, f.value ?? (f.type === "multi" ? [] : f.type === "checkbox" ? "false" : "")]));
/** A saved value as the «saved values» list shows it. */
const shownValue = (f: Field, value: string) => f.type === "checkbox" ? (value === "true" ? "Да" : "Нет") : value || "—";

/** Where a chain of own saves (from → to) leads from `from`. */
const follow = <K,>(chain: [K, K][], from: K) => {
  let current = from;
  for (let steps = 0; steps < chain.length; steps++) {
    const next = chain.find(([at]) => at === current);
    if (!next) break;
    current = next[1];
  }
  return current;
};

/** People a multiple choice with saved members would remove, by label. */
const removals = (fields: Field[], values: Values) =>
  fields
    .filter((f) => f.type === "multi" && f.confirmRemoval !== false && Array.isArray(f.value) && visible(f, values))
    .flatMap((f) => {
      const kept = new Set((values[f.name] as string[] | undefined) ?? []);
      return (f.value as string[]).filter((v) => !kept.has(v)).map((v) => f.options?.find((o) => o.value === v)?.label ?? v);
    });

export function ActionForm({
  title,
  fields,
  submitLabel = "Сохранить",
  submitTitle,
  onSubmit,
  onConflict,
  successMessage = "Изменения сохранены",
  children,
  disabled = false,
  revision,
  revisionKey,
  record,
  rebaseKey,
  savedDetails,
  onReplaceWithSaved,
  adoptWhenUntouched = false,
  resetOnSuccess = false,
  resetFieldsOnSuccess = [],
  changeRequired,
  variant = "primary",
  externalState,
  savedExternalState,
  externalBusy = false,
  allowExitSave = true,
  beforeFields,
  confirm,
  actions,
  failureActions,
}: {
  title?: string;
  fields: Field[];
  submitLabel?: string;
  /** The submit's full name, its tooltip and accessible name, when its label is one short word
   *  in a row of a list, e.g. «Убрать» for «Убрать из состава: …» (D-05). */
  submitTitle?: string;
  onSubmit: (values: Values, expectedRevision?: number, expectedRevisionKey?: string) => Promise<void | { revision: number } | { version: number } | { revisionKey: string }>;
  successMessage?: string;
  children?: ReactNode;
  disabled?: boolean;
  savedDetails?: ReactNode;
  onReplaceWithSaved?: () => void;
  /** All input is in the fields: an untouched form takes a newer revision with its values. */
  adoptWhenUntouched?: boolean;
  /** A form that creates something starts empty again after a success (A-TSK-6). */
  resetOnSuccess?: boolean;
  /** Clear one-shot decisions only after a successful save, retaining the other saved input. */
  resetFieldsOnSuccess?: string[];
  /**
   * Saving is offered only once one of these fields differs from its saved value (A-ROL-12),
   * or once what the function derives from the values differs from what it derives from the saved ones.
   */
  changeRequired?: string[] | ((values: Values) => unknown);
  /** The look of the submit: the main action, a minor one, or one that takes something away. */
  variant?: "primary" | "quiet" | "danger";
  /** Source text or attachments edited outside Formik. */
  externalState?: unknown;
  savedExternalState?: unknown;
  externalBusy?: boolean;
  /** Publishing/destructive actions must remain explicit in their own form. */
  allowExitSave?: boolean;
  /** Opt-in helpers may copy values into the current draft without replacing dates/recipients. */
  beforeFields?: (form: FormikProps<Values>) => ReactNode;
  /**
   * An irreversible command asks once more, naming its target and consequences, before it is sent.
   * A text function returns null only for input its onSubmit refuses itself before any request.
   */
  confirm?: { text: ReactNode | ((values: Values) => ReactNode); label: string };
  /** Secondary controls in one row after the submit, such as a cancel link or a preview toggle. */
  actions?: ReactNode;
  /** More ways on under a refusal, such as saving again without an applied template (B6). */
  failureActions?: (failure: ApiError, form: FormikProps<Values>) => ReactNode;
} & Versioning) {
  const formId = useId();
  const submitted = useRef(false);
  // A successful save clears the leave warning, but its editor still holds the
  // values/revision it accepted. A foreign refetch must not silently adopt a
  // different draft just because the saved input is now clean in Formik.
  const [holdSavedInput, setHoldSavedInput] = useState(false);
  const externalValue = JSON.stringify(externalState);
  const [externalBaseline, setExternalBaseline] = useState(externalValue);
  const [expectedRevision, setExpectedRevision] = useState(revision);
  const [expectedRevisionKey, setExpectedRevisionKey] = useState(revisionKey);
  const [refreshing, setRefreshing] = useState(false);
  // Own saves of this form (from → to). Their reread runs in the background (PF-02), so the
  // props may still carry what a save has just replaced: that is not someone else's change.
  const [ownSaves, setOwnSaves] = useState<{ revisions: [number, number][]; keys: [string, string][] }>({ revisions: [], keys: [] });
  const confirmedRemoval = useRef<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<string[]>([]);
  // The exact values an irreversible command awaits confirmation for; another choice withdraws the question.
  const confirmedCommand = useRef<string | null>(null);
  const [pendingCommand, setPendingCommand] = useState<string | null>(null);
  const versioned = revision !== undefined || revisionKey !== undefined;
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState<ReturnType<
    typeof normalizeApiError
  > | null>(null);
  // Labels of the fields the server refused, for the text of the failure.
  const [refused, setRefused] = useState<string[]>([]);
  // Someone else changed the data (or our version is behind): reread before saving again.
  const stale = !!failure && (isStale(failure) || (failure.status === 409 && failure.code === "client_error"));
  const client = useOwnRevisions();
  // Own saves elsewhere may advance this exact baseline, never past a foreign revision.
  // Adjust only our state before committing UI.
  if (record && expectedRevision !== undefined) {
    const advanced = advanceOwn(client, record, expectedRevision);
    if (advanced !== expectedRevision) {
      setExpectedRevision(advanced);
      setFailure(null);
    }
  }
  if (rebaseKey && expectedRevisionKey !== undefined) {
    const rebased = rebaseKey(expectedRevisionKey);
    if (rebased !== expectedRevisionKey) setExpectedRevisionKey(rebased);
  }
  const changed = revision !== expectedRevision || revisionKey !== expectedRevisionKey;
  // The props are behind only by own saves (of this form or, through `record`, of another
  // form of the record): they are being reread. A foreign revision is never on that chain.
  const catchingUp = changed &&
    (revision === undefined ? undefined : follow(ownSaves.revisions, record ? advanceOwn(client, record, revision) : revision)) === expectedRevision &&
    (revisionKey === undefined ? undefined : follow(ownSaves.keys, rebaseKey ? rebaseKey(revisionKey) : revisionKey)) === expectedRevisionKey;
  const changedRevision = changed && !catchingUp;
  const schema = (values: Values) =>
    z.object(
      Object.fromEntries(
        fields
          .filter((f) => visible(f, values))
          .map((f) => [
            f.name,
            f.type === "multi"
              ? isRequired(f, values)
                ? z
                    .array(z.string())
                    .min(1, "Выберите хотя бы одного участника")
                : z.array(z.string())
              : z
                  .string()
                  .refine(
                    (v) => !isRequired(f, values) || v.trim().length > 0,
                    "Обязательное поле",
                  )
                  .refine(
                    (v) =>
                      !v ||
                      f.type !== "number" ||
                      (Number.isFinite(Number(v)) &&
                        (f.min === undefined || Number(v) >= f.min) &&
                        (f.max === undefined || Number(v) <= f.max)),
                    "Проверьте число",
                  )
                  .refine(
                    (v) => !v || f.type !== "url" || /^https?:\/\//i.test(v),
                    "Используйте ссылку https:// или http://",
                  )
                  .refine(
                    (v) =>
                      !v ||
                      f.type !== "email" ||
                      /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
                    "Проверьте адрес почты",
                  ),
          ]),
      ),
    );
  const initialValues = savedValues(fields);
  const form = useFormik<Values>({
    initialValues,
    validate: (values) => {
      const current = { ...initialValues, ...values };
      const result = schema(current).safeParse(current);
      return result.success
        ? {}
        : Object.fromEntries(
            result.error.issues.map((i) => [String(i.path[0]), i.message]),
          );
    },
    onSubmit: async (draft) => {
      submitted.current = false;
      const values = { ...initialValues, ...draft };
      setMessage("");
      setFailure(null);
      setRefused([]);
      // Removing people from a role is confirmed against the saved list (A-ROL-13).
      const removed = removals(fields, values);
      if (removed.length && JSON.stringify(removed) !== confirmedRemoval.current) {
        setPendingRemoval(removed);
        return;
      }
      setPendingRemoval([]);
      try {
        if (versioned && (changedRevision || stale))
          throw new ApiError("Сначала обновите данные и подтвердите версию для сохранения.", 409);
        const command = JSON.stringify(values);
        const question = confirm && (typeof confirm.text === "function" ? confirm.text(values) : confirm.text);
        if (confirm && question !== null && confirmedCommand.current !== command) {
          setPendingCommand(command);
          return;
        }
        confirmedCommand.current = null;
        setPendingCommand(null);
        const saved = await (revisionKey === undefined
          ? onSubmit(values, expectedRevision)
          : onSubmit(values, expectedRevision, expectedRevisionKey));
        if (saved) {
          const next = "revision" in saved ? saved.revision : "version" in saved ? saved.version : undefined;
          const ownRevision = revision !== undefined && next !== undefined && expectedRevision !== undefined && next !== expectedRevision ? [expectedRevision, next] as [number, number] : undefined;
          const ownKey = revisionKey !== undefined && "revisionKey" in saved && expectedRevisionKey !== undefined && saved.revisionKey !== expectedRevisionKey ? [expectedRevisionKey, saved.revisionKey] as [string, string] : undefined;
          if (ownRevision || ownKey) setOwnSaves((own) => ({ revisions: ownRevision ? [...own.revisions, ownRevision] : own.revisions, keys: ownKey ? [...own.keys, ownKey] : own.keys }));
          if (revision !== undefined && next !== undefined) {
            setExpectedRevision(next);
            if (record) recordOwnChange(client, record, expectedRevision!, next);
          }
          if (revisionKey !== undefined && "revisionKey" in saved) setExpectedRevisionKey(saved.revisionKey);
        }
        confirmedRemoval.current = null;
        const acceptedValues = resetOnSuccess ? savedValues(fields) : { ...values, ...Object.fromEntries(resetFieldsOnSuccess.map(name => [name, savedValues(fields)[name] ?? ""])) };
        form.resetForm({ values: acceptedValues });
        setExternalBaseline(resetOnSuccess ? JSON.stringify(savedExternalState ?? externalState) : externalValue);
        submitted.current = true;
        setHoldSavedInput(!resetOnSuccess);
        setMessage(successMessage);
      } catch (error) {
        const failure = normalizeApiError(error);
        setFailure(failure);
        const errors: Record<string, string> = {};
        for (const [key, message] of Object.entries(failure.fields))
          if (typeof message === "string" && fields.some((f) => f.name === key))
            errors[key] = fieldMessage(message);
        if (Array.isArray(failure.fields.errors))
          for (const item of failure.fields.errors) {
            const key = String(item.loc?.at(-1) ?? "");
            if (fields.some((f) => f.name === key)) errors[key] = fieldMessage(item);
          }
        setRefused(fields.filter((f) => f.name in errors).map((f) => f.label));
        form.setErrors(errors);
      }
    },
  });
  // Nothing typed, nothing to keep: take the newer saved version with its values. Like the
  // baseline advance above, this adjusts only this form's own state during render. A record
  // not yet reread (its own change is ahead of the props) is left to that reread.
  const reread =
    (!record || revision === undefined || advanceOwn(client, record, revision) === revision) &&
    (!rebaseKey || revisionKey === undefined || rebaseKey(revisionKey) === revisionKey);
  const adopt = adoptWhenUntouched && !holdSavedInput && externalValue === externalBaseline && reread && changedRevision && !form.dirty && !failure && !form.isSubmitting && !refreshing;
  if (adopt) {
    form.resetForm({ values: savedValues(fields) });
    setExpectedRevision(revision);
    setExpectedRevisionKey(revisionKey);
  }
  // The success note speaks of the saved input: the first new change takes it away.
  if (message && form.dirty) setMessage("");
  const saveForNavigation = async () => {
    if (disabled || externalBusy || form.isSubmitting || refreshing) return false;
    submitted.current = false;
    await form.submitForm();
    return submitted.current;
  };
  useUnsavedChanges({
    dirty: form.dirty || externalValue !== externalBaseline,
    busy: form.isSubmitting || externalBusy,
    label: title ?? submitLabel,
    save: variant === "danger" || !allowExitSave ? undefined : saveForNavigation,
    discard: () => {
      form.resetForm();
      setHoldSavedInput(false);
      onReplaceWithSaved?.();
      setExternalBaseline(JSON.stringify(savedExternalState ?? externalState));
    },
  });
  const currentValues = { ...initialValues, ...form.values };
  const question = confirm && (typeof confirm.text === "function" ? confirm.text(currentValues) : confirm.text);
  const awaitingCommand = !!confirm && question !== null && pendingCommand !== null && pendingCommand === JSON.stringify(currentValues);
  // The submit is disabled while a question waits, so its answer takes the focus once the form is idle.
  const answer = useRef<HTMLButtonElement>(null);
  const asking = pendingRemoval.length > 0 || awaitingCommand;
  useEffect(() => { if (asking && !form.isSubmitting) answer.current?.focus(); }, [asking, form.isSubmitting]);
  // A changed external state (an applied template) is a change too, even when the field values match.
  const unchanged = (typeof changeRequired === "function"
    ? JSON.stringify(changeRequired(currentValues)) === JSON.stringify(changeRequired(savedValues(fields)))
    : !!changeRequired?.every((name) => JSON.stringify(form.values[name] ?? initialValues[name]) === JSON.stringify(savedValues(fields)[name]))) && externalValue === externalBaseline;
  const setValue = (field: Field, value: string | string[]) =>
    void (field.onChangeValues ? form.setValues(field.onChangeValues({ ...initialValues, ...form.values, [field.name]: value })) : form.setFieldValue(field.name, value));
  const replaceWithSaved = () => {
    form.resetForm({ values: savedValues(fields) });
    setHoldSavedInput(false);
    onReplaceWithSaved?.();
    setExternalBaseline(JSON.stringify(savedExternalState ?? externalState));
    setExpectedRevision(revision); setExpectedRevisionKey(revisionKey); setFailure(null); setMessage("");
  };
  return (
    <form className={s.form} onSubmit={form.handleSubmit} noValidate onKeyDown={(event) => {
      if (editorShortcut(event) === "s") {
        event.preventDefault();
        if (allowExitSave && variant !== "danger" && (fields.length > 0 || externalState !== undefined) && !disabled && !externalBusy && !form.isSubmitting) void form.submitForm();
      }
    }}>
      <fieldset
        className={`${s.formFields} ${fields.some((field) => field.compact) ? s.compactFields : ""}`}
        disabled={form.isSubmitting || refreshing || disabled || externalBusy}
      >
        {title && <h3>{title}</h3>}
        {beforeFields?.(form)}
        {fields
          .filter((field) => visible(field, form.values))
          .map((field, index, shown) => {
            const compact = field.compact ? `${s.compactField} ${shown[index - 1]?.compact !== field.compact ? s.compactStart : ""}` : "";
            const id = `${formId}-${field.name}`;
            const error = form.touched[field.name] && form.errors[field.name];
            const entityPicker = !!field.entity || !!field.options?.some(option => option.user || option.block || option.scope);
            const pickerProps = {
              id, name: field.name, labelledBy: `${id}-label`, entity: field.entity, options: field.options ?? [],
              invalid: !!error, describedBy: error ? `${id}-error` : undefined, required: isRequired(field, form.values),
              disabled: form.isSubmitting || refreshing || disabled || externalBusy, loading: field.loading, placeholder: field.placeholder,
              onBlur: () => { void form.setFieldTouched(field.name, true); },
            };
            const props = {
              id,
              name: field.name,
              onBlur: form.handleBlur,
              "aria-invalid": !!error,
              "aria-describedby": error ? `${id}-error` : undefined,
              required: isRequired(field, form.values),
              disabled: form.isSubmitting,
            };
            if (field.type === "checkbox") return (
              <div className={`${s.field} ${s.checkField} ${compact}`} key={field.name}>
                <label className={s.check} id={`${id}-label`}>
                  <input id={id} name={field.name} type="checkbox" value="true" onBlur={form.handleBlur} disabled={form.isSubmitting}
                    checked={String(form.values[field.name] ?? initialValues[field.name]) === "true"}
                    aria-describedby={props["aria-describedby"]}
                    onChange={(e) => setValue(field, e.target.checked ? "true" : "false")} />
                  {field.label}
                </label>
                {field.hint && <small>{field.hint}</small>}
              </div>
            );
            // The Markdown editor labels its own source field and keeps its toolbar, preview and frame.
            if (field.type === "markdown") return (
              <div key={field.name}>
                <Suspense fallback={<p role="status">Загружаем редактор…</p>}>
                  <MarkdownEditor name={field.name} label={`${field.label}${isRequired(field, form.values) ? " *" : ""}`} rows={field.rows} context="task" draft={false}
                    value={String(form.values[field.name] ?? initialValues[field.name])} placeholder={field.placeholder} disabled={form.isSubmitting}
                    required={props.required} invalid={!!error} describedBy={props["aria-describedby"]}
                    onChange={(value) => setValue(field, value)} />
                </Suspense>
                {field.hint && <small>{field.hint}</small>}
                {error && <span className={s.fieldError} id={`${id}-error`}>{String(error)}</span>}
              </div>
            );
            return (
              <div className={`${s.field} ${compact}`} key={field.name}>
                <label
                  id={`${id}-label`}
                  htmlFor={field.type === "multi" && !entityPicker ? `${id}-search` : id}
                >
                  {field.label}
                  {isRequired(field, form.values) ? " *" : ""}
                </label>
                {field.type === "multi" && entityPicker ? (
                  <EntityPicker {...pickerProps} multiple value={(form.values[field.name] as string[] | undefined) ?? []}
                    onChange={value => { setValue(field, value);setPendingRemoval([]);field.onSelectionChange?.(value); }} />
                ) : field.type === "select" && entityPicker ? (
                  <EntityPicker {...pickerProps} value={String(form.values[field.name] ?? initialValues[field.name] ?? "")}
                    onChange={value => { setValue(field, value);field.onSelectionChange?.([value]); }} />
                ) : field.type === "multi" ? (
                  <RecipientPicker
                    id={id}
                    name={field.name}
                    invalid={!!error}
                    describedBy={error ? `${id}-error` : undefined}
                    options={field.options ?? []}
                    value={(form.values[field.name] as string[] | undefined) ?? []}
                    onChange={(value) => {
                      setValue(field, value);
                      setPendingRemoval([]);
                      field.onSelectionChange?.(value);
                    }}
                  />
                ) : field.type === "textarea" ? (
                  <textarea
                    {...props}
                    value={String(form.values[field.name] ?? initialValues[field.name])}
                    onChange={(e) => setValue(field, e.target.value)}
                  />
                ) : field.type === "select" ? (
                  <select
                    {...props}
                    value={form.values[field.name] ?? initialValues[field.name]}
                    onChange={(e) => {
                      setValue(field, e.target.value);
                      field.onSelectionChange?.([e.target.value]);
                    }}
                  >
                    <option value="">Выберите…</option>
                    {field.options?.map((o) => (
                      <option value={o.value} key={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    {...props}
                    type={field.type ?? "text"}
                    min={field.min}
                    max={field.max}
                    step={field.type === "number" ? "any" : undefined}
                    value={String(form.values[field.name] ?? initialValues[field.name])}
                    autoCapitalize={field.normalize ? "characters" : undefined}
                    onChange={(e) => {
                      const input = e.target, value = field.normalize ? field.normalize(input.value) : input.value;
                      if (value !== input.value) {
                        // Rewritten here, React finds the DOM already equal to the state and leaves the caret where it was typed.
                        const { selectionStart, selectionEnd } = input;
                        input.value = value;
                        if (selectionStart !== null && selectionEnd !== null) input.setSelectionRange(selectionStart, selectionEnd);
                      }
                      setValue(field, value);
                    }}
                  />
                )}
                {field.hint && <small>{field.hint}</small>}
                {error && (
                  <span className={s.fieldError} id={`${id}-error`}>
                    {String(error)}
                  </span>
                )}
              </div>
            );
          })}
        {children}
        {pendingRemoval.length > 0 && (
          <div role="alert" className={s.warning}>
            <p>Будут сняты: {pendingRemoval.join(", ")}.</p>
            <button ref={answer} type="button" className={s.button} onClick={() => {
              confirmedRemoval.current = JSON.stringify(pendingRemoval);
              void form.submitForm();
            }}>
              Снять и сохранить
            </button>
          </div>
        )}
        {confirm && awaitingCommand && (
          <div role="alert" className={s.warning}>
            <p>{question}</p>
            <div className={s.row}>
              <button ref={answer} type="button" className={s.button} onClick={() => {
                confirmedCommand.current = pendingCommand;
                void form.submitForm();
              }}>
                {confirm.label}
              </button>
              <button type="button" className={s.button} onClick={() => setPendingCommand(null)}>
                Отмена
              </button>
            </div>
          </div>
        )}
        {failure && (
          <div className={s.error} role="alert">
            {refused.length ? `Проверьте поля: ${refused.join(", ")}.` : userMessage(failure)}
            {stale && onConflict && (
              <p>
                <button type="button" className={s.button} onClick={async () => {
                  setRefreshing(true);
                  try { await onConflict(); setFailure(null); setRefused([]); }
                  catch (error) { setFailure(normalizeApiError(error)); }
                  finally { setRefreshing(false); }
                }}>
                  Обновить данные
                </button>
              </p>
            )}
            {failureActions?.(failure, form)}
          </div>
        )}
        {failure && <ErrorDetail error={failure} />}
        {changedRevision && (
          <div role="status" className={s.details}>
            <p>Запись изменилась на сервере. Ваш ввод сохранён. Сверьте актуальные значения перед сохранением.</p>
            <details><summary>Актуальные сохранённые значения</summary>
              <dl>{fields.filter((f) => f.value !== undefined && visible(f, initialValues)).map((f) => <div key={f.name}><dt>{f.label}</dt><dd>{Array.isArray(f.value) ? f.value.map((value) => f.options?.find((o) => o.value === value)?.label ?? value).join(", ") : shownValue(f, f.value ?? "")}</dd></div>)}</dl>
              {savedDetails}
            </details>
            <button type="button" className={s.button} onClick={() => { setExpectedRevision(revision); setExpectedRevisionKey(revisionKey); setFailure(null); setMessage(""); }}>Сохранить мой ввод с обновлённой версией</button>
            <button type="button" className={s.button} onClick={replaceWithSaved}>Заменить мой ввод сохранёнными значениями</button>
          </div>
        )}
        {message && (
          <p role="status" className={s.success}>
            {message}
          </p>
        )}
        <div className={actions ? s.row : undefined}>
          <button
            className={`${s.button} ${variant === "primary" ? s.primary : variant === "danger" ? s.danger : ""}`}
            type="submit"
            aria-label={form.isSubmitting ? undefined : submitTitle}
            title={submitTitle}
            disabled={form.isSubmitting || refreshing || disabled || unchanged || pendingRemoval.length > 0 || awaitingCommand || (versioned && (changedRevision || stale))}
          >
            {form.isSubmitting ? "Сохраняем…" : submitLabel}
          </button>
          {actions}
        </div>
      </fieldset>
    </form>
  );
}
