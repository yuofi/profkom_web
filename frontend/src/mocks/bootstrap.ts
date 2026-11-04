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
  const selectedBot = sessionStorage.getItem("profkom-demo-bot");
  const bot = (["ok", "none", "denied", "blocked", "off"] as const).find((b) => b === selectedBot);
  installMockTransport(role, { scenario, bot });
}
