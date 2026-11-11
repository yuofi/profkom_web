// @vitest-environment jsdom
import Cookies from "js-cookie";
import { expect, it } from "vitest";
import { authApi } from "../../utils/api/auth.api";
import { membershipApi } from "../../utils/api/membership.api";
import { sessionApi } from "../../utils/api/session.api";
import { liveLogin, livePassword } from "../../test/liveApi";

it("keeps the explicit patronymic decision across real registration, edits and approval", async () => {
  const account = { email: `patronymic-${crypto.randomUUID()}@example.com`, password: livePassword,
    surname: "Тестовая", name: "Участница", patronymic: "", group_number: 301,
    tg: "@profkom_test", phone: "+79990000000", vk: "id123", funding: "budget" as const, residence: "Тест" };
  await expect(authApi.register(account)).rejects.toMatchObject({ response: { status: 422 } });
  const registered = await authApi.register({ ...account, no_patronymic: true });
  expect(registered.status).toBe(201);
  Cookies.set("access_token", registered.data.access_token);
  let application = await membershipApi.registration();
  expect(application.fields.no_patronymic).toBe(true); expect(application.fields.patronymic).toBeNull();
  const initialRevision = application.revision;
  await expect(membershipApi.updateRegistration({ expected_revision: initialRevision,
    fields: { ...application.fields, no_patronymic: false } })).rejects.toMatchObject({ status: 422 });
  expect((await membershipApi.registration()).revision).toBe(initialRevision);
  application = await membershipApi.updateRegistration({ expected_revision: initialRevision,
    fields: { ...application.fields, patronymic: "  Сергеевна  ", no_patronymic: false } });
  expect(application.fields.patronymic).toBe("Сергеевна"); expect(application.fields.no_patronymic).toBe(false);
  await expect(membershipApi.updateRegistration({ expected_revision: application.revision,
    fields: { ...application.fields, no_patronymic: true } })).rejects.toMatchObject({ status: 422 });
  application = await membershipApi.updateRegistration({ expected_revision: application.revision,
    fields: { ...application.fields, patronymic: null, no_patronymic: true } });
  const user = await sessionApi.get();
  await liveLogin();
  const approved = await membershipApi.registrationCommand(user.user_id, "approve", { expected_revision: application.revision });
  expect(approved.fields.no_patronymic).toBe(true);
  await liveLogin(account.email);
  expect((await authApi.getMe()).data.patronymic).toBe("");
});
