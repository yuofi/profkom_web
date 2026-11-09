import type { AccountingBatch } from "./api/kkr.api";
import { criteriaKeys } from "./kkrCriteria";

/** Hours as the KKR window writes them: a decimal comma and no grouping («2,5»); empty when not given. */
export const formatHours = (value: number | null) => value == null ? "" : String(value).replace(".", ",");

/** Typed hours: null when the field is empty, undefined while the text is not a number yet (a lone comma). */
export function parseHours(text: string): number | null | undefined {
  const value = text.trim().replace(",", ".");
  if (!value) return null;
  const hours = Number(value);
  return Number.isFinite(hours) && hours >= 0 ? hours : undefined;
}

const decimal = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const excludedWord = (count: number) => new Intl.PluralRules("ru-RU").select(count) === "one" ? "исключён" : "исключены";

/**
 * The line under «Учёт работы и ККР» on a task (owner A2): how many of the counted executors are rated,
 * how many are excluded, their hours and the task criteria out of all of them, e.g.
 * «Оценено 3 из 3 · 1 исключён · всего 9,5 ч · признаков задачи: 4 из 5». Excluded executors count
 * neither in the rated ones nor in the hours.
 */
export function accountingSummary(batch: AccountingBatch) {
  const counted = batch.assignments.filter(row => !row.excluded), excluded = batch.assignments.length - counted.length;
  const rated = counted.filter(row => row.evaluation != null).length;
  const hours = counted.reduce((sum, row) => sum + (row.hours ?? 0), 0);
  const criteria = criteriaKeys.filter(key => batch.criteria[key]).length;
  const people = !batch.assignments.length ? "Исполнителей нет" : !counted.length ? "" : rated ? `Оценено ${rated} из ${counted.length}` : "Оценок пока нет";
  return [
    people,
    excluded ? `${excluded} ${excludedWord(excluded)}` : "",
    batch.assignments.length ? `всего ${decimal.format(hours)} ч` : "",
    `признаков задачи: ${criteria} из ${criteriaKeys.length}`,
  ].filter(Boolean).join(" · ");
}
