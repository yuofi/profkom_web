import { isDemoMode } from "../utils/demoData";

export async function startDevelopmentMocks(): Promise<void> {
  if (!import.meta.env.DEV || !isDemoMode) return;
  const [{ installMockTransport }, { mockRoles }] = await Promise.all([
    import("./transport"),
    import("./fixtures"),
  ]);
  const selected =
    sessionStorage.getItem("profkom-demo-role") ??
    import.meta.env.VITE_DEMO_ROLE ??
    "organizer";
  const role = mockRoles.find((r) => r === selected) ?? "organizer";
  const selectedScenario =
    sessionStorage.getItem("profkom-demo-scenario") ?? "normal";
  const scenario =
    (["normal", "empty", "error", "conflict"] as const).find(
      (s) => s === selectedScenario,
    ) ?? "normal";
  installMockTransport(role, { scenario });
}
