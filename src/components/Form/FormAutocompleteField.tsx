import { useField } from 'formik';
import { useState, useRef, useEffect } from 'react';
import { TextField } from '../TextField/TextField';
import styles from './FormAutocompleteField.module.css';

interface Option {
  label: string;
  value: string;
}

interface FormAutocompleteFieldProps {
  name: string;
  label: string;
  options: Option[];
  supportingText?: string;
  disabled?: boolean;
}

export const FormAutocompleteField = ({ 
  name, 
  label, 
  options, 
  supportingText,
  disabled 
}: FormAutocompleteFieldProps) => {
  const [field, meta, helpers] = useField(name);
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const hasError = Boolean(meta.touched && meta.error);

  // If user hasn't typed anything yet, show the label corresponding to the field value
  const searchTerm = inputValue !== null ? inputValue : (options.find(o => o.value === field.value)?.label || field.value || '');

  const filteredOptions = options.filter(option =>
    option.label.toLowerCase().includes(searchTerm.toLowerCase())
  );

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (option: Option) => {
    helpers.setValue(option.value);
    setInputValue(null); // Reset local input to track field.value again
    setIsOpen(false);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setInputValue(value);
    helpers.setValue(value);
    if (!isOpen) setIsOpen(true);
  };

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <TextField
        {...field}
        value={searchTerm}
        onChange={handleInputChange}
        onFocus={() => setIsOpen(true)}
        label={label}
        error={hasError}
        supportingText={hasError ? meta.error : supportingText}
        disabled={disabled}
        autoComplete="off"
        color = 'secondary'
      />
      
      {isOpen && filteredOptions.length > 0 && (
        <ul className={styles.optionsList}>
          {filteredOptions.map((option, index) => (
            <li 
              key={index} 
              className={styles.optionItem}
              onClick={() => handleSelect(option)}
            >
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
