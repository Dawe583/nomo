// Test-only preload. Never imported by the production application.
export function validateCloudTestEnvironment(env) {
  const fail = () => { throw new Error("Cloud integration requires an explicitly isolated loopback void_gui_upgrade_preview database."); };
  if (env.VOID_TEST_DATABASE_ISOLATED !== "1" || !env.VOID_TEST_DATABASE_URL) fail();
  let url;
  try { url = new URL(env.VOID_TEST_DATABASE_URL); } catch { fail(); }
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" ||
      url.port !== "5432" || url.pathname !== "/void_gui_upgrade_preview" ||
      url.username !== "void_test" || url.search || url.hash) fail();
  if (env.DATABASE_URL && env.DATABASE_URL !== env.VOID_TEST_DATABASE_URL) fail();
  return url.href;
}

export async function configureCloudTest() {
  process.env.DATABASE_URL = validateCloudTestEnvironment(process.env);
  const { neonConfig } = await import("@neondatabase/serverless");
  neonConfig.wsProxy = "127.0.0.1:5433/v1";
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineConnect = false;
  neonConfig.pipelineTLS = false;
  process.env.VOID_LOCAL_TEST = "1";
}
