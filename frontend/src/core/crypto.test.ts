// @vitest-environment node
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { decryptChallenge, exportPublicKey, generateKeyPair, peerKey, seal, unseal } from './crypto'
import { HlcClock, decodeHlc, encodeHlc } from './hlc'

// Produced by backend/app/crypto.py encrypt_to(), keeps client and server in sync.
const VECTOR = {
  jwk: {
    kty: 'EC',
    crv: 'P-256',
    d: '8B9ymSwvLwCStY_5UU3ah4KJKjYtcoDbC6wcUKmux4Y',
    x: 'VYROd5ipAJ4T--uYMypV1nydq_j3PiRjfUx4xQVAjrc',
    y: 'BPjeImlVsMvEcAJVTkjpQX4pJvADzHeG3evH5AEvDu4',
  },
  box: {
    epk: 'BG5a52DgON8U4PzY3z7iEXIAndNWx4G96qG2rgwVlBU-Vie5zlTkjxR02VM3PGnOSPUSI6iExNv1pEZ2ttDjH-I',
    iv: 'Pn3nJLmu52vkftEo',
    ct: 'Gql5-SfrNSmHJmSMbN-ldpilalvyNiTydSGWTsfgTkfJtmddOk20OkVc19MX0M7a',
  },
  nonce: 'YmFyZGVzay1jaGFsbGVuZ2UtdGVzdC12ZWN0b3ItMDE',
}

describe('crypto', () => {
  it('decrypts a login challenge encrypted by the Python server', async () => {
    const privateKey = await crypto.subtle.importKey('jwk', VECTOR.jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, [
      'deriveBits',
    ])
    expect(await decryptChallenge(privateKey, VECTOR.box)).toBe(VECTOR.nonce)
  })

  it('two peers derive the same key and can read each other', async () => {
    const alice = await generateKeyPair()
    const bob = await generateKeyPair()
    const aliceSide = await peerKey(alice.privateKey, await exportPublicKey(bob.publicKey))
    const bobSide = await peerKey(bob.privateKey, await exportPublicKey(alice.publicKey))
    const sealed = await seal(aliceSide, { hello: 'bob', n: 1 })
    expect(await unseal(bobSide, sealed)).toEqual({ hello: 'bob', n: 1 })
  })

  it('a third party cannot read a sealed message', async () => {
    const [alice, bob, eve] = await Promise.all([generateKeyPair(), generateKeyPair(), generateKeyPair()])
    const key = await peerKey(alice.privateKey, await exportPublicKey(bob.publicKey))
    const eveKey = await peerKey(eve.privateKey, await exportPublicKey(alice.publicKey))
    await expect(unseal(eveKey, await seal(key, 'secret'))).rejects.toThrow()
  })

  it('private keys are not extractable', async () => {
    const { privateKey } = await generateKeyPair()
    expect(privateKey.extractable).toBe(false)
  })
})

describe('HlcClock', () => {
  it('is strictly increasing even when the wall clock stands still', () => {
    const clock = new HlcClock(() => 1000)
    const a = clock.next()
    const b = clock.next()
    expect(b > a).toBe(true)
    expect(decodeHlc(b)).toEqual({ ms: 1000, counter: 1 })
  })

  it('moves past observed timestamps from devices with a later clock', () => {
    const clock = new HlcClock(() => 1000)
    clock.observe(encodeHlc(5000, 3))
    expect(clock.next()).toBe(encodeHlc(5000, 4))
  })

  it('ignores observed timestamps far in the future (broken clocks)', () => {
    const clock = new HlcClock(() => 1000)
    clock.observe(encodeHlc(1000 + 2 * 60 * 60 * 1000, 0))
    expect(decodeHlc(clock.next()).ms).toBe(1000)
  })
})
