import { test, expect } from "./fixtures";
import { createFixtures } from "../src/mocks/fixtures";

test("directory roles and saved registration decisions fit desktop and phone", async ({ page, baseURL, external }, info) => {
  const fixture = createFixtures("chair");
  const people = Array.from({ length: 5 }, (_, i) => ({ user_id: 10001 + i, display_name: `Синтетический Участник ${i + 1}`, avatar_url: null }));
  const contacts = people.map(person => ({ ...fixture.profile, user_id: person.user_id, surname: "Синтетический", name: "Участник", patronymic: String(person.user_id), photo_url: null, blocks: "", in_profcom: true }));
  const blocks = people.slice(0, 3).map((user, i) => ({ ...fixture.blocks[0], name: `Блок ${i + 1}`, block_id: `visual-${i}`, master: { role_assignment_id: `master-${i}`, user, deputy_user_ids: [], revision: 1, capabilities: [] } }));
  const registrations = ["approved", "rejected"].map((status, i) => ({ ...fixture.registration, user_id: people[i].user_id, status, fields: { ...fixture.registration.fields, surname: "Синтетическая", name: `Заявка ${i + 1}` }, rejection_reason: status === "rejected" ? "Уточните контактные данные" : null, decision: { outcome: status, actor: people[2], at: "2026-11-10T08:12:00+00:00" }, capabilities: [] }));
  await page.context().addCookies([{ name: "access_token", value: "synthetic-visual-only", url: baseURL! }]);
  const empty = { items: [], next_cursor: null };
  await page.route(/\/api\//, async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    const data: Record<string, unknown> = {
      "/session": fixture.session,
      "/profile/me": fixture.profile,
      "/contacts": contacts,
      "/blocks": blocks,
      "/leadership": { chair: people[0], deputies: [people[1]], revision: 1, capabilities: [] },
      "/participants/categories": { items: people.map((person, i) => ({ user_id: person.user_id, category: i === 3 ? "activist" : "junior", revision: 1, capabilities: [] })) },
      "/registrations": { items: registrations, next_cursor: null },
      "/notifications/unread-count": { count: 0 },
      "/notifications": empty,
      "/events": empty,
      "/block-requests": empty,
      "/seasons": empty,
    };
    await route.fulfill({ json: data[path] ?? empty });
  });
  await page.goto("/contacts");
  const badges = page.locator("[data-contact-role]");
  await expect(badges).toHaveCount(5);
  expect(await badges.allTextContents()).toEqual(["Председатель", "Зам председателя", "Мастер", "Активист", "Джун"]);
  const deputy = page.locator('[data-contact-role="deputy"]');
  const deputyBounds = await deputy.boundingBox();
  expect(deputyBounds!.width).toBeLessThanOrEqual(106);
  // The two-word label wraps instead of stealing the name column on a phone.
  expect(deputyBounds!.height).toBeGreaterThan(30);
  for (const badge of await badges.all()) {
    const bounds = await badge.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(await badge.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: info.outputPath("directory-roles.png"), fullPage: true });
  await page.goto("/registrations");
  await page.getByRole("button", { name: "Все", exact: true }).click();
  const decisions = page.getByRole("region", { name: "Решение по заявке" });
  await expect(decisions).toHaveCount(2);
  await expect(decisions.first()).toContainText("Синтетический Участник 3");
  await expect(decisions.first()).toContainText("11:12 МСК");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: info.outputPath("registration-decisions.png"), fullPage: true });
  expect(external).toEqual([]);
});
