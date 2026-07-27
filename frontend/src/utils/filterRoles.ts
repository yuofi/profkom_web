import type { MeOut } from "./api/types";

type Roles = Array<"admin" | "super_user"> | undefined

export const filterRoles = (allowed: Roles, user: MeOut | null) => {
    if (!allowed || !user) {
        return false
    }

    const hasRole = allowed.some((role) => user[role]);
        if (!hasRole) {
            return false
    }
    return true
}