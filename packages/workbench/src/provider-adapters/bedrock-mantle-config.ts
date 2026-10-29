export function isBedrockMantleBaseUrl(value: string): boolean {
  try {
    const endpoint = new URL(value);
    return (
      endpoint.protocol === "https:" &&
      /^bedrock-mantle\.[a-z]{2}(?:-[a-z0-9]+)+-\d+\.api\.aws$/i.test(endpoint.hostname) &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.port &&
      !endpoint.search &&
      !endpoint.hash &&
      ["/openai/v1", "/openai/v1/"].includes(endpoint.pathname)
    );
  } catch {
    return false;
  }
}
