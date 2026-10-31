import type {
  Season,
  SeasonReadiness,
  SeasonSummary,
  SeasonAnalytics,
  MasterBonus,
  Contribution,
  Merit,
  MeritContexts,
  MeritCreate,
  MeritPatch,
  Revision,
  Decision,
  SummaryVersionMetadata,
  SummaryVersionSnapshot,
} from "./contract";
import { api } from "./index";
import {
  idPath,
  allPages as page,
  request,
  normalizeApiError,
} from "./request";
export const seasonsApi = {
  list: () => page<Season>("/seasons"),
  current: () => request<Season>("get", "/seasons/current"),
  create: (data: Pick<Season, "title" | "type" | "starts_at" | "ends_at">) =>
    request<Season>("post", "/seasons", data),
  update: (
    id: string,
    data: Revision &
      Partial<Pick<Season, "title" | "starts_at" | "ends_at">> & {
        reason: string;
      },
  ) => request<Season>("patch", `/seasons/${idPath(id)}`, data),
  command: (
    id: string,
    action: "open" | "begin-summary" | "close",
    data: Revision,
  ) =>
    request<Season | { season: Season; summary: SeasonSummary }>(
      "post",
      `/seasons/${idPath(id)}/${action}`,
      data,
    ),
  summary: (id: string) =>
    request<SeasonSummary>("get", `/seasons/${idPath(id)}/summary`),
  /** include_task_ids: assignment blockers carry the task the reader may open (or null). */
  readiness: (id: string, params?: { include_task_ids?: boolean }) => request<SeasonReadiness>("get", `/seasons/${idPath(id)}/readiness`, undefined, params),
  analytics: (id: string, params: { participant_id?: string; block_id?: string } = {}) =>
    request<SeasonAnalytics>("get", `/seasons/${idPath(id)}/analytics`, undefined, params),
  summaryVersions: (id: string) =>
    page<SummaryVersionMetadata>(`/seasons/${idPath(id)}/summary/versions`),
  summaryVersion: (id: string, version: number) =>
    request<SummaryVersionSnapshot>("get", `/seasons/${idPath(id)}/summary/versions/${version}`),
  bonuses: (id: string) =>
    page<MasterBonus>(`/seasons/${idPath(id)}/master-bonuses`),
  decisions: (
    id: string,
    userId: number,
    /** expected_decisions: the participant's marks the client saw; in an open or summarizing
     * season they replace the summary version check (PB-16). */
    data: { expected_version: number; expected_decisions?: Decision[]; decisions: Decision[]; reason?: string },
  ) =>
    request<SeasonSummary>(
      "put",
      `/seasons/${idPath(id)}/summary/decisions/${userId}`,
      data,
    ),
  correctSummary: (
    id: string,
    data: {
      expected_version: number;
      reason: string;
      changes: {
        kind: "task_inputs" | "assessment_inputs" | "merit";
        id: string;
        expected_revision: number;
        values: object;
      }[];
    },
  ) =>
    request<SeasonSummary & {applied_revisions: {kind: string; id: string; revision: number}[]}>(
      "post",
      `/seasons/${idPath(id)}/summary/correct`,
      data,
    ),
  correctSeason: (data: {
    object_kind: "event" | "block_task" | "merit";
    object_id: string;
    expected_revision: number;
    target_season_id: string;
    reason: string;
  }) =>
    request<{
      object_id: string;
      source_season_id: string;
      target_season_id: string;
      revision: number;
    }>("post", "/season-corrections", data),
  correctionPreview: (eventId: string) => request<{ object_id: string; source_season_id: string; revision: number; counts: { subevents: number; tasks: number; reports: number; merits: number } }>("get", `/season-corrections/event/${idPath(eventId)}/preview`),
  assessments: (params?: object) => page<Contribution>("/assessments", params),
  merits: (params?: object) => page<Merit>("/merits", params),
  /** One request for the merit forms' blocks, events and subevents (optionally of one season). */
  meritContexts: (seasonId?: string) => request<MeritContexts>("get", "/merits/contexts", undefined, seasonId ? { season_id: seasonId } : undefined),
  merit: (id: string) => request<Merit>("get", `/merits/${idPath(id)}`),
  createMerit: (data: MeritCreate) => request<Merit>("post", "/merits", data),
  updateMerit: (
    id: string,
    data: Revision & Partial<MeritPatch> & { reason: string },
  ) => request<Merit>("patch", `/merits/${idPath(id)}`, data),
  export: async (id: string): Promise<Blob> => {
    try {
      return (
        await api.get<Blob>(`/seasons/${idPath(id)}/summary.xlsx`, {
          responseType: "blob",
        })
      ).data;
    } catch (error) {
      throw normalizeApiError(error);
    }
  },
};
