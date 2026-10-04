export interface PkcePair {
  verifier: string;
  challenge: string;
  state: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Create an RFC 7636 S256 proof and a separate CSRF state value. */
export async function createPkcePair(): Promise<PkcePair> {
  const verifierBytes = new Uint8Array(32);
  const stateBytes = new Uint8Array(16);
  crypto.getRandomValues(verifierBytes);
  crypto.getRandomValues(stateBytes);

  const verifier = base64Url(verifierBytes);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));

  return {
    verifier,
    challenge: base64Url(new Uint8Array(digest)),
    state: base64Url(stateBytes),
  };
}
