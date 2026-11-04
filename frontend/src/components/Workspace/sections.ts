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
  /** Pages of the section that have no menu item of their own; `*` stands for one path segment. */
  under?: string[];
}

/** The menu: every page is in one of its sections, and the section gives it the colour. */
export const SECTIONS: Section[] = [
  { to: "/", label: "Рабочее пространство", icon: "space_dashboard", tone: "yellow" },
  { to: "/events", label: "Мероприятия", icon: "celebration", tone: "mint", under: ["/subevents", "/meetings", "/reports"] },
  { to: "/tasks", label: "Трекер", icon: "task_alt", tone: "lilac" },
  { to: "/calendar", label: "Календарь", icon: "calendar_month", tone: "sky" },
  { to: "/contacts", label: "Контакты", icon: "contacts", tone: "sky" },
  { to: "/notifications", label: "Уведомления", icon: "notifications", tone: "peach" },
  { to: "/seasons", label: "Сезоны и ККР", icon: "insights", tone: "lilac" },
  { to: "/merits", label: "Учёт выполненной работы", icon: "fact_check", tone: "mint", under: ["/seasons/*/merits"] },
  { to: "/admin", label: "Администрирование", icon: "admin_panel_settings", tone: "rose", under: ["/accounts", "/registrations"] },
  { to: "/broadcasts", label: "Рассылки", icon: "send", tone: "sky" },
  { to: "/blocks", label: "Блоки", icon: "groups", tone: "peach" },
  { to: "/materials", label: "Материалы", icon: "menu_book", tone: "rose", under: ["/guides", "/docs", "/info"] },
  { to: "/pgas", label: "ПГАС", icon: "workspace_premium", tone: "yellow" },
];

const inside = (pathname: string, path: string) => {
  const parts = pathname.split("/"), pattern = path.split("/");
  return pattern.length <= parts.length && pattern.every((part, index) => part === "*" ? !!parts[index] : part === parts[index]);
};

/** The section of the most specific matching path: /seasons/1/merits is under Учёт выполненной работы, not Сезоны. */
export function sectionOf(pathname: string, { supportStaff = false, broadcaster = false }: { supportStaff?: boolean; broadcaster?: boolean } = {}): Section {
  // /support is reached from the profile («Мои обращения») and belongs to it (GL-30); for the
  // support staff it is the work page of the queue, in the workspace.
  if (inside(pathname, "/profile") || !supportStaff && inside(pathname, "/support")) return { to: "/profile", label: "Мой профиль", icon: "account_circle", tone: "yellow" };
  // A broadcast's page is where the bell leads every member (BOT_API.md, stage 4): it is a
  // notification for them, and a page of Рассылки for those who have that menu item.
  if (!broadcaster && inside(pathname, "/broadcasts/*")) return SECTIONS.find(({ to }) => to === "/notifications")!;
  let found: Section | undefined, depth = 0;
  for (const section of SECTIONS)
    for (const path of section.to === "/" ? [] : [section.to, ...(section.under ?? [])])
      if (path.split("/").length > depth && inside(pathname, path)) { found = section;depth = path.split("/").length; }
  return found ?? SECTIONS[0];
}

/** The section of the page shown, for its header. */
export const SectionContext = createContext<Section | undefined>(undefined);
/** What a page shows under its header, before its content: the tabs of a cabinet. */
export const PageNavContext = createContext<ReactNode>(null);
