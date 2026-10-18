import { imageApi } from "./api/imges.api";
import axios from "axios";
import { api } from "./api";
import { logger } from "./logger";

export const uploadFile = async (folder: string, file: File): Promise<string> => {
  try {
    if (folder === "pgas") {
      const intent = (await api.post("/files/upload-intents", { owner_kind: "pgas", purpose: "pgas", name: file.name, mime_type: file.type, size_bytes: file.size })).data;
      await axios.put(intent.upload_url, file, { headers: intent.headers });
      await api.post(`/files/${encodeURIComponent(intent.file_id)}/complete`, {});
      return `file:${intent.file_id}`;
    }
    const { upload_url, public_url } = (
      await imageApi.GetPresignedUrl(folder, file)
    ).data;



    await axios.put(upload_url, file, {
      headers: {
        "Content-Type": file.type,
      },
    });

    return public_url;
  } catch (error) {
    logger.log(error);
    throw error;
  }
};

export const uploadImage = async (folder: string, file: File) => {
  return uploadFile(folder, file);
};
