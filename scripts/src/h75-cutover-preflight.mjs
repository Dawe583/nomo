import { readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";

const usage =
  "usage: node scripts/src/h75-cutover-preflight.mjs <evidence.json>";
const caution =
  "This preflight does not verify referenced evidence or authorize cutover.";

function object(value, path, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path}: must be an object`);
    return {};
  }
  return value;
}

function text(value, path, errors) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${path}: required`);
    return "";
  }
  return value.trim();
}

function items(value, path, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path}: must be a non-empty array`);
    return [];
  }
  return value;
}

function yes(value, path, errors) {
  if (value !== true) errors.push(`${path}: must be true`);
}

function knownFields(value, fields, path, errors, noun = "row") {
  for (const field of Object.keys(value))
    if (!fields.includes(field))
      errors.push(`${path}.${field}: unknown ${noun} field`);
}

function evidenceRef(value, path, errors) {
  const result = text(value, path, errors);
  if (
    result &&
    (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s][^\s]*$/.test(result) ||
      /^file:/i.test(result))
  )
    errors.push(`${path}: must be a non-file URI evidence reference`);
  return result;
}

function timestamp(value, path, errors) {
  const result = text(value, path, errors);
  if (
    result &&
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(result)
  )
    errors.push(`${path}: must be a UTC ISO timestamp`);
  else if (result) {
    const parsed = new Date(result);
    const canonical = result.replace(
      /(?:\.(\d{1,3}))?Z$/,
      (_, milliseconds = "") => `.${milliseconds.padEnd(3, "0")}Z`,
    );
    if (
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString() !== canonical
    )
      errors.push(`${path}: must be a real UTC date-time`);
  }
  return result;
}

const GATE_FIELDS = {
  inventory: [
    "owner",
    "independentVerifier",
    "decision",
    "decisionAt",
    "recordRef",
    "coverageMethod",
    "entrypoints",
    "roots",
  ],
  fence: [
    "owner",
    "independentVerifier",
    "decision",
    "decisionAt",
    "recordRef",
    "mechanism",
    "scope",
    "activationRef",
    "activatedAt",
    "entrypointResults",
    "rootResults",
  ],
  drain: [
    "owner",
    "independentVerifier",
    "decision",
    "decisionAt",
    "recordRef",
    "graceIntervalMs",
    "firstObservationAt",
    "secondObservationAt",
    "firstObservationRef",
    "secondObservationRef",
    "rootResults",
  ],
  preservation: [
    "owner",
    "independentVerifier",
    "decision",
    "decisionAt",
    "recordRef",
    "rootResults",
  ],
  restart: [
    "owner",
    "independentVerifier",
    "decision",
    "decisionAt",
    "recordRef",
    "candidateReleaseHash",
    "runtimeVersion",
    "conversionPlanRef",
    "rootResults",
  ],
  rollback: [
    "owner",
    "independentVerifier",
    "decision",
    "decisionAt",
    "recordRef",
    "separateApprovalRef",
    "fenceRetainedDuringRehearsal",
    "fenceRetentionRef",
    "rollbackFenceAt",
    "rollbackDrainAt",
    "failedStatePreserved",
    "failedStatePreservedAt",
    "failedStateRef",
    "approvalAt",
    "cutoverAt",
    "rehearsalAt",
    "trigger",
    "lockRepresentation",
    "candidateReleaseHash",
    "encryptedStateRestorePointRef",
    "priorRelease",
    "priorRuntime",
    "fenceRef",
    "drainRef",
    "restoreProcedureRef",
    "rehearsalRef",
    "restartRef",
    "integrityRef",
    "rootResults",
  ],
};

function gate(register, name, record, errors) {
  const value = object(register[name], name, errors);
  for (const field of Object.keys(value))
    if (!GATE_FIELDS[name].includes(field))
      errors.push(`${name}.${field}: unknown gate field`);
  for (const field of ["owner", "independentVerifier"])
    text(value[field], `${name}.${field}`, errors);
  timestamp(value.decisionAt, `${name}.decisionAt`, errors);
  evidenceRef(value.recordRef, `${name}.recordRef`, errors);
  if (text(value.decision, `${name}.decision`, errors) !== "accepted")
    errors.push(`${name}.decision: must be accepted`);
  if (
    value.owner?.trim() &&
    value.owner.trim() === value.independentVerifier?.trim()
  )
    errors.push(`${name}.independentVerifier: must differ from evidence owner`);
  const reference = value.recordRef?.trim();
  if (reference) {
    if (record.value && record.value !== reference)
      errors.push(
        `${name}.recordRef: must match the maintenance change record`,
      );
    else record.value = reference;
  }
  return value;
}

function uniqueRows(value, path, errors) {
  const rows = items(value, path, errors).map((row, index) =>
    object(row, `${path}[${index}]`, errors),
  );
  const ids = new Set();
  for (let index = 0; index < rows.length; index++) {
    const id = text(rows[index].id, `${path}[${index}].id`, errors);
    if (id && ids.has(id)) errors.push(`${path}[${index}].id: duplicate`);
    ids.add(id);
  }
  return rows;
}

function coverage(rows, key, expected, path, errors, check) {
  const seen = new Set();
  for (let index = 0; index < rows.length; index++) {
    const item = rows[index];
    const id = text(item[key], `${path}[${index}].${key}`, errors);
    if (id && !expected.has(id))
      errors.push(`${path}[${index}].${key}: unknown inventory id`);
    if (id && seen.has(id))
      errors.push(`${path}[${index}].${key}: duplicate coverage`);
    if (id) seen.add(id);
    check(item, `${path}[${index}]`);
  }
  for (const id of expected)
    if (!seen.has(id))
      errors.push(
        `${path}: missing coverage for inventory ${key === "rootId" ? "root" : "entrypoint"} ${id}`,
      );
}

function validate(register) {
  const errors = [];
  if (register.schemaVersion !== 1) errors.push("schemaVersion: must be 1");
  for (const key of Object.keys(register))
    if (
      !new Set([
        "schemaVersion",
        "inventory",
        "fence",
        "drain",
        "preservation",
        "restart",
        "rollback",
      ]).has(key)
    )
      errors.push(`${key}: unknown evidence register section`);
  const record = { value: "" };
  const inventory = gate(register, "inventory", record, errors);
  const fence = gate(register, "fence", record, errors);
  const drain = gate(register, "drain", record, errors);
  const preservation = gate(register, "preservation", record, errors);
  const restart = gate(register, "restart", record, errors);
  const rollback = gate(register, "rollback", record, errors);

  text(inventory.coverageMethod, "inventory.coverageMethod", errors);
  const entrypoints = uniqueRows(
    inventory.entrypoints,
    "inventory.entrypoints",
    errors,
  );
  const roots = uniqueRows(inventory.roots, "inventory.roots", errors);
  const entrypointIds = new Set(
    entrypoints.map((row) => row.id).filter(Boolean),
  );
  const rootIds = new Set(roots.map((row) => row.id).filter(Boolean));
  const canonicalPaths = new Map();
  for (let index = 0; index < roots.length; index++) {
    knownFields(
      roots[index],
      ["id", "canonicalPath", "filesystemIdentity", "owner", "checkedAt"],
      `inventory.roots[${index}]`,
      errors,
      "inventory row",
    );
    const path = text(
      roots[index].canonicalPath,
      `inventory.roots[${index}].canonicalPath`,
      errors,
    );
    if (path && !isAbsolute(path))
      errors.push(`inventory.roots[${index}].canonicalPath: must be absolute`);
    const normalizedPath = path && isAbsolute(path) ? resolvePath(path) : "";
    if (normalizedPath && canonicalPaths.has(normalizedPath))
      errors.push(
        `inventory.roots[${index}].canonicalPath: duplicates canonical root ${canonicalPaths.get(normalizedPath)}`,
      );
    else if (normalizedPath)
      canonicalPaths.set(normalizedPath, roots[index].id);
    text(
      roots[index].filesystemIdentity,
      `inventory.roots[${index}].filesystemIdentity`,
      errors,
    );
    text(roots[index].owner, `inventory.roots[${index}].owner`, errors);
    const checkedAt = timestamp(
      roots[index].checkedAt,
      `inventory.roots[${index}].checkedAt`,
      errors,
    );
    if (
      inventory.decisionAt &&
      checkedAt &&
      Date.parse(checkedAt) > Date.parse(inventory.decisionAt)
    )
      errors.push(
        `inventory.roots[${index}].checkedAt: must be at or before inventory acceptance`,
      );
  }
  const associatedRootIds = new Set();
  for (let index = 0; index < entrypoints.length; index++) {
    const entrypoint = entrypoints[index];
    knownFields(
      entrypoint,
      [
        "id",
        "executable",
        "releaseHash",
        "runtime",
        "launchMechanism",
        "configSource",
        "lockProtocol",
        "owner",
        "rootIds",
        "checkedAt",
      ],
      `inventory.entrypoints[${index}]`,
      errors,
      "inventory row",
    );
    for (const field of [
      "executable",
      "releaseHash",
      "runtime",
      "launchMechanism",
      "configSource",
      "lockProtocol",
      "owner",
    ])
      text(
        entrypoint[field],
        `inventory.entrypoints[${index}].${field}`,
        errors,
      );
    const refs = items(
      entrypoint.rootIds,
      `inventory.entrypoints[${index}].rootIds`,
      errors,
    );
    const seenRoots = new Set();
    const checkedAt = timestamp(
      entrypoint.checkedAt,
      `inventory.entrypoints[${index}].checkedAt`,
      errors,
    );
    if (
      inventory.decisionAt &&
      checkedAt &&
      Date.parse(checkedAt) > Date.parse(inventory.decisionAt)
    )
      errors.push(
        `inventory.entrypoints[${index}].checkedAt: must be at or before inventory acceptance`,
      );
    for (const id of refs) {
      if (!rootIds.has(id))
        errors.push(
          `inventory.entrypoints[${index}].rootIds: unknown inventory root`,
        );
      else associatedRootIds.add(id);
      if (seenRoots.has(id))
        errors.push(
          `inventory.entrypoints[${index}].rootIds: duplicate root association`,
        );
      seenRoots.add(id);
    }
  }

  for (let index = 0; index < roots.length; index++)
    if (roots[index].id && !associatedRootIds.has(roots[index].id))
      errors.push(
        `inventory.roots[${index}].id: not associated with any entrypoint`,
      );

  text(fence.mechanism, "fence.mechanism", errors);
  text(fence.scope, "fence.scope", errors);
  evidenceRef(fence.activationRef, "fence.activationRef", errors);
  const fenceDecisionAt = timestamp(
    fence.decisionAt,
    "fence.decisionAt",
    errors,
  );
  const inventoryDecisionAt = timestamp(
    inventory.decisionAt,
    "inventory.decisionAt",
    errors,
  );
  const activatedAt = timestamp(fence.activatedAt, "fence.activatedAt", errors);
  if (
    inventoryDecisionAt &&
    activatedAt &&
    Date.parse(activatedAt) < Date.parse(inventoryDecisionAt)
  )
    errors.push("fence.activatedAt: must be at or after inventory acceptance");
  const firstObservationAt = timestamp(
    drain.firstObservationAt,
    "drain.firstObservationAt",
    errors,
  );
  const secondObservationAt = timestamp(
    drain.secondObservationAt,
    "drain.secondObservationAt",
    errors,
  );
  const drainDecisionAt = timestamp(
    drain.decisionAt,
    "drain.decisionAt",
    errors,
  );
  if (
    firstObservationAt &&
    secondObservationAt &&
    Date.parse(secondObservationAt) <= Date.parse(firstObservationAt)
  )
    errors.push("drain.secondObservationAt: must be after first observation");
  if (
    drainDecisionAt &&
    secondObservationAt &&
    Date.parse(drainDecisionAt) < Date.parse(secondObservationAt)
  )
    errors.push("drain.decisionAt: must be at or after the second observation");
  if (
    !Number.isSafeInteger(drain.graceIntervalMs) ||
    drain.graceIntervalMs <= 0
  )
    errors.push("drain.graceIntervalMs: must be a positive integer");
  else if (
    firstObservationAt &&
    secondObservationAt &&
    Date.parse(secondObservationAt) - Date.parse(firstObservationAt) <
      drain.graceIntervalMs
  )
    errors.push("drain: observations do not span the required grace interval");
  if (
    fenceDecisionAt &&
    firstObservationAt &&
    Date.parse(firstObservationAt) < Date.parse(fenceDecisionAt)
  )
    errors.push(
      "drain.firstObservationAt: must be at or after fence acceptance",
    );
  if (
    activatedAt &&
    firstObservationAt &&
    Date.parse(firstObservationAt) < Date.parse(activatedAt)
  )
    errors.push(
      "drain.firstObservationAt: must be at or after fence activation",
    );
  const fenceRows = Array.isArray(fence.entrypointResults)
    ? fence.entrypointResults.map((row, index) =>
        object(row, `fence.entrypointResults[${index}]`, errors),
      )
    : [];
  if (!Array.isArray(fence.entrypointResults))
    errors.push("fence.entrypointResults: must be an array");
  coverage(
    fenceRows,
    "entrypointId",
    entrypointIds,
    "fence.entrypointResults",
    errors,
    (row, path) => {
      knownFields(
        row,
        ["entrypointId", "checkedAt", "denied", "evidenceRef"],
        path,
        errors,
      );
      const checkedAt = timestamp(row.checkedAt, `${path}.checkedAt`, errors);
      if (
        activatedAt &&
        checkedAt &&
        Date.parse(checkedAt) < Date.parse(activatedAt)
      )
        errors.push(`${path}.checkedAt: must be at or after fence activation`);
      if (
        fenceDecisionAt &&
        checkedAt &&
        Date.parse(fenceDecisionAt) < Date.parse(checkedAt)
      )
        errors.push(
          "fence.decisionAt: must be at or after every entrypoint check",
        );
      yes(row.denied, `${path}.denied`, errors);
      evidenceRef(row.evidenceRef, `${path}.evidenceRef`, errors);
    },
  );

  evidenceRef(drain.firstObservationRef, "drain.firstObservationRef", errors);
  evidenceRef(drain.secondObservationRef, "drain.secondObservationRef", errors);
  const fenceRootRows = Array.isArray(fence.rootResults)
    ? fence.rootResults.map((row, index) =>
        object(row, `fence.rootResults[${index}]`, errors),
      )
    : [];
  if (!Array.isArray(fence.rootResults))
    errors.push("fence.rootResults: must be an array");
  coverage(
    fenceRootRows,
    "rootId",
    rootIds,
    "fence.rootResults",
    errors,
    (row, path) => {
      knownFields(
        row,
        ["rootId", "checkedAt", "denied", "evidenceRef"],
        path,
        errors,
      );
      const checkedAt = timestamp(row.checkedAt, `${path}.checkedAt`, errors);
      if (
        activatedAt &&
        checkedAt &&
        Date.parse(checkedAt) < Date.parse(activatedAt)
      )
        errors.push(`${path}.checkedAt: must be at or after fence activation`);
      if (
        fenceDecisionAt &&
        checkedAt &&
        Date.parse(fenceDecisionAt) < Date.parse(checkedAt)
      )
        errors.push(
          "fence.decisionAt: must be at or after every entrypoint and root check",
        );
      yes(row.denied, `${path}.denied`, errors);
      evidenceRef(row.evidenceRef, `${path}.evidenceRef`, errors);
    },
  );

  const drainRows = Array.isArray(drain.rootResults)
    ? drain.rootResults.map((row, index) =>
        object(row, `drain.rootResults[${index}]`, errors),
      )
    : [];
  if (!Array.isArray(drain.rootResults))
    errors.push("drain.rootResults: must be an array");
  coverage(
    drainRows,
    "rootId",
    rootIds,
    "drain.rootResults",
    errors,
    (row, path) => {
      knownFields(
        row,
        [
          "rootId",
          "checkedAt",
          "staleReaperBarrierAt",
          "admittedWritersDrained",
          "processCensusBeforeRef",
          "processCensusAfterRef",
          "staleReaperBarrierRef",
          "evidenceRef",
        ],
        path,
        errors,
      );
      const checkedAt = timestamp(row.checkedAt, `${path}.checkedAt`, errors);
      const staleReaperBarrierAt = timestamp(
        row.staleReaperBarrierAt,
        `${path}.staleReaperBarrierAt`,
        errors,
      );
      if (
        secondObservationAt &&
        staleReaperBarrierAt &&
        Date.parse(staleReaperBarrierAt) < Date.parse(secondObservationAt)
      )
        errors.push(
          `${path}.staleReaperBarrierAt: must be at or after the second observation`,
        );
      if (
        checkedAt &&
        staleReaperBarrierAt &&
        Date.parse(staleReaperBarrierAt) > Date.parse(checkedAt)
      )
        errors.push(
          `${path}.staleReaperBarrierAt: must be at or before the root drain check`,
        );
      if (
        secondObservationAt &&
        checkedAt &&
        Date.parse(checkedAt) < Date.parse(secondObservationAt)
      )
        errors.push(
          `${path}.checkedAt: must be at or after the second observation`,
        );
      if (
        drainDecisionAt &&
        checkedAt &&
        Date.parse(drainDecisionAt) < Date.parse(checkedAt)
      )
        errors.push(
          "drain.decisionAt: must be at or after every root drain check",
        );
      yes(row.admittedWritersDrained, `${path}.admittedWritersDrained`, errors);
      for (const field of [
        "processCensusBeforeRef",
        "processCensusAfterRef",
        "staleReaperBarrierRef",
        "evidenceRef",
      ])
        (field.endsWith("Ref") ? evidenceRef : text)(
          row[field],
          `${path}.${field}`,
          errors,
        );
    },
  );

  const preservationDecisionAt = timestamp(
    preservation.decisionAt,
    "preservation.decisionAt",
    errors,
  );
  const preservationRows = Array.isArray(preservation.rootResults)
    ? preservation.rootResults.map((row, index) =>
        object(row, `preservation.rootResults[${index}]`, errors),
      )
    : [];
  if (!Array.isArray(preservation.rootResults))
    errors.push("preservation.rootResults: must be an array");
  coverage(
    preservationRows,
    "rootId",
    rootIds,
    "preservation.rootResults",
    errors,
    (row, path) => {
      knownFields(
        row,
        [
          "rootId",
          "checkedAt",
          "backupId",
          "destinationRootId",
          "fileManifestRef",
          "offlineIntegrityCheckRef",
          "sourceUnchanged",
        ],
        path,
        errors,
      );
      const checkedAt = timestamp(row.checkedAt, `${path}.checkedAt`, errors);
      if (
        drainDecisionAt &&
        checkedAt &&
        Date.parse(checkedAt) < Date.parse(drainDecisionAt)
      )
        errors.push(`${path}.checkedAt: must be at or after drain acceptance`);
      if (
        preservationDecisionAt &&
        checkedAt &&
        Date.parse(preservationDecisionAt) < Date.parse(checkedAt)
      )
        errors.push(
          "preservation.decisionAt: must be at or after every root check",
        );
      for (const field of ["backupId", "destinationRootId"])
        text(row[field], `${path}.${field}`, errors);
      for (const field of ["fileManifestRef", "offlineIntegrityCheckRef"])
        evidenceRef(row[field], `${path}.${field}`, errors);
      yes(row.sourceUnchanged, `${path}.sourceUnchanged`, errors);
      if (row.rootId && row.destinationRootId === row.rootId)
        errors.push(`${path}.destinationRootId: must differ from source root`);
    },
  );

  text(restart.candidateReleaseHash, "restart.candidateReleaseHash", errors);
  text(restart.runtimeVersion, "restart.runtimeVersion", errors);
  evidenceRef(restart.conversionPlanRef, "restart.conversionPlanRef", errors);
  const restartRows = Array.isArray(restart.rootResults)
    ? restart.rootResults.map((row, index) =>
        object(row, `restart.rootResults[${index}]`, errors),
      )
    : [];
  if (!Array.isArray(restart.rootResults))
    errors.push("restart.rootResults: must be an array");
  const restartDecisionAt = timestamp(
    restart.decisionAt,
    "restart.decisionAt",
    errors,
  );
  coverage(
    restartRows,
    "rootId",
    rootIds,
    "restart.rootResults",
    errors,
    (row, path) => {
      knownFields(
        row,
        [
          "rootId",
          "checkedAt",
          "runtimeVersion",
          "candidateReleaseHash",
          "lockLayout",
          "firstWriterReadRef",
          "reversibleWriteRef",
          "freshProcessRereadRef",
          "backupUnchanged",
        ],
        path,
        errors,
      );
      const checkedAt = timestamp(row.checkedAt, `${path}.checkedAt`, errors);
      text(row.runtimeVersion, `${path}.runtimeVersion`, errors);
      text(row.candidateReleaseHash, `${path}.candidateReleaseHash`, errors);
      if (
        row.runtimeVersion &&
        restart.runtimeVersion &&
        row.runtimeVersion.trim() !== restart.runtimeVersion.trim()
      )
        errors.push(
          `${path}.runtimeVersion: must match restart.runtimeVersion`,
        );
      if (
        row.candidateReleaseHash &&
        restart.candidateReleaseHash &&
        row.candidateReleaseHash.trim() !== restart.candidateReleaseHash.trim()
      )
        errors.push(
          `${path}.candidateReleaseHash: must match restart.candidateReleaseHash`,
        );
      if (
        preservationDecisionAt &&
        checkedAt &&
        Date.parse(checkedAt) < Date.parse(preservationDecisionAt)
      )
        errors.push(
          `${path}.checkedAt: must be at or after preservation acceptance`,
        );
      if (
        drainDecisionAt &&
        checkedAt &&
        Date.parse(checkedAt) < Date.parse(drainDecisionAt)
      )
        errors.push(`${path}.checkedAt: must be at or after drain acceptance`);
      if (
        restartDecisionAt &&
        checkedAt &&
        Date.parse(restartDecisionAt) < Date.parse(checkedAt)
      )
        errors.push("restart.decisionAt: must be at or after every root check");
      for (const field of [
        "lockLayout",
        "firstWriterReadRef",
        "reversibleWriteRef",
        "freshProcessRereadRef",
      ])
        (field === "lockLayout" ? text : evidenceRef)(
          row[field],
          `${path}.${field}`,
          errors,
        );
      yes(row.backupUnchanged, `${path}.backupUnchanged`, errors);
    },
  );

  const rollbackRehearsalAt = timestamp(
    rollback.rehearsalAt,
    "rollback.rehearsalAt",
    errors,
  );
  const rollbackDecisionAt = timestamp(
    rollback.decisionAt,
    "rollback.decisionAt",
    errors,
  );
  const rollbackApprovalAt = timestamp(
    rollback.approvalAt,
    "rollback.approvalAt",
    errors,
  );
  const cutoverAt = timestamp(rollback.cutoverAt, "rollback.cutoverAt", errors);
  if (
    rollbackRehearsalAt &&
    rollbackApprovalAt &&
    Date.parse(rollbackApprovalAt) < Date.parse(rollbackRehearsalAt)
  )
    errors.push("rollback.approvalAt: must be at or after rollback rehearsal");
  if (
    rollbackApprovalAt &&
    cutoverAt &&
    Date.parse(rollbackApprovalAt) > Date.parse(cutoverAt)
  )
    errors.push("rollback.approvalAt: must be at or before planned cutover");
  if (
    rollbackApprovalAt &&
    rollbackDecisionAt &&
    Date.parse(rollbackDecisionAt) < Date.parse(rollbackApprovalAt)
  )
    errors.push("rollback.decisionAt: must be at or after rollback approval");
  for (const [name, decisionAt] of [
    ["inventory", inventoryDecisionAt],
    ["fence", fenceDecisionAt],
    ["drain", drainDecisionAt],
    ["preservation", preservationDecisionAt],
    ["restart", restartDecisionAt],
    ["rollback", rollbackDecisionAt],
  ])
    if (
      cutoverAt &&
      decisionAt &&
      Date.parse(decisionAt) > Date.parse(cutoverAt)
    )
      errors.push(`${name}.decisionAt: must be at or before planned cutover`);
  if (
    drainDecisionAt &&
    rollbackRehearsalAt &&
    Date.parse(rollbackRehearsalAt) < Date.parse(drainDecisionAt)
  )
    errors.push("rollback.rehearsalAt: must be at or after drain acceptance");
  if (
    restartDecisionAt &&
    rollbackRehearsalAt &&
    Date.parse(rollbackRehearsalAt) < Date.parse(restartDecisionAt)
  )
    errors.push("rollback.rehearsalAt: must be at or after restart acceptance");
  if (
    activatedAt &&
    rollbackRehearsalAt &&
    Date.parse(rollbackRehearsalAt) < Date.parse(activatedAt)
  )
    errors.push("rollback.rehearsalAt: must be at or after fence activation");
  if (
    rollbackDecisionAt &&
    rollbackRehearsalAt &&
    Date.parse(rollbackDecisionAt) < Date.parse(rollbackRehearsalAt)
  )
    errors.push("rollback.decisionAt: must be at or after rollback rehearsal");
  yes(
    rollback.fenceRetainedDuringRehearsal,
    "rollback.fenceRetainedDuringRehearsal",
    errors,
  );
  evidenceRef(rollback.fenceRetentionRef, "rollback.fenceRetentionRef", errors);
  yes(rollback.failedStatePreserved, "rollback.failedStatePreserved", errors);
  const rollbackFenceAt = timestamp(
    rollback.rollbackFenceAt,
    "rollback.rollbackFenceAt",
    errors,
  );
  const rollbackDrainAt = timestamp(
    rollback.rollbackDrainAt,
    "rollback.rollbackDrainAt",
    errors,
  );
  const failedStatePreservedAt = timestamp(
    rollback.failedStatePreservedAt,
    "rollback.failedStatePreservedAt",
    errors,
  );
  evidenceRef(rollback.failedStateRef, "rollback.failedStateRef", errors);
  if (
    rollbackFenceAt &&
    rollbackDrainAt &&
    Date.parse(rollbackDrainAt) < Date.parse(rollbackFenceAt)
  )
    errors.push("rollback.rollbackDrainAt: must be at or after rollback fence");
  if (
    rollbackDrainAt &&
    failedStatePreservedAt &&
    Date.parse(failedStatePreservedAt) < Date.parse(rollbackDrainAt)
  )
    errors.push(
      "rollback.failedStatePreservedAt: must be at or after rollback drain",
    );
  if (
    rollbackRehearsalAt &&
    failedStatePreservedAt &&
    Date.parse(failedStatePreservedAt) > Date.parse(rollbackRehearsalAt)
  )
    errors.push(
      "rollback.failedStatePreservedAt: must be at or before rollback rehearsal",
    );
  for (const field of [
    "separateApprovalRef",
    "trigger",
    "lockRepresentation",
    "priorRelease",
    "priorRuntime",
    "fenceRef",
    "drainRef",
    "restoreProcedureRef",
    "encryptedStateRestorePointRef",
    "rehearsalRef",
    "restartRef",
    "integrityRef",
  ])
    (field === "trigger" ||
      field === "lockRepresentation" ||
      field === "priorRelease" ||
      field === "priorRuntime"
      ? text
      : evidenceRef)(rollback[field], `rollback.${field}`, errors);
  if (
    rollback.priorRuntime &&
    restart.runtimeVersion &&
    rollback.priorRuntime.trim() === restart.runtimeVersion.trim()
  )
    errors.push("rollback.priorRuntime: must differ from candidate runtime");
  text(rollback.candidateReleaseHash, "rollback.candidateReleaseHash", errors);
  if (
    rollback.candidateReleaseHash &&
    restart.candidateReleaseHash &&
    rollback.candidateReleaseHash.trim() !== restart.candidateReleaseHash.trim()
  )
    errors.push(
      "rollback.candidateReleaseHash: must match restart.candidateReleaseHash",
    );
  if (
    rollback.priorRelease &&
    restart.candidateReleaseHash &&
    rollback.priorRelease.trim() === restart.candidateReleaseHash.trim()
  )
    errors.push(
      "rollback.priorRelease: must differ from candidate release hash",
    );
  if (
    rollback.owner?.trim() &&
    restart.owner?.trim() &&
    rollback.owner.trim() === restart.owner.trim()
  )
    errors.push("rollback.owner: must differ from release operator");
  if (
    rollback.independentVerifier?.trim() &&
    restart.owner?.trim() &&
    rollback.independentVerifier.trim() === restart.owner.trim()
  )
    errors.push(
      "rollback.independentVerifier: must differ from release operator",
    );
  if (
    rollback.separateApprovalRef &&
    rollback.recordRef &&
    rollback.separateApprovalRef.trim() === rollback.recordRef.trim()
  )
    errors.push(
      "rollback.separateApprovalRef: must be distinct from the maintenance change record",
    );

  const rollbackRows = Array.isArray(rollback.rootResults)
    ? rollback.rootResults.map((row, index) =>
        object(row, `rollback.rootResults[${index}]`, errors),
      )
    : [];
  if (!Array.isArray(rollback.rootResults))
    errors.push("rollback.rootResults: must be an array");
  if (
    rollbackDrainAt &&
    rollbackRows.some(
      (row) =>
        row.writersDrainedAt &&
        Date.parse(row.writersDrainedAt) < Date.parse(rollbackDrainAt),
    )
  )
    errors.push(
      "rollback.rootResults: every writer drain must be at or after rollback drain",
    );
  if (
    rollbackApprovalAt &&
    rollbackRows.some(
      (row) =>
        row.checkedAt &&
        Date.parse(rollbackApprovalAt) < Date.parse(row.checkedAt),
    )
  )
    errors.push("rollback.approvalAt: must be at or after every root check");
  coverage(
    rollbackRows,
    "rootId",
    rootIds,
    "rollback.rootResults",
    errors,
    (row, path) => {
      knownFields(
        row,
        [
          "rootId",
          "checkedAt",
          "restoredReleaseHash",
          "runtimeVersion",
          "integrityRef",
          "encryptedStateRestorePointRef",
          "staleReaperBarrierAt",
          "legacyWritersAbsent",
          "admittedWritersDrained",
          "writersDrainedAt",
          "lockCompatibleWithPriorRuntime",
          "lockCompatibilityRef",
          "lockCompatibilityCheckedAt",
        ],
        path,
        errors,
      );
      const checkedAt = timestamp(row.checkedAt, `${path}.checkedAt`, errors);
      const staleReaperBarrierAt = timestamp(
        row.staleReaperBarrierAt,
        `${path}.staleReaperBarrierAt`,
        errors,
      );
      const writersDrainedAt = timestamp(
        row.writersDrainedAt,
        `${path}.writersDrainedAt`,
        errors,
      );
      yes(row.admittedWritersDrained, `${path}.admittedWritersDrained`, errors);
      text(row.restoredReleaseHash, `${path}.restoredReleaseHash`, errors);
      yes(row.legacyWritersAbsent, `${path}.legacyWritersAbsent`, errors);
      if (
        rollbackDrainAt &&
        writersDrainedAt &&
        Date.parse(writersDrainedAt) < Date.parse(rollbackDrainAt)
      )
        errors.push(
          `${path}.writersDrainedAt: must be at or after rollback drain`,
        );
      if (
        writersDrainedAt &&
        staleReaperBarrierAt &&
        Date.parse(staleReaperBarrierAt) < Date.parse(writersDrainedAt)
      )
        errors.push(
          `${path}.staleReaperBarrierAt: must be at or after writer drain`,
        );
      if (
        rollbackDrainAt &&
        staleReaperBarrierAt &&
        Date.parse(staleReaperBarrierAt) < Date.parse(rollbackDrainAt)
      )
        errors.push(
          `${path}.staleReaperBarrierAt: must be at or after rollback drain`,
        );
      if (
        checkedAt &&
        staleReaperBarrierAt &&
        Date.parse(staleReaperBarrierAt) > Date.parse(checkedAt)
      )
        errors.push(
          `${path}.staleReaperBarrierAt: must be at or before root restore check`,
        );
      text(row.runtimeVersion, `${path}.runtimeVersion`, errors);
      yes(
        row.lockCompatibleWithPriorRuntime,
        `${path}.lockCompatibleWithPriorRuntime`,
        errors,
      );
      const lockCompatibilityCheckedAt = timestamp(
        row.lockCompatibilityCheckedAt,
        `${path}.lockCompatibilityCheckedAt`,
        errors,
      );
      if (
        staleReaperBarrierAt &&
        lockCompatibilityCheckedAt &&
        Date.parse(lockCompatibilityCheckedAt) <
          Date.parse(staleReaperBarrierAt)
      )
        errors.push(
          `${path}.lockCompatibilityCheckedAt: must be at or after stale-reaper barrier`,
        );
      if (
        checkedAt &&
        lockCompatibilityCheckedAt &&
        Date.parse(lockCompatibilityCheckedAt) > Date.parse(checkedAt)
      )
        errors.push(
          `${path}.lockCompatibilityCheckedAt: must be at or before root restore check`,
        );
      evidenceRef(
        row.lockCompatibilityRef,
        `${path}.lockCompatibilityRef`,
        errors,
      );
      evidenceRef(
        row.encryptedStateRestorePointRef,
        `${path}.encryptedStateRestorePointRef`,
        errors,
      );
      evidenceRef(row.integrityRef, `${path}.integrityRef`, errors);
      if (
        rollbackRehearsalAt &&
        checkedAt &&
        Date.parse(checkedAt) < Date.parse(rollbackRehearsalAt)
      )
        errors.push(
          `${path}.checkedAt: must be at or after rollback rehearsal`,
        );
      if (
        rollbackDecisionAt &&
        checkedAt &&
        Date.parse(rollbackDecisionAt) < Date.parse(checkedAt)
      )
        errors.push(
          "rollback.decisionAt: must be at or after every root check",
        );
      if (
        rollback.priorRelease &&
        row.restoredReleaseHash &&
        row.restoredReleaseHash.trim() !== rollback.priorRelease.trim()
      )
        errors.push(
          `${path}.restoredReleaseHash: must match rollback.priorRelease`,
        );
      if (
        rollback.priorRuntime &&
        row.runtimeVersion &&
        row.runtimeVersion.trim() !== rollback.priorRuntime.trim()
      )
        errors.push(`${path}.runtimeVersion: must match rollback.priorRuntime`);
    },
  );

  return errors;
}

if (process.argv.length !== 3) {
  console.error(`${usage}
${caution}`);
  process.exit(2);
}

let register;
try {
  register = JSON.parse(readFileSync(process.argv[2], "utf8"));
} catch {
  console.error(
    "Evidence register could not be read as JSON. No evidence values were printed.",
  );
  process.exit(2);
}

const shapeErrors = [];
const value = object(register, "evidence", shapeErrors);
if (shapeErrors.length) {
  console.log("NO GO: evidence register is incomplete or inconsistent.");
  for (const error of shapeErrors) console.log(error);
  console.log(caution);
  process.exit(1);
}
const errors = validate(value);
if (errors.length) {
  console.log("NO GO: evidence register is incomplete or inconsistent.");
  for (const error of errors) console.log(error);
  console.log(caution);
  process.exit(1);
}

console.log("Evidence register is complete for independent review only.");
console.log(caution);
