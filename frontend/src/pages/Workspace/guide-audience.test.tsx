// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, settle } from "../../test/workspace";
import { MaterialPage } from "./MaterialPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; });

const open = async (role: "chair" | "organizer") => {
  mock = installMockTransport(role, { delay: 0 });
  page = await mountWorkspace(<Routes><Route path="/materials/:id" element={<MaterialPage />} /></Routes>, { role, path: "/materials/material-1" });
  await settle(); await settle();
};

it("a guide's writer decides who reads it; a reader is told who does", async () => {
  await open("chair");
  expect(page!.container.querySelector("form")).toBeNull();
  const chip = [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Только свой блок"))!;
  await act(async () => chip.click());await settle();
  const menu = [...document.querySelectorAll('[data-anchored-popover]')].find(node => node.textContent?.includes("Кто видит гайд"))!;
  expect(menu).not.toBeNull();
  await act(async () => [...menu.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Все активисты")!.click());await settle();await settle();
  expect(mock!.state.materials.find((m) => m.material_id === "material-1")!.audience).toBe("everyone");
  await page!.cleanup(); page = undefined; mock!.restore();

  await open("organizer");
  expect(page!.container.querySelector('[name="audience"]')).toBeNull();
  expect(page!.container.textContent).toContain("Только свой блок");
});
