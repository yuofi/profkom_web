import type { Notification } from "./api/contract";

/** The facts of a service-account sign-in notice (owner 2026-11-08, item 25); null for every other notice and for an
 *  older one without them. */
export const signInDetails = (notification: Pick<Notification, "kind" | "details">) =>
  (notification.kind === "service_login" || notification.kind === "service_login_failed") && notification.details ? notification.details : null;
