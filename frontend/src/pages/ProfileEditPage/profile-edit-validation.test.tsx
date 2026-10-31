// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import MockAdapter from "axios-mock-adapter";
import { HelmetProvider } from "react-helmet-async";
import { api } from "../../utils/api";
import { createFixtures } from "../../mocks/fixtures";
import { UserContext } from "../../utils/me";
import { change, field, mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { ProfileEditPage } from "./ProfileEditPage";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let adapter: MockAdapter | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;adapter?.restore();adapter = undefined; });

async function open() {
  const f = createFixtures("organizer");
  const profile = { ...f.profile, group_number: "301", email: "student@example.org", phone: "", tg: "", vk: "" };
  adapter = new MockAdapter(api);
  adapter.onGet("/profile/me/editor").reply(200, { revision: 1, fingerprint: "0".repeat(64), contact: profile });
  adapter.onGet("/avatars").reply(200, { items: [] });
  adapter.onPatch("/profile/me/editor").reply(200, { revision: 2, fingerprint: "1".repeat(64), contact: profile });
  page = await mountWorkspace(<HelmetProvider><UserContext.Provider value={profile}><ProfileEditPage /></UserContext.Provider></HelmetProvider>);
  await waitForPage(page);
  return page;
}
const save = () => Array.from(page!.container.querySelectorAll<HTMLButtonElement>('button[type="submit"]')).find((b) => b.textContent === "Сохранить")!;

it("profile edit offers saving only after a change and refuses blank names, bad phones and an empty address (PE-03)", async () => {
  await open();
  expect(save().disabled).toBe(true);
  const funding = field(page!.container, "budget");
  expect(funding.tagName).toBe("SELECT");
  expect(Array.from((funding as HTMLSelectElement).options).map((o) => o.value)).toEqual(["Бюджет", "Контракт"]);
  expect(page!.container.textContent).toContain("Telegram");
  expect(page!.container.textContent).not.toContain("Телеграмм");
  for (const [name, value, message] of [["name", "   ", "Укажите имя"], ["phone", "abc", "Укажите телефон цифрами"], ["email", "", "Неправильный формат email"], ["group_number", "", "Укажите номер группы"]]) {
    await open();
    await change(field(page!.container, name), value);
    expect(save().disabled).toBe(false);
    await submit(page!.container.querySelector("form")!);await waitForPage(page!);
    expect(adapter!.history.patch).toHaveLength(0);
    expect(page!.container.textContent).toContain(message);
    await page!.cleanup();page = undefined;adapter!.restore();adapter = undefined;
  }
});

it("profile edit sends trimmed names and the chosen funding (PE-03)", async () => {
  await open();
  await change(field(page!.container, "name"), "  Анна  ");
  await change(field(page!.container, "budget"), "Контракт");
  await submit(page!.container.querySelector("form")!);await waitForPage(page!);
  expect(adapter!.history.patch).toHaveLength(1);
  const sent = JSON.parse(adapter!.history.patch[0].data).profile;
  expect(sent.name).toBe("Анна");
  expect(sent.budget).toBe(false);
});
