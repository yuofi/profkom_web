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

// export const pages = [
//   { name: "guides", text: "гайды" },
//   { name: "KMB", text: "кмб" },
//   { name: "information", text: "информация" },
// ];