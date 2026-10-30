import type { SourceKind } from "../../utils/api/contract";
export const sourceNames: Record<SourceKind | "unallocated", string> = { block_task: "Задачи блоков", event_task: "Задачи мероприятий", chair_task: "Работа председателя", subevent_task: "Задачи подмероприятий", head_merit: "Заслуги главоргов", chair_merit: "Особые заслуги", block_volunteer: "Волонтёрство в блоках", subevent_volunteer: "Волонтёрство на мероприятиях", master_bonus: "Бонусы мастеров", unallocated: "Источник неизвестен" };
export const analyticsKey = (id: string, participant = "", block = "") => ["summary", "analytics", id, participant, block];
export const analyticsParams = (participant = "", block = "") => ({ ...(participant ? { participant_id: participant } : {}), ...(block ? { block_id: block } : {}) });
export const metricValue = (value: number | null | undefined) => value == null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value);
