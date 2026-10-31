import { useId } from "react";
import clsx from "clsx";
import { useField, useFormikContext } from "formik";
import { Icon } from "../Icon";
import styles from "../TextField/TextField.module.css";
import own from "./FormSelectField.module.css";

/** A closed choice in the outlined look of FormTextField; the label always stays above. */
export function FormSelectField({ name, label, options, color = "on-surface" }: {
  name: string;
  label: string;
  options: { value: string; label: string }[];
  color?: "primary" | "secondary" | "tertiary" | "on-surface";
}) {
  const id = useId();
  const [field, meta] = useField(name);
  const { isSubmitting } = useFormikContext();
  const error = Boolean(meta.touched && meta.error);
  return (
    <div className={styles.wrapper}>
      <div className={clsx(styles.container, styles[color], error && styles.error)}>
        <select {...field} id={id} className={clsx(styles.input, own.select)} disabled={isSubmitting}
          aria-invalid={error || undefined} aria-describedby={error ? `${id}-error` : undefined}>
          {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <label htmlFor={id} className={clsx(styles.label, own.label)}>{label}</label>
        <fieldset aria-hidden="true" className={styles.fieldset}>
          <legend className={clsx(styles.legend, own.legend)}><span>{label}</span></legend>
        </fieldset>
        <Icon name="expand_more" size={24} className={own.chevron} aria-hidden="true" />
      </div>
      {error && <p id={`${id}-error`} className={clsx(styles.supportingText, styles.textError)}>{meta.error}</p>}
    </div>
  );
}
