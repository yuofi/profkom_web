import { useQuery } from "@tanstack/react-query";
import type { Event } from "../../utils/api/contract";
import { eventsApi } from "../../utils/api/events.api";
export const NEW_SERIES = "new";
/** One key per form: under ["reports"], so every workspace command rereads it. */
export const continuableSeriesKey = (parentEventId?: string) => ["reports", "series", "continuable", parentEventId ?? null] as const;
/**
 * The report series a new instance may continue (FIX_PLAN 2.21): event series for a new
 * event, the parent's child series not yet used by its subevents for a new subevent.
 * Each option names the latest instance and its season to tell similar series apart.
 * The server computes the options in one read (PB-11) instead of the series, events and
 * seasons lists plus the subevents of every earlier instance of the parent's series.
 */
export function useSeriesField(enabled: boolean, parent?: Event) {
  const series = useQuery({
    queryKey: continuableSeriesKey(parent?.event_id),
    queryFn: ({ signal }) => eventsApi.continuableSeries(parent?.event_id, signal),
    enabled,
  });
  const options = (series.data?.items ?? []).map((x) => ({
    value: x.series_id,
    label: x.latest ? `${x.title} — ${x.latest.title}, ${x.latest.season_title ?? "сезон недоступен"}` : x.title,
  }));
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
