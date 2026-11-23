import test from "node:test";
import assert from "node:assert/strict";
import { visibleLength } from "./layout.ts";
import { motionContext } from "./motion.ts";
import {
  PET_APPROVAL_BREATHE_MS,
  PET_BUBBLE_MIN_WIDTH,
  PET_BUBBLE_ROWS,
  PET_DOCK_MARK,
  PET_DOCK_MIN_WIDTH,
  PET_HEIGHT,
  PET_IMAGE_COLUMNS,
  PET_IMAGE_DATA_URI,
  PET_IMAGE_ID,
  PET_IMAGE_MIN_WIDTH,
  PET_IMAGE_ROWS,
  PET_MINI_WIDTH,
  PET_PERCH_ROWS,
  PET_REACTION_MAX_WIDTH,
  PET_SPLASH_MIN_WIDTH,
  PET_SPLASH_ROWS,
  PET_WIDTH,
  attachPetRow,
  detectPetTerminal,
  petCaption,
  petCardLines,
  petImageCleanup,
  petImagePlan,
  petImageSupport,
  petImageTransfer,
  petLayout,
  petPose,
  petPoseKind,
  petReaction,
  petStateFrom,
  renderPetBubble,
  renderPetDock,
  renderPetMini,
  renderPetRows,
  renderPetSplash,
  type PetImageReason,
  type PetSignal,
  type PetState,
  type PetTerminalKind,
  type PetTerminalReason,
  type PetPoseKind,
} from "./pet.ts";
import type { SymbolPreset } from "./theme-config.ts";

const STATES: readonly PetState[] = [
  "idle",
  "waiting",
  "thinking",
  "streaming",
  "tool",
  "approval",
  "error",
  "done",
  "cancelled",
];
const PRESETS: readonly SymbolPreset[] = [
  "ascii",
  "unicode",
  "classic",
  "nerd",
];
const POSES: readonly PetPoseKind[] = ["sit", "work", "report"];
const POSE_STATES: Record<PetPoseKind, readonly PetState[]> = {
  sit: ["idle", "waiting", "thinking"],
  work: ["streaming", "tool", "approval"],
  report: ["error", "done", "cancelled"],
};

/** ASCII, box drawing and block elements, geometric shapes, braille. */
function allowedGlyph(point: string): boolean {
  const code = point.codePointAt(0) ?? 0;
  return (
    (code >= 0x20 && code <= 0x7e) ||
    (code >= 0x2500 && code <= 0x25ff) ||
    (code >= 0x2800 && code <= 0x28ff)
  );
}

/**
 * The three border rows, which are the silhouette. Rows 1 and 2 carry the
 * per-state content and are not part of the shape.
 */
function silhouette(state: PetState, frame = 0): string {
  const rows = petPose(state, frame, motionContext(0)).rows;
  return [rows[0], rows[3], rows[4]].join("\n");
}

test("pet state comes from run signals, never from a clock", () => {
  // A pending approval outranks every activity signal: the run cannot move
  // until a human decides.
  assert.equal(
    petStateFrom({
      approval: true,
      status: "running",
      lastEventType: "tool.started",
    }),
    "approval",
  );
  assert.equal(
    petStateFrom({ status: "running", lastEventType: "tool.started" }),
    "tool",
  );
  assert.equal(
    petStateFrom({ status: "running", lastEventType: "tool.result" }),
    "tool",
  );
  assert.equal(
    petStateFrom({
      status: "running",
      lastEventType: "message.completed",
      toolCallsPresent: true,
    }),
    "tool",
  );
  assert.equal(
    petStateFrom({ status: "running", lastEventType: "message.delta" }),
    "streaming",
  );
  // A turn is in flight and the model has produced nothing yet.
  assert.equal(
    petStateFrom({ status: "running", lastEventKind: "user" }),
    "thinking",
  );
  assert.equal(petStateFrom({ status: "running" }), "thinking");
  // A run that is still active but has nothing left in flight waits.
  assert.equal(
    petStateFrom({ status: "running", lastEventType: "message.completed" }),
    "waiting",
  );
  assert.equal(petStateFrom({ status: "queued" }), "waiting");
  assert.equal(petStateFrom({ status: "paused" }), "waiting");
  assert.equal(petStateFrom({ status: "failed" }), "error");
  assert.equal(petStateFrom({ lastEventType: "run.error" }), "error");
  assert.equal(petStateFrom({ status: "cancelled" }), "cancelled");
  assert.equal(
    petStateFrom({ status: "idle", lastEventType: "message.completed" }),
    "done",
  );
  // An unconfirmed outcome never looks done: reconciliation owns that answer.
  assert.equal(
    petStateFrom({ status: "unknown", lastEventType: "message.completed" }),
    "idle",
  );
  assert.equal(petStateFrom({ status: "idle" }), "idle");
});

test("pet never invents thinking while idle or from a stale prompt", () => {
  // No session, no events: idle, not thinking.
  assert.equal(petStateFrom({}), "idle");
  // A prompt recorded in a conversation that is not running is not a model
  // thinking; it is a finished or unsent turn.
  assert.equal(petStateFrom({ status: "idle", lastEventKind: "user" }), "idle");
  assert.equal(
    petStateFrom({ status: "cancelled", lastEventKind: "user" }),
    "cancelled",
  );
  // The mapping has no clock parameter at all, so elapsed time cannot reach it.
  assert.equal(petStateFrom.length, 1);
});

test("pet state priority follows the audit order", () => {
  // approval > tool
  assert.equal(
    petStateFrom({ approval: true, lastEventType: "tool.started" }),
    "approval",
  );
  // tool > streaming
  assert.equal(
    petStateFrom({
      status: "running",
      lastEventType: "message.delta",
      toolCallsPresent: true,
    }),
    "streaming",
  );
  assert.equal(
    petStateFrom({ status: "running", lastEventType: "tool.started" }),
    "tool",
  );
  // streaming > thinking
  assert.equal(
    petStateFrom({
      status: "running",
      lastEventKind: "user",
      lastEventType: "message.delta",
    }),
    "streaming",
  );
  // waiting > terminal
  assert.equal(
    petStateFrom({ status: "running", lastEventType: "message.completed" }),
    "waiting",
  );
  // terminal > idle
  assert.equal(petStateFrom({ status: "failed" }), "error");
});

