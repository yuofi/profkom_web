import type { UploadIntentCreate } from "./api/contract";
import { ApiError } from "./api/request";

const textExtensions = new Set(["txt", "md", "py", "js", "jsx", "ts", "tsx", "json", "yaml", "yml", "toml", "ini", "cfg", "log", "sh", "zsh", "c", "h", "cpp", "hpp", "java", "rs", "go", "sql", "r", "css"]);
const textApplicationMimes = new Set(["application/json", "application/javascript", "application/x-javascript", "application/typescript", "application/x-python-code", "application/x-sh", "application/x-shellscript", "application/yaml", "application/x-yaml", "application/toml", "application/sql"]);
const formats: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  pdf: "application/pdf", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip", ...Object.fromEntries([...textExtensions].map(ext => [ext, "text/plain"])),
};
const aliases: Record<string, string> = {
  "image/jpg": "image/jpeg", "application/x-zip-compressed": "application/zip",
};
export const fileLimitMiB = (kind: string) => ["avatar", "block"].includes(kind) ? 10 : 20;
export function fileExtensions(kind: string) {
  return ["avatar", "block"].includes(kind) ? ["png", "jpg", "jpeg", "webp"]
    : kind === "pgas" ? ["pdf", "doc", "docx", "png", "jpg", "jpeg"]
      : Object.keys(formats);
}
export const fileAccept = (kind: string) => fileExtensions(kind).map(ext => `.${ext}`).join(",");

/** A missing browser MIME is inferred only from the whitelist; complete verifies actual bytes. */
export function fileMetadata(kind: string, file: { name: string; type: string; size: number }) {
  const fail = (message: string): never => { throw new ApiError(`${file.name}: ${message}`, 422, "client_error"); };
  if (!file.name || /[/\\]/.test(file.name) || [...file.name].some(c => c.charCodeAt(0) < 32)) fail("недопустимое имя файла");
  const ext = file.name.includes(".") ? file.name.split(".").at(-1)!.toLowerCase() : "";
  const canonical = formats[ext];
  if (!canonical || !fileExtensions(kind).includes(ext)) fail("неподдерживаемый формат файла");
  const raw = file.type.trim().toLowerCase();
  const textSource = textExtensions.has(ext) && (raw.startsWith("text/") || textApplicationMimes.has(raw) || ext === "ts" && raw === "video/mp2t");
  const mime = !raw || raw === "application/octet-stream" || textSource ? canonical : aliases[raw] ?? raw;
  if (mime !== canonical) fail("тип файла не соответствует расширению");
  const limit = fileLimitMiB(kind);
  if (!Number.isInteger(file.size) || file.size <= 0 || file.size > limit * 1024 * 1024)
    fail(`размер должен быть от 1 байта до ${limit} МиБ`);
  return { name: file.name, mime_type: mime, size_bytes: file.size };
}
export function normalizeUpload(data: UploadIntentCreate): UploadIntentCreate {
  return { ...data, ...fileMetadata(data.owner_kind, { name: data.name, type: data.mime_type, size: data.size_bytes }) };
}
