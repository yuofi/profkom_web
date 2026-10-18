import { useId, useState, type ReactNode } from "react";
import { useFormik } from "formik";
import { z } from "zod";
import { normalizeApiError } from "../../utils/api/request";
import s from "./Workspace.module.css";
import type { Values } from "./formValues";
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
}

export function ActionForm({
  title,
  fields,
  submitLabel = "Сохранить",
  onSubmit,
  onConflict,
  successMessage = "Изменения сохранены",
  children,
  disabled = false,
}: {
  title?: string;
  fields: Field[];
  submitLabel?: string;
  onSubmit: (values: Values) => Promise<void>;
  onConflict?: () => void;
  successMessage?: string;
  children?: ReactNode;
  disabled?: boolean;
}) {
  const formId = useId();
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState<ReturnType<
    typeof normalizeApiError
  > | null>(null);
  const schema = z.object(
    Object.fromEntries(
      fields.map((f) => [
        f.name,
        f.type === "multi"
          ? f.required
            ? z.array(z.string()).min(1, "Выберите хотя бы одного участника")
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
  const form = useFormik<Values>({
    initialValues: Object.fromEntries(
      fields.map((f) => [f.name, f.value ?? (f.type === "multi" ? [] : "")]),
    ),
    validate: (values) => {
      const result = schema.safeParse(values);
      return result.success
        ? {}
        : Object.fromEntries(
            result.error.issues.map((i) => [String(i.path[0]), i.message]),
          );
    },
    onSubmit: async (values) => {
      setMessage("");
      setFailure(null);
      try {
        await onSubmit(values);
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
        disabled={form.isSubmitting || disabled}
      >
        {title && <h3>{title}</h3>}
        {fields.map((field) => {
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
            <label className={s.field} key={field.name} htmlFor={id}>
              <span>
                {field.label}
                {field.required ? " *" : ""}
              </span>
              {field.type === "textarea" ? (
                <textarea
                  {...props}
                  value={String(form.values[field.name])}
                  onChange={form.handleChange}
                />
              ) : field.type === "select" || field.type === "multi" ? (
                <select
                  {...props}
                  multiple={field.type === "multi"}
                  value={form.values[field.name]}
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
                  value={String(form.values[field.name])}
                  onChange={form.handleChange}
                />
              )}
              {field.hint && <small>{field.hint}</small>}
              {error && (
                <span className={s.fieldError} id={`${id}-error`}>
                  {String(error)}
                </span>
              )}
            </label>
          );
        })}
        {children}
        {failure && (
          <div className={s.error} role="alert">
            {failure.message}
            {failure.status === 409 && onConflict && (
              <p>
                <button type="button" className={s.button} onClick={onConflict}>
                  Обновить данные
                </button>
              </p>
            )}
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
            disabled={form.isSubmitting || disabled}
          >
            {form.isSubmitting ? "Сохраняем…" : submitLabel}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
