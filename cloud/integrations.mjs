import { read, write, transaction, encrypt, decrypt } from "./store.mjs";
import { assertOwner } from "./owner.mjs";
import { openOwnerState, sealOwnerState } from "./oauth-state.mjs";
import { catalog } from "./mcp.mjs";
import { vercelCatalog } from "./vercel-integration.mjs";
import {
  PROVIDERS,
  authorization,
  exchange,
  hash,
  validateCallback,
  providerDefinition,
} from "./oauth.mjs";
const prefix = "integration:";
const providerCatalog = (id, config) =>
  id === "vercel" ? vercelCatalog(config) : catalog(config);
const callbackBase = () =>
  (process.env.VOID_PUBLIC_ORIGIN || "https://void-tui.vercel.app") +
  "/api/integrations";
const epoch = () => hash(process.env.VOID_CONTROL_TOKEN || "");
const cookieName = (id) => `__Host-void-oauth-${id}`;
const cookie = (id, value, age) =>
  `${cookieName(id)}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${age}`;
function binding(req, id) {
  return req.headers.cookie
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(cookieName(id) + "="))
    ?.slice(cookieName(id).length + 1);
}
async function clientFor(owner, id, c) {
  const stored = await read(owner, prefix + "client:" + id, c);
  return stored ? decrypt(stored) : undefined;
}
export async function integrationStatus(owner) {
  assertOwner(owner);
  return {
    supported: true,
    callbackBase: callbackBase(),
    integrations: await Promise.all(
      Object.entries(PROVIDERS).map(async ([id, spec]) => {
        const client = await clientFor(owner, id),
          record = await read(owner, prefix + id),
          value = record ? decrypt(record) : null;
        return {
          id,
          name: spec.name,
          description: spec.description,
          configured: !!client,
          connected: !!value?.tokens,
          status: value?.status ?? (client ? "disconnected" : "setup_required"),
          toolCount: value?.tools?.length ?? 0,
          tools: (value?.tools ?? []).map((t) => t.name),
          connectedAt: value?.connectedAt,
          scopes: value?.tokens?.scope?.split(" ") ?? [],
          undo: false,
        };
      }),
    ),
  };
}
export async function integrationConfig(owner, id) {
  assertOwner(owner);
  providerDefinition(id);
  return transaction(owner, prefix + id, async (c) => {
    const stored = await read(owner, prefix + id, c),
      value = stored ? decrypt(stored) : null;
    if (!value?.tokens)
      throw Object.assign(
        new Error(
          "Integration disconnected. Reconnect in Tools and connections.",
        ),
        { status: 409 },
      );
    if (value.tokens.expiresAt && value.tokens.expiresAt < Date.now() + 60000) {
      if (!value.tokens.refresh_token)
        throw Object.assign(new Error("Integration expired. Reconnect."), {
          status: 401,
        });
      const refreshed = await exchange(id, await clientFor(owner, id, c), {
        grant_type: "refresh_token",
        refresh_token: value.tokens.refresh_token,
      });
      value.tokens = {
        ...refreshed,
        refresh_token: refreshed.refresh_token ?? value.tokens.refresh_token,
      };
      await write(owner, prefix + id, encrypt(value), c);
    }
    return {
      url: PROVIDERS[id].url,
      token: value.tokens.access_token,
      teamId: value.tokens.teamId,
    };
  });
}
export async function integrationCatalogs(owner) {
  assertOwner(owner);
  const result = [];
  for (const id of Object.keys(PROVIDERS)) {
    const stored = await read(owner, prefix + id);
    if (!stored || !decrypt(stored)?.tokens) continue;
    const data = await providerCatalog(id, await integrationConfig(owner, id));
    result.push({
      id: "oauth-" + id,
      provider: id,
      config: encrypt({ oauthProvider: id, url: PROVIDERS[id].url }),
      sessionId: data.sessionId,
      tools: data.tools.map((t) => ({
        ...t,
        description: `[${PROVIDERS[id].name}] ${t.description ?? t.name}`,
        connectorId: "oauth-" + id,
      })),
    });
  }
  return result;
}
export async function resolveIntegration(owner, config) {
  assertOwner(owner);
  return config.oauthProvider
    ? { ...config, ...(await integrationConfig(owner, config.oauthProvider)) }
    : config;
}
export function mountIntegrationCallback(app) {
  // Cross-site OAuth redirects cannot carry the Strict workspace cookie. Only this
  // GET callback bypasses it; single-use state + Lax browser binding + PKCE replace it.
  app.get("/api/integrations/:id/callback", async (req, res) => {
    res.set({ "cache-control": "no-store", "referrer-policy": "no-referrer" });
    const { id } = req.params;
    try {
      providerDefinition(id);
      // The owner arrives sealed inside the state, minted behind the session
      // gate when the flow started. A state this deployment did not seal names
      // no owner, and the flow fails rather than falling back to a namespace.
      const opened = openOwnerState(req.query.state);
      if (!opened) throw new Error("Invalid state.");
      const owner = opened.owner;
      const pending = await transaction(
        owner,
        "oauth:" + hash(opened.nonce),
        async (c) => {
          const key = "oauth:" + hash(opened.nonce),
            stored = await read(owner, key, c),
            pending = stored ? decrypt(stored) : null;
          validateCallback(pending, id, binding(req, id), epoch());
          await write(owner, key, encrypt({ ...pending, used: true }), c);
          return pending;
        },
      );
      res.setHeader("set-cookie", cookie(id, "", 0));
      if (req.query.error) return res.redirect("/connections?oauth=denied");
      if (typeof req.query.code !== "string" || req.query.code.length > 4096)
        throw new Error("Invalid code.");
      const client = await clientFor(owner, id);
      if (!client || pending.clientHash !== hash(JSON.stringify(client)))
        throw new Error("OAuth registration changed. Start again.");
      if (
        ((await read(owner, prefix + "version:" + id)) ?? 0) !==
        pending.connectionVersion
      )
        throw new Error("OAuth connection was disconnected. Start again.");
      const tokens = await exchange(id, client, {
        grant_type: "authorization_code",
        code: req.query.code,
        code_verifier: pending.verifier,
        redirect_uri: pending.callback,
      });
      const tools = await providerCatalog(id, {
        url: PROVIDERS[id].url,
        token: tokens.access_token,
        teamId: tokens.teamId,
      });
      await transaction(owner, prefix + id, async (c) => {
        if (
          ((await read(owner, prefix + "version:" + id, c)) ?? 0) !==
          pending.connectionVersion
        )
          throw new Error("Connection changed. Start again.");
        await write(
          owner,
          prefix + id,
          encrypt({
            tokens,
            tools: tools.tools,
            status: "connected",
            connectedAt: new Date().toISOString(),
          }),
          c,
        );
      });
      return res.redirect("/connections?oauth=connected");
    } catch {
      return res.redirect("/connections?oauth=failed");
    }
  });
}
export function mountIntegrationRoutes(app) {
  app.get("/api/integrations", async (req, res) =>
    res.json(await integrationStatus(req.owner)),
  );
  app.post("/api/integrations/:id/client", async (req, res) => {
    const { id } = req.params;
    providerDefinition(id);
    const { clientId, clientSecret, integrationSlug } = req.body ?? {};
    if (
      id === "vercel" &&
      (typeof integrationSlug !== "string" ||
        !/^[a-z0-9-]{1,80}$/.test(integrationSlug))
    )
      return res
        .status(400)
        .json({ message: "Enter the Vercel connectable integration slug." });
    if (
      typeof clientId !== "string" ||
      !clientId.trim() ||
      clientId.length > 512 ||
      typeof clientSecret !== "string" ||
      !clientSecret.trim() ||
      clientSecret.length > 2048
    )
      return res
        .status(400)
        .json({ message: "Enter the registered OAuth client ID and secret." });
    // Changing client registration invalidates previous grants.
    await transaction(req.owner, prefix + id, async (c) => {
      await write(
        req.owner,
        prefix + "client:" + id,
        encrypt({
          client_id: clientId.trim(),
          client_secret: clientSecret.trim(),
          ...(id === "vercel" ? { integration_slug: integrationSlug } : {}),
        }),
        c,
      );
      await write(req.owner, prefix + id, null, c);
      await write(req.owner, prefix + "version:" + id, Date.now(), c);
    });
    res.json({ ok: true });
  });
  app.post("/api/integrations/:id/start", async (req, res) => {
    const { id } = req.params;
    providerDefinition(id);
    const flow = await transaction(req.owner, prefix + id, async (c) => {
      const client = await clientFor(req.owner, id, c);
      if (!client)
        throw Object.assign(new Error("Register the OAuth app first."), {
          status: 409,
        });
      const flow = authorization(
        id,
        client,
        callbackBase() + "/" + id + "/callback",
      );
      await write(
        req.owner,
        "oauth:" + hash(flow.state),
        encrypt({
          provider: id,
          verifier: flow.verifier,
          callback: flow.callback,
          expiresAt: flow.expiresAt,
          bindingHash: hash(flow.binding),
          epoch: epoch(),
          clientHash: hash(JSON.stringify(client)),
          connectionVersion:
            (await read(req.owner, prefix + "version:" + id, c)) ?? 0,
        }),
        c,
      );
      return sealOwnerState(req.owner, flow);
    });
    res.setHeader("set-cookie", cookie(id, flow.binding, 600));
    res.json({ url: flow.url });
  });
  app.post("/api/integrations/:id/refresh", async (req, res) => {
    const { id } = req.params;
    providerDefinition(id);
    const data = await providerCatalog(id, await integrationConfig(req.owner, id));
    await transaction(req.owner, prefix + id, async (c) => {
      const stored = await read(req.owner, prefix + id, c);
      if (!stored) throw new Error("Disconnected.");
      const value = decrypt(stored);
      if (!value?.tokens) throw new Error("Disconnected.");
      await write(
        req.owner,
        prefix + id,
        encrypt({ ...value, tools: data.tools, status: "connected" }),
        c,
      );
    });
    res.json({ ok: true, toolCount: data.tools.length });
  });
  app.delete("/api/integrations/:id", async (req, res) => {
    const { id } = req.params;
    providerDefinition(id);
    await transaction(req.owner, prefix + id, async (c) => {
      await write(req.owner, prefix + id, null, c);
      await write(req.owner, prefix + "version:" + id, Date.now(), c);
    });
    res.json({ ok: true });
  });
}
