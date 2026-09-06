import { imageApi } from "./api/imges.api";
import axios from "axios";
import { logger } from "./logger";

export const uploadFile = async (folder: string, file: File): Promise<string> => {
  try {
    const { upload_url, public_url } = (
      await imageApi.GetPresignedUrl(folder, file)
    ).data;

    logger.log(`upload file :: ${upload_url} ${public_url}`);

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