test("three poses, three silhouettes, one 9x5 grid", () => {
  assert.deepEqual(
    STATES.map((state) => petPoseKind(state)),
    ["sit", "sit", "sit", "work", "work", "work", "report", "report", "report"],
  );
  const seen = new Map<string, PetPoseKind>();
  for (const pose of POSES) {
    const reference = silhouette(POSE_STATES[pose][0]!);
    for (const state of POSE_STATES[pose])
      assert.equal(
        silhouette(state),
        reference,
        `${state} does not use the ${pose} silhouette`,
      );
    assert.equal(seen.has(reference), false, `${pose} shares a silhouette`);
    seen.set(reference, pose);
  }
});

test("a pose keeps its outline, and only an approval breathes", () => {
  const motion = motionContext(0);
  for (const state of STATES) {
    const shapes = new Set<string>();
    for (let frame = 0; frame < 40; frame += 1)
      shapes.add(silhouette(state, frame));
    if (state === "approval")
      assert.equal(shapes.size, 2, "the approval breathe is not two weights");
    else assert.equal(shapes.size, 1, `${state} changed its outline`);
  }
});

test("approval breathes its border every 1200 ms beside the ! hold", () => {
  assert.equal(PET_APPROVAL_BREATHE_MS, 1200);
  const motion = motionContext(0);
  const border = (frame: number) => petPose("approval", frame, motion).rows[0];
  const light = border(0);
  const heavy = border(12);
  assert.notEqual(light, heavy, "the border has one weight");
  for (const frame of [0, 1, 11]) assert.equal(border(frame), light);
  for (const frame of [12, 23, 24, 35]) assert.equal(border(frame), heavy);
  assert.equal(border(36), light);
  for (let frame = 0; frame < 40; frame += 1) {
    const rows = petPose("approval", frame, motion).rows;
    assert.ok(rows[1]!.includes("!"), `frame ${frame} lost the hold in text`);
    assert.ok(rows[2]!.includes("!"), `frame ${frame} lost the hold in text`);
  }
});

test("idle blinks in four steps and never faster than 4 fps", () => {
  const motion = motionContext(0);
  // 100 ms ticks: idle steps at ticks 0, 3, 5, 8, 10 which is four steps per
  // ten ticks, so a full idle cycle cannot run faster than 4 fps.
  const idleSteps = Array.from(
    { length: 10 },
    (_, frame) => petPose("idle", frame, motion).step,
  );
  assert.deepEqual(idleSteps, [0, 0, 0, 1, 1, 2, 2, 2, 3, 3]);
  const faces = new Set(
    Array.from(
      { length: 20 },
      (_, frame) => petPose("idle", frame, motion).rows[1],
    ),
  );
  assert.equal(faces.size, 2, "idle does not blink");
  // An active state advances at most once per tick, so ten frames per second.
  for (const state of ["thinking", "streaming", "tool", "waiting"] as const) {
    const steps = Array.from(
      { length: 10 },
      (_, frame) => petPose(state, frame, motion).step,
    );
    assert.equal(new Set(steps).size <= 10, true, `${state} exceeded 10 fps`);
  }
  // Settled states hold one frame.
  for (const state of ["done", "error", "cancelled"] as const) {
    const pose = petPose(state, 0, motion);
    assert.equal(pose.moving, false, `${state} is not settled`);
    for (const frame of [1, 13, 900])
      assert.deepEqual(petPose(state, frame, motion).rows, pose.rows);
  }
});

test("waiting alternates o and O in two steps", () => {
  const motion = motionContext(0);
  const faces = new Set(
    Array.from(
      { length: 40 },
      (_, frame) => petPose("waiting", frame, motion).rows[1],
    ),
  );
  assert.equal(faces.size, 2);
  assert.ok([...faces].some((face) => face.includes("o")));
  assert.ok([...faces].some((face) => face.includes("O")));
});

test("thinking spins a ten frame braille spinner beside a dot", () => {
  const motion = motionContext(0);
  const face = (state: PetState, frame: number, preset: SymbolPreset) =>
    [...petPose(state, frame, motion, preset).rows[1]!].slice(2, 7).join("");
  const faces = new Set(
    Array.from({ length: 40 }, (_, frame) =>
      face("thinking", frame, "unicode"),
    ),
  );
  assert.equal(faces.size, 10, "thinking is not a ten frame cycle");
  for (const drawn of faces) assert.match(drawn, /^ [\u2800-\u28ff] \. $/);
  // The ASCII preset cannot print braille, so it keeps its own four frames.
  const ascii = new Set(
    Array.from({ length: 40 }, (_, frame) => face("thinking", frame, "ascii")),
  );
  assert.equal(ascii.size, 4);
  for (const drawn of ascii) assert.match(drawn, /^ [|\/\\-] \. $/);
});

test("streaming moves one star across seven cells", () => {
  const motion = motionContext(0);
  for (let frame = 0; frame < 7; frame += 1) {
    const inner = [...petPose("streaming", frame, motion).rows[2]!].slice(1, 8);
    assert.equal(inner.length, 7);
    assert.equal(inner.filter((cell) => cell === "*").length, 1);
    assert.equal(inner[frame], "*", `frame ${frame} put the star elsewhere`);
    assert.ok(
      inner.every((cell, index) => index === frame || cell === "."),
      `frame ${frame} left a stray cell`,
    );
  }
  // Seven cells, so frame seven is frame zero again.
  assert.deepEqual(
    petPose("streaming", 7, motion).rows,
    petPose("streaming", 0, motion).rows,
  );
});

