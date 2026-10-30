import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { SessionContext } from "../utils/session";
import { createFixtures, type MockRole } from "../mocks/fixtures";
import type { Session } from "../utils/api/contract";
import { forgetOwnChanges } from "../components/Workspace/ownRevisions";
import { workspaceQueryCache } from "../utils/api/invalidation";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
export async function mountWorkspace(
  element: ReactNode,
  options: { role?: MockRole; path?: string; client?: QueryClient; session?: Session } = {},
) {
  const client =
    options.client ??
    new QueryClient({
      queryCache: workspaceQueryCache(),
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      },
    });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[options.path ?? "/"]}>
          <SessionContext.Provider
            value={{
              session: options.session ?? createFixtures(options.role ?? "chair").session,
              loading: false,
              error: null,
              refresh: () => {},
            }}
          >
            {element}
          </SessionContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  return {
    container,
    client,
    cleanup: async () => {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
      forgetOwnChanges(client);
    },
  };
}
export const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
};
/**
 * Waits inside act until the predicate holds and React Query has no request or mutation in
 * flight for two checks in a row, so late HTTP responses cannot update the page outside act.
 * Bounded by time, not by a number of iterations: a slow real API must not flip the result.
 */
export async function waitForPage(
  page: { client: QueryClient; container?: HTMLElement },
  predicate: () => boolean = () => true,
  timeout = 15000,
) {
  const started = Date.now();
  let quiet = 0;
  while (quiet < 2) {
    await settle();
    // ActionForm uses Formik rather than a Query mutation. A quiet Query cache
    // does not mean that an acknowledged form save has finished yet.
    const savingForm = !!page.container && [...page.container.querySelectorAll<HTMLButtonElement>("button:disabled")]
      .some(button => button.textContent?.trim() === "Сохраняем…");
    const idle = page.client.isFetching() === 0 && page.client.isMutating() === 0 && !savingForm;
    quiet = predicate() && idle ? quiet + 1 : 0;
    if (quiet < 2 && Date.now() - started > timeout) {
      const busy = page.client.getQueryCache().findAll({ fetchStatus: "fetching" }).map((q) => JSON.stringify(q.queryKey));
      throw Error(
        `The page did not reach the expected state within ${timeout} ms ` +
          `(predicate ${predicate()}, fetching [${busy.join(", ")}], mutating ${page.client.isMutating()}): ` +
          (page.container?.textContent?.slice(0, 2000) ?? ""),
      );
    }
  }
}
export async function change(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
) {
  const picker = element.closest<HTMLElement>("[data-entity-picker]");
  if (picker && element instanceof HTMLInputElement && element.type === "hidden") {
    await selectEntity(picker, value);
    return;
  }
  await act(async () => {
    const prototype =
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
export async function submit(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  await settle();
}
/** Selects through the visible combobox and listbox, including a portalled popup. */
async function selectEntity(picker: HTMLElement, value: string, checked?: boolean) {
  const input = picker.querySelector<HTMLInputElement>('[role="combobox"]');
  if (!input) throw Error("Missing entity combobox");
  await act(async () => { input.focus();input.click(); });
  const listId = input.getAttribute("aria-controls");
  const list = listId ? document.getElementById(listId) : null;
  const option = Array.from(list?.querySelectorAll<HTMLElement>("[data-option-value]") ?? []).find(item => item.dataset.optionValue === value);
  if (!option) throw Error(`Missing entity choice ${value}`);
  if (checked === undefined || (option.getAttribute("aria-selected") === "true") !== checked) await act(async () => option.click());
}
/** Ticks or unticks one person through the actual selection UI. */
export async function pick(container: ParentNode, name: string, value: string, checked = true) {
  const picker = Array.from(container.querySelectorAll<HTMLElement>("[data-entity-picker]")).find(node => node.dataset.fieldName === name);
  if (picker) { await selectEntity(picker, value, checked);return; }
  const box = container.querySelector<HTMLInputElement>(`input[type="checkbox"][name="${name}"][value="${value}"]`);
  if (!box) throw Error(`Missing choice ${value} of ${name}`);
  if (box.checked !== checked) await act(async () => box.click());
}
export function field(container: ParentNode, name: string) {
  const element = container.querySelector<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >(`[name="${name}"]`);
  if (!element) throw Error(`Missing field ${name}`);
  return element;
}
