import { createContext } from "react";

/** Opens the report dialog of FeedbackProvider; null outside the provider. */
export const FeedbackDialogContext = createContext<(() => void) | null>(null);
