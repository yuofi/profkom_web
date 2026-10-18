import { useState } from "react";
import { useFormik, type FormikErrors, type FormikHelpers } from "formik";
import { withZodSchema } from "formik-validator-zod";
import { z } from "zod";
import {tryCatch} from "../../utils/tryCatch"
import { normalizeApiError } from "../../utils/api/request";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const useForm = <UserSchema extends z.ZodType<Record<string, any>>>({
  initialValues,
  successMessage = false,
  validationSchema,
  onSubmit,
}: {
  initialValues: z.infer<UserSchema>;
  validationSchema: UserSchema;
  successMessage?: boolean;
  onSubmit?: (
    values: z.infer<UserSchema>,
    actions: FormikHelpers<z.infer<UserSchema>>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => Promise<any>;
}) => {
  const [isSuccess, setIsSuccess] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const formik = useFormik<z.infer<UserSchema>>({
    initialValues,
    validate: withZodSchema(validationSchema),
    onSubmit: async (values, actions) => {
      setIsSuccess(false);
      setGlobalError(null);

      const sendForm = async () => {
        if (onSubmit) {
          await onSubmit(values, actions);
        }
        
        if (successMessage) {
          setIsSuccess(true);
          actions.resetForm();
        }
      };
      const result = await tryCatch(sendForm());
      if (result.error) {
        const failure = normalizeApiError(result.error);
        setGlobalError(failure.message);
        const errors: Record<string, string> = {};
        for (const [key, message] of Object.entries(failure.fields)) {
          if (key in values && typeof message === "string") errors[key] = message;
        }
        if (Array.isArray(failure.fields.errors)) {
          for (const item of failure.fields.errors) {
            const key = String(item?.loc?.at(-1) ?? "");
            if (key in values && typeof item?.msg === "string") errors[key] = item.msg;
          }
        }
        actions.setErrors(errors as FormikErrors<z.infer<UserSchema>>);
      }
      actions.setSubmitting(false);
    },
  });

  return {
    formik,
    isSuccess,
    globalError,
    setIsSuccess,
    setGlobalError,
  };
};