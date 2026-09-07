import type {AxiosResponse } from "axios";
import {api} from "."

interface UrlsResponse {
    upload_url: string;
    public_url: string;
}


async function GetPresignedUrl(folder: string, file: File): Promise<AxiosResponse<UrlsResponse>> {
    return api.post<UrlsResponse>(`/upload/presigned-url`, {
        folder: folder,
        content_type: file.type,
        file_name: file.name,
    });
}

export const imageApi = {
    GetPresignedUrl
}