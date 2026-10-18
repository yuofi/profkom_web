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
}: {
  title?: string;
  fields: Field[];
  submitLabel?: string;
  onSubmit: (values: Values, expectedRevision?: number) => Promise<void>;
  onConflict?: () => unknown | Promise<unknown>;
  successMessage?: string;
  children?: ReactNode;
  disabled?: boolean;
  revision?: number;
}) {
  const formId = useId();
  const [expectedRevision, setExpectedRevision] = useState(revision);
  const [savedRevision, setSavedRevision] = useState<number>();
  const [refreshing, setRefreshing] = useState(false);
  // A successful mutation has already re-read the object. Other updates need consent.
  if (savedRevision !== undefined && revision !== savedRevision) {
    setExpectedRevision(revision);
    setSavedRevision(undefined);
  }
  const changedRevision = revision !== expectedRevision;
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState<ReturnType<
    typeof normalizeApiError
  > | null>(null);
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
        if (revision !== undefined && (changedRevision || failure?.status === 409))
          throw new ApiError("Сначала обновите данные и подтвердите версию для сохранения.", 409);
        await onSubmit(values, expectedRevision);
        setSavedRevision(expectedRevision);
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
                  try { await onConflict(); }
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
            </details>
            <button type="button" className={s.button} onClick={() => { setExpectedRevision(revision); setFailure(null); setMessage(""); }}>Сохранить мой ввод с обновлённой версией</button>
            <button type="button" className={s.button} onClick={() => {
              form.resetForm({ values: Object.fromEntries(fields.map((f) => [f.name, f.value ?? (f.type === "multi" ? [] : "")])) });
              setExpectedRevision(revision); setFailure(null); setMessage("");
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
            disabled={form.isSubmitting || refreshing || disabled || (revision !== undefined && (changedRevision || failure?.status === 409))}
          >
            {form.isSubmitting ? "Сохраняем…" : submitLabel}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
