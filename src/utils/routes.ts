// export const getDocRoute = (name: string) => {
//     return `/docs/${name}`;
// }

export const getDocRoute = (id: string | number = ":id") => {
    return `/docs/${id}`;
}

export const getDocEditRoute = (name: string) => {
    return `/docs/${name}/edit`;
}

export const getHomeRoute = () => "/";
export const getProflePAge = () => "/profile";

export const pages = [
  { name: "guides", text: "гайды" },
  { name: "KMB", text: "кмб" },
  { name: "information", text: "информация" },
];

type AdminPageSections = "blocks" | "users"

export const getAdminRoute = (route: AdminPageSections) => {
  return `/admin/${route}`;
}