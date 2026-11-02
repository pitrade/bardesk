# SPDX-License-Identifier: GPL-3.0-or-later
"""Encrypting the login challenge to a client's public key.

ECIES on P-256: ephemeral ECDH -> HKDF-SHA256 -> AES-256-GCM. Must match
`decryptChallenge` in frontend/src/core/crypto.ts.
"""
import base64
import os

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

SALT = b"bardesk-v1"
CHALLENGE_INFO = b"bardesk-challenge"


def b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def load_public_key(text: str) -> ec.EllipticCurvePublicKey:
    """Parse a base64url raw P-256 point. Raises ValueError if invalid."""
    try:
        raw = b64d(text)
    except Exception as exc:
        raise ValueError("invalid base64") from exc
    return ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)


def _derive_key(shared: bytes, info: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=SALT, info=info).derive(shared)


def encrypt_to(public_key: str, plaintext: bytes) -> dict[str, str]:
    """Encrypt so that only the holder of the matching private key can read it."""
    peer = load_public_key(public_key)
    ephemeral = ec.generate_private_key(ec.SECP256R1())
    key = _derive_key(ephemeral.exchange(ec.ECDH(), peer), CHALLENGE_INFO)
    iv = os.urandom(12)
    epk = ephemeral.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return {"epk": b64e(epk), "iv": b64e(iv), "ct": b64e(AESGCM(key).encrypt(iv, plaintext, None))}


def decrypt_with(private_key: ec.EllipticCurvePrivateKey, box: dict[str, str]) -> bytes:
    """Inverse of encrypt_to, used by tests to play the client side."""
    epk = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), b64d(box["epk"]))
    key = _derive_key(private_key.exchange(ec.ECDH(), epk), CHALLENGE_INFO)
    return AESGCM(key).decrypt(b64d(box["iv"]), b64d(box["ct"]), None)
