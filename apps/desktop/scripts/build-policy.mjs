export function resolveBuildPolicy({ platform, distribution, env }) {
  const selected = distribution ?? 'direct';
  if (!['direct', 'store'].includes(selected)) {
    throw new Error(`Unknown VOID_DISTRIBUTION profile: ${selected}`);
  }
  if (platform === 'darwin' && selected === 'store') {
    throw new Error('Mac App Store packaging is not configured; use the direct-download profile until a separate signed sandbox/provisioning path exists.');
  }
  return {
    distribution: selected,
    signingIdentity: platform === 'darwin' ? (env.APPLE_SIGNING_IDENTITY ?? '-') : undefined,
  };
}
