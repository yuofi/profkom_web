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

    // Superuser / global guides can only be edited by superusers
    if (isSuperUserGuide(guide)) {
        return false;
    }

    const guideBlock = guide.owner_block?.trim().toLowerCase();
    if (!guideBlock) return false;

    // A block master can only edit guides of their own block
    if (blocks && blocks.length > 0 && user.kkr_name) {
        const matchedBlock = blocks.find((b) => b.name.trim().toLowerCase() === guideBlock);
        if (matchedBlock && matchedBlock.master === user.kkr_name) {
            return true;
        }
    }

    return false;
};
