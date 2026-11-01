import assert from "node:assert/strict";
import test from "node:test";

import { workspaceSurface } from "./workspace-app-model.ts";
import type { WorkspaceTab, WorkspaceTui } from "./workspace.ts";

function fakeUi(tab: WorkspaceTab, overrides: Record<string, unknown> = {}) {
  const ui = {
    tab,
    selected: 0,
    model: "provider-model-a",
    projectId: undefined,
    detail: undefined,
    modelPicker: undefined,
    provider: undefined,
    items: () => [],
    session: () => undefined,
    workbench: { listProjects: () => [] },
    ...overrides,
  };
  return ui as unknown as WorkspaceTui;
}

test("workspace surface adapts data layout at the approved 120-column boundary", () => {
  const ui = fakeUi("sessions", {
    selected: 1,
    items: () => [
      { id: "one", label: "First", lines: ["State: idle"] },
      { id: "two", label: "Second", lines: ["State: running"] },
    ],
  });

  assert.equal(workspaceSurface(ui, 119, 40).layout, "stacked");
  assert.equal(workspaceSurface(ui, 120, 40).layout, "columns");
  assert.equal(workspaceSurface(ui, 120, 40).selected?.id, "two");
});

test("model surface uses the complete provider catalog and human-readable fields", () => {
  const models = [
    { id: "provider-model-a", name: "Model Alpha" },
    { id: "provider-model-b", name: "Model Beta" },
  ];
  const ui = fakeUi("models", {
    provider: { providerId: "provider-a", models },
    modelCatalogStatus: "ready",
    items: () =>
      models.map((model) => ({
        id: model.id,
        label: model.name,
        lines: ["raw JSON"],
      })),
  });

  const surface = workspaceSurface(ui, 140, 40);

  assert.deepEqual(
    surface.rows.map(({ id, label }) => [id, label]),
    [
      ["provider-model-a", "Model Alpha"],
      ["provider-model-b", "Model Beta"],
    ],
  );
  assert.equal(surface.provider, "provider-a");
  assert.equal(surface.selected?.id, "provider-model-a");
  assert.doesNotMatch(JSON.stringify(surface), /raw JSON/);
});

test("policy surface retains structured consent details instead of serialized objects", () => {
  const ui = fakeUi("policy", {
    items: () => [
      {
        id: "connector-1",
        label: "Local Files",
        lines: ["Consent: granted", "Policy: read only", "Tools: 3"],
      },
    ],
  });

  const surface = workspaceSurface(ui, 100, 24);

  assert.deepEqual(surface.rows[0]?.details, [
    "Consent: granted",
    "Policy: read only",
    "Tools: 3",
  ]);
  assert.equal(surface.empty, false);
});

test("empty screens expose a named panel state rather than an inert line", () => {
  const surface = workspaceSurface(fakeUi("approvals"), 80, 24);

  assert.equal(surface.empty, true);
  assert.equal(surface.emptyTitle, "No pending approvals");
  assert.equal(surface.layout, "stacked");
});
