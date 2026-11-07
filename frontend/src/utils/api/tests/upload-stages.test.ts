import { afterEach, expect, it, vi } from "vitest";
import axios from "axios";
import { ApiError } from "../request";
import { filesApi } from "../files.api";
import { ERROR_TEXTS, userMessage } from "../messages";

const intent = {
  file_id: "file-local",
  upload_url: "https://storage.invalid/private-upload",
  method: "PUT" as const,
  headers: { "Content-Type": "text/plain" },
  expires_at: "2099-01-01T00:00:00Z",
};
const upload = () => filesApi.upload(new File(["local bytes"], "local.txt", { type: "text/plain" }), {
  owner_kind: "assignment", owner_id: "assignment-local", purpose: "submission",
});
afterEach(() => vi.restoreAllMocks());

it("a denied upload intent retains the API error and does not send file bytes", async () => {
  vi.spyOn(filesApi, "intent").mockRejectedValue(new ApiError("Forbidden", 403, "forbidden"));
  const transfer = vi.spyOn(axios, "request");
  const error = await upload().catch((e) => e);
  expect(error).toMatchObject({ status: 403, code: "forbidden", fields: { upload_stage: "intent" } });
  expect(userMessage(error)).toContain("Не удалось начать загрузку файла");
  expect(transfer).not.toHaveBeenCalled();
});

it("an upload intent refused without any detail keeps that through its stage", async () => {
  vi.spyOn(filesApi, "intent").mockRejectedValue(new ApiError("Не удалось выполнить запрос", 403, "http_403", {}, false));
  const error = await upload().catch((e) => e);
  expect(error).toMatchObject({ status: 403, explained: false, fields: { upload_stage: "intent" } });
  expect(userMessage(error)).toBe(`Не удалось начать загрузку файла. ${ERROR_TEXTS.forbidden_unexplained}`);
});

it.each([0, 403, 503])("a failed file transfer (%s) is safe and never completes the object", async (status) => {
  vi.spyOn(filesApi, "intent").mockResolvedValue(intent);
  const error = Object.assign(new Error("private-upload provider details"), {
    isAxiosError: true,
    response: status ? { status, data: { detail: "private-upload provider details" } } : undefined,
    config: { url: intent.upload_url, headers: { Authorization: "hidden" } },
  });
  vi.spyOn(axios, "request").mockRejectedValue(error);
  const complete = vi.spyOn(filesApi, "complete");
  const failure = await upload().catch((e) => e);
  expect(failure).toMatchObject({ status, code: "upload_transfer_failed", fields: { upload_stage: "transfer" } });
  expect(userMessage(failure)).toContain(status === 403 ? "Сервис загрузки отклонил файл" : status >= 500 ? "Сервис загрузки временно недоступен" : "Не удалось передать файл");
  expect(JSON.stringify(failure)).not.toContain("private-upload");
  expect(failure.message).not.toContain("private-upload");
  expect(complete).not.toHaveBeenCalled();
});

it("a completion refusal states that the bytes were sent but not saved", async () => {
  vi.spyOn(filesApi, "intent").mockResolvedValue(intent);
  vi.spyOn(axios, "request").mockResolvedValue({ status: 200 });
  vi.spyOn(filesApi, "complete").mockRejectedValue(new ApiError("Upload expired", 409, "upload_expired"));
  const error = await upload().catch((e) => e);
  expect(error).toMatchObject({ status: 409, code: "upload_expired", fields: { upload_stage: "complete" } });
  expect(userMessage(error)).toContain("Файл передан, но сохранение не завершено");
});
