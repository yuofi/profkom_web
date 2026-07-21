import { imageApi } from "./api/imges.api";
import axios from "axios";
import { logger } from "./logger";

export const uploadImage = async (folder: string, file: File) => {
  try {
    const { upload_url, public_url } = (
      await imageApi.GetPresignedUrl(folder, file)
    ).data;

    logger.log(`upload image :: ${upload_url} ${public_url}`);

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
