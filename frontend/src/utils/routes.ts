// export const getDocRoute = (name: string) => {
//     return `/docs/${name}`;
// }

export const getDocRoute = (id: string | number = ":id") => {
    return `/docs/${id}`;
}

export const getAdminTabRoute = (tab: string | number = ":tab") => {
    return `/admin/${tab}`;
}

export const getDocEditRoute = (id: string | number = ":id") => {
    return `/docs/${id}/edit`;
}

export const getHomeRoute = () => "/";
export const getProfilePage = () => "/profile";
export const getPgasRoute = () => "/pgas";

export const getEventRoute = (id: string) => `/events/${encodeURIComponent(id)}`;
export const getSubeventRoute = (id: string) => `/subevents/${encodeURIComponent(id)}`;
export const getTaskRoute = (id: string) => `/tasks/${encodeURIComponent(id)}`;
export const getBlockRoute = (id: string) => `/blocks/${encodeURIComponent(id)}`;
export const getReportRoute = (id: string) => `/reports/${encodeURIComponent(id)}`;
export const getMaterialRoute = (id: string) => `/materials/${encodeURIComponent(id)}`;
export const getSeasonRoute = (id: string) => `/seasons/${encodeURIComponent(id)}`;
export function targetRoute(target: { kind: string; id: string } | null | undefined): string | null {
    if (!target || typeof target.id !== 'string' || !target.id) return null;
    const builders: Record<string, (id: string) => string> = { event: getEventRoute, subevent: getSubeventRoute, task: getTaskRoute, block: getBlockRoute, report: getReportRoute, material: getMaterialRoute, season: getSeasonRoute };
    return Object.hasOwn(builders, target.kind) ? builders[target.kind](target.id) : null;
}

// export const pages = [
//   { name: "guides", text: "гайды" },
//   { name: "KMB", text: "кмб" },
//   { name: "information", text: "информация" },
// ];
