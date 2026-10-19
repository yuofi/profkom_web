import { imageApi } from "./api/imges.api";
import axios from "axios";
import { filesApi } from "./api/files.api";
import { logger } from "./logger";

export const uploadFile = async (folder: string, file: File): Promise<string> => {
  try {
    if (folder === "pgas") {
      const uploaded = await filesApi.upload(file, { owner_kind: "pgas", purpose: "pgas" });
      return `file:${uploaded.file_id}`;
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