test("tool alternates = and # in two steps", () => {
  const motion = motionContext(0);
  const bodies = new Set(
    Array.from(
      { length: 40 },
      (_, frame) => petPose("tool", frame, motion).rows[2],
    ),
  );
  assert.equal(bodies.size, 2);
  assert.ok([...bodies].some((body) => body.includes("===")));
  assert.ok([...bodies].some((body) => body.includes("###")));
});

test("every state stays inside the 9x5 grid on all three poses", () => {
  const motion = motionContext(0);
  for (const pose of POSES) {
    for (const state of POSE_STATES[pose]) {
      for (const preset of PRESETS) {
        for (let frame = 0; frame < 40; frame += 1) {
          const drawn = petPose(state, frame, motion, preset);
          assert.equal(drawn.pose, pose, `${state} ${preset} pose`);
          assert.equal(
            drawn.rows.length,
            PET_HEIGHT,
            `${state} ${preset} rows`,
          );
          for (const row of drawn.rows) {
            assert.equal(
              [...row].length,
              PET_WIDTH,
              `${state} ${preset} frame ${frame} code points: ${JSON.stringify(row)}`,
            );
            assert.equal(
              visibleLength(row),
              PET_WIDTH,
              `${state} ${preset} frame ${frame} cells: ${JSON.stringify(row)}`,
            );
          }
        }
      }
    }
  }
});

test("a frame is a pure function of the counter", () => {
  for (const state of STATES)
    for (const frame of [0, 1, 6, 13, 39])
      assert.deepEqual(
        petPose(state, frame, motionContext(frame)),
        petPose(state, frame, motionContext(frame)),
        `${state} frame ${frame} is not reproducible`,
      );
  for (const state of STATES) {
    assert.deepEqual(
      renderPetRows(state, 40, motionContext(17)),
      renderPetRows(state, 40, motionContext(17)),
    );
    assert.deepEqual(
      renderPetDock(state, 20, motionContext(17)),
      renderPetDock(state, 20, motionContext(17)),
    );
  }
});

test("pet glyphs stay inside the whitelist and carry no colour", () => {
  const motion = motionContext(0);
  for (const preset of PRESETS) {
    for (const state of STATES) {
      for (let frame = 0; frame < 24; frame += 1) {
        const pose = petPose(state, frame, motion, preset);
        const text = [
          ...pose.rows,
          petCaption(state, PET_WIDTH),
          renderPetMini(state, preset),
          renderPetDock(state, 40, motion) ?? "",
          (renderPetSplash(40) ?? []).join(""),
          petCardLines(state, { status: "running" }).join(""),
        ].join("");
        assert.ok(!text.includes("\u001b"), `${preset} ${state} emitted ANSI`);
        for (const point of text) {
          assert.ok(
            allowedGlyph(point),
            `${preset} ${state} uses U+${(point.codePointAt(0) ?? 0).toString(16)}`,
          );
          const code = point.codePointAt(0) ?? 0;
          assert.ok(
            code < 0x2600 || code > 0x27bf,
            `${preset} ${state} uses two-cell U+${code.toString(16)}`,
          );
        }
      }
    }
  }
});

test("the ASCII preset renders an ASCII pet", () => {
  const motion = motionContext(0);
  for (const state of STATES) {
    const text = [
      ...petPose(state, 0, motion, "ascii").rows,
      petCaption(state, PET_WIDTH),
      renderPetMini(state, "ascii"),
    ].join("");
    for (const point of text)
      assert.ok(
        point.codePointAt(0)! >= 0x20 && point.codePointAt(0)! <= 0x7e,
        `ascii ${state} uses ${JSON.stringify(point)}`,
      );
  }
});

test("reduced motion is byte identical on every frame", () => {
  for (const state of STATES) {
    const frozen = renderPetRows(state, 40, motionContext(0, true, true));
    for (const frame of [1, 7, 41, 1000])
      assert.deepEqual(
        renderPetRows(state, 40, motionContext(frame, true, true)),
        frozen,
        `${state} moved while reduced`,
      );
    // NOMO_TUI_MOTION=0 is the same contract as the reduced context: the
    // first frame is what is drawn, whatever the counter says.
    const disabled = renderPetRows(state, 40, motionContext(0, false));
    for (const frame of [1, 9, 37])
      assert.deepEqual(
        renderPetRows(state, 40, motionContext(frame, false)),
        disabled,
        `${state} moved while motion was disabled`,
      );
    assert.deepEqual(
      disabled,
      frozen,
      `${state} disabled is not the base frame`,
    );
    // The dock has no motion at all, so a frozen counter cannot change it.
    assert.deepEqual(
      renderPetDock(state, 20, motionContext(37, true, true)),
      renderPetDock(state, 20, motionContext(0, true, true)),
    );
  }
});

test("the caption always names the state in words", () => {
  for (const state of STATES) {
    const wide = petCaption(state, 40);
    assert.match(wide, /^NIB /, `${state} caption lost the pet name`);
    assert.ok(wide.length > 4, `${state} caption lost the state`);
    const mini = renderPetMini(state);
    assert.match(mini, /^.{3} \S+$/, `${state} mini lost its word`);
    assert.ok(
      visibleLength(mini) <= PET_MINI_WIDTH,
      `${state} mini exceeds the reserved cells`,
    );
  }
});

test("the dock is one right aligned row that hides instead of clipping", () => {
  for (const state of STATES) {
    for (const width of [0, 4, 8])
      assert.equal(
        renderPetDock(state, width, motionContext(0)),
        null,
        `${state} docked in ${width} cells`,
      );
    // The dock uses the caption word when it fits and the mini word when it
    // does not, so the three forms never disagree about the same state.
    const long = `${PET_DOCK_MARK} ${petCaption(state, 40).slice(4)}`;
    const short = `${PET_DOCK_MARK} ${renderPetMini(state).slice(4)}`;
    for (const width of [PET_DOCK_MIN_WIDTH, 10, 20, 40]) {
      const line = renderPetDock(state, width, motionContext(0));
      assert.ok(line !== null, `${state} dock vanished at ${width}`);
      assert.ok(!line.includes("\n"), `${state} dock is not one row`);
      assert.equal(visibleLength(line), width, `${state} dock width drift`);
      // Right aligned: padding on the left, no trailing cells.
      const word = visibleLength(long) <= width ? long : short;
      assert.equal(line, `${" ".repeat(width - visibleLength(word))}${word}`);
    }
  }
  // A wide dock keeps the long word and pads the left edge only.
  assert.equal(
    renderPetDock("streaming", 20, motionContext(0)),
    `${" ".repeat(11)}${PET_DOCK_MARK} writing`,
  );
});

