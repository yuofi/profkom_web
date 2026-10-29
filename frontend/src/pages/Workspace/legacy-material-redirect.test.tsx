// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { LegacyMaterialRedirect } from "./LegacyMaterialRedirect";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page=undefined;mock?.restore();mock=undefined; });
function Location() { return <output>{useLocation().pathname}</output>; }
const routes=<><Location /><Routes><Route path="/docs/:id" element={<LegacyMaterialRedirect />} /><Route path="/docs/:id/edit" element={<LegacyMaterialRedirect />} /><Route path="/guides/:id" element={<LegacyMaterialRedirect />} /><Route path="/materials/:id" element={<p>Текущий материал</p>} /></Routes></>;

it.each(["/docs/1","/docs/1/edit","/guides/1"])("old URL %s resolves an id once and enters the current material screen",async path => {
  mock=installMockTransport("chair",{delay:0});
  page=await mountWorkspace(routes,{path});await waitForPage(page);
  expect(page.container.querySelector("output")?.textContent).toBe(`/materials/${mock.state.materials[0].material_id}`);
  expect(page.container.textContent).toContain("Текущий материал");
  expect(page.container.querySelector("textarea")).toBeNull();
  expect(mock.adapter.history.get.map(request=>request.url)).toEqual(["/materials/legacy-guides/1"]);
  expect(mock.adapter.history.post).toHaveLength(0);expect(mock.adapter.history.patch).toHaveLength(0);
});

it.each(["missing","draft"])("an unavailable %s mapping cannot enter a fallback editor or disclose a material id",async kind => {
  mock=installMockTransport("organizer",{delay:0});
  if(kind==="missing")mock.legacyMaterialIds.clear();else { mock.state.materials[0].capabilities=[];mock.state.materials[0].published_content=null; }
  page=await mountWorkspace(routes,{path:"/docs/1/edit",role:"organizer"});await waitForPage(page);
  expect(page.container.querySelector("output")?.textContent).toBe("/docs/1/edit");
  expect(page.container.querySelector("textarea")).toBeNull();expect(page.container.textContent).not.toContain("Текущий материал");
  expect(page.container.querySelector('[role="alert"]')).not.toBeNull();
  expect(mock.adapter.history.get.map(request=>request.url)).toEqual(["/materials/legacy-guides/1"]);
});
