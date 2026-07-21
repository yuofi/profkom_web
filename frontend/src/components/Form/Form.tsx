import { useState } from "react";
import { useFormik, type FormikHelpers } from "formik";
import { withZodSchema } from "formik-validator-zod";
import { z } from "zod";
import {tryCatch} from "../../utils/tryCatch"
import { AxiosError } from "axios";

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
      //error handling
      const result = await tryCatch(sendForm());
      if (result.error) {
         let errorMessage = "Произошла непредвиденная ошибка";
         
         if (result.error instanceof Error) {
            errorMessage = result.error.message;
         }
         
         if (result.error instanceof AxiosError && result.error.response) {
             const data = result.error.response?.data;
             if (data && typeof data === 'object') {
                 errorMessage = data.detail || data.message || errorMessage;
             }
             if (result.error.response.status === 401) {
                 errorMessage = "Неверный логин или пароль";
             }
         }
         setGlobalError(errorMessage);
      }
       actions.setSubmitting(false);
      
      // try {
      //   if (onSubmit) {
      //     await onSubmit(values, actions);
      //   }
        
      //   if (successMessage) {
      //     setIsSuccess(true);
      //     actions.resetForm();
      //   }
      // } catch (error) {
      //   setGlobalError(error?.message || "Произошла непредвиденная ошибка");
      // } finally {
      //   actions.setSubmitting(false);
      // }
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