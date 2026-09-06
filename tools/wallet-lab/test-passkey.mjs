import crypto from "node:crypto";

const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

function bytes32(value) {
  return Buffer.from(value.toString(16).padStart(64, "0"), "hex");
}

/**
 * Deterministic software credential for hermetic tests only.
 *
 * The private scalar stays inside a KeyObject and callers receive only the
 * public coordinates and a stable credential identifier. Never use this
 * helper on a public chain or with assets of value.
 */
export function deterministicTestPasskey(seed) {
  if (typeof seed !== "string" || seed.length < 8) throw new Error("test passkey seed is too short");
  const digest = crypto.createHash("sha256").update(`loom.wallet-lab.passkey:${seed}`).digest();
  const scalar = (BigInt(`0x${digest.toString("hex")}`) % (P256_ORDER - 1n)) + 1n;
  const d = bytes32(scalar);
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const publicPoint = ecdh.getPublicKey(undefined, "uncompressed");
  const x = publicPoint.subarray(1, 33);
  const y = publicPoint.subarray(33, 65);
  const privateKey = crypto.createPrivateKey({
    key: { kty: "EC", crv: "P-256", x: x.toString("base64url"), y: y.toString("base64url"), d: d.toString("base64url") },
    format: "jwk"
  });
  return Object.freeze({
    privateKey,
    credentialId: crypto.createHash("sha256").update(`loom.wallet-lab.credential:${seed}`).digest("base64url"),
    publicKey: Object.freeze({ x: `0x${x.toString("hex")}`, y: `0x${y.toString("hex")}` })
  });
}
