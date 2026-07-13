import { imageApi } from "./api/imges.api";
import axios from "axios";

export const uploadImage = async (folder: string, file: File) => {
  try {
    const { upload_url, public_url } = (
      await imageApi.GetPresignedUrl(folder, file)
    ).data;

    console.log(`upload image :: ${upload_url} ${public_url}`);

    await axios.put(upload_url, file, {
      headers: {
        "Content-Type": file.type,
      },
    });

    return public_url;
  } catch (error) {
    console.log(error);
    throw error;
  }
};
