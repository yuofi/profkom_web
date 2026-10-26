import { useRef, useState } from "react";
import { useFormik, type FormikErrors, type FormikHelpers } from "formik";
import { withZodSchema } from "formik-validator-zod";
import { z } from "zod";
import { useUnsavedChanges } from "../Workspace/unsavedChangesHooks";
import {tryCatch} from "../../utils/tryCatch"
import { normalizeApiError } from "../../utils/api/request";
import { fieldMessage, userMessage } from "../../utils/api/messages";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const useForm = <UserSchema extends z.ZodType<Record<string, any>>>({
  initialValues,
  successMessage = false,
  validationSchema,
  onSubmit,
  errorTexts,
  protectChanges,
}: {
  initialValues: z.infer<UserSchema>;
  /** Opt-in: authentication forms do not contain an editable saved draft. */
  protectChanges?: { enabled: boolean; scope: string; label: string; externalDirty?: boolean; externalBusy?: boolean; discard?: () => void };
  validationSchema: UserSchema;
  successMessage?: boolean;
  /** This screen's own texts for a code or a status (messages.ts userMessage). */
  errorTexts?: Partial<Record<string | number, string>>;
  onSubmit?: (
    values: z.infer<UserSchema>,
    actions: FormikHelpers<z.infer<UserSchema>>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => Promise<any>;
}) => {
  const submitted = useRef(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const formik = useFormik<z.infer<UserSchema>>({
    initialValues,
    validate: withZodSchema(validationSchema),
    onSubmit: async (values, actions) => {
      submitted.current = false;
      setIsSuccess(false);
      setGlobalError(null);

      const sendForm = async () => {
        if (onSubmit) {
          await onSubmit(values, actions);
        }
        
        submitted.current = true;
        if (successMessage) {
          setIsSuccess(true);
          actions.resetForm();
        }
      };
      const result = await tryCatch(sendForm());
      if (result.error) {
        const failure = normalizeApiError(result.error);
        setGlobalError(userMessage(failure, errorTexts));
        const errors: Record<string, string> = {};
        for (const [key, message] of Object.entries(failure.fields)) {
          if (key in values && typeof message === "string") errors[key] = fieldMessage(message);
        }
        if (Array.isArray(failure.fields.errors)) {
          for (const item of failure.fields.errors) {
            const key = String(item?.loc?.at(-1) ?? "");
            if (key in values) errors[key] = fieldMessage(item);
          }
        }
        actions.setErrors(errors as FormikErrors<z.infer<UserSchema>>);
      }
      actions.setSubmitting(false);
    },
  });

  useUnsavedChanges({
    dirty: !!protectChanges?.enabled && (formik.dirty || !!protectChanges.externalDirty),
    busy: !!protectChanges?.enabled && (formik.isSubmitting || !!protectChanges.externalBusy),
    scope: protectChanges?.scope,
    label: protectChanges?.label,
    save: async () => {
      if (formik.isSubmitting || protectChanges?.externalBusy) return false;
      submitted.current = false;
      await formik.submitForm();
      return submitted.current;
    },
    discard: () => { formik.resetForm(); protectChanges?.discard?.(); },
  });
  return {
    formik,
    isSuccess,
    globalError,
    setIsSuccess,
    setGlobalError,
  };
};