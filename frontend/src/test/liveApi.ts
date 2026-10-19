import Cookies from "js-cookie";
import { authApi } from "../utils/api/auth.api";
import { sessionApi } from "../utils/api/session.api";
import { membershipApi } from "../utils/api/membership.api";

export const livePassword = "Synthetic-Local-2026";
export async function liveLogin(email = "chair@example.com") {
  const response = await authApi.login({ email, password: livePassword });
  Cookies.set("access_token", response.data.access_token);
  return sessionApi.get();
}
export async function liveParticipant(label: string) {
  const email = `integration-${label}-${crypto.randomUUID()}@example.com`;
  const response = await authApi.register({ email, password: livePassword,
    surname: "Тестовый", name: label, patronymic: "", group_number: 301, tg: "@profkom_test",
    phone: "+79990000000", vk: "https://vk.com/id123", funding: "budget", residence: "Тест" } as Parameters<typeof authApi.register>[0]);
  Cookies.set("access_token", response.data.access_token);
  const pending = await sessionApi.get();
  const application = await membershipApi.registration();
  await liveLogin();
  await membershipApi.registrationCommand(pending.user_id, "approve", { expected_revision: application.revision });
  return { user_id: pending.user_id, email };
}
