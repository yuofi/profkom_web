import { useField } from 'formik';
import { type ComponentProps } from 'react';
import { TextField } from '../TextField/TextField';

interface FormTextFieldProps extends Omit<ComponentProps<typeof TextField>, 'name'> {
  name: string;
}

export const FormTextField = ({ name, supportingText, ...props }: FormTextFieldProps) => {
  const [field, meta] = useField(name);

  const hasError = Boolean(meta.touched && meta.error);

  return (
    <TextField
      {...field}
      {...props}
      error={hasError}
      supportingText={hasError ? meta.error : supportingText}
    />
  );
};