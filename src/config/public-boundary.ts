const secretName = /(token|secret|password|private[_-]?key|credential|api[_-]?key)/i;

export function assertPublicConfiguration(values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    if (secretName.test(name)) throw new Error(`${name} cannot be exposed to the browser.`);
    if (value && /-----BEGIN|ghp_|github_pat_/i.test(value))
      throw new Error(`${name} contains credential material.`);
  }
}

export function publicEndpoint(name: string, value: string): string {
  assertPublicConfiguration({ [name]: value });
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS.`);
  return url.toString().replace(/\/$/, "");
}
