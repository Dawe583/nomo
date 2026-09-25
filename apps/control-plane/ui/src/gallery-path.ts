/**
 * Routing gate for the D02.07 internal gallery.
 *
 * This is pure routing logic, so it lives apart from the React surface in
 * `gallery.tsx` and can be unit tested without a DOM. The repo already keeps
 * pure logic out of components the same way (`draft-state.ts`,
 * `recovery-review.ts`, `verify-scope.ts`).
 */

/**
 * The gallery is a real served path, added to the SPA allowlist in
 * `apps/control-plane/api/server.ts` and to the rewrites in `vercel.json`.
 * It is deliberately absent from the `routes` table in `main.tsx`, which is
 * what the sidebar and the command palette are both built from, so the page is
 * reachable by URL and unlisted in the product.
 */
export const GALLERY_PATH = "/gallery";

/** True when a location asks for the gallery instead of the application. */
export function isGalleryRequest(location: { pathname: string }): boolean {
  return location.pathname === GALLERY_PATH;
}
