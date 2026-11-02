// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Identity of the headless client (the bar station): an ordinary device key pair like
 * any phone has, but kept in a file instead of the browser. The server only knows the
 * public key (table `account`); nothing else about the bot is special.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { exportPublicKey } from '../core/crypto'

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const

export interface BotIdentity {
  email: string
  /** keeps the sequence numbers of the bot's own entries running across restarts */
  deviceId: string
  keyPair: CryptoKeyPair
}

interface IdentityFile {
  email: string
  deviceId: string
  privateKey: JsonWebKey
  publicKey: JsonWebKey
}

export const identityPath = (dir: string): string => join(dir, 'identity.json')

/** Create a new identity file (private key included: protect the folder). Returns the public key to register. */
export async function createIdentity(dir: string, email: string): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])
  const file: IdentityFile = {
    email: email.toLowerCase(),
    deviceId: randomUUID(),
    privateKey: await crypto.subtle.exportKey('jwk', keyPair.privateKey),
    publicKey: await crypto.subtle.exportKey('jwk', keyPair.publicKey),
  }
  await mkdir(dirname(identityPath(dir)), { recursive: true })
  await writeFile(identityPath(dir), JSON.stringify(file, null, 2), { flag: 'wx', mode: 0o600 }) // never overwrite a key
  return exportPublicKey(keyPair.publicKey)
}

export async function loadIdentity(dir: string): Promise<BotIdentity> {
  const file = JSON.parse(await readFile(identityPath(dir), 'utf8')) as IdentityFile
  return {
    email: file.email,
    deviceId: file.deviceId,
    keyPair: {
      privateKey: await crypto.subtle.importKey('jwk', file.privateKey, ECDH, false, ['deriveBits']),
      publicKey: await crypto.subtle.importKey('jwk', file.publicKey, ECDH, true, []),
    },
  }
}
