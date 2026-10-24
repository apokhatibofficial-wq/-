// Builds the whole API (used by index.ts in production and by the tests).
import { createApp } from "./app.ts";
import type { AppDeps } from "./http.ts";
import { authRoutes } from "./routes/auth.ts";

export const modules = [authRoutes];

export function buildApp(d: AppDeps) {
  return createApp(d, modules);
}
