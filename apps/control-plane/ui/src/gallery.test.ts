import test from "node:test";
import assert from "node:assert/strict";
import { GALLERY_PATH, isGalleryRequest } from "./gallery-path.ts";

test("the gallery opens on its own path and nowhere else", () => {
  assert.equal(isGalleryRequest({ pathname: GALLERY_PATH }), true);
  for (const pathname of [
    "/",
    "/chat",
    "/chat/new",
    "/settings",
    "/settings/",
    "/Gallery",
    "/gallery/",
    "/gallery/extra",
    "/api/gallery",
    "/demo",
  ]) {
    assert.equal(
      isGalleryRequest({ pathname }),
      false,
      `${pathname} must not render the gallery`,
    );
  }
});

test("the gallery path is a bare served pathname", () => {
  // A query-gated page cannot be added to a server's SPA allowlist, which is
  // why this is a path. Anything after the slash would not be served.
  assert.equal(GALLERY_PATH, "/gallery");
  assert.doesNotMatch(GALLERY_PATH, /[?#]/, "the gallery path must not depend on a query or fragment");
  assert.equal(
    new URL(GALLERY_PATH, "http://127.0.0.1").pathname,
    GALLERY_PATH,
    "GALLERY_PATH resolves to a different path than it declares",
  );
});
