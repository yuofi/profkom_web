import type {
  Event,
  Subevent,
  RichText,
  Leader,
  Meeting,
  TeamMeeting,
  Revision,
  ReportSeries,
  ContinuableSeries,
  Block,
} from "./contract";
import { idPath, allPages as page, request } from "./request";
export const eventsApi = {
  list: (params?: object) => page<Event>("/events", params),
  /** include_deputies: every leader also carries its deputies as user references. */
  get: (id: string, params?: { include_deputies?: boolean }) => request<Event>("get", `/events/${idPath(id)}`, undefined, params),
  setClosed: (id: string, closed: boolean, version: Revision) =>
    request<Event>("post", `/events/${idPath(id)}/${closed ? "close" : "reopen"}`, version),
  create: (data: {
    season_id: string;
    title: string;
    description: RichText;
    starts_at?: string;
    ends_at?: string;
    all_day?: boolean;
    report_series_id?: string;
  }) => request<Event>("post", "/events", data),
  update: (
    id: string,
    data: Revision &
      Partial<Pick<Event, "title" | "description" | "starts_at" | "ends_at" | "all_day">>,
  ) => request<Event>("patch", `/events/${idPath(id)}`, data),
  copy: (id: string, data: { season_id: string; title: string }) =>
    request<{ event: Event; subevents: Subevent[] }>(
      "post",
      `/events/${idPath(id)}/copy`,
      data,
    ),
  subevents: (id: string) => page<Subevent>(`/events/${idPath(id)}/subevents`),
  subevent: (id: string, params?: { include_deputies?: boolean }) =>
    request<Subevent>("get", `/subevents/${idPath(id)}`, undefined, params),
  createSubevent: (
    id: string,
    data: { title: string; description: RichText; report_series_id?: string; announcement?: RichText; starts_at?: string | null; ends_at?: string | null; all_day?: boolean },
  ) => request<Subevent>("post", `/events/${idPath(id)}/subevents`, data),
  updateSubevent: (
    id: string,
    data: Revision & Partial<Pick<Subevent, "title" | "description" | "announcement" | "starts_at" | "ends_at" | "all_day">>,
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
  assignSubeventHr: (id: string, data: Revision & { user_id: number | null }) => request<Subevent>("put", `/subevents/${idPath(id)}/hr`, data),
  blockLeader: (id: string, user_id: number, version: Revision) =>
    request<Block>("put", `/blocks/${idPath(id)}/leader`, {
      user_id,
      ...version,
    }),
  series: () => page<ReportSeries>("/report-series"),
  /** One read for the series field of a new event, or of a new subevent of `parentEventId` (PB-11). */
  continuableSeries: (parentEventId?: string, signal?: AbortSignal) =>
    page<ContinuableSeries>("/report-series/continuable", parentEventId ? { parent_event_id: parentEventId } : undefined, signal),
  meeting: (kind: "events" | "subevents", id: string) =>
    request<Meeting | null>("get", `/${kind}/${idPath(id)}/meeting`),
  /** The readable child-team announcements of one event, filtered by the server. */
  teamMeetings: (id: string) => page<TeamMeeting>(`/events/${idPath(id)}/meetings`),
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
  /** The revision the user confirmed; a changed announcement is refused with 409. */
  deleteMeeting: (kind: "events" | "subevents", id: string, version?: Revision) =>
    request<void>("delete", `/${kind}/${idPath(id)}/meeting`, version),
};
