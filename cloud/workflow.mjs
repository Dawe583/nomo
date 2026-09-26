import { sleep } from "workflow";
import { advance, fail } from "./steps.mjs";

/**
 * The owner travels with the run, as a durable workflow argument rather than as
 * something re-derived inside the step. It is the owner the request that started
 * this run was verified to be, captured once at launch, so a step that resumes an
 * hour later reads the same rows it was authorised to read when it began.
 */
export async function runCloudSession(owner, id, generation) {
  "use workflow";
  try {
    for (let step = 0; step < 1500; step++) {
      const state = await advance(owner, id, generation);
      if (state === "done") return;
      if (state === "wait") await sleep("5s");
    }
    await fail(owner, id, generation);
  } catch {
    await fail(owner, id, generation);
  }
}
