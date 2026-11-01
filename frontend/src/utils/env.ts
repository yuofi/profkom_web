/** The build's settings, checked once at start (an unset one stops the app with its name).
 *  A plain check instead of a schema keeps the schema library out of the first download. */
const ENVIRONMENTS = ["development", "production", "test"] as const;
function setting(name: string, required = false): string {
    const value: unknown = import.meta.env[name];
    if (typeof value !== "string" || (required && !value.trim())) throw new Error(`Environment variable ${name} is not set`);
    return value.trim();
}
function environment(): (typeof ENVIRONMENTS)[number] {
    const value = setting("VITE_ENVIRONMENT");
    const known = ENVIRONMENTS.find((item) => item === value);
    if (!known) throw new Error(`Environment variable VITE_ENVIRONMENT is not one of ${ENVIRONMENTS.join(", ")}`);
    return known;
}

export const env = {
    VITE_BACKEND_URL: setting("VITE_BACKEND_URL", true),
    VITE_ENVIRONMENT: environment(),
    VITE_APP_ID: setting("VITE_APP_ID"),
    VITE_REDIRECT_URL: setting("VITE_REDIRECT_URL"),
};
