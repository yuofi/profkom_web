import { act } from "react";
import { expect } from "vitest";
import { mountWorkspace, waitForPage } from "./workspace";

export async function openMaterialEditor(page: Awaited<ReturnType<typeof mountWorkspace>>) {
  await waitForPage(page, () => !!page.container.querySelector('button[aria-label="Редактировать материал"]'));
  const pencil = page.container.querySelector<HTMLButtonElement>('button[aria-label="Редактировать материал"]')!;
  expect(page.container.querySelector("textarea")).toBeNull();
  await act(async () => pencil.click());
  await waitForPage(page, () => !!page.container.querySelector('textarea[name="body"]'));
}
