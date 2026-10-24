export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]") return true;
  const octets = host.split(".").map(Number);
  return octets.length === 4 && octets.every(part => Number.isInteger(part) && part >= 0 && part <= 255) && octets[0] === 127;
}
