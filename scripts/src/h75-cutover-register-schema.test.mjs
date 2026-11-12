import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const schemaPath = fileURLToPath(
  new URL("./h75-cutover-register.schema.json", import.meta.url),
);
const preflightPath = fileURLToPath(
  new URL("./h75-cutover-preflight.mjs", import.meta.url),
);
const fixturePath = fileURLToPath(
  new URL("./h75-cutover-preflight.test.mjs", import.meta.url),
);
const templatePath = fileURLToPath(
  new URL("./h75-cutover-register.template.json", import.meta.url),
);
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const preflight = readFileSync(preflightPath, "utf8");
const fixture = readFileSync(fixturePath, "utf8");
const template = JSON.parse(readFileSync(templatePath, "utf8"));
const expectedGates = [
  "inventory",
  "fence",
  "drain",
  "preservation",
  "restart",
  "rollback",
];

test("preflight rejects the checked-in blank template", () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./h75-cutover-preflight.mjs", import.meta.url)),
      templatePath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /NO GO: evidence register is incomplete or inconsistent/,
  );
  assert.match(result.stdout, /inventory\.roots: must be a non-empty array/);
  assert.match(result.stdout, /fence\.decision: must be accepted/);
  assert.match(result.stdout, /rollback\.separateApprovalRef: required/);
  assert.match(
    result.stdout,
    /does not verify referenced evidence or authorize cutover/,
  );
});

test("blank template keys match the schema contract and remain fail closed", () => {
  assert.deepEqual(Object.keys(template).sort(), [...schema.required].sort());
  for (const gate of expectedGates) {
    const reference = schema.properties[gate].$ref.split("/").at(-1);
    const gateSchema = schema.$defs[reference];
    const gateProperties = {
      ...schema.$defs.gate.properties,
      ...gateSchema.allOf[1].properties,
    };
    assert.deepEqual(
      Object.keys(template[gate]).sort(),
      Object.keys(gateProperties).sort(),
      gate,
    );
    assert.deepEqual(
      Object.keys(template[gate]).sort(),
      [
        ...new Set([
          ...schema.$defs.gate.required,
          ...gateSchema.allOf[1].required,
        ]),
      ].sort(),
      `${gate} required fields`,
    );
  }
  assert.equal(template.inventory.roots.length, 0);
  assert.equal(template.inventory.entrypoints.length, 0);
  assert.equal(template.fence.entrypointResults.length, 0);
  assert.equal(template.drain.rootResults.length, 0);
  assert.equal(template.preservation.rootResults.length, 0);
  assert.equal(template.restart.rootResults.length, 0);
  assert.equal(template.drain.graceIntervalMs, 0);
  for (const gate of expectedGates.slice(1)) {
    assert.equal(template[gate].decision, "");
    assert.equal(template[gate].owner, "");
    assert.equal(template[gate].independentVerifier, "");
    assert.equal(template[gate].recordRef, "");
  }
});

test("schema parses and declares the draft 2020-12 contract", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
});

test("schema requires exactly the six cutover gates and schema version 1", () => {
  assert.deepEqual(schema.required, ["schemaVersion", ...expectedGates]);
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.deepEqual(
    Object.keys(schema.properties).filter((name) => name !== "schemaVersion"),
    expectedGates,
  );
  assert.equal(schema.additionalProperties, false);
});

