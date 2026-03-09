import { type InputHTMLAttributes, forwardRef } from 'react';
import clsx from 'clsx';
import styles from './TextField.module.css';

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: boolean;
  supportingText?: string;
  className?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(({ 
  label, 
  error, 
  supportingText, 
  className,
  ...props 
}, ref) => {
  
  return (
    <div className={clsx(styles.wrapper, className)}>
      <div className={clsx(styles.container, error && styles.error)}>
        <input
          ref={ref}
          className={styles.input}
          placeholder=" "
          {...props}
        />
        
        <label className={styles.label}>
          {label}
        </label>

        <fieldset aria-hidden="true" className={styles.fieldset}>
          <legend className={styles.legend}>
            <span>{label}</span>
          </legend>
        </fieldset>
      </div>

      {supportingText && (
        <p className={clsx(styles.supportingText, error && styles.textError)}>
          {supportingText}
        </p>
      )}
    </div>
  );
});