test("the splash is three static rows with keys and no telemetry", () => {
  for (const width of [0, 12, 29])
    assert.equal(renderPetSplash(width), null, `${width} drew a splash`);
  for (const width of [PET_SPLASH_MIN_WIDTH, 31, 40, 80, 120]) {
    const rows = renderPetSplash(width);
    assert.ok(rows !== null, `${width} lost the splash`);
    assert.equal(rows.length, PET_SPLASH_ROWS);
    for (const row of rows) {
      assert.ok(!row.includes("\n"));
      assert.equal(visibleLength(row), width, `${width} splash width drift`);
    }
    const text = rows.join("\n");
    assert.ok(text.includes("NIB is awake"), `${width} lost the title`);
    assert.ok(text.includes("/pet"), `${width} lost the keys`);
    // No clock, no counters, no percentages, no version numbers.
    assert.doesNotMatch(text, /\d/, `${width} splash carries a number`);
    assert.doesNotMatch(text, /heartbeat|elapsed|uptime|version|%|Hz/);
    // Static: two calls are the same bytes.
    assert.deepEqual(renderPetSplash(width), rows);
  }
});

test("the pet card reports only the signals it was given", () => {
  const none = petCardLines("idle", {});
  assert.equal(none.length, 2);
  assert.equal(none[0], "signal: none");
  assert.equal(none[1], "reads: NIB idle from no run signal");

  const approval = petCardLines("approval", {
    approval: true,
    status: "running",
    lastEventType: "tool.started",
  });
  assert.equal(
    approval[0],
    "signal: approval=yes status=running event=tool.started",
  );
  assert.equal(approval[1], "reads: NIB approval from approval pending");
  // A field that was not supplied is not reported at all.
  assert.doesNotMatch(approval[0]!, /kind=|tools=|error=/);

  const streaming = petCardLines("streaming", {
    status: "running",
    lastEventType: "message.delta",
    lastEventKind: "assistant",
    toolCallsPresent: false,
  });
  assert.equal(
    streaming[0],
    "signal: status=running event=message.delta kind=assistant tools=no",
  );
  assert.equal(streaming[1], "reads: NIB writing from event=message.delta");
});

test("the pet card never invents a number or a clock", () => {
  const signals: readonly PetSignal[] = [
    {},
    { status: "idle" },
    { status: "queued" },
    { status: "paused" },
    { status: "running", lastEventKind: "user" },
    { status: "running" },
    { status: "failed" },
    { status: "unknown" },
    { error: true },
    { status: "cancelled" },
    { approval: true },
  ];
  for (const state of STATES) {
    for (const signal of signals) {
      const lines = petCardLines(state, signal);
      const text = lines.join("\n");
      assert.match(lines[0]!, /^signal: /);
      assert.match(lines[1]!, /^reads: NIB /);
      assert.doesNotMatch(text, /\d/, `${state} card carries a number`);
      assert.doesNotMatch(
        text,
        /heartbeat|elapsed|uptime|since|clock|%|Hz/,
        `${state} card carries a clock`,
      );
    }
  }
});

test("the pet card reports a disagreement instead of hiding it", () => {
  const lines = petCardLines("idle", {
    status: "running",
    lastEventType: "message.delta",
  });
  assert.match(lines[1]!, /NIB idle shown/);
  assert.match(lines[1]!, /signals read writing/);
  assert.match(lines[1]!, /event=message\.delta/);
});

test("the perch needs room, and the mini form falls back rather than truncate", () => {
  // The 40x12 terminal stays on the mini form.
  assert.deepEqual(petLayout(40, 12, 13, "idle"), {
    kind: "mini",
    width: PET_MINI_WIDTH,
  });
  // A full perch is available from 64x22, where the six-row brand header is.
  const perch = petLayout(80, 24, 29, "thinking");
  assert.equal(perch.kind, "perch");
  assert.ok(perch.width >= PET_WIDTH);
  assert.equal(petLayout(64, 22, 29, "thinking").kind, "perch");
  assert.equal(petLayout(63, 22, 29, "thinking").kind, "mini");
  assert.equal(petLayout(64, 21, 29, "thinking").kind, "mini");
  // No room at the right edge means no pet, never a clipped brand.
  assert.equal(petLayout(22, 12, 13, "idle").kind, "hidden");
  assert.equal(petLayout(26, 12, 13, "idle").kind, "mini");
  assert.equal(petLayout(40, 12, 13, "idle", false).kind, "hidden");
  // The perch rows are the five sprite rows plus the caption.
  assert.equal(
    renderPetRows("idle", perch.width, motionContext(0)).length,
    PET_PERCH_ROWS,
  );
});

test("attaching the pet keeps the header row intact and inside the width", () => {
  const row = "NOMO  Chat";
  const merged = attachPetRow(row, "▄█▄ idle", 40);
  assert.equal(visibleLength(merged), 40);
  assert.ok(merged.startsWith(row), "the pet overwrote the header text");
  assert.ok(merged.includes("▄█▄ idle"), "the pet is missing");
  for (const width of [24, 40, 80, 120]) {
    const petRows = renderPetRows("streaming", 12, motionContext(3));
    for (const petRow of petRows) {
      const line = attachPetRow(row, petRow, width);
      assert.equal(visibleLength(line), width, `${width} width drift`);
      assert.ok(line.startsWith(row), `${width} lost the header text`);
    }
  }
});

