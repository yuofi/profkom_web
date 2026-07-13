import { guideApi } from "../utils/api/docs.api";
import fs from "node:fs/promises";
import path from "node:path";

const names = ["guides", "information", "KMB"];

async function presetGuides() {
    const mdDir = path.resolve(process.cwd(), "public", "md");   
    for (const name of names) {
        const filePath = path.join(mdDir, `${name}.md`);

        try {
            const text = await fs.readFile(filePath, "utf-8");

            const guide = {
                title: name,
                owner_block: "none",
                text: text,
                original_link: null
            }; 

            await guideApi.SaveGuide(guide);
            console.log(`Успешно сохранен гайд: ${name}`);
        } catch (err) {
            console.error(`Ошибка при обработке файла ${name}.md:`, err);
        }
    }
}

presetGuides();