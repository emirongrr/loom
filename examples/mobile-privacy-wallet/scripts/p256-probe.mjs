// Live probe for the EIP-7951 P-256 precompile (address 0x100).
//
// Generates a fresh P-256 keypair, signs a random message, and asks the
// precompile to verify it via eth_call. A functioning precompile returns
// 32-byte 0x…01 for the valid signature and empty output for a corrupted
// one. Anything else means native mode must not be used on that chain.

import crypto from "node:crypto";

export const P256_PRECOMPILE = "0x0000000000000000000000000000000000000100";

function derToRs(der) {
  let i = 2;
  if (der[1] & 0x80) i += der[1] & 0x7f;
  i += 1;
  const rl = der[i];
  i += 1;
  const r = der.slice(i, i + rl);
  i += rl;
  i += 1;
  const sl = der[i];
  i += 1;
  const s = der.slice(i, i + sl);
  const pad = bytes => {
    let b = Buffer.from(bytes);
    while (b.length > 32) b = b.slice(1);
    while (b.length < 32) b = Buffer.concat([Buffer.alloc(1), b]);
    return b;
  };
  return Buffer.concat([pad(r), pad(s)]);
}

export async function probeP256Precompile(rpcUrl) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const message = crypto.randomBytes(64);
  const hash = crypto.createHash("sha256").update(message).digest();
  const derSig = crypto.sign("sha256", message, { key: privateKey, dsaEncoding: "der" });
  const jwk = publicKey.export({ format: "jwk" });
  const input =
    "0x" +
    Buffer.concat([
      hash,
      derToRs(derSig),
      Buffer.from(jwk.x, "base64url"),
      Buffer.from(jwk.y, "base64url")
    ]).toString("hex");

  const call = async data => {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: P256_PRECOMPILE, data }, "latest"]
      })
    });
    const body = await response.json();
    if (body.error) throw new Error(`eth_call: ${body.error.message}`);
    return body.result;
  };

  const valid = await call(input);
  const corrupted = input.slice(0, 2 + 64) + (input[2 + 64] === "a" ? "b" : "a") + input.slice(2 + 65);
  const invalid = await call(corrupted);

  return {
    supported:
      valid === "0x0000000000000000000000000000000000000000000000000000000000000001" &&
      (invalid === "0x" || invalid === null),
    valid,
    invalid
  };
}
