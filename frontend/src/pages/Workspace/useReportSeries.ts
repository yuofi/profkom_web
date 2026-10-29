import { useQuery } from "@tanstack/react-query";
import type { Event } from "../../utils/api/contract";
import { eventsApi } from "../../utils/api/events.api";
import { seasonsApi } from "../../utils/api/seasons.api";
export const NEW_SERIES = "new";
/**
 * The report series a new instance may continue (FIX_PLAN 2.21): event series for a new
 * event, the parent's child series not yet used by its subevents for a new subevent.
 * Each option names the latest instance and its season to tell similar series apart.
 */
export function useSeriesField(enabled: boolean, parent?: Event, used: string[] = []) {
  const series = useQuery({ queryKey: ["reports", "series"], queryFn: eventsApi.series, enabled });
  const events = useQuery({ queryKey: ["events"], queryFn: () => eventsApi.list(), enabled });
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list, enabled });
  const earlier = useQuery({
    queryKey: ["events", "series-instances", parent?.event_id],
    enabled: enabled && !!parent && !!events.data,
    queryFn: async () => (await Promise.all(events.data!.items
      .filter((e) => e.report_series_id === parent!.report_series_id && e.event_id !== parent!.event_id)
      .map(async (e) => (await eventsApi.subevents(e.event_id)).items.map((sub) => ({ ...sub, season_id: e.season_id }))))).flat(),
  });
  const currentChildren = useQuery({ queryKey: ["events", parent?.event_id, "subevents"], queryFn: () => eventsApi.subevents(parent!.event_id), enabled: enabled && !!parent });
  const usedIds = new Set([...used, ...(currentChildren.data?.items.map(item => item.report_series_id).filter((id): id is string => !!id) ?? [])]);
  const order = (seasonId: string) => seasons.data?.items.find((x) => x.season_id === seasonId)?.sequence_number ?? 0;
  const instances = parent ? earlier.data ?? [] : events.data?.items ?? [];
  const options = (series.data?.items ?? [])
    .filter((x) => (parent
      ? x.owner_kind === "subevent" && x.parent_series_id === parent.report_series_id
      : x.owner_kind === "event") && !usedIds.has(x.series_id))
    .map((x) => {
      const latest = instances.filter((i) => i.report_series_id === x.series_id)
        .sort((a, b) => order(b.season_id) - order(a.season_id))[0];
      const season = latest && seasons.data?.items.find((y) => y.season_id === latest.season_id)?.title;
      return { value: x.series_id, label: latest ? `${x.title} — ${latest.title}, ${season ?? "сезон недоступен"}` : x.title };
    });
  return {
    name: "series",
    label: "Серия отчётов",
    type: "select" as const,
    required: true,
    value: NEW_SERIES,
    hint: "Продолжение серии открывает её прошлые отчёты в истории.",
    options: [{ value: NEW_SERIES, label: "Новая серия" }, ...options],
  };
}
export const chosenSeries = (value: string) => (value && value !== NEW_SERIES ? { report_series_id: value } : {});
