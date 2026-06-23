// src/core/enterprise/skill/__tests__/verify.test.ts
// Note: @noble/curves/ed25519 uses synchronous API (keygen/sign/verify)
import { describe, it, expect } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha2'
import { verifyZipSignature } from '../verify'

describe('verifyZipSignature', () => {
  it('returns true on valid sig', () => {
    const secretKey = ed25519.utils.randomPrivateKey()
    const publicKey = ed25519.getPublicKey(secretKey)
    const data = new TextEncoder().encode('fake zip')
    const sig = ed25519.sign(sha256(data), secretKey)
    const ok = verifyZipSignature(
      data,
      Buffer.from(sig).toString('base64url'),
      Buffer.from(publicKey).toString('hex'),
    )
    expect(ok).toBe(true)
  })

  it('returns false on tampered data', () => {
    const secretKey = ed25519.utils.randomPrivateKey()
    const publicKey = ed25519.getPublicKey(secretKey)
    const data = new TextEncoder().encode('original')
    const sig = ed25519.sign(sha256(data), secretKey)
    const tampered = new TextEncoder().encode('tampered')
    const ok = verifyZipSignature(
      tampered,
      Buffer.from(sig).toString('base64url'),
      Buffer.from(publicKey).toString('hex'),
    )
    expect(ok).toBe(false)
  })

  it('returns false when publicKeyHex is empty', () => {
    const data = new TextEncoder().encode('zip data')
    expect(verifyZipSignature(data, 'AAAA', '')).toBe(false)
  })

  it('returns false when signatureB64 is empty', () => {
    const data = new TextEncoder().encode('zip data')
    expect(verifyZipSignature(data, '', 'AABBCC')).toBe(false)
  })
})
