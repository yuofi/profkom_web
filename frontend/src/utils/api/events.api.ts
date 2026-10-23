import type {
  Event,
  Subevent,
  RichText,
  Leader,
  Meeting,
  Revision,
  ReportSeries,
  Block,
} from "./contract";
import { idPath, allPages as page, request } from "./request";
export const eventsApi = {
  list: (params?: object) => page<Event>("/events", params),
  get: (id: string) => request<Event>("get", `/events/${idPath(id)}`),
  create: (data: {
    season_id: string;
    title: string;
    description: RichText;
    starts_at?: string;
    ends_at?: string;
    report_series_id?: string;
  }) => request<Event>("post", "/events", data),
  update: (
    id: string,
    data: Revision &
      Partial<Pick<Event, "title" | "description" | "starts_at" | "ends_at">>,
  ) => request<Event>("patch", `/events/${idPath(id)}`, data),
  copy: (id: string, data: { season_id: string; title: string }) =>
    request<{ event: Event; subevents: Subevent[] }>(
      "post",
      `/events/${idPath(id)}/copy`,
      data,
    ),
  subevents: (id: string) => page<Subevent>(`/events/${idPath(id)}/subevents`),
  subevent: (id: string) =>
    request<Subevent>("get", `/subevents/${idPath(id)}`),
  createSubevent: (
    id: string,
    data: { title: string; description: RichText; report_series_id?: string },
  ) => request<Subevent>("post", `/events/${idPath(id)}/subevents`, data),
  updateSubevent: (
    id: string,
    data: Revision & Partial<Pick<Subevent, "title" | "description">>,
  ) => request<Subevent>("patch", `/subevents/${idPath(id)}`, data),
  leaders: (
    kind: "events" | "subevents",
    id: string,
    user_ids: number[],
    version: Revision,
  ) =>
    request<Event | Subevent>("put", `/${kind}/${idPath(id)}/leaders`, {
      user_ids,
      ...version,
    }),
  deputies: (id: string, user_ids: number[], version: Revision) =>
    request<Leader>("put", `/role-assignments/${idPath(id)}/deputies`, {
      user_ids,
      ...version,
    }),
  organizers: (id: string, user_ids: number[], version: Revision) =>
    request<Subevent>("put", `/subevents/${idPath(id)}/organizers`, {
      user_ids,
      ...version,
    }),
  blockLeader: (id: string, user_id: number, version: Revision) =>
    request<Block>("put", `/blocks/${idPath(id)}/leader`, {
      user_id,
      ...version,
    }),
  series: () => page<ReportSeries>("/report-series"),
  meeting: (kind: "events" | "subevents", id: string) =>
    request<Meeting | null>("get", `/${kind}/${idPath(id)}/meeting`),
  saveMeeting: (
    kind: "events" | "subevents",
    id: string,
    data: {
      title: string;
      starts_at: string;
      join_url: string;
      expected_revision?: number;
    },
  ) => request<Meeting>("put", `/${kind}/${idPath(id)}/meeting`, data),
  deleteMeeting: (kind: "events" | "subevents", id: string) =>
    request<void>("delete", `/${kind}/${idPath(id)}/meeting`),
};
