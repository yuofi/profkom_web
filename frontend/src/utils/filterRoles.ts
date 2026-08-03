import type { BlockOut, GuideOut, MeOut } from "./api/types";

type Roles = Array<"admin" | "super_user"> | undefined;

export const filterRoles = (allowed: Roles, user: MeOut | null) => {
    if (!allowed || !user) {
        return false;
    }

    const hasRole = allowed.some((role) => user[role]);
    if (!hasRole) {
        return false;
    }
    return true;
};

export const hasPermission = (allowed: string[], user: MeOut | null) => {
    if (!allowed || !user) {
        return false;
    }

    const userBlocks = (user.blocks || "")
        .split(/[,;\n]+/)
        .map((block) => block.trim().toLowerCase())
        .filter(Boolean);
    const hasBlock = allowed.some((block) => userBlocks.includes(block.trim().toLowerCase()));
    if (!hasBlock) {
        return false;
    }
    return true;
};

export const isSuperUserGuide = (guide: GuideOut | { owner_block?: string | null } | null | undefined): boolean => {
    if (!guide || !guide.owner_block) return true;
    const ob = guide.owner_block.trim().toLowerCase();
    return ob === "none" || ob === "all" || ob === "";
};

export const canEditGuide = (
    guide: GuideOut | { owner_block?: string | null } | null | undefined,
    user: MeOut | null | undefined,
    blocks?: BlockOut[] | null
): boolean => {
    if (!guide || !user) return false;
    if (user.super_user) return true;
    if (!user.admin) return false;

    // Superuser guides can only be edited by superusers
    if (isSuperUserGuide(guide)) {
        return false;
    }

    const guideBlock = guide.owner_block?.trim().toLowerCase();
    if (!guideBlock) return false;

    // Check user's assigned blocks string
    const userBlocks = (user.blocks || "")
        .split(/[,;\n]+/)
        .map((b) => b.trim().toLowerCase())
        .filter(Boolean);
    if (userBlocks.includes(guideBlock)) {
        return true;
    }

    // Check blocks list if provided (user is master, hr, or in arr_of_human)
    if (blocks && blocks.length > 0) {
        const matchedBlock = blocks.find((b) => b.name.trim().toLowerCase() === guideBlock);
        if (matchedBlock) {
            if (user.kkr_name && (matchedBlock.master === user.kkr_name || matchedBlock.hr === user.kkr_name)) {
                return true;
            }
            if (matchedBlock.arr_of_human && matchedBlock.arr_of_human.includes(user.user_id)) {
                return true;
            }
        }
    }

    return false;
};
