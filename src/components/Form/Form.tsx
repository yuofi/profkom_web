import { useState } from "react";
import { useFormik, type FormikHelpers } from "formik";
import { withZodSchema } from "formik-validator-zod";
import { z } from "zod";

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

      try {
        if (onSubmit) {
          await onSubmit(values, actions);
        }
        
        if (successMessage) {
          setIsSuccess(true);
          actions.resetForm();
        }
      } catch (error: any) {
        setGlobalError(error?.message || "Произошла непредвиденная ошибка");
      } finally {
        actions.setSubmitting(false);
      }
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