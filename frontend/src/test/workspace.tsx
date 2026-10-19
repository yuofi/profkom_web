import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { SessionContext } from "../utils/session";
import { createFixtures, type MockRole } from "../mocks/fixtures";
import type { Session } from "../utils/api/contract";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
export async function mountWorkspace(
  element: ReactNode,
  options: { role?: MockRole; path?: string; client?: QueryClient; session?: Session } = {},
) {
  const client =
    options.client ??
    new QueryClient({
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
    },
  };
}
export const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
};
export async function change(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
) {
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
export function field(container: ParentNode, name: string) {
  const element = container.querySelector<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >(`[name="${name}"]`);
  if (!element) throw Error(`Missing field ${name}`);
  return element;
}
