// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Web Crypto helpers (P-256 ECDH + HKDF-SHA256 + AES-256-GCM).
 *
 * - Device key: ECDH key pair, private key non-extractable.
 * - Login challenge: the server encrypts a nonce to our public key (ECIES with an
 *   ephemeral server key); must match backend/app/crypto.py.
 * - Peer messages: static-static ECDH between two members' keys, so each message
 *   is encrypted for exactly one recipient. No group key, no signatures.
 */

const SALT = new TextEncoder().encode('bardesk-v1')
const CHALLENGE_INFO = new TextEncoder().encode('bardesk-challenge')
const PEER_INFO = new TextEncoder().encode('bardesk-peer')
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const

export function b64e(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64d(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDH, false, ['deriveBits'])
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return b64e(new Uint8Array(await crypto.subtle.exportKey('raw', key)))
}

async function importPublicKey(text: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', b64d(text), ECDH, false, [])
}

async function deriveAesKey(privateKey: CryptoKey, publicKey: CryptoKey, info: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256)
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export interface ChallengeBox {
  epk: string
  iv: string
  ct: string
}

/** Decrypt the relay's login challenge; returns the nonce (base64url) to send back. */
export async function decryptChallenge(privateKey: CryptoKey, box: ChallengeBox): Promise<string> {
  const key = await deriveAesKey(privateKey, await importPublicKey(box.epk), CHALLENGE_INFO)
  const nonce = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(box.iv) }, key, b64d(box.ct))
  return b64e(new Uint8Array(nonce))
}

/** Symmetric key shared by us and one peer (same key in both directions). */
export async function peerKey(privateKey: CryptoKey, peerPublicKey: string): Promise<CryptoKey> {
  return deriveAesKey(privateKey, await importPublicKey(peerPublicKey), PEER_INFO)
}

export async function seal(key: CryptoKey, message: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)))
  const plaintext = new TextEncoder().encode(JSON.stringify(message))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  return `${b64e(iv)}.${b64e(new Uint8Array(ciphertext))}`
}

export async function unseal(key: CryptoKey, sealed: string): Promise<unknown> {
  const [iv, ciphertext] = sealed.split('.')
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(iv) }, key, b64d(ciphertext))
  return JSON.parse(new TextDecoder().decode(plaintext))
}
