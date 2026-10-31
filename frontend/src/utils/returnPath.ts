/** Where to go after signing in: only a path of this site, never the login itself (GL-13).
 *  `//host`, `/\host` and absolute URLs would leave the site, so they open the home page. */
export function returnPath(value: unknown): string {
  if (typeof value !== "string" || !/^\/(?![\\/])/.test(value)) return "/";
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname === "/auth" || url.pathname.startsWith("/auth/")) return "/";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/";
  }
}