test("life frames hold the 9x5 grid for every state, pose and 60 frames", () => {
  for (const pose of POSES) {
    for (const state of STATES) {
      for (const preset of PRESETS) {
        for (let frame = 0; frame < 60; frame += 1) {
          const drawn = petPose(
            state,
            frame,
            motionContext(frame),
            preset,
            pose,
          );
          assert.equal(drawn.pose, pose, `${state} ${pose} lost its pose`);
          assert.equal(
            drawn.rows.length,
            PET_HEIGHT,
            `${state} ${pose} ${preset} frame ${frame} row count`,
          );
          for (const row of drawn.rows) {
            assert.equal(
              [...row].length,
              PET_WIDTH,
              `${state} ${pose} ${preset} frame ${frame} code points: ${JSON.stringify(row)}`,
            );
            assert.equal(
              visibleLength(row),
              PET_WIDTH,
              `${state} ${pose} ${preset} frame ${frame} cells: ${JSON.stringify(row)}`,
            );
            for (const point of row) {
              assert.ok(
                allowedGlyph(point),
                `${state} ${pose} ${preset} frame ${frame} uses U+${(point.codePointAt(0) ?? 0).toString(16)}`,
              );
              const code = point.codePointAt(0) ?? 0;
              assert.ok(
                code < 0x2600 || code > 0x27bf,
                `${state} ${pose} ${preset} frame ${frame} uses two-cell U+${code.toString(16)}`,
              );
            }
          }
        }
      }
    }
  }
});

test("every life frame is a pure function of the counter", () => {
  for (const pose of POSES)
    for (const state of STATES)
      for (const preset of PRESETS)
        for (const frame of [0, 1, 5, 13, 40, 59])
          assert.deepEqual(
            petPose(state, frame, motionContext(frame), preset, pose),
            petPose(state, frame, motionContext(frame), preset, pose),
            `${state} ${pose} ${preset} frame ${frame} is not reproducible`,
          );
});

test("reduced motion holds the base frame in every pose and preset", () => {
  for (const pose of POSES)
    for (const state of STATES)
      for (const preset of PRESETS) {
        const base = petPose(
          state,
          0,
          motionContext(0, true, true),
          preset,
          pose,
        ).rows;
        for (const frame of [1, 7, 41, 59])
          assert.deepEqual(
            petPose(
              state,
              frame,
              motionContext(frame, true, true),
              preset,
              pose,
            ).rows,
            base,
            `${state} ${pose} ${preset} moved while reduced`,
          );
        assert.deepEqual(
          petPose(state, 59, motionContext(59, false), preset, pose).rows,
          base,
          `${state} ${pose} ${preset} moved while motion was disabled`,
        );
      }
});

test("idle twitches an ear, wags a tail and sleeps on its own frames", () => {
  const motion = motionContext(0);
  const body = (frame: number) =>
    [...petPose("idle", frame, motion).rows[2]!].slice(2, 7);
  // Step 3 of the idle cadence: the left edge lifts.
  assert.equal(body(8)[0], "^", "the ear twitch is not visible");
  // Step 2: the right edge wags, while the blink closes the eyes.
  assert.equal(body(5)[4], "~", "the tail wag is not visible");
  // Step 16: closed eyes and a z, so sleep reads as sleep and not as busy.
  const sleep = petPose("idle", 40, motion);
  assert.ok(sleep.rows[1]!.includes("- -"), "sleep lost the closed eyes");
  assert.ok(sleep.rows[2]!.includes("z"), "sleep lost the z");
  // Frame zero is the clean base frame, so reduced motion starts neutral.
  const base = body(0).join("");
  assert.ok(!base.includes("^"), "the base frame twitches");
  assert.ok(!base.includes("~"), "the base frame wags");
  assert.ok(!base.includes("z"), "the base frame sleeps");
  // The life marks never move the silhouette.
  const outline = (frame: number) => {
    const rows = petPose("idle", frame, motion).rows;
    return [rows[0], rows[3], rows[4]];
  };
  for (const frame of [0, 5, 8, 40]) assert.deepEqual(outline(frame), outline(0));
});

test("work bounces its hands without breaking the seven frame star", () => {
  const motion = motionContext(0);
  // Tool: four step bounce, so step 2 lifts the hands and step 0 rests.
  const toolBase = petPose("tool", 0, motion).rows[1]!;
  const toolLift = petPose("tool", 2, motion).rows[1]!;
  assert.ok(toolBase.includes("="), "the tool base frame lost its hands");
  assert.ok(!toolBase.includes("^"), "the tool base frame already bounces");
  assert.ok(toolLift.includes("^"), "the tool bounce is not visible");
  // Streaming: seven step bounce, which is why frame seven is frame zero.
  assert.ok(petPose("streaming", 5, motion).rows[1]!.includes("^"));
  assert.deepEqual(
    petPose("streaming", 7, motion).rows,
    petPose("streaming", 0, motion).rows,
  );
  // Approval keeps its ! hold: the decision, not decoration, is the signal.
  for (const frame of [0, 2, 5, 7])
    for (const row of petPose("approval", frame, motion).rows.slice(1, 3))
      assert.ok(row.includes("!"), `approval frame ${frame} lost the hold`);
});

