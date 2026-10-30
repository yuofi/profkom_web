import { useLayoutEffect, useState, type RefObject } from "react";
export function useAnchoredLayer(open: boolean, anchorRef: RefObject<HTMLElement | null>, layerRef: RefObject<HTMLElement | null>, width: number) {
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const target = anchorRef.current?.closest("dialog") ?? document.body;
    setPortal(target);
  }, [open, anchorRef]);
  useLayoutEffect(() => {
    if (!open || !portal) return;
    const position = () => {
      const anchor = anchorRef.current, layer = layerRef.current;
      if (!anchor || !layer) return;
      const rect = anchor.getBoundingClientRect(), box = layer.getBoundingClientRect();
      // On mobile, innerWidth can expand with an initially offscreen portal.
      // Clamp to the root layout viewport, then to a smaller visual viewport
      // (keyboard/pinch zoom), so positioning cannot amplify its own overflow.
      const layoutWidth = document.documentElement.clientWidth || window.innerWidth;
      const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
      const visual = window.visualViewport;
      const left = Math.max(0, visual?.offsetLeft ?? 0), top = Math.max(0, visual?.offsetTop ?? 0);
      const right = Math.min(layoutWidth, left + (visual?.width || layoutWidth));
      const bottom = Math.min(layoutHeight, top + (visual?.height || layoutHeight));
      const sized = Math.max(0, Math.min(width, right - left - 16));
      const below = bottom - rect.bottom - 16, above = rect.top - top - 16;
      const upwards = below < Math.min(240, box.height) && above > below;
      layer.style.width = `${sized}px`;
      layer.style.maxHeight = `${Math.max(48, Math.min(bottom - top - 16, upwards ? above : below))}px`;
      layer.style.left = `${Math.max(left + 8, Math.min(rect.left, right - sized - 8))}px`;
      layer.style.top = upwards ? "auto" : `${Math.max(top + 8, Math.min(rect.bottom + 8, bottom - 56))}px`;
      layer.style.bottom = upwards ? `${Math.max(8, layoutHeight - rect.top + 8)}px` : "auto";
    };
    position();const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);if (layerRef.current) observer?.observe(layerRef.current);
    window.addEventListener("resize", position);window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);window.visualViewport?.addEventListener("scroll", position);
    return () => { observer?.disconnect();window.removeEventListener("resize", position);window.removeEventListener("scroll", position, true);window.visualViewport?.removeEventListener("resize", position);window.visualViewport?.removeEventListener("scroll", position); };
  }, [open, anchorRef, layerRef, portal, width]);
  return portal;
}
/** Nested picker suggestions belong to the form even when they are portalled outside it. */
export function ownedLayerTarget(target: EventTarget | null, root: HTMLElement | null) {
  if (!(target instanceof Node) || !root) return false;
  if (root.contains(target)) return true;
  if (!(target instanceof Element)) return false;
  const picker = target.closest<HTMLElement>("[data-entity-picker-popup]");
  const inputId = picker?.dataset.entityPickerPopup;
  return !!inputId && root.contains(document.getElementById(inputId));
}
