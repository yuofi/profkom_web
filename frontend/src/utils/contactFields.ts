import type { RegistrationApplication } from "./api/contract";
import { z } from "zod";

export function normalizeTelegram(value: string) {
  const clean = value.trim();
  const match = clean.match(/^(?:https?:\/\/)?(?:www\.)?t\.me\/([A-Za-z0-9_]{5,32})\/?$/i);
  return match ? `@${match[1]}` : clean;
}
export function normalizeVk(value: string) {
  const clean = value.trim();
  const match = clean.match(/^(?:https?:\/\/)?(?:www\.)?vk\.com\/([A-Za-z0-9_][A-Za-z0-9_.]{0,63})\/?$/i);
  return match ? `https://vk.com/${match[1]}` : clean;
}
export const telegramField = z.string().transform(normalizeTelegram).refine(
  value => !value || /^@?[A-Za-z0-9_]{5,32}$/.test(value),
  "Укажите Telegram: @username, username или ссылку t.me/username",
);
export const vkField = z.string().transform(normalizeVk).refine(
  value => !value || /^[A-Za-z0-9_][A-Za-z0-9_.]{0,63}$/.test(value) || /^https:\/\/vk\.com\/[A-Za-z0-9_][A-Za-z0-9_.]{0,63}$/.test(value),
  "Укажите имя профиля VK или ссылку vk.com/имя",
);
/** The same rule as the server: a group is a number from 100 to 700 (A-ROL-17). */
export const isValidGroupNumber = (value: string | number) => {
  const str = String(value).trim();
  if (!/^\d+$/.test(str)) return false;
  const num = parseInt(str, 10);
  return num >= 100 && num <= 700;
};
export const groupNumberMessage = "Номер группы должен быть числом от 100 до 700";
export const patronymicField = z.preprocess(value => value ?? "", z.string().trim());
export const registrationFieldsSchema = z.object({
  surname: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(100),
  patronymic: patronymicField.transform(value => value || null),
  group_number: z.string().trim().refine(isValidGroupNumber, groupNumberMessage), phone: z.string().trim().min(1).max(40),
  email: z.email(), tg: telegramField.refine(Boolean, "Укажите Telegram"), vk: vkField.refine(Boolean, "Укажите VK"),
  funding: z.enum(["budget", "contract"], "Выберите основу обучения"), residence: z.string().trim().min(1).max(500),
});
export const registrationLabels = {
  surname: "Фамилия",
  name: "Имя",
  patronymic: "Отчество",
  group_number: "Группа",
  phone: "Телефон",
  email: "Почта",
  tg: "Telegram",
  vk: "VK",
  residence: "Место проживания",
};
export const fundingLabels = { budget: "Бюджет", contract: "Контракт" } as const;
/** Labels of the fields that block approval, in form order (A-ROL-20). */
export function missingFields(fields: RegistrationApplication["fields"]) {
  const parsed = registrationFieldsSchema.safeParse(fields);
  if (parsed.success) return [];
  const failed = new Set(parsed.error.issues.map((issue) => String(issue.path[0])));
  return Object.entries({ ...registrationLabels, funding: "Основа обучения" })
    .filter(([name]) => failed.has(name))
    .map(([, label]) => label);
}
