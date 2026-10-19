import { useId, useState, type ReactNode } from "react";
import { useFormik } from "formik";
import { z } from "zod";
import { ApiError, normalizeApiError } from "../../utils/api/request";
import s from "./Workspace.module.css";
import type { Values } from "./formValues";
import { RecipientPicker } from "./RecipientPicker";
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
  required?: boolean;
  value?: string | string[];
  options?: { value: string; label: string }[];
  hint?: string;
  min?: number;
  max?: number;
  searchable?: boolean;
  whenSelected?: { name: string; value: string };
  onSelectionChange?: (values: string[]) => void;
}
export interface OwnRevisionChange { from: number; to: number }

const visible = (field: Field, values: Values) =>
  !field.whenSelected ||
  (Array.isArray(values[field.whenSelected.name]) &&
    (values[field.whenSelected.name] as string[]).includes(
      field.whenSelected.value,
    ));

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
  savedDetails,
  onReplaceWithSaved,
  ownChange,
  onSavedRevision,
}: {
  title?: string;
  fields: Field[];
  submitLabel?: string;
  onSubmit: (values: Values, expectedRevision?: number, expectedRevisionKey?: string) => Promise<void | { revision: number } | { version: number } | { revisionKey: string }>;
  onConflict?: () => unknown | Promise<unknown>;
  successMessage?: string;
  children?: ReactNode;
  disabled?: boolean;
  revision?: number;
  revisionKey?: string;
  savedDetails?: ReactNode;
  onReplaceWithSaved?: () => void;
  ownChange?: OwnRevisionChange;
  onSavedRevision?: (change: OwnRevisionChange) => void;
}) {
  const formId = useId();
  const [expectedRevision, setExpectedRevision] = useState(revision);
  const [expectedRevisionKey, setExpectedRevisionKey] = useState(revisionKey);
  const [appliedChange, setAppliedChange] = useState(ownChange);
  const [refreshing, setRefreshing] = useState(false);
  const versioned = revision !== undefined || revisionKey !== undefined;
  const changedRevision = revision !== expectedRevision || revisionKey !== expectedRevisionKey;
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState<ReturnType<
    typeof normalizeApiError
  > | null>(null);
  // A sibling command may advance this exact baseline, but cannot acknowledge
  // an intervening foreign revision. Adjust only our state before committing UI.
  if (appliedChange !== ownChange) {
    setAppliedChange(ownChange);
    if (ownChange && expectedRevision === ownChange.from) {
      setExpectedRevision(ownChange.to);
      setFailure(null);
    }
  }
  const schema = (values: Values) =>
    z.object(
      Object.fromEntries(
        fields
          .filter((f) => visible(f, values))
          .map((f) => [
            f.name,
            f.type === "multi"
              ? f.required
                ? z
                    .array(z.string())
                    .min(1, "Выберите хотя бы одного участника")
                : z.array(z.string())
              : z
                  .string()
                  .refine(
                    (v) => !f.required || v.trim().length > 0,
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
  const initialValues: Values = Object.fromEntries(
      fields.map((f) => [f.name, f.value ?? (f.type === "multi" ? [] : "")]),
    );
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
            onSavedRevision?.({from: expectedRevision!, to: next});
          }
          if (revisionKey !== undefined && "revisionKey" in saved) setExpectedRevisionKey(saved.revisionKey);
        }
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
              required: field.required,
              disabled: form.isSubmitting,
            };
            return (
              <div className={s.field} key={field.name}>
                <label
                  id={`${id}-label`}
                  htmlFor={field.searchable ? `${id}-search` : id}
                >
                  {field.label}
                  {field.required ? " *" : ""}
                </label>
                {field.type === "multi" && field.searchable ? (
                  <RecipientPicker
                    id={id}
                    invalid={!!error}
                    describedBy={error ? `${id}-error` : undefined}
                    options={field.options ?? []}
                    value={form.values[field.name] as string[]}
                    onChange={(value) => {
                      void form.setFieldValue(field.name, value);
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
                ) : field.type === "select" || field.type === "multi" ? (
                  <select
                    {...props}
                    multiple={field.type === "multi"}
                    value={form.values[field.name] ?? initialValues[field.name]}
                    onChange={(e) => {
                      void form.setFieldValue(
                        field.name,
                        field.type === "multi"
                          ? Array.from(e.target.selectedOptions, (o) => o.value)
                          : e.target.value,
                      );
                    }}
                  >
                    {field.type !== "multi" && (
                      <option value="">Выберите…</option>
                    )}
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
            <button type="button" className={s.button} onClick={() => {
              form.resetForm({ values: Object.fromEntries(fields.map((f) => [f.name, f.value ?? (f.type === "multi" ? [] : "")])) });
              onReplaceWithSaved?.();
              setExpectedRevision(revision); setExpectedRevisionKey(revisionKey); setFailure(null); setMessage("");
            }}>Заменить мой ввод сохранёнными значениями</button>
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
