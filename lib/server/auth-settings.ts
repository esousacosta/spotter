export function isAuthenticationEnabled(): boolean {
  return process.env.AUTH_ENABLED === "true" && Boolean(process.env.AUTH_SECRET);
}
