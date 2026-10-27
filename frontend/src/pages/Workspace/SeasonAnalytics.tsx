import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { seasonsApi } from "../../utils/api/seasons.api";
import type { SeasonAnalytics as Analytics, SeasonAnalyticsTotals } from "../../utils/api/contract";
import { QueryState } from "../../components/Workspace/WorkspaceUI";
import { displayDate } from "../../utils/dates";
import u from "./SeasonWorkspace.module.css";
import { analyticsKey, analyticsParams, metricValue } from "./seasonAnalyticsView";

const metrics = { completed_tasks: { title: "Учтённые задачи", unit: "задач", hint: "Различные задачи с положительным расчётным решением" }, credited_hours: { title: "Учтённые часы", unit: "ч", hint: "Часы исполнителей с положительным расчётным решением" }, kkr: { title: "ККР", unit: "баллов", hint: "Сумма начислений, включая отрицательные" } };
type Metric = keyof SeasonAnalyticsTotals;
export function AnalyticsMetrics({ totals }: { totals: SeasonAnalyticsTotals }) {
  return <div className={u.metrics}>{(Object.keys(metrics) as Metric[]).map(key => <div key={key} className={u.metric}><span>{metrics[key].title}</span><strong>{metricValue(totals[key])}</strong><small>{metrics[key].hint}</small></div>)}</div>;
}
export function SeasonAnalytics({ seasonId }: { seasonId: string }) {
  const [participant, setParticipant] = useState(""), [block, setBlock] = useState("");
  const [mode, setMode] = useState<"weeks" | "seasons">("weeks"), [metric, setMetric] = useState<Metric>("completed_tasks");
  const query = useQuery({ queryKey: analyticsKey(seasonId, participant, block), queryFn: () => seasonsApi.analytics(seasonId, analyticsParams(participant, block)) });
  return <section className={u.stack} aria-label="Аналитика сезона"><div className={u.toolbar}><label>Участник<select aria-label="Участник" value={participant} onChange={e => setParticipant(e.target.value)}><option value="">Все участники</option>{query.data?.participants.map(person => <option key={person.participant_id} value={person.participant_id}>{person.user.display_name}</option>)}</select></label><label>Блок-источник<select aria-label="Блок-источник" value={block} onChange={e => setBlock(e.target.value)}><option value="">Все источники</option>{query.data?.blocks.map(item => <option key={item.block_id} value={item.block_id}>{item.name}</option>)}</select></label></div>
    <QueryState loading={query.isLoading} error={query.error} retry={() => void query.refetch()}>{query.data && <AnalyticsContent data={query.data} mode={mode} setMode={setMode} metric={metric} setMetric={setMetric} />}</QueryState>
  </section>;
}
function AnalyticsContent({ data, mode, setMode, metric, setMetric }: { data: Analytics; mode: "weeks" | "seasons"; setMode: (mode: "weeks" | "seasons") => void; metric: Metric; setMetric: (metric: Metric) => void }) {
  const dateParts = new Intl.DateTimeFormat("en", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(data.as_of));
  const day = (part: Intl.DateTimeFormatPartTypes) => dateParts.find(item => item.type === part)?.value ?? "";
  const observedDay = `${day("year")}-${day("month")}-${day("day")}`;
  const weeks = data.weekly.filter(row => data.basis.kind !== "current_ledger" || row.starts_on <= observedDay || row.completed_tasks !== 0 || row.credited_hours !== 0 || row.kkr !== 0);
  const points = mode === "weeks" ? weeks.map(row => ({ key: row.starts_on, label: shortDate(row.starts_on), detail: `Неделя с ${shortDate(row.starts_on)}`, value: row[metric] })) : data.season_comparison.map(row => ({ key: row.season_id, label: row.title, detail: `${row.title}${row.basis.kind === "approved_snapshot" ? " · утверждённый итог" : " · текущий учёт"}`, value: row.totals[metric] }));
  return <div className={u.stack}><AnalyticsMetrics totals={data.totals} /><section className={u.panel}>
    <div className={u.chartHeader}><h2>Динамика учтённой работы</h2><div className={u.chartModes} aria-label="Период графика"><button type="button" aria-pressed={mode === "weeks"} onClick={() => setMode("weeks")}>По неделям</button><button type="button" aria-pressed={mode === "seasons"} onClick={() => setMode("seasons")}>По сезонам</button></div></div>
    <div className={u.chartModes} aria-label="Показатель графика">{(Object.keys(metrics) as Metric[]).map(key => <button key={key} type="button" aria-pressed={metric === key} onClick={() => setMetric(key)}>{metrics[key].title}</button>)}</div>
    <WorkChart key={`${mode}-${metric}`} points={points} unit={metrics[metric].unit} period={mode} title={metrics[metric].title} />
    <p className={u.note}>{mode === "weeks" ? "Недели сгруппированы по расчётной дате выполнения работы, с понедельника по московскому времени. Это распределение текущего учёта по периодам, а не история баланса ККР на каждый день." : "Закрытые сезоны показаны по утверждённым снимкам. Пропуск означает, что показателя нет в сохранённых данных; нулём он не заменяется."}</p>
  </section>
  <section className={u.panel}><div className={u.panelHeader}><h2>Полнота данных</h2><span className={u.note}>На {displayDate(data.as_of)}</span></div><div className={u.chartSummary}><span>{data.basis.kind === "approved_snapshot" ? `Утверждённая версия ${data.basis.version ?? "—"}` : data.basis.kind === "current_ledger" ? "Текущие расчётные данные" : "Расчётные данные недоступны"}</span><span>Без привязки к неделе: {metricValue(data.unallocated.kkr)} ККР · {metricValue(data.unallocated.credited_hours)} ч.</span></div>{data.coverage.notes.length > 0 && <ul className={u.coverage}>{data.coverage.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}</section>
  </div>;
}
function shortDate(value: string) { return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${value.slice(0, 10)}T12:00:00Z`)); }
type Point = { key: string; label: string; detail: string; value: number | null };
function WorkChart({ points, title, unit, period }: { points: Point[]; title: string; unit: string; period: "weeks" | "seasons" }) {
  const container = useRef<HTMLDivElement>(null);const [width, setWidth] = useState(720), [active, setActive] = useState<number | null>(null);
  useEffect(() => { const node = container.current;if (!node || typeof ResizeObserver === "undefined") return;const observer = new ResizeObserver(entries => { const next = entries[0]?.contentRect.width;if (next) setWidth(Math.max(240, Math.round(next))); });observer.observe(node);return () => observer.disconnect(); }, []);
  const known = points.filter((p): p is Point & { value: number } => p.value !== null), left = 55, right = width - 18, top = 26, bottom = 220;
  const minimum = Math.min(0, ...known.map(p => p.value)), maximum = Math.max(0, ...known.map(p => p.value));
  const rawStep = (maximum - minimum || 1) / 4, power = 10 ** Math.floor(Math.log10(rawStep));
  const step = Math.max(unit === "задач" ? 1 : 0, ([1, 2, 5, 10].find(value => value * power >= rawStep) ?? 10) * power);
  const low = Math.floor(minimum / step) * step, high = Math.ceil(maximum / step) * step === low ? low + step : Math.ceil(maximum / step) * step;
  const barInset = period === "seasons" ? Math.min(30, (right - left) / 4) : 0;
  const firstDate = Date.parse(points[0]?.key ?? ""), lastDate = Date.parse(points.at(-1)?.key ?? "");
  const x = (index: number) => { const fraction = period === "weeks" && lastDate > firstDate ? (Date.parse(points[index].key) - firstDate) / (lastDate - firstDate) : points.length <= 1 ? .5 : index / (points.length - 1);return left + barInset + (right - left - 2 * barInset) * fraction; };
  const y = (value: number) => bottom - (bottom - top) * (value - low) / (high - low);
  const ticks = Array.from({ length: Math.round((high - low) / step) + 1 }, (_, index) => Math.abs(low + step * index) < step * 1e-8 ? 0 : low + step * index);
  const labels: number[] = [], spacing = period === "seasons" ? 110 : 75;
  points.forEach((_, index) => { if (!labels.length || x(index) - x(labels.at(-1)!) >= spacing) labels.push(index); });
  if (points.length > 1 && labels.at(-1) !== points.length - 1) { if (labels.length > 1 && x(points.length - 1) - x(labels.at(-1)!) < spacing) labels.pop();labels.push(points.length - 1); }
  const axisValue = (value: number) => new Intl.NumberFormat("ru-RU", { maximumSignificantDigits: 3, ...(Math.abs(value) >= 10000 ? { notation: "compact" as const } : {}) }).format(value);
  const paths: string[] = [];let path = "";points.forEach((point, index) => { if (point.value === null) { if (path) paths.push(path);path = ""; } else path += `${path ? " L" : "M"}${x(index)},${y(point.value)}`; });if (path) paths.push(path);
  const selected = active === null ? null : points[active];
  return <div ref={container}>
    {!known.length ? <div className={u.chartEmpty}>Для этого показателя нет датированных данных.</div> : <svg className={u.chart} role="img" aria-label={`${title}, ${period === "weeks" ? "по неделям выполнения" : "по сезонам"}; ${unit}`} viewBox={`0 0 ${width} 285`}>
      <title>{title}</title><desc>{points.length} периодов. Пропуски не считаются нулевыми значениями.</desc>
      {ticks.map((value, index) => <g key={index}><line className={u.chartGrid} x1={left} x2={right} y1={y(value)} y2={y(value)} /><text x={left - 10} y={y(value) + 4} textAnchor="end">{axisValue(value)}</text></g>)}
      <text x={left} y="13">{unit}</text>
      {period === "weeks" ? <>{paths.map((d, index) => <path key={index} d={d} className={u.chartLine} />)}{points.map((point, index) => point.value === null ? null : <circle key={point.key} className={u.chartPoint} cx={x(index)} cy={y(point.value)} r={active === index ? 5 : 3} />)}</> : points.map((point, index) => point.value === null ? null : <rect key={point.key} className={u.chartBar} data-negative={point.value < 0} x={x(index) - Math.min(28, (right - left) / Math.max(1, points.length) * .3)} y={Math.min(y(0), y(point.value))} width={Math.min(56, (right - left) / Math.max(1, points.length) * .6)} height={Math.abs(y(point.value) - y(0))} rx="4" />)}
      {points.map((point, index) => <g key={point.key} role="button" tabIndex={0} aria-label={`${point.detail}: ${point.value === null ? "нет данных" : `${metricValue(point.value)} ${unit}`}`} onFocus={() => setActive(index)} onMouseEnter={() => setActive(index)} onClick={() => setActive(index)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault();setActive(index); } }}><rect className={u.chartOverlay} x={Math.max(left, x(index) - (right - left) / Math.max(1, points.length) / 2)} y={top} width={Math.max(1, Math.min(right, x(index) + (right - left) / Math.max(1, points.length) / 2) - Math.max(left, x(index) - (right - left) / Math.max(1, points.length) / 2))} height={bottom - top + 25} />{labels.includes(index) && <text x={x(index)} y={bottom + 23} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}>{point.label.length > (width < 480 ? 14 : 22) ? `${point.label.slice(0, width < 480 ? 12 : 20)}…` : point.label}</text>}</g>)}
      <text x={right} y="277" textAnchor="end">{period === "weeks" ? "Недели выполнения работы" : "Сезоны"}</text>
    </svg>}
    <div className={u.chartSummary} aria-live="polite"><span>{selected ? selected.detail : `${known.length} из ${points.length} периодов с данными`}</span><strong>{selected ? selected.value === null ? "Нет данных" : `${metricValue(selected.value)} ${unit}` : ""}</strong></div>
  </div>;
}
