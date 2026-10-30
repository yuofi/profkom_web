import type { Participation } from "./contract";
import { idPath, request } from "./request";

/** Public current team identities, never another person's private workspace. */
export const publicParticipationApi = {
  get: (userId: number) => request<Participation>("get", `/participants/${idPath(userId)}/participation`),
};
