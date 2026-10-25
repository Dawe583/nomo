import type { ProviderVertexOptions } from "./types.ts";

const GOOGLE_PROJECT_ID = /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{6,20})$/;
const LOCATION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function standardVertexBaseUrl(location: string): string | undefined {
  if (location === "global") return "https://aiplatform.googleapis.com";
  if (!LOCATION_ID.test(location)) return undefined;
  return `https://${location}-aiplatform.googleapis.com`;
}

export function isStandardVertexOptions(value: unknown): value is ProviderVertexOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const options = value as Record<string, unknown>;
  return (
    Object.keys(options).length === 3 &&
    Object.hasOwn(options, "mode") &&
    Object.hasOwn(options, "projectId") &&
    Object.hasOwn(options, "location") &&
    options.mode === "standard" &&
    typeof options.projectId === "string" &&
    GOOGLE_PROJECT_ID.test(options.projectId) &&
    typeof options.location === "string" &&
    standardVertexBaseUrl(options.location) !== undefined
  );
}
