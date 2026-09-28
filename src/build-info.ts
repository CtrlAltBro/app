// Build stamp baked by vite.renderer.config.ts (mirrors __API_URL__ in config.ts).
export type BuildInfo = { version: string; branch: string; commit: string; dirty: boolean; time: string };
declare const __BUILD__: BuildInfo;

export const BUILD: BuildInfo = __BUILD__;

// Short label for the window footer, e.g. "v1.0.0 · dev@4960dbf" ("✱" = tree had
// uncommitted changes at build time).
export const buildLabel = () => `v${BUILD.version} · ${BUILD.branch}@${BUILD.commit}${BUILD.dirty ? '✱' : ''}`;
