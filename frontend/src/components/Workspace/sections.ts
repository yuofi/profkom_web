import { createContext, type CSSProperties, type ReactNode } from "react";
import type { IconName } from "../icons";

/** The accents next to the yellow of the brand (vars.css). */
export type Tone = "yellow" | "mint" | "lilac" | "peach" | "rose" | "sky";

/** --tone for the element and what is inside it. */
export const toneStyle = (tone?: Tone) =>
  tone ? ({ "--tone": `var(--accent-${tone})` } as CSSProperties) : undefined;

export interface Section {
  to: string;
  label: string;
  icon: IconName;
  tone: Tone;
  /** Pages of the section that have no menu item of their own. */
  under?: string[];
}

/** The menu: every page is in one of its sections, and the section gives it the colour. */
export const SECTIONS: Section[] = [
  { to: "/", label: "Моё участие", icon: "space_dashboard", tone: "yellow" },
  { to: "/events", label: "Мероприятия", icon: "celebration", tone: "mint", under: ["/subevents", "/meetings", "/reports"] },
  { to: "/tasks", label: "Мои задачи", icon: "task_alt", tone: "lilac" },
  { to: "/calendar", label: "Календарь", icon: "calendar_month", tone: "sky" },
  { to: "/contacts", label: "Контакты", icon: "contacts", tone: "sky" },
  { to: "/notifications", label: "Уведомления", icon: "notifications", tone: "peach" },
  { to: "/seasons", label: "Сезоны и ККР", icon: "insights", tone: "lilac" },
  { to: "/merits", label: "Учёт выполненной работы", icon: "fact_check", tone: "mint" },
  { to: "/admin", label: "Администрирование", icon: "admin_panel_settings", tone: "rose", under: ["/accounts", "/registrations"] },
  { to: "/blocks", label: "Блоки", icon: "groups", tone: "peach" },
  { to: "/materials", label: "Материалы", icon: "menu_book", tone: "rose", under: ["/guides", "/docs", "/info"] },
  { to: "/pgas", label: "ПГАС", icon: "workspace_premium", tone: "yellow" },
];

const inside = (pathname: string, path: string) =>
  pathname === path || pathname.startsWith(path + "/");

export function sectionOf(pathname: string): Section {
  if (inside(pathname, "/profile")) return { to: "/profile", label: "Мой профиль", icon: "account_circle", tone: "yellow" };
  return (
    SECTIONS.find((s) => s.to !== "/" && [s.to, ...(s.under ?? [])].some((p) => inside(pathname, p))) ??
    SECTIONS[0]
  );
}

/** The section of the page shown, for its header. */
export const SectionContext = createContext<Section | undefined>(undefined);
/** What a page shows under its header, before its content: the tabs of a cabinet. */
export const PageNavContext = createContext<ReactNode>(null);
