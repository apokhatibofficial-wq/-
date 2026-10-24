// Builds the whole API (used by index.ts in production and by the tests).
import { createApp } from "./app.ts";
import type { AppDeps } from "./http.ts";
import { adminRoutes } from "./routes/admin.ts";
import { authRoutes } from "./routes/auth.ts";
import { formRoutes } from "./routes/forms.ts";
import { hospitalRoutes, publicSlugRoutes } from "./routes/hospital.ts";

export const modules = [authRoutes, adminRoutes, formRoutes, hospitalRoutes, publicSlugRoutes];

export function buildApp(d: AppDeps) {
  return createApp(d, modules);
}