test("a reaction names only the state and the real context it was given", () => {
  assert.equal(petReaction("idle"), "NIB: idle");
  assert.equal(petReaction("waiting"), "NIB: waiting to start");
  assert.equal(petReaction("thinking"), "NIB: waiting for provider");
  assert.equal(
    petReaction("thinking", { provider: "openai" }),
    "NIB: waiting for openai",
  );
  assert.equal(petReaction("streaming"), "NIB: writing...");
  assert.equal(petReaction("tool"), "NIB: using a tool...");
  assert.equal(
    petReaction("tool", { tool: "read parser" }),
    "NIB: reading parser...",
  );
  assert.equal(petReaction("tool", { tool: "bash" }), "NIB: running...");
  assert.equal(
    petReaction("tool", { tool: "mystery" }),
    "NIB: using mystery...",
  );
  assert.equal(petReaction("approval"), "NIB: needs approval");
  assert.equal(petReaction("error"), "NIB: failed");
  assert.equal(petReaction("done"), "NIB: done");
  assert.equal(petReaction("cancelled"), "NIB: cancelled");
  // A finished outcome is only ever named by the state that reached it.
  assert.ok(!petReaction("streaming").includes("done"));
  assert.ok(!petReaction("tool").includes("done"));
  // The context cannot smuggle a control sequence or a second line in.
  const dirty = petReaction("tool", { tool: "read \u001b[2Jparser\nnow" });
  assert.ok(!dirty.includes("\u001b"), "the reaction carried ANSI");
  assert.ok(!dirty.includes("\n"), "the reaction carried a second line");
  // The signature takes the state and an optional real context: no clock.
  assert.equal(petReaction.length, 1);
  for (const state of STATES) {
    const line = petReaction(state);
    assert.match(line, /^NIB: /);
    assert.equal(line, line.trim());
    assert.ok(visibleLength(line) <= PET_REACTION_MAX_WIDTH);
    assert.doesNotMatch(line, /heartbeat|elapsed|uptime|since|clock|Hz|%/);
    assert.doesNotMatch(line, /\d/, `${state} reaction invented a number`);
  }
});

test("a bubble is one or two rows and hides below twenty columns", () => {
  for (const width of [0, 1, 19, Number.NaN])
    assert.equal(
      renderPetBubble("idle", {}, width),
      null,
      `${width} drew a bubble`,
    );
  for (const state of STATES) {
    for (const width of [PET_BUBBLE_MIN_WIDTH, 21, 30, 40, 80]) {
      const rows = renderPetBubble(state, {}, width);
      assert.ok(rows !== null, `${state} bubble vanished at ${width}`);
      assert.ok(rows.length >= 1, `${state} bubble is empty`);
      assert.ok(
        rows.length <= PET_BUBBLE_ROWS,
        `${state} bubble stole composer rows at ${width}`,
      );
      for (const row of rows) {
        assert.ok(!row.includes("\n"), `${state} bubble is not one row`);
        assert.equal(visibleLength(row), width, `${state} bubble width drift`);
        const trimmed = row.trim();
        assert.ok(trimmed.startsWith("("), `${state} bubble lost its open`);
        assert.ok(trimmed.endsWith(")"), `${state} bubble lost its close`);
        for (const point of row) {
          const code = point.codePointAt(0) ?? 0;
          assert.ok(code < 0x7f, `${state} bubble uses U+${code.toString(16)}`);
          assert.ok(code < 0x2600 || code > 0x27bf);
        }
      }
      assert.ok(rows.join(" ").includes("NIB:"));
    }
  }
  // A reaction that does not fit wraps instead of widening or dropping text.
  const wrapped = renderPetBubble("thinking", { provider: "a-provider" }, 20);
  assert.equal(wrapped?.length, 2, "the long reaction did not wrap");
  assert.equal(visibleLength(wrapped![0]!), 20);
  assert.equal(visibleLength(wrapped![1]!), 20);
  // No clock: two calls are the same bytes.
  assert.deepEqual(
    renderPetBubble("streaming", {}, 24),
    renderPetBubble("streaming", {}, 24),
  );
});

test("splash v2 is an ASCII card with the mark and no telemetry", () => {
  assert.equal(renderPetSplash(29), null);
  const rows = renderPetSplash(PET_SPLASH_MIN_WIDTH);
  assert.ok(rows !== null, "the splash vanished at its minimum width");
  assert.equal(rows.length, PET_SPLASH_ROWS);
  const text = rows.join("\n");
  assert.ok(text.includes("NIB is awake"), "the splash lost its title");
  assert.ok(text.includes("/help  /pet  /exit"), "the splash lost its keys");
  assert.ok(text.includes(",#,"), "the splash lost its ASCII mark");
  for (const point of text)
    assert.ok(
      (point.codePointAt(0) ?? 0) < 0x7f,
      `the splash uses U+${(point.codePointAt(0) ?? 0).toString(16)}`,
    );
  assert.doesNotMatch(text, /\d|heartbeat|elapsed|uptime|version|%|Hz/);
});

// ---------------------------------------------------------------------------
// Optional image mode. ASCII stays the tested path, so every one of these
// checks that the escape appears only where it is safe and that every refusal
// leaves the ASCII pet exactly as it was.
// ---------------------------------------------------------------------------

const GHOSTTY = { TERM_PROGRAM: "ghostty", TERM: "xterm-ghostty" } as const;
const IMAGE_ON = { ...GHOSTTY, NOMO_TUI_IMAGE: "1" } as const;

/** No escape, no placeholder and no transfer: the ASCII contract. */
function plain(text: string): boolean {
  return !text.includes("\x1b") && !text.includes("\u{10eeee}");
}

