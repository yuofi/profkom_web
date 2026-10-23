import { useId, useRef, useState, type ReactNode } from "react";
import { useFormik } from "formik";
import { z } from "zod";
import { ApiError, normalizeApiError } from "../../utils/api/request";
import s from "./Workspace.module.css";
import type { Values } from "./formValues";
import { RecipientPicker } from "./RecipientPicker";
import { advanceOwn, recordOwnChange, useOwnRevisions } from "./ownRevisions";
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
    | "url";
  /** A function makes the field required depending on the other values. */
  required?: boolean | ((values: Values) => boolean);
  value?: string | string[];
  options?: { value: string; label: string }[];
  hint?: string;
  min?: number;
  max?: number;
  whenSelected?: { name: string; value: string };
  onSelectionChange?: (values: string[]) => void;
  /** A multiple choice of people asks before removing saved ones; marks need not. */
  confirmRemoval?: boolean;
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
  !field.whenSelected ||
  (Array.isArray(values[field.whenSelected.name]) &&
    (values[field.whenSelected.name] as string[]).includes(
      field.whenSelected.value,
    ));

const savedValues = (fields: Field[]): Values =>
  Object.fromEntries(fields.map((f) => [f.name, f.value ?? (f.type === "multi" ? [] : "")]));

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
}: {
  title?: string;
  fields: Field[];
  submitLabel?: string;
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
} & Versioning) {
  const formId = useId();
  const [expectedRevision, setExpectedRevision] = useState(revision);
  const [expectedRevisionKey, setExpectedRevisionKey] = useState(revisionKey);
  const [refreshing, setRefreshing] = useState(false);
  const confirmedRemoval = useRef<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<string[]>([]);
  const versioned = revision !== undefined || revisionKey !== undefined;
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState<ReturnType<
    typeof normalizeApiError
  > | null>(null);
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
  const changedRevision = revision !== expectedRevision || revisionKey !== expectedRevisionKey;
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
      const values = { ...initialValues, ...draft };
      setMessage("");
      setFailure(null);
      // Removing people from a role is confirmed against the saved list (A-ROL-13).
      const removed = removals(fields, values);
      if (removed.length && JSON.stringify(removed) !== confirmedRemoval.current) {
        setPendingRemoval(removed);
        return;
      }
      setPendingRemoval([]);
      try {
        if (versioned && (changedRevision || failure?.status === 409))
          throw new ApiError("Сначала обновите данные и подтвердите версию для сохранения.", 409);
        const saved = await (revisionKey === undefined
          ? onSubmit(values, expectedRevision)
          : onSubmit(values, expectedRevision, expectedRevisionKey));
        if (saved) {
          const next = "revision" in saved ? saved.revision : "version" in saved ? saved.version : undefined;
          if (revision !== undefined && next !== undefined) {
            setExpectedRevision(next);
            if (record) recordOwnChange(client, record, expectedRevision!, next);
          }
          if (revisionKey !== undefined && "revisionKey" in saved) setExpectedRevisionKey(saved.revisionKey);
        }
        confirmedRemoval.current = null;
        if (resetOnSuccess) form.resetForm({ values: savedValues(fields) });
        setMessage(successMessage);
      } catch (error) {
        const failure = normalizeApiError(error);
        setFailure(failure);
        const errors: Record<string, string> = {};
        for (const [key, message] of Object.entries(failure.fields))
          if (typeof message === "string" && fields.some((f) => f.name === key))
            errors[key] = message;
        if (Array.isArray(failure.fields.errors))
          for (const item of failure.fields.errors) {
            const key = String(item.loc?.at(-1) ?? "");
            if (fields.some((f) => f.name === key))
              errors[key] = String(item.msg ?? "Проверьте значение");
          }
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
  const adopt = adoptWhenUntouched && reread && changedRevision && !form.dirty && !failure && !form.isSubmitting && !refreshing;
  if (adopt) {
    form.resetForm({ values: savedValues(fields) });
    setExpectedRevision(revision);
    setExpectedRevisionKey(revisionKey);
  }
  const replaceWithSaved = () => {
    form.resetForm({ values: savedValues(fields) });
    onReplaceWithSaved?.();
    setExpectedRevision(revision); setExpectedRevisionKey(revisionKey); setFailure(null); setMessage("");
  };
  return (
    <form className={s.form} onSubmit={form.handleSubmit} noValidate>
      <fieldset
        className={s.formFields}
        disabled={form.isSubmitting || refreshing || disabled}
      >
        {title && <h3>{title}</h3>}
        {fields
          .filter((field) => visible(field, form.values))
          .map((field) => {
            const id = `${formId}-${field.name}`;
            const error = form.touched[field.name] && form.errors[field.name];
            const props = {
              id,
              name: field.name,
              onBlur: form.handleBlur,
              "aria-invalid": !!error,
              "aria-describedby": error ? `${id}-error` : undefined,
              required: isRequired(field, form.values),
              disabled: form.isSubmitting,
            };
            return (
              <div className={s.field} key={field.name}>
                <label
                  id={`${id}-label`}
                  htmlFor={field.type === "multi" ? `${id}-search` : id}
                >
                  {field.label}
                  {isRequired(field, form.values) ? " *" : ""}
                </label>
                {field.type === "multi" ? (
                  <RecipientPicker
                    id={id}
                    name={field.name}
                    invalid={!!error}
                    describedBy={error ? `${id}-error` : undefined}
                    options={field.options ?? []}
                    value={(form.values[field.name] as string[] | undefined) ?? []}
                    onChange={(value) => {
                      void form.setFieldValue(field.name, value);
                      setPendingRemoval([]);
                      field.onSelectionChange?.(value);
                    }}
                  />
                ) : field.type === "textarea" ? (
                  <textarea
                    {...props}
                    value={String(form.values[field.name] ?? initialValues[field.name])}
                    onChange={(e) =>
                      void form.setFieldValue(field.name, e.target.value)
                    }
                  />
                ) : field.type === "select" ? (
                  <select
                    {...props}
                    value={form.values[field.name] ?? initialValues[field.name]}
                    onChange={(e) => {
                      void form.setFieldValue(field.name, e.target.value);
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
                    onChange={(e) =>
                      void form.setFieldValue(field.name, e.target.value)
                    }
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
            <button type="button" className={s.button} onClick={() => {
              confirmedRemoval.current = JSON.stringify(pendingRemoval);
              void form.submitForm();
            }}>
              Снять и сохранить
            </button>
          </div>
        )}
        {failure && (
          <div className={s.error} role="alert">
            {failure.message}
            {failure.status === 409 && onConflict && (
              <p>
                <button type="button" className={s.button} onClick={async () => {
                  setRefreshing(true);
                  try { await onConflict(); setFailure(null); }
                  catch (error) { setFailure(normalizeApiError(error)); }
                  finally { setRefreshing(false); }
                }}>
                  Обновить данные
                </button>
              </p>
            )}
          </div>
        )}
        {changedRevision && (
          <div role="status" className={s.details}>
            <p>Запись изменилась на сервере. Ваш ввод сохранён. Сверьте актуальные значения перед сохранением.</p>
            <details><summary>Актуальные сохранённые значения</summary>
              <dl>{fields.filter((f) => f.value !== undefined).map((f) => <div key={f.name}><dt>{f.label}</dt><dd>{Array.isArray(f.value) ? f.value.map((value) => f.options?.find((o) => o.value === value)?.label ?? value).join(", ") : f.value || "—"}</dd></div>)}</dl>
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
        <div>
          <button
            className={`${s.button} ${s.primary}`}
            type="submit"
            disabled={form.isSubmitting || refreshing || disabled || (versioned && (changedRevision || failure?.status === 409))}
          >
            {form.isSubmitting ? "Сохраняем…" : submitLabel}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
