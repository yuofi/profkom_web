import type { UploadIntentCreate } from "./api/contract";
import { ApiError } from "./api/request";

const formats: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  pdf: "application/pdf", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip", txt: "text/plain",
};
const aliases: Record<string, string> = {
  "image/jpg": "image/jpeg", "application/x-zip-compressed": "application/zip",
};
export const fileLimitMiB = (kind: string) => kind === "avatar" ? 10 : 20;
export function fileExtensions(kind: string) {
  return kind === "avatar" ? ["png", "jpg", "jpeg", "webp"]
    : kind === "pgas" ? ["pdf", "doc", "docx", "png", "jpg", "jpeg"]
      : Object.keys(formats);
}
export const fileAccept = (kind: string) => fileExtensions(kind).map(ext => `.${ext}`).join(",");

/** A missing browser MIME is inferred only from the whitelist; complete verifies actual bytes. */
export function fileMetadata(kind: string, file: { name: string; type: string; size: number }) {
  const fail = (message: string): never => { throw new ApiError(`${file.name}: ${message}`, 422, "invalid_input"); };
  if (!file.name || /[/\\]/.test(file.name) || [...file.name].some(c => c.charCodeAt(0) < 32)) fail("недопустимое имя файла");
  const ext = file.name.includes(".") ? file.name.split(".").at(-1)!.toLowerCase() : "";
  const canonical = formats[ext];
  if (!canonical || !fileExtensions(kind).includes(ext)) fail("неподдерживаемый формат файла");
  const raw = file.type.trim().toLowerCase();
  const mime = !raw || raw === "application/octet-stream" ? canonical : aliases[raw] ?? raw;
  if (mime !== canonical) fail("тип файла не соответствует расширению");
  const limit = fileLimitMiB(kind);
  if (!Number.isInteger(file.size) || file.size <= 0 || file.size > limit * 1024 * 1024)
    fail(`размер должен быть от 1 байта до ${limit} МиБ`);
  return { name: file.name, mime_type: mime, size_bytes: file.size };
}
export function normalizeUpload(data: UploadIntentCreate): UploadIntentCreate {
  return { ...data, ...fileMetadata(data.owner_kind, { name: data.name, type: data.mime_type, size: data.size_bytes }) };
}
