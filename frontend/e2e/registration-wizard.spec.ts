import { test, expect } from "./fixtures";
import { createFixtures } from "../src/mocks/fixtures";

test("registration C validates each step, keeps the draft and saves only once", async ({ page, baseURL, external }, info) => {
  const f = createFixtures("pending");
  f.registration.fields = { ...f.registration.fields, surname:"Петрова", name:"Анна", patronymic:null, no_patronymic:false, group_number:"", funding:null, residence:"", phone:"", email:"anna@example.com", tg:"", vk:"" };
  const writes: Record<string, unknown>[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.context().addCookies([{ name:"access_token",value:"synthetic-registration-preview",url:baseURL! }]);
  await page.route(/\/api\//, async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/registrations/me" && route.request().method() === "PATCH") {
      const body=route.request().postDataJSON();writes.push(body);
      f.registration={ ...f.registration,fields:body.fields,revision:f.registration.revision+1 };
      return route.fulfill({ json:f.registration });
    }
    const data: Record<string,unknown> = { "/session":f.session,"/profile/me":f.profile,"/registrations/me":f.registration,"/notifications/unread-count":{count:0} };
    return route.fulfill({ json:data[path] ?? {items:[],next_cursor:null} });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", {name:"Давайте знакомиться"})).toBeVisible();
  const forward=page.getByRole("button",{name:"Продолжить →",exact:true});
  await forward.click();
  await expect(page.locator('[name="patronymic"]')).toBeFocused();
  await expect(page.getByText("Шаг 1 из 3")).toBeVisible();
  await page.locator('[name="patronymic"]').fill("Тестовна");
  await page.getByRole("checkbox",{name:"У меня нет отчества",exact:true}).check();
  await expect(page.locator('[name="patronymic"]')).toBeDisabled();
  await expect(page.locator('[name="patronymic"]')).toHaveValue("");
  await page.screenshot({path:info.outputPath("registration-c-personal.png"),fullPage:true});
  await forward.click();
  await page.locator('[name="group_number"]').fill("321");
  await page.locator('[name="funding"]').selectOption("budget");
  await page.locator('[name="residence"]').fill("Москва, общежитие");
  await page.getByRole("button",{name:"Назад",exact:true}).click();
  await expect(page.locator('[name="surname"]')).toHaveValue("Петрова");
  await expect(page.getByRole("checkbox",{name:"У меня нет отчества",exact:true})).toBeChecked();
  await forward.click();
  await expect(page.locator('[name="residence"]')).toHaveValue("Москва, общежитие");
  // Enter advances without sending the unfinished application.
  await page.locator('[name="residence"]').press("Enter");
  await expect(page.getByText("Шаг 3 из 3")).toBeVisible();
  expect(writes).toHaveLength(0);
  await page.locator('[name="phone"]').fill("+79990000000");
  await page.locator('[name="tg"]').fill("@anna_test");
  await page.locator('[name="vk"]').fill("id123");
  await page.screenshot({path:info.outputPath("registration-c-contacts.png"),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(0);
  await page.getByRole("button",{name:"Сохранить сведения",exact:true}).click();
  await expect(page.getByText("Изменения сохранены",{exact:true})).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0].expected_revision).toBe(1);
  expect(writes[0].fields).toMatchObject({surname:"Петрова",patronymic:null,no_patronymic:true,group_number:"321",funding:"budget",residence:"Москва, общежитие"});
  expect(errors).toEqual([]);expect(external).toEqual([]);
});