test("terminal detection answers for every terminal the pet must survive", () => {
  const matrix: readonly (readonly [
    string,
    Readonly<Record<string, string>>,
    PetTerminalKind,
    PetTerminalReason,
    boolean,
  ])[] = [
    ["ghostty", GHOSTTY, "ghostty", "ghostty-kitty", true],
    [
      "ghostty by resources dir",
      { GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app/Contents/Resources" },
      "ghostty",
      "ghostty-kitty",
      true,
    ],
    [
      "kitty",
      { KITTY_WINDOW_ID: "1", TERM: "xterm-kitty" },
      "kitty",
      "kitty-native",
      true,
    ],
    [
      "iterm2",
      { TERM_PROGRAM: "iTerm.app", ITERM_SESSION_ID: "w0t0p0:1" },
      "iterm2",
      "iterm2-no-kitty-graphics",
      false,
    ],
    [
      "iterm2 by session",
      { I_TERM_SESSION: "w0t0p0" },
      "iterm2",
      "iterm2-no-kitty-graphics",
      false,
    ],
    [
      "macOS Terminal.app",
      { TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" },
      "terminal-app",
      "terminal-app-no-graphics",
      false,
    ],
    [
      "tmux",
      { TMUX: "/tmp/tmux-501/default,1,0", TERM: "screen-256color" },
      "tmux",
      "multiplexer-needs-passthrough",
      false,
    ],
    [
      "tmux over ghostty",
      { ...GHOSTTY, TMUX: "/tmp/tmux-501/default,1,0" },
      "tmux",
      "multiplexer-needs-passthrough",
      false,
    ],
    [
      "screen",
      { STY: "1.pts-0.host", TERM: "screen-256color" },
      "screen",
      "multiplexer-needs-passthrough",
      false,
    ],
    ["dumb", { TERM: "dumb" }, "dumb", "dumb-terminal", false],
    [
      "plain xterm",
      { TERM: "xterm-256color" },
      "unknown",
      "unknown-terminal",
      false,
    ],
  ];
  for (const [name, env, kind, reason, graphics] of matrix) {
    const terminal = detectPetTerminal(env);
    assert.equal(terminal.kind, kind, `${name} kind`);
    assert.equal(terminal.reason, reason, `${name} reason`);
    assert.equal(terminal.graphics, graphics, `${name} graphics`);
    assert.equal(
      terminal.protocol,
      graphics ? "kitty" : "none",
      `${name} protocol`,
    );
  }
  // A declared passthrough is the only way a multiplexer forwards graphics.
  const passthrough = detectPetTerminal({
    ...GHOSTTY,
    TMUX: "/tmp/tmux-501/default,1,0",
    NOMO_TUI_IMAGE_PASSTHROUGH: "1",
  });
  assert.equal(passthrough.kind, "ghostty");
  assert.equal(passthrough.multiplexer, "tmux");
  assert.equal(passthrough.graphics, true);
});

test("image mode is an exact opt-in that respects colour and the terminal", () => {
  const cases: readonly (readonly [
    string,
    Readonly<Record<string, string>>,
    PetImageReason,
  ])[] = [
    ["unset", GHOSTTY, "image-off"],
    ["zero", { ...GHOSTTY, NOMO_TUI_IMAGE: "0" }, "image-off"],
    ["empty", { ...GHOSTTY, NOMO_TUI_IMAGE: "" }, "image-off"],
    ["true is not 1", { ...GHOSTTY, NOMO_TUI_IMAGE: "true" }, "image-off"],
    ["ghostty", IMAGE_ON, "image-on"],
    [
      "kitty",
      { KITTY_WINDOW_ID: "1", TERM: "xterm-kitty", NOMO_TUI_IMAGE: "1" },
      "image-on",
    ],
    [
      "terminal.app",
      { TERM_PROGRAM: "Apple_Terminal", NOMO_TUI_IMAGE: "1" },
      "unsupported-terminal",
    ],
    [
      "iterm2",
      { TERM_PROGRAM: "iTerm.app", NOMO_TUI_IMAGE: "1" },
      "unsupported-terminal",
    ],
    [
      "tmux without passthrough",
      { ...GHOSTTY, TMUX: "/tmp/tmux,1,0", NOMO_TUI_IMAGE: "1" },
      "unsupported-terminal",
    ],
    [
      "no color",
      { ...IMAGE_ON, NO_COLOR: "1" },
      "no-color",
    ],
  ];
  for (const [name, env, reason] of cases) {
    const support = petImageSupport(env);
    assert.equal(support.reason, reason, `${name} reason`);
    assert.equal(support.available, reason === "image-on", `${name} available`);
    assert.equal(
      petImageTransfer(env) === "",
      reason !== "image-on",
      `${name} transfer`,
    );
  }
  // An explicit colour override is the user asking for colour anyway.
  assert.equal(
    petImageSupport({ ...IMAGE_ON, NO_COLOR: "1", FORCE_COLOR: "1" }).reason,
    "image-on",
  );
});

test("the transfer is one quiet Kitty escape carrying the built-in PNG", () => {
  const transfer = petImageTransfer(IMAGE_ON);
  assert.equal(transfer, petImageTransfer(IMAGE_ON), "not reproducible");
  assert.match(
    transfer,
    new RegExp(
      `^\\x1b_Ga=T,f=100,i=${PET_IMAGE_ID},U=1,c=${PET_IMAGE_COLUMNS},r=${PET_IMAGE_ROWS},q=2,m=0;`,
    ),
  );
  assert.ok(transfer.endsWith("\x1b\\"), "the transfer is not terminated");
  assert.equal(
    [...transfer.matchAll(/\x1b_G/g)].length,
    1,
    "a 152 byte payload must not be chunked",
  );
  // The payload is a real PNG, small enough for the icon validator, and the
  // whole image is inline: no file, no network, no dependency.
  const payload = PET_IMAGE_DATA_URI.slice(PET_IMAGE_DATA_URI.indexOf(",") + 1);
  assert.ok(transfer.includes(payload));
  const png = Buffer.from(payload, "base64");
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    "the built-in image is not a PNG",
  );
  assert.equal(png.toString("ascii", 12, 16), "IHDR");
  assert.ok(png.readUInt32BE(16) <= 64 && png.readUInt32BE(20) <= 64);
  assert.ok(png.length < 64 * 1024);
  // Cleanup names the same id, so a caller can remove exactly this image.
  assert.equal(
    petImageCleanup(),
    `\x1b_Ga=d,d=I,i=${PET_IMAGE_ID},q=2\x1b\\`,
  );
});

test("a multiplexer passthrough wraps the escape the way it forwards it", () => {
  const tmux = petImageTransfer({
    ...GHOSTTY,
    TMUX: "/tmp/tmux,1,0",
    NOMO_TUI_IMAGE: "1",
    NOMO_TUI_IMAGE_PASSTHROUGH: "1",
  });
  assert.ok(tmux.startsWith("\x1bPtmux;"), "tmux passthrough is not wrapped");
  assert.ok(tmux.endsWith("\x1b\\"));
  // Every inner escape is doubled so tmux forwards it verbatim.
  assert.ok(tmux.includes("\x1b\x1b_G"), "the inner escape was not doubled");
  const body = tmux.slice("\x1bPtmux;".length, -2);
  assert.equal(
    body.replaceAll("\x1b\x1b", "").includes("\x1b"),
    false,
    "an inner escape reached the multiplexer undoubled",
  );
  const screen = petImageTransfer({
    STY: "1.pts-0.host",
    TERM: "screen-256color",
    // A passthrough only says the multiplexer forwards graphics; the outer
    // terminal still has to be one that speaks the protocol.
    KITTY_WINDOW_ID: "1",
    NOMO_TUI_IMAGE: "1",
    NOMO_TUI_IMAGE_PASSTHROUGH: "1",
  });
  assert.ok(screen.startsWith("\x1bP"));
  assert.ok(screen.includes("\x1b_G"));
  // Without a graphics terminal behind it, a passthrough stays refused.
  assert.equal(
    petImageTransfer({
      STY: "1.pts-0.host",
      TERM: "screen-256color",
      NOMO_TUI_IMAGE: "1",
      NOMO_TUI_IMAGE_PASSTHROUGH: "1",
    }),
    "",
  );
});

test("the placeholder block is ordinary one-cell text the layout can measure", () => {
  const plan = petImagePlan(IMAGE_ON, 40, motionContext(0));
  assert.equal(plan.available, true);
  assert.equal(plan.reason, "image-on");
  assert.equal(plan.columns, PET_IMAGE_COLUMNS);
  assert.equal(plan.rows, PET_IMAGE_ROWS);
  assert.equal(plan.transfer, petImageTransfer(IMAGE_ON));
  assert.equal(plan.block.length, PET_IMAGE_ROWS);
  const rowMarks = new Set<string>();
  for (const row of plan.block) {
    // Nine placeholders of exactly one cell each, so attachPetRow, pad and the
    // renderer's diffing all keep the ASCII width contract.
    assert.equal(visibleLength(row), PET_IMAGE_COLUMNS);
    assert.equal(row.match(/\u{10eeee}/gu)?.length, PET_IMAGE_COLUMNS);
    assert.ok(!row.includes("\x1b_G"), "a frame row carried a transfer");
    const marks = row.match(/[\u0300-\u036f]/gu) ?? [];
    assert.equal(marks.length, PET_IMAGE_COLUMNS * 2, "row or column mark");
    rowMarks.add(marks[0]!);
    // The image id rides in the foreground colour, as Kitty requires for ids
    // above 255.
    assert.ok(
      row.includes(
        `\x1b[38;2;${(PET_IMAGE_ID >> 16) & 0xff};${(PET_IMAGE_ID >> 8) & 0xff};${PET_IMAGE_ID & 0xff}m`,
      ),
      "the placeholder row does not name the image",
    );
    assert.equal(visibleLength(attachPetRow("NOMO  Chat", row, 40)), 40);
  }
  assert.equal(rowMarks.size, PET_IMAGE_ROWS, "two rows share a row mark");
  // The caption row is still the ASCII one, so the state word is never pixels.
  const caption = petCaption("streaming", PET_IMAGE_COLUMNS);
  assert.ok(caption.startsWith("NIB "));
  assert.ok(plain(caption));
});

test("image mode falls back to ASCII on reduced motion, NO_COLOR and width", () => {
  // Reduced motion, and motion switched off, both keep the plain pet.
  for (const motion of [motionContext(0, true, true), motionContext(0, false)]) {
    const plan = petImagePlan(IMAGE_ON, 40, motion);
    assert.equal(plan.available, false);
    assert.equal(plan.reason, "reduced-motion");
    assert.equal(plan.transfer, "");
    assert.deepEqual(plan.block, []);
  }
  const noColor = petImagePlan({ ...IMAGE_ON, NO_COLOR: "1" }, 40, motionContext(0));
  assert.equal(noColor.reason, "no-color");
  assert.equal(noColor.transfer, "");
  assert.deepEqual(noColor.block, []);
  // The image never squeezes into a block that only fits the mini form.
  assert.equal(
    petImagePlan(IMAGE_ON, PET_IMAGE_MIN_WIDTH - 1, motionContext(0)).reason,
    "too-narrow",
  );
  assert.equal(
    petImagePlan(IMAGE_ON, Number.NaN, motionContext(0)).reason,
    "too-narrow",
  );
  assert.equal(
    petImagePlan(IMAGE_ON, PET_IMAGE_MIN_WIDTH, motionContext(0)).available,
    true,
  );
  // Whatever the verdict, the ASCII renderer is untouched and escape free.
  for (const state of STATES) {
    const rows = renderPetRows(state, 40, motionContext(0));
    assert.ok(plain(rows.join("")), `${state} ASCII rows carry an escape`);
  }
});

test("a 40x12 frame keeps the ASCII mini pet even with the opt-in", () => {
  const place = petLayout(40, 12, 13, "idle");
  assert.deepEqual(place, { kind: "mini", width: PET_MINI_WIDTH });
  // The terminal is wide enough for the image form in principle, but a 40x12
  // frame never reaches the perch, so the frame stays ASCII.
  assert.equal(petImagePlan(IMAGE_ON, 40, motionContext(0)).available, true);
  assert.ok(plain(renderPetMini("idle")));
  assert.ok(plain(renderPetRows("idle", place.width, motionContext(0)).join("")));
  assert.ok(plain(petCaption("idle", place.width)));
});

test("macOS Terminal.app is never handed a graphics escape", () => {
  const env = {
    TERM_PROGRAM: "Apple_Terminal",
    TERM: "xterm-256color",
    NOMO_TUI_IMAGE: "1",
  };
  const plan = petImagePlan(env, 80, motionContext(0));
  assert.equal(plan.available, false);
  assert.equal(plan.reason, "unsupported-terminal");
  assert.equal(plan.transfer, "");
  assert.deepEqual(plan.block, []);
  assert.equal(petImageTransfer(env), "");
  // Nothing the ASCII path renders depends on truecolor either: the sprite and
  // the caption are plain text, and no row paints a background.
  const rows = renderPetRows("streaming", 80, motionContext(0));
  assert.ok(plain(rows.join("")));
  assert.ok(!rows.join("").includes("\x1b[48;"));
});
