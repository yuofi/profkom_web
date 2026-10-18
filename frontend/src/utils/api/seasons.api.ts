import type {
  Season,
  SeasonSummary,
  MasterBonus,
  Contribution,
  Merit,
  MeritCreate,
  Revision,
  Decision,
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
  bonuses: (id: string) =>
    page<MasterBonus>(`/seasons/${idPath(id)}/master-bonuses`),
  decisions: (
    id: string,
    userId: number,
    data: { expected_version: number; decisions: Decision[]; reason?: string },
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
    request<SeasonSummary>(
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
  assessments: (params?: object) => page<Contribution>("/assessments", params),
  merits: (params?: object) => page<Merit>("/merits", params),
  merit: (id: string) => request<Merit>("get", `/merits/${idPath(id)}`),
  createMerit: (data: MeritCreate) => request<Merit>("post", "/merits", data),
  updateMerit: (
    id: string,
    data: Revision & Partial<MeritCreate> & { reason: string },
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
