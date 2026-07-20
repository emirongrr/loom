// A browser passkey wallet on Loom.
//
// The full lifecycle a web wallet needs — register a passkey, derive the
// counterfactual account, reconnect on a later visit, sign an operation, and
// grant/revoke a scoped session — built on @loom/core (derivation), @loom/passkey
// (the engine-free WebAuthn signer), and @loom/sdk (the account client and
// session builders). No Loom-operated service; the RPC/bundler are the caller's.
//
// WebAuthn is reached through an injected `credentials` provider so this module
// is platform-neutral and testable:
//
//   credentials.create({ rpId, userName })
//     -> { credentialId: Hex, publicKeyX: Hex, publicKeyY: Hex }
//   credentials.get({ credentialId, rpId, origin, challenge })
//     -> { authenticatorData: Hex, clientDataJSON: Hex, signature: Hex }
//
// index.html wires these to `navigator.credentials`; the tests wire a software
// P-256 authenticator so the whole flow is deterministic.

import { deriveAccountAddress, P256ValidatorAbi } from "@loom/core";
import { createWebAuthnSigner } from "@loom/passkey";
import { createLoomClient } from "@loom/sdk";
import { encodeAbiParameters, encodeFunctionData, keccak256, stringToHex } from "viem";

// Build the account configuration a registered passkey controls. Onboarding is
// passkey-only (no guardians yet); a wallet adds recovery afterwards and must
// show that state — see @loom/sdk's account safety snapshot.
function buildAccountConfig({ entryPoint, validator, policyHook, rpId, origin, publicKey }) {
  return {
    entryPoint,
    guardianRoot: keccak256(stringToHex("passkey-wallet-web.guardians")),
    guardianThreshold: 1,
    configHash: keccak256(stringToHex("passkey-wallet-web.config")),
    modules: [
      { moduleTypeId: 4n, module: policyHook, initData: "0x" },
      {
        moduleTypeId: 1n,
        module: validator,
        initData: encodeFunctionData({
          abi: P256ValidatorAbi,
          functionName: "initialize",
          args: [publicKey.x, publicKey.y, keccak256(stringToHex(rpId)), keccak256(stringToHex(origin)), policyHook]
        })
      }
    ]
  };
}

// A deterministic salt from the passkey's public key, so reconnecting derives
// the same account without a new registration.
function saltFor(publicKey) {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [publicKey.x, publicKey.y]));
}

function deriveWallet({ deployment, rpId, origin, chainId, credentialId, publicKey }) {
  const config = buildAccountConfig({ entryPoint: deployment.entryPoint, validator: deployment.validator, policyHook: deployment.policyHook, rpId, origin, publicKey });
  const salt = saltFor(publicKey);
  const account = deriveAccountAddress({
    factory: deployment.factory,
    implementation: deployment.implementation,
    proxyCreationCode: deployment.proxyCreationCode,
    salt,
    config
  });
  return { account, credentialId, publicKey, salt, config, rpId, origin, chainId, validator: deployment.validator };
}

// Register a new passkey and derive its counterfactual Loom account. The
// returned handle is everything a wallet persists locally to reconnect later
// (no private key — the credential stays in the platform authenticator).
export async function registerPasskeyAccount({ credentials, rpId, origin, userName, chainId, deployment }) {
  const { credentialId, publicKeyX, publicKeyY } = await credentials.create({ rpId, userName });
  return deriveWallet({ deployment, rpId, origin, chainId, credentialId, publicKey: { x: publicKeyX, y: publicKeyY } });
}

// Reconnect on a later visit from the persisted handle — re-derives the same
// account address deterministically, with no new registration prompt.
export function reconnectPasskeyAccount({ deployment, rpId, origin, chainId, credentialId, publicKey }) {
  return deriveWallet({ deployment, rpId, origin, chainId, credentialId, publicKey });
}

// An engine-free @loom/passkey signer bound to this wallet's credential. Pass
// it a canonical user-operation hash (from the SDK client) and it drives the
// authenticator and returns the account-ready signature.
export function walletSigner({ credentials, wallet }) {
  return createWebAuthnSigner({
    validator: wallet.validator,
    origin: wallet.origin,
    rpId: wallet.rpId,
    credentialId: wallet.credentialId,
    async signChallenge(challenge) {
      return credentials.get({ credentialId: wallet.credentialId, rpId: wallet.rpId, origin: wallet.origin, challenge: challenge.challenge });
    }
  });
}

// The SDK account client for this wallet, with the passkey signer wired in
// through the client's signer adapter (the client computes the canonical hash;
// the passkey signer signs it). Transports are the caller's — no default RPC or
// bundler is selected here.
export function walletClient({ credentials, wallet, transport, stateTransport, computeUserOperationHash }) {
  const signer = walletSigner({ credentials, wallet });
  return createLoomClient({
    chainId: wallet.chainId,
    account: wallet.account,
    signer: {
      dummySignature: signer.dummySignature,
      verificationGasBuffer: signer.verificationGasBuffer,
      async signUserOperation(envelope) {
        // The client hands over the prepared envelope; the passkey signs the
        // canonical hash the chain will validate.
        const hash = computeUserOperationHash(envelope, { entryPoint: wallet.config.entryPoint });
        return signer.sign(hash);
      }
    },
    ...(transport ? { transport } : {}),
    ...(stateTransport ? { stateTransport } : {})
  });
}

// Grant a scoped session key to an application, and revoke it. Both return
// clear-signing lifecycle intents the wallet reviews before signing — the same
// passkey signer submits them like any other operation.
export function grantSession(client, input) {
  return client.grantSession(input);
}
export function revokeSession(client, sessionKey) {
  return client.revokeSession({ sessionKey });
}
