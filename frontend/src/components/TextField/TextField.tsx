import { type InputHTMLAttributes, forwardRef, useState } from 'react';
import clsx from 'clsx';
import styles from './TextField.module.css';
import { Icon } from '../Icon';

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: boolean;
  supportingText?: string;
  className?: string;
  color?: "primary" | "secondary" | "tertiary" | "on-surface";
  isPassword?: boolean;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(({ 
  label, 
  error, 
  supportingText, 
  className,
  color = "primary",
  isPassword,
  type,
  ...props 
}, ref) => {
  const [showPassword, setShowPassword] = useState(false);
  const inputType = isPassword ? (showPassword ? "text" : "password") : type;
  
  return (
    <div className={clsx(styles.wrapper, className)}>
      <div className={clsx(styles.container, styles[color], error && styles.error)}>
        <input
          ref={ref}
          className={clsx(styles.input, isPassword && styles.hasAdornment)}
          placeholder=" "
          type={inputType}
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

        {isPassword && (
          <button 
            type="button"
            className={styles.passwordToggle}
            onClick={() => setShowPassword(!showPassword)}
          >
            <Icon name={showPassword ? 'visibility_off' : 'visibility'} size={24} />
          </button>
        )}
      </div>

      {supportingText && (
        <p className={clsx(styles.supportingText, error && styles.textError)}>
          {supportingText}
        </p>
      )}
    </div>
  );
});