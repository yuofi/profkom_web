import { createContext } from "react";

/** Opens the report dialog of FeedbackProvider; null outside the provider. */
export const FeedbackDialogContext = createContext<(() => void) | null>(null);

/** The side menu of the workspace registers itself (a ref callback): on a task page the report button
 *  stands in the bottom-left corner below it when it fits (D-03); null outside the provider. */
export const FeedbackSideMenuContext = createContext<((menu: HTMLElement | null) => void) | null>(null);
