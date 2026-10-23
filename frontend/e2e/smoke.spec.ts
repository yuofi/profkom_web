import { test, expect } from "./fixtures";

test("the production build opens the password sign-in without horizontal scroll", async ({ page, external }) => {
  await page.goto("/auth");
  await page.getByText(/или войти/).click();
  await expect(page.getByRole("button", { name: "Войти" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // Known third parties (VK ID SDK, the Material Symbols font in index.html) are blocked, not
  // reached; any other origin is a new external dependency and fails the check.
  const known = /(^|\.)(vk\.(ru|com)|fonts\.(googleapis|gstatic)\.com)$/;
  expect(external.filter((origin) => !known.test(new URL(origin).hostname))).toEqual([]);
});
