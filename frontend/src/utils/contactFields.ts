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
export const patronymicField = z.preprocess(value => value ?? "", z.string().trim());
export const registrationFieldsSchema = z.object({
  surname: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(100),
  patronymic: patronymicField.transform(value => value || null),
  group_number: z.string().trim().min(1).max(30), phone: z.string().trim().min(1).max(40),
  email: z.email(), tg: telegramField.refine(Boolean, "Укажите Telegram"), vk: vkField.refine(Boolean, "Укажите VK"),
  funding: z.enum(["budget", "contract"]), residence: z.string().trim().min(1).max(500),
});
