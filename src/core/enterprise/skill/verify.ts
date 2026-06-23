// src/core/enterprise/skill/verify.ts
// Note: uses @noble/curves/ed25519 (synchronous API), not @noble/ed25519
import { ed25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha2'

export function verifyZipSignature(zipBytes: Uint8Array, signatureB64: string, publicKeyHex: string): boolean {
  if (!publicKeyHex || !signatureB64) return false
  try {
    const pub = Uint8Array.from(Buffer.from(publicKeyHex.replace(/\s+/g, ''), 'hex'))
    const sig = Uint8Array.from(Buffer.from(signatureB64, 'base64url'))
    // Note: server signs canonical(manifest) + sha256(zip); V1 client has no manifest payload
    // V1 degrades to "verify SHA-256(zip) is signed" — weaker but non-zero assurance.
    // V1.5 will download manifest separately and verify the full canonical payload.
    const msg = sha256(zipBytes)
    return ed25519.verify(sig, msg, pub)
  } catch { return false }
}
