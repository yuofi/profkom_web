import { resolve } from "node:path";
import { ESLint } from "eslint";
import { expect, it } from "vitest";

const cwd = resolve(__dirname, "..");
const lint = async (filePath: string, code: string) =>
  (await new ESLint({ cwd }).lintText(code, { filePath: resolve(cwd, filePath) }))[0].messages.filter(message => message.ruleId === "no-restricted-properties");

it("GL-04: app code cannot call randomUUID directly, only through createClientId", async () => {
  for (const code of ["export const id = crypto.randomUUID();\n", "export const id = window.crypto.randomUUID();\n", "export const id = globalThis.crypto?.randomUUID();\n"])
    expect(await lint("src/pages/Workspace/Example.tsx", code)).toHaveLength(1);
  expect(await lint("src/utils/clientId.ts", "export const id = crypto.randomUUID();\n")).toHaveLength(0);
  expect(await lint("src/pages/Workspace/Example.test.tsx", "export const id = crypto.randomUUID();\n")).toHaveLength(0);
}, 30_000);
