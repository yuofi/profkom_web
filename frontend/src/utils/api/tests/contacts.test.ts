import { expect, it } from "vitest";
import { ProfileValidationSchema, SignUpValidationSchema } from "../../zod";
import { registrationFieldsSchema, telegramField, vkField } from "../../contactFields";

it.each(["@valid_user", "valid_user", "https://t.me/valid_user/", " t.me/valid_user "])("INT-04: accepts existing and normalized Telegram form %s", tg => {
  const registration = { surname: "Тестовый", name: "Участник", patronymic: null, group_number: "301", phone: "+79990000000", email: "test@example.com", tg, vk: "id1", funding: "budget", residence: "Тест" };
  const profile = ProfileValidationSchema.safeParse({ ...registration, patronymic: "", budget: "Бюджет" });
  expect(profile.success).toBe(true); expect(registrationFieldsSchema.safeParse(registration).success).toBe(true);
  expect(SignUpValidationSchema.safeParse({ name: "Тест", surname: "Тест", patronymic: "", email: registration.email, telegram: tg, groupNumber: "301", password: "Synthetic-2026", passwordAgain: "Synthetic-2026" }).success).toBe(true);
});
it.each(["id1", "u", "https://vk.com/id1", "vk.com/u/"])("INT-04: preserves short VK contacts %s", value => expect(vkField.safeParse(value).success).toBe(true));
it.each([
  ["https://vk.ru/id294457478", "https://vk.ru/id294457478"],
  ["https://m.vk.com/durov", "https://vk.ru/durov"],
  ["https://vk.com/id1", "https://vk.ru/id1"],
  ["vk.ru/some.name/", "https://vk.ru/some.name"],
  ["@durov", "durov"],
])("accepts the usual VK forms %s", (value, saved) => expect(vkField.parse(value)).toBe(saved));
it("explains the VK and Telegram formats in the field error", () => {
  expect(vkField.safeParse("not a profile").error?.issues[0].message).toBe("Укажите VK: ссылку vk.ru/имя, vk.ru/id123 или только имя профиля");
  expect(telegramField.safeParse("not a profile").error?.issues[0].message).toBe("Укажите Telegram: @имя, имя или ссылку t.me/имя");
});
it.each(["javascript:alert(1)", "https://vk.com.evil.test/id1", "not a profile"])("INT-04: rejects invalid contact %s", value => {
  expect(vkField.safeParse(value).success).toBe(false); expect(telegramField.safeParse(value).success).toBe(false);
});
