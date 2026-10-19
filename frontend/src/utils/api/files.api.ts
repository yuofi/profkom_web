import axios from "axios";
import type { FileRef, UploadIntent, UploadIntentCreate } from "./contract";
import { idPath, request, normalizeApiError } from "./request";
import { normalizeUpload } from "../filePolicy";
export const filesApi = {
  intent: async (data: UploadIntentCreate) =>
    request<UploadIntent>("post", "/files/upload-intents", normalizeUpload(data)),
  complete: (id: string) =>
    request<FileRef>("post", `/files/${idPath(id)}/complete`, {}),
  download: (id: string) =>
    request<{ download_url: string; expires_at: string }>(
      "get",
      `/files/${idPath(id)}/download`,
    ),
  upload: async (
    file: File,
    owner: Pick<UploadIntentCreate, "owner_kind" | "owner_id" | "purpose">,
    onProgress?: (percent: number) => void,
    signal?: AbortSignal,
  ): Promise<FileRef> => {
    const intent = await filesApi.intent({
      ...owner,
      name: file.name,
      mime_type: file.type,
      size_bytes: file.size,
    });
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
      return await filesApi.complete(intent.file_id);
    } catch (error) {
      throw normalizeApiError(error);
    }
  },
};
