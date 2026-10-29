import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { HoverCard } from "../../components/Workspace/HoverCard";
import { InteractiveChip } from "../../components/Workspace/InteractiveChip";
import type { CalendarItem } from "../../utils/api/contract";
import { getMeetingRoute, getSeasonRoute, targetRoute } from "../../utils/routes";
import { displayTime } from "../../utils/dates";
import { moscowDay, occursOnDay } from "../../utils/calendar";
import { toneStyle, type Tone } from "../../components/Workspace/sections";
import { eventPeriod } from "./eventDates";
import { dayStart, timedCalendarItems, type TimedCalendarItem } from "./calendarLayout";
import { statusNames } from "./trackerStatus";
import c from "./calendar.module.css";

const KINDS: Record<CalendarItem["kind"], { label: string; tone: Tone }> = {
  task_deadline: { label: "Дедлайн", tone: "lilac" }, event: { label: "Мероприятие", tone: "mint" }, meeting: { label: "Созвон", tone: "yellow" },
};
function calendarRoute(item: CalendarItem) {
  return item.kind === "meeting" && (item.target.kind === "event" || item.target.kind === "subevent") ? getMeetingRoute(item.target.kind, item.target.id) : targetRoute(item.target);
}
function CalendarPreview({ item, season }: { item: CalendarItem; season: string }) {
  const route = calendarRoute(item);
  return <div className={c.preview} style={toneStyle(KINDS[item.kind].tone)}>
    <small className={c.previewKind}>{KINDS[item.kind].label}{item.task_key ? ` · ${item.task_key}` : ""}</small>
    <h3>{route ? <Link to={route}>{item.title}</Link> : item.title}</h3><p>{eventPeriod(item)}</p>
    {item.status && <p>{statusNames[item.status]}</p>}
    <InteractiveChip kind="link" to={getSeasonRoute(item.season_id)} className={c.seasonChip}
      label={<span className={c.seasonLabel}><span className={c.seasonPrefix}>Сезон:</span><span className={c.seasonName}>{season}</span></span>}
      title={`Сезон: ${season}`} ariaLabel={`Открыть сезон: ${season}`}
      icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M3 10h18M8 3v4M16 3v4M8 14h3M13 17h3" /></svg>} />
  </div>;
}
export function CalendarItemLink({ item, season, time, compact = false }: { item: CalendarItem; season: string; time?: string; compact?: boolean }) {
  const route = calendarRoute(item), label = `${KINDS[item.kind].label}: ${item.title}. ${eventPeriod(item)}. Сезон: ${season}`;
  return <HoverCard className={compact ? c.compactAnchor : c.timedAnchor} content={() => <CalendarPreview item={item} season={season} />}>
    {({ describedBy }) => route ? <Link className={compact ? c.compactLink : c.timedLink} to={route} aria-label={label} aria-describedby={describedBy}>
      <i className={c.dot} aria-hidden="true" />{time && <time className={c.entryTime}>{time}</time>}<span className={c.entryTitle}>{item.title}</span>
    </Link> : <span className={c.compactLink} tabIndex={0} aria-label={label} aria-describedby={describedBy}>{time && <time>{time}</time>}<span>{item.title}</span></span>}
  </HoverCard>;
}
function segmentTime(segment: TimedCalendarItem) {
  if (segment.point) return displayTime(segment.item.starts_at);
  const first = segment.continuesBefore ? "00:00" : displayTime(segment.item.starts_at);
  const last = segment.continuesAfter ? "24:00" : displayTime(segment.item.ends_at!);
  return `${first}–${last}`;
}
/** Shared by the workspace's Today widget and full day/week views. No extra domain reads. */
export function CalendarTimeGrid({ days, items, seasonTitle, today, compact = false }: {
  days: string[]; items: CalendarItem[]; seasonTitle: (id: string) => string; today: string; compact?: boolean;
}) {
  const scroll = useRef<HTMLDivElement>(null), key = days.join(",");
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000);return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (!compact || !scroll.current) return;
    const now = Date.now(), currentDay = moscowDay(new Date(now).toISOString());
    const currentHour = (now - dayStart(currentDay)) / 3600000;
    scroll.current.scrollTop = Math.max(0, Math.min(20, key.split(",").includes(currentDay) ? currentHour - 2 : 8)) * 48;
  // Only Today scrolls to its hours; full views remain in the page's normal flow.
  // Background data refreshes never reset the compact widget's chosen position.
  }, [compact, key]);
  const nowDay = moscowDay(new Date(now).toISOString()), nowMinute = (now - dayStart(nowDay)) / 60000;
  const style = { "--calendar-days": days.length, "--calendar-min-width": days.length > 1 ? "780px" : "0px" } as CSSProperties;
  const dayLabel = (day: string) => new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/Moscow" }).format(dayStart(day));
  return <section className={`${c.timelineFrame} ${compact ? c.timelineCompact : ""}`} aria-label={days.length > 1 ? "Календарь недели" : "Календарь дня"} style={style}>
    <div className={c.timelineOverflow}><div className={c.timelineInner}>
      <div className={c.timelineHeader}><span>МСК</span>{days.map(day => <strong key={day} aria-current={day === today ? "date" : undefined} aria-label={day}>{dayLabel(day)}</strong>)}</div>
      <div className={c.allDayRow}><small>Весь день</small>{days.map(day => <div key={day} aria-label={`Весь день: ${day}`}>
        {items.filter(item => item.all_day && occursOnDay(item, day)).map(item => <div key={item.id} style={toneStyle(KINDS[item.kind].tone)}><CalendarItemLink item={item} season={seasonTitle(item.season_id)} compact /></div>)}
        {!items.some(item => item.all_day && occursOnDay(item, day)) && <span className={c.allDayEmpty}>—</span>}
      </div>)}</div>
      <div className={compact ? c.timelineScroller : c.timelineBody} ref={compact ? scroll : undefined}><div className={c.timeCanvas}>
        <div className={c.hourGutter} aria-label="Шкала часов">{Array.from({ length: 24 }, (_, hour) => <span key={hour} style={{ top: `${hour * 48}px` }}>{String(hour).padStart(2, "0")}:00</span>)}</div>
        {days.map(day => <div className={c.timeColumn} key={day} aria-label={`События: ${day}`}>
          {Array.from({ length: 24 }, (_, hour) => <div key={hour} className={c.hourLine} style={{ top: `${hour * 48}px` }} />)}
          {day === nowDay && <div className={c.nowLine} style={{ top: `${nowMinute / 60 * 48}px` }} aria-label="Текущее время" />}
          {timedCalendarItems(items, day).map(segment => <div key={segment.item.id} className={`${c.timedItem} ${segment.point ? c.point : ""}`} data-calendar-item={segment.item.id} data-point={segment.point || undefined}
            style={{ ...toneStyle(KINDS[segment.item.kind].tone), top: `${segment.start / 60 * 48}px`, height: `${Math.max(26, (segment.end - segment.start) / 60 * 48)}px`, left: `calc(${segment.lane / segment.lanes * 100}% + 3px)`, width: `calc(${100 / segment.lanes}% - 6px)` }}>
            <CalendarItemLink item={segment.item} time={segmentTime(segment)} season={seasonTitle(segment.item.season_id)} />
          </div>)}
        </div>)}
      </div></div>
    </div></div>
  </section>;
}
export function CalendarMonth({ days, offset, items, today, seasonTitle, openDay }: {
  days: string[]; offset: number; items: CalendarItem[]; today: string; seasonTitle: (id: string) => string; openDay: (day: string) => void;
}) {
  return <div className={c.calendar} role="table" aria-label="Календарь месяца"><div className={c.week} role="row">{["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map(day => <strong role="columnheader" key={day}>{day}</strong>)}</div><div className={c.days}>
    {Array.from({ length: offset }, (_, index) => <div key={`empty-${index}`} className={c.empty} />)}
    {days.map(day => { const entries = items.filter(item => occursOnDay(item, day)).sort((left, right) => Number(!!right.all_day) - Number(!!left.all_day) || left.starts_at.localeCompare(right.starts_at));return <div key={day} className={`${c.day} ${day === today ? c.today : ""}`} role="cell" aria-label={day} aria-current={day === today ? "date" : undefined}>
      <button className={c.dayNumber} aria-label={`Открыть день: ${day}`} onClick={() => openDay(day)}>{Number(day.slice(-2))}</button>
      {entries.slice(0, 4).map(item => <div key={item.id} className={c.monthEntry} style={toneStyle(KINDS[item.kind].tone)}>
        <CalendarItemLink item={item} season={seasonTitle(item.season_id)} compact time={item.all_day ? undefined : moscowDay(item.starts_at) === day ? displayTime(item.starts_at) : "↔"} />
      </div>)}
      {entries.length > 4 && <button className={c.moreEntries} onClick={() => openDay(day)}>Ещё {entries.length - 4}</button>}
    </div>;})}
  </div></div>;
}
