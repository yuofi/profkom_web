import axios from "axios";
import { api } from "./index";
import type { FileRef, UploadIntent, UploadIntentCreate } from "./contract";
import { idPath, request, normalizeApiError, ApiError } from "./request";
import { normalizeUpload } from "../filePolicy";
/** Upload failures retain only a stage and safe API diagnostics, never signed addresses. */
export type UploadStage = "intent" | "transfer" | "complete";
export class UploadError extends ApiError {
  constructor(stage: UploadStage, error: unknown) {
    const original = normalizeApiError(error);
    const transfer = stage === "transfer";
    super(
      transfer ? `Передача файла не завершена${original.status ? ` (HTTP ${original.status})` : ""}` : original.message,
      original.status,
      transfer ? "upload_transfer_failed" : original.code,
      { ...(transfer ? {} : original.fields), upload_stage: stage },
    );
    this.name = "UploadError";
  }
}
export const filesApi = {
  intent: async (data: UploadIntentCreate) =>
    request<UploadIntent>("post", "/files/upload-intents", normalizeUpload(data)),
  complete: (id: string) =>
    request<FileRef>("post", `/files/${idPath(id)}/complete`, {}),
  download: (id: string) =>
    // The address does not expire: the server checks its every request (decision 23).
    request<{ download_url: string; expires_at: string | null }>(
      "get",
      `/files/${idPath(id)}/download`,
    ),
  /** Checked bytes stay on the API origin; the caller owns cancellation and preview lifetime. */
  content: async (id: string, signal?: AbortSignal): Promise<Blob> => {
    try { return (await api.get<Blob>(`/files/${idPath(id)}/content`, { responseType: "blob", signal })).data; }
    catch (error) { throw normalizeApiError(error); }
  },
  upload: async (
    file: File,
    owner: Pick<UploadIntentCreate, "owner_kind" | "owner_id" | "purpose">,
    onProgress?: (percent: number) => void,
    signal?: AbortSignal,
  ): Promise<FileRef> => {
    let intent: UploadIntent;
    try {
      intent = await filesApi.intent(normalizeUpload({
        ...owner,
        name: file.name,
        mime_type: file.type,
        size_bytes: file.size,
      }));
    } catch (error) {
      throw new UploadError("intent", error);
    }
    try {
      await axios.request({
        url: intent.upload_url,
        method: intent.method,
        headers: intent.headers,
        // Some transports derive Content-Type from Blob.type, overriding headers.
        data: file.slice(0, file.size, intent.headers["Content-Type"]),
        signal,
        onUploadProgress: (event) =>
          onProgress?.(
            event.total ? Math.round((event.loaded / event.total) * 100) : 0,
          ),
      });
    } catch (error) {
      // A cancelled request is intentional, not a storage failure.
      if (axios.isCancel(error)) throw normalizeApiError(error);
      throw new UploadError("transfer", error);
    }
    try {
      return await filesApi.complete(intent.file_id);
    } catch (error) {
      throw new UploadError("complete", error);
    }
  },
};
