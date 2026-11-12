import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const generator = join(root, "scripts/generate-provider-manifest.mjs");

test("manifest generator preserves Kimi Code and Prime Kimi Coding auth contracts", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nomo-provider-manifest-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const omp = join(directory, "omp");
  const prime = join(directory, "prime");
  const output = join(directory, "provider-manifest.json");
  const write = (base, path, value) => {
    const file = join(base, path);
    mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    writeFileSync(file, value);
  };

  write(
    omp,
    "packages/coding-agent/package.json",
    JSON.stringify({ version: "18.6.2" }),
  );
  write(
    omp,
    "packages/catalog/src/compat/provider-ids.ts",
    'export type ProviderId =\n  | "kimi-code";\n',
  );
  write(
    omp,
    "packages/catalog/src/types.ts",
    'export type KnownApi =\n  | "openai-completions";\nexport type Api = string;\n',
  );
  const models = Object.fromEntries(
    [
      "k3",
      "k3-256k",
      "kimi-for-coding",
      "kimi-for-coding-highspeed",
      "kimi-k2",
      "kimi-k2-turbo-preview",
      "kimi-k2.5",
    ].map((id) => [
      id,
      {
        id,
        name: id,
        api: "openai-completions",
        baseUrl: "https://api.kimi.com/coding/v1",
      },
    ]),
  );
  write(
    omp,
    "packages/catalog/src/models.json",
    JSON.stringify({ "kimi-code": models }),
  );
  write(
    omp,
    "packages/catalog/src/compat/rules.json",
    JSON.stringify({
      providers: {
        "kimi-code": {
          defaultModel: "kimi-for-coding",
          discovery: { label: "Kimi Code", envVars: ["KIMI_API_KEY"] },
        },
      },
      auth: {
        providers: [
          {
            id: "kimi-code",
            login: { kind: "device-code" },
            env: { vars: ["KIMI_API_KEY"] },
          },
        ],
      },
    }),
  );
  write(prime, "Cargo.toml", '[workspace.package]\nversion = "0.10.1"\n');
  write(
    prime,
    "crates/pa-types/src/ai/mod.rs",
    "pub enum KnownApi {\n    AnthropicMessages,\n}\n",
  );
  write(
    prime,
    "crates/pa-ai/src/models_generated.rs",
    `pub const RAW_MODELS: &[RawModel] = &[
  RawModel {
    provider: "kimi-coding",
    id: "k3",
    name: "Kimi K3",
    api: "anthropic-messages",
    base_url: "https://api.kimi.com/coding",
    input: &[ModelInput::Text, ModelInput::Image],
    reasoning: true,
    context_window: 1_048_576,
    max_tokens: 131_072,
    },
  RawModel {
    provider: "alias-one",
    id: "model-one",
    name: "One",
    api: "anthropic-messages",
    base_url: "",
    },
  RawModel {
    provider: "alias-middle",
    id: "model-middle",
    name: "Middle",
    api: "anthropic-messages",
    base_url: "",
    },
  RawModel {
    provider: "alias-last",
    id: "model-last",
    name: "Last",
    api: "anthropic-messages",
    base_url: "",
    },
  RawModel {
    provider: "alias-fourth",
    id: "model-fourth",
    name: "Fourth",
    api: "anthropic-messages",
    base_url: "",
    },
  RawModel {
    provider: "alias-trailing",
    id: "model-trailing",
    name: "Trailing",
    api: "anthropic-messages",
    base_url: "",
    },
  RawModel {
    provider: "alias-trailing-two",
    id: "model-trailing-two",
    name: "Trailing Two",
    api: "anthropic-messages",
    base_url: "",
    },
  RawModel {
    provider: "alias-solo",
    id: "model-solo",
    name: "Solo",
    api: "anthropic-messages",
    base_url: "",
    },
  RawModel {
    provider: "alias-many",
    id: "model-many",
    name: "Many",
    api: "anthropic-messages",
    base_url: "",
    },
];
`,
  );
  write(
    prime,
    "crates/pa-ai/src/env_api_keys.rs",
    '"kimi-coding" => Some(vec!["KIMI_API_KEY"]),\n"alias-one"\n    | "alias-middle"\n    | "alias-last"\n    | "alias-fourth" => "SHARED_API_KEY",\n"alias-trailing" | "alias-trailing-two" => "TRAILING_KEY",\n"alias-solo" => "SOLO_KEY",\n"alias-many" => Some(vec!["FIRST_KEY", "SECOND_KEY"]),\n',
  );

  const result = spawnSync(process.execPath, [generator, omp, prime, output], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const firstOutput = readFileSync(output, "utf8");
  const secondRun = spawnSync(
    process.execPath,
    [generator, omp, prime, output],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(secondRun.status, 0, secondRun.stderr || secondRun.stdout);
  assert.equal(readFileSync(output, "utf8"), firstOutput);
  const manifest = JSON.parse(firstOutput);
  const kimiCode = manifest.providers.find(
    (row) => row.source === "omp" && row.providerId === "kimi-code",
  );
  assert.ok(kimiCode);
  assert.deepEqual(kimiCode.authentication.methods, ["device-code", "api-key"]);
  assert.deepEqual(kimiCode.authentication.envVars, ["KIMI_API_KEY"]);
  assert.equal(kimiCode.models.length, 7);
  assert.ok(
    kimiCode.models.every(
      (row) => row.endpoint === "https://api.kimi.com/coding/v1",
    ),
  );
  const kimiCoding = manifest.providers.find(
    (row) => row.source === "prime" && row.providerId === "kimi-coding",
  );
  assert.ok(kimiCoding);
  assert.deepEqual(kimiCoding.authentication.envVars, ["KIMI_API_KEY"]);
  assert.equal(kimiCoding.models[0].transport, "anthropic-messages");
  for (const providerId of [
    "alias-one",
    "alias-middle",
    "alias-last",
    "alias-fourth",
  ]) {
    const provider = manifest.providers.find(
      (row) => row.source === "prime" && row.providerId === providerId,
    );
    assert.ok(provider, providerId);
    assert.deepEqual(
      provider.authentication.envVars,
      ["SHARED_API_KEY"],
      providerId,
    );
  }
  for (const [providerId, envVar] of [
    ["alias-trailing", "TRAILING_KEY"],
    ["alias-trailing-two", "TRAILING_KEY"],
    ["alias-solo", "SOLO_KEY"],
  ]) {
    const provider = manifest.providers.find(
      (row) => row.source === "prime" && row.providerId === providerId,
    );
    assert.ok(provider, providerId);
    assert.deepEqual(provider.authentication.envVars, [envVar], providerId);
  }
  const aliasMany = manifest.providers.find(
    (row) => row.source === "prime" && row.providerId === "alias-many",
  );
  assert.ok(aliasMany);
  assert.deepEqual(aliasMany.authentication.envVars, [
    "FIRST_KEY",
    "SECOND_KEY",
  ]);
});
