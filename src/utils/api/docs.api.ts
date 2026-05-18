import type { AxiosResponse } from "axios";
import {api} from "./index"
import { type GuideIn, type GuideOut } from "./types"

async function SaveGuide (guide: GuideIn): Promise<AxiosResponse<GuideOut>> {
    const response = await api.post("/guides", guide);
    return response.data;
}

export const guideApi = {
    SaveGuide: SaveGuide
};