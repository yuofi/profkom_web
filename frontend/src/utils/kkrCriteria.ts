import type { Criteria } from "./api/contract";

/**
 * The five KKR criteria in order, named as in the owner's KKR table (A1, owner 2026-11-08).
 * Every screen that names a criterion reads this list; the server's export and history use
 * the same words (backend database.KKR_CRITERIA).
 */
export const criteriaLabels: Record<keyof Criteria, string> = {
  unique: "Уникальная задача",
  creative: "Требует творческого подхода",
  external_communication: "Требует общения с администрацией или людьми вне вуза",
  in_person: "Требует очного присутствия",
  fixed_time: "Выполняется в определённое время",
};
export const criteriaKeys = Object.keys(criteriaLabels) as (keyof Criteria)[];

/** The criteria of a form whose checkbox fields are named by their keys ("true" / "false"). */
export const criteriaFromValues = (values: Record<string, string | string[] | undefined>): Criteria =>
  Object.fromEntries(criteriaKeys.map((key) => [key, values[key] === "true"])) as unknown as Criteria;
