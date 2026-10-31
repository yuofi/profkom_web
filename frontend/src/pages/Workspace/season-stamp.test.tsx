// @vitest-environment jsdom
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { KkrTemplatesPage, SeasonsPage } from "./SeasonPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined, mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined; });

it.each([["/seasons", <SeasonsPage />], ["/seasons/templates", <KkrTemplatesPage />]] as const)("names the season section in the stamp of %s, as the menu does", async (path, element) => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<Routes><Route path={path} element={element} /></Routes>, { path });await waitForPage(page);
  // «Учёт работы» is the /merits section, not the seasons' one (GL-37).
  // On /seasons itself the stamp is the current page, not a link to it (GL-36).
  const stamp = path === "/seasons" ? page.container.querySelector('header [aria-current="page"]') : page.container.querySelector('header a[href="/seasons"]');
  expect(stamp?.textContent).toBe("Профком ВМК · Сезоны и ККР");
});