test("schema gate names match the preflight and fixture gate lists", () => {
  const preflightGateBlock = preflight.match(
    /const GATE_FIELDS = \{([\s\S]*?)^\};/m,
  )?.[1];
  assert.ok(preflightGateBlock, "preflight gate list exists");
  const preflightGates = [...preflightGateBlock.matchAll(/^  (\w+): \[/gm)].map(
    ([, name]) => name,
  );
  assert.deepEqual(preflightGates, expectedGates);

  const manifestStart = fixture.indexOf("function manifest() {");
  const fixtureStart = fixture.indexOf("return {", manifestStart);
  const fixtureEnd = fixture.indexOf("\n  };", fixtureStart);
  assert.notEqual(manifestStart, -1);
  assert.notEqual(fixtureStart, -1);
  assert.notEqual(fixtureEnd, -1);
  const fixtureBody = fixture.slice(fixtureStart, fixtureEnd);
  const fixtureGates = [...fixtureBody.matchAll(/^    (\w+): \{/gm)]
    .map(([, name]) => name)
    .filter((name) => name !== "schemaVersion");
  assert.deepEqual(fixtureGates, expectedGates);

  assert.deepEqual(
    Object.keys(schema.properties).filter((name) => name !== "schemaVersion"),
    preflightGates,
  );
  assert.deepEqual(
    Object.keys(schema.properties).filter((name) => name !== "schemaVersion"),
    fixtureGates,
  );
});

test("schema gate properties match preflight gate allowlists", () => {
  const gateBlock = preflight.match(
    /const GATE_FIELDS = (\{[\s\S]*?^\});/m,
  )?.[1];
  assert.ok(gateBlock, "preflight gate allowlists exist");
  const gateFields = Object.fromEntries(
    [...gateBlock.matchAll(/^  (\w+): \[([\s\S]*?)^  \],/gm)].map(
      ([, name, fields]) => [
        name,
        [...fields.matchAll(/"([^"]+)"/g)].map(([, field]) => field),
      ],
    ),
  );
  for (const [name, fields] of Object.entries(gateFields)) {
    const schemaFields = [
      ...Object.keys(schema.$defs.gate.properties),
      ...Object.keys(schema.$defs[name].allOf[1].properties),
    ];
    assert.deepEqual([...schemaFields].sort(), [...fields].sort(), name);
  }
});

test("schema row properties match preflight row allowlists", () => {
  const validator = readFileSync(preflightPath, "utf8");
  const rowDefinitions = [
    "fenceResult",
    "fenceRootResult",
    "drainResult",
    "preservationResult",
    "restartResult",
    "rollbackResult",
  ];
  const rowAllowlistCalls = [
    ...validator.matchAll(
      /knownFields\(\s*row,\s*\[([\s\S]*?)\],\s*path,\s*errors,?\s*\)/g,
    ),
  ];
  assert.equal(rowAllowlistCalls.length, rowDefinitions.length);
  const inventoryDefinitions = ["root", "entrypoint"];
  const inventoryAllowlistCalls = [
    ...validator.matchAll(
      /knownFields\(\s*(roots\[index\]|entrypoint),\s*\[([\s\S]*?)\],\s*`inventory\.(?:roots|entrypoints)\[\$\{index\}\]`,\s*errors,/g,
    ),
  ];
  assert.equal(inventoryAllowlistCalls.length, inventoryDefinitions.length);
  for (const [index, definition] of inventoryDefinitions.entries()) {
    const fields = [
      ...inventoryAllowlistCalls[index][2].matchAll(/"([^"]+)"/g),
    ].map(([, field]) => field);
    const rowSchema = schema.$defs[definition];
    assert.equal(rowSchema.additionalProperties, false, definition);
    assert.deepEqual(
      Object.keys(rowSchema.properties).sort(),
      fields.sort(),
      definition,
    );
  }
  for (const [index, definition] of rowDefinitions.entries()) {
    const fields = [...rowAllowlistCalls[index][1].matchAll(/"([^"]+)"/g)].map(
      ([, field]) => field,
    );
    const rowSchema = schema.$defs[definition];
    assert.equal(rowSchema.additionalProperties, false, definition);
    assert.deepEqual(
      Object.keys(rowSchema.properties).sort(),
      fields.sort(),
      definition,
    );
  }
});

test("schema evidence reference pattern excludes empty authorities and file URIs", () => {
  assert.ok(schema.$defs.evidenceRef.pattern.includes("[^/\\s][^\\s]*"));
  assert.ok(schema.$defs.evidenceRef.pattern.includes("(?![fF][iI][lL][eE]:)"));
  assert.ok(preflight.includes("[^/\\s][^\\s]*"));
});

test("schema closes inventory row properties", () => {
  assert.equal(schema.$defs.root.additionalProperties, false);
  assert.equal(schema.$defs.entrypoint.additionalProperties, false);
});

test("schema disclaimer does not treat shape validation as evidence or approval", () => {
  assert.match(schema.description, /does not verify referenced evidence/i);
  assert.match(schema.description, /establish evidence truth/i);
  assert.match(schema.description, /authorize a cutover/i);
});
