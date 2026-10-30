// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { mountWorkspace } from "../../test/workspace";
import { AnchoredPopover } from "./AnchoredPopover";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;vi.restoreAllMocks();vi.unstubAllGlobals(); });

function Probe() {
  const anchor = useRef<HTMLButtonElement>(null), [open, setOpen] = useState(false);
  return <><button data-anchor ref={anchor} onClick={() => setOpen(true)}>Отметки</button><AnchoredPopover open={open} anchorRef={anchor} label="Отметки участника" onRequestClose={() => setOpen(false)} width={340}><input aria-label="Поле" /></AnchoredPopover></>;
}
function mobileViewport() {
  // Mobile innerWidth can grow to the overflowed content while the layout
  // viewport remains 390px. Reproduce that condition instead of hiding overflow.
  vi.stubGlobal("innerWidth", 739);vi.stubGlobal("innerHeight", 844);
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(390);
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(844);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-anchor") ? new DOMRect(358, 120, 30, 30) : this.hasAttribute("data-anchored-popover") ? new DOMRect(0, 0, 340, 220) : new DOMRect();
  });
}
async function open() {
  page = await mountWorkspace(<Probe />);
  const anchor = page.container.querySelector<HTMLButtonElement>("[data-anchor]")!;
  await act(async () => { anchor.focus();anchor.click(); });
  return { anchor, layer: document.querySelector<HTMLElement>("[data-anchored-popover]")! };
}

it("clamps an offscreen table-trigger portal to the actual mobile layout viewport", async () => {
  mobileViewport();const { layer } = await open();
  expect(layer.style.width).toBe("340px");expect(layer.style.left).toBe("42px");
  expect(Number.parseFloat(layer.style.left) + Number.parseFloat(layer.style.width)).toBeLessThanOrEqual(382);
});

it("clamps to a smaller visual viewport and repositions after keyboard/visual viewport changes", async () => {
  mobileViewport();const visual = Object.assign(new EventTarget(), { width: 320, height: 400, offsetLeft: 0, offsetTop: 0 });
  vi.stubGlobal("visualViewport", visual);
  const { layer } = await open();
  expect(layer.style.width).toBe("304px");expect(layer.style.left).toBe("8px");
  const before = Number.parseFloat(layer.style.maxHeight);
  await act(async () => { visual.height = 220;visual.dispatchEvent(new Event("resize")); });
  expect(Number.parseFloat(layer.style.maxHeight)).toBeLessThan(before);
});

it("focuses and restores the anchor without scrolling the document or its horizontal table", async () => {
  mobileViewport();const focus = vi.spyOn(HTMLElement.prototype, "focus"), { layer, anchor } = await open();
  expect(document.activeElement).toBe(layer.querySelector("input"));
  expect(focus.mock.calls.at(-1)).toEqual([{ preventScroll: true }]);
  await act(async () => layer.querySelector<HTMLButtonElement>("[aria-label='Закрыть окно']")!.click());
  expect(document.activeElement).toBe(anchor);expect(focus.mock.calls.at(-1)).toEqual([{ preventScroll: true }]);
});
