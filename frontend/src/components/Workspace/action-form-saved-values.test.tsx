// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { evaluationOptions } from "../../utils/evaluations";
import { ActionForm, type Field } from "./ActionForm";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; vi.restoreAllMocks(); });

it("the saved values after someone else's change read like the form: a choice by its words, hours with a decimal comma (FIX1)", async () => {
  function Probe() {
    const [revision, setRevision] = useState(1);
    const fields: Field[] = [
      { name: "hours", label: "Часы", type: "number", value: revision === 1 ? "2" : "1.5" },
      { name: "evaluation", label: "Оценка", type: "select", value: revision === 1 ? "1" : "1.5", options: evaluationOptions },
      { name: "archived", label: "Состояние шаблона", type: "select", value: "false", options: [{ value: "false", label: "Активен" }, { value: "true", label: "В архиве" }] },
      { name: "note", label: "Заметка", value: "" },
    ];
    return <><button type="button" onClick={() => setRevision(2)}>Чужая версия</button><ActionForm revision={revision} onConflict={() => {}} fields={fields} onSubmit={vi.fn()} /></>;
  }
  page = await mountWorkspace(<Probe />);
  await act(async () => [...page!.container.querySelectorAll("button")].find(button => button.textContent === "Чужая версия")!.click());
  await waitForPage(page);
  const saved = Object.fromEntries([...page.container.querySelectorAll("details dl > div")].map(row => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent]));
  expect(saved).toEqual({ "Часы": "1,5", "Оценка": "Зачесть · оценка 1,5", "Состояние шаблона": "Активен", "Заметка": "—" });
});
