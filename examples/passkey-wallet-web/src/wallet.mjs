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

import { deriveAccountAddress, encodeCreateAccountCall, getUserOpHash, packUserOperation, P256ValidatorAbi } from "@loom/core";
import { createWebAuthnSigner } from "@loom/passkey";
import { computeUserOperationHash, createBundlerTransport, createLoomClient, createRpcStateTransport } from "@loom/sdk";
import {
  createPublicClient, encodeAbiParameters, encodeFunctionData, formatUnits, getAddress, http,
  isAddress, keccak256, parseUnits, sha256, stringToHex
} from "viem";

// Accounts created before guardians were modelled honestly committed to this
// root. It is the hash of a string, not a merkle root over real guardian
// leaves, so nothing can ever be proven against it: the account reports itself
// guardian-protected while no one can freeze or recover it. It survives only so
// those accounts keep deriving to the same address.
export const LEGACY_PLACEHOLDER_GUARDIAN_ROOT = keccak256(stringToHex("passkey-wallet-web.guardians"));
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;

// Build the account configuration a registered passkey controls.
//
// Onboarding is passkey-only, and the contract has a state for exactly that:
// root zero with threshold zero, which makes `recoveryConfigured` report false.
// Fabricating a root instead would claim a protection nobody holds a key for,
// so guardians are added deliberately later rather than invented here.
function buildAccountConfig({
  entryPoint, validator, policyHook, rpId, origin, publicKey,
  guardianRoot = ZERO_BYTES32, guardianThreshold = 0
}) {
  return {
    entryPoint,
    guardianRoot,
    guardianThreshold,
    configHash: keccak256(stringToHex("passkey-wallet-web.config")),
    modules: [
      { moduleTypeId: 4n, module: policyHook, initData: "0x" },
      {
        moduleTypeId: 1n,
        module: validator,
        initData: encodeFunctionData({
          abi: P256ValidatorAbi,
          functionName: "initialize",
          // rpIdHash is SHA-256, not keccak: the validator compares it against
          // the first 32 bytes of authenticatorData, and WebAuthn authenticators
          // put sha256(rpId) there. originHash is keccak, because the validator
          // hashes the origin bytes itself (WebAuthnP256.verify).
          args: [publicKey.x, publicKey.y, sha256(stringToHex(rpId)), keccak256(stringToHex(origin)), policyHook]
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

// The guardian configuration is part of what the address is derived from, so a
// saved account must be re-derived with the values it was created under — not
// with whatever the current default happens to be. Callers persist these with
// the account handle and pass them back on reconnect.
function deriveWallet({ deployment, rpId, origin, chainId, credentialId, publicKey, guardianRoot, guardianThreshold }) {
  const config = buildAccountConfig({
    entryPoint: deployment.entryPoint, validator: deployment.validator, policyHook: deployment.policyHook,
    rpId, origin, publicKey, guardianRoot, guardianThreshold
  });
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
export function reconnectPasskeyAccount({
  deployment, rpId, origin, chainId, credentialId, publicKey, guardianRoot, guardianThreshold
}) {
  return deriveWallet({ deployment, rpId, origin, chainId, credentialId, publicKey, guardianRoot, guardianThreshold });
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

// Build and passkey-sign the operation that brings the account into existence.
//
// The factory fail-closes to the EntryPoint's SenderCreator, so no third-party
// bundler can simulate initCode — creation is published straight to the
// EntryPoint instead. That publication costs gas, which is why the returned
// operation is handed back packed rather than sent: whoever sponsors the
// account (an institution funding onboarding, or the user themselves) submits
// it through `EntryPoint.handleOps`. The signature is the user's either way;
// sponsorship pays for the account, it does not gain authority over it.
export async function prepareDeployOperation({ credentials, wallet, deployment, calls = [], gas = {} }) {
  const signer = walletSigner({ credentials, wallet });
  const client = createLoomClient({
    chainId: wallet.chainId,
    account: wallet.account,
    signer: {
      dummySignature: signer.dummySignature,
      verificationGasBuffer: signer.verificationGasBuffer,
      async signUserOperation() {
        throw new Error("prepareDeployOperation signs the canonical hash directly");
      }
    }
  });
  const prepared = client.prepareUserOperation(client.prepareCalls({ calls }), {
    // A counterfactual account has never been used, so its EntryPoint nonce is 0.
    nonce: 0n,
    factory: deployment.factory,
    factoryData: encodeCreateAccountCall(wallet.salt, wallet.config),
    callGasLimit: gas.callGasLimit ?? 500_000n,
    // Creation plus a P-256 verification; the buffer the signer declares covers
    // the WebAuthn tail a dummy signature never reaches.
    verificationGasLimit: gas.verificationGasLimit ?? 2_000_000n,
    preVerificationGas: gas.preVerificationGas ?? 150_000n,
    maxFeePerGas: gas.maxFeePerGas ?? 3_000_000_000n,
    maxPriorityFeePerGas: gas.maxPriorityFeePerGas ?? 1_000_000_000n
  });
  const userOperation = prepared.userOperation ?? prepared;
  const unsigned = packUserOperation({ ...userOperation, signature: "0x" });
  const userOpHash = getUserOpHash(unsigned, deployment.entryPoint, BigInt(wallet.chainId));
  const signature = await signer.sign(userOpHash);
  return { userOpHash, packed: packUserOperation({ ...userOperation, signature }) };
}

// Any operation after creation: no initCode, and the nonce comes from the
// EntryPoint rather than being zero. The account pays from its own deposit, so
// nobody has to fund anything for it to act.
export async function prepareOperation({ credentials, wallet, deployment, calls, nonce, gas = {} }) {
  const signer = walletSigner({ credentials, wallet });
  const client = createLoomClient({
    chainId: wallet.chainId,
    account: wallet.account,
    signer: {
      dummySignature: signer.dummySignature,
      verificationGasBuffer: signer.verificationGasBuffer,
      async signUserOperation() {
        throw new Error("prepareOperation signs the canonical hash directly");
      }
    }
  });
  const prepared = client.prepareUserOperation(client.prepareCalls({ calls }), {
    nonce: BigInt(nonce),
    callGasLimit: gas.callGasLimit ?? 300_000n,
    // No account creation this time, so verification is just the P-256 check.
    verificationGasLimit: gas.verificationGasLimit ?? 600_000n,
    preVerificationGas: gas.preVerificationGas ?? 100_000n,
    maxFeePerGas: gas.maxFeePerGas ?? 3_000_000_000n,
    // Estimated from the network by the caller when available: a fixed tip is
    // paid to whoever relays the operation, and overstating it is a real cost.
    maxPriorityFeePerGas: gas.maxPriorityFeePerGas ?? 1_000_000n
  });
  const userOperation = prepared.userOperation ?? prepared;
  const unsigned = packUserOperation({ ...userOperation, signature: "0x" });
  const userOpHash = getUserOpHash(unsigned, deployment.entryPoint, BigInt(wallet.chainId));
  const signature = await signer.sign(userOpHash);
  return { userOpHash, packed: packUserOperation({ ...userOperation, signature }) };
}

// The two transactions a sponsor sends to bring a signed creation operation on
// chain: fund the account's EntryPoint deposit, then publish the operation.
//
// These are returned as plain calldata rather than sent, because the sponsor's
// key belongs in the sponsor's wallet — a browser wallet, a hardware signer, a
// backend key. Nothing here holds it, and neither should the page.
export function sponsorCalls({ deployment, packed, beneficiary, depositWei }) {
  return [
    {
      label: "depositTo",
      to: deployment.entryPoint,
      value: depositWei,
      data: encodeFunctionData({ abi: EntryPointAbi, functionName: "depositTo", args: [packed.sender] })
    },
    {
      label: "handleOps",
      to: deployment.entryPoint,
      value: 0n,
      data: encodeFunctionData({ abi: EntryPointAbi, functionName: "handleOps", args: [[packed], beneficiary] })
    }
  ];
}

// --- guardians ------------------------------------------------------------

// Validate the addresses someone proposes as guardians.
//
// What can actually be proven here is worth being precise about. Format and
// checksum catch typing mistakes; the on-chain code check catches an address
// that could never work. What none of it proves is that anyone holds the key —
// only a signature from that address does, which is why a possession challenge
// is a separate, later step rather than something inferred here.
export async function validateGuardians({ rpcUrl, account, addresses }) {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const seen = new Map();
  const results = [];

  for (const raw of addresses) {
    const input = String(raw ?? "").trim();
    const entry = { input, address: null, errors: [], warnings: [] };
    results.push(entry);
    if (input === "") { entry.errors.push("empty"); continue; }

    if (!isAddress(input, { strict: false })) {
      entry.errors.push("not an Ethereum address — expected 0x followed by 40 hex characters");
      continue;
    }
    // A mixed-case address carries its own EIP-55 checksum. If it fails, a
    // character was mistyped, and accepting it would hand recovery authority to
    // an address nobody controls.
    const hasMixedCase = /[a-f]/.test(input.slice(2)) && /[A-F]/.test(input.slice(2));
    let address;
    try {
      address = getAddress(input);
      if (hasMixedCase && address !== input) {
        entry.errors.push("checksum does not match — this address has a typo");
        continue;
      }
    } catch {
      entry.errors.push("checksum does not match — this address has a typo");
      continue;
    }
    entry.address = address;

    if (/^0x0{40}$/i.test(address)) { entry.errors.push("the zero address cannot be a guardian"); continue; }
    if (account && address.toLowerCase() === account.toLowerCase()) {
      entry.errors.push("an account cannot guard itself — recovery would depend on the key being recovered");
      continue;
    }
    const duplicate = seen.get(address.toLowerCase());
    if (duplicate !== undefined) { entry.errors.push(`already listed as guardian ${duplicate + 1}`); continue; }
    seen.set(address.toLowerCase(), results.length - 1);

    // An ECDSA guardian approves by signing, and a signature recovers to the
    // signer's address. A contract has no private key, so a contract address
    // can never produce one: it would be a guardian that can never act.
    try {
      const code = await client.getCode({ address });
      if (code && code !== "0x") {
        entry.errors.push("this is a contract, not a wallet — it holds no key and could never sign an approval");
        continue;
      }
      const [nonce, balance] = await Promise.all([
        client.getTransactionCount({ address }),
        client.getBalance({ address })
      ]);
      entry.nonce = nonce;
      if (nonce === 0 && balance === 0n) {
        entry.warnings.push("this address has never been used on this chain — make sure someone holds its key");
      }
    } catch (error) {
      entry.warnings.push(`could not be checked on chain (${error.message})`);
    }
  }

  const valid = results.filter(r => r.errors.length === 0);
  return { results, valid: valid.map(r => r.address), ok: valid.length === results.length && results.length > 0 };
}

// Build the guardian merkle root the account commits to. The leaf encoding
// mirrors the contract exactly — keccak256(abi.encode(verifier, verifier
// .codehash, keyCommitment, salt)) — and an ECDSA guardian's commitment is the
// hash of its address, which is what the verifier recovers a signature to.
export async function buildGuardianSet({ rpcUrl, verifier, addresses, salt }) {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const code = await client.getCode({ address: verifier });
  if (!code || code === "0x") throw new Error(`no guardian verifier deployed at ${verifier}`);
  const verifierCodeHash = keccak256(code);
  const leafSalt = salt ?? keccak256(stringToHex("passkey-wallet-web.guardian-salt"));

  const leaves = addresses.map(address => {
    const keyCommitment = keccak256(encodeAbiParameters([{ type: "address" }], [address]));
    return {
      address,
      keyCommitment,
      leaf: keccak256(encodeAbiParameters(
        [{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
        [verifier, verifierCodeHash, keyCommitment, leafSalt]
      ))
    };
  });
  // The contract requires strictly increasing leaves across approvals, so the
  // set is sorted here and the tree is built over that order.
  leaves.sort((a, b) => (BigInt(a.leaf) < BigInt(b.leaf) ? -1 : 1));

  let layer = leaves.map(l => l.leaf);
  const layers = [layer];
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = layer[i + 1] ?? left;
      const [a, b] = BigInt(left) <= BigInt(right) ? [left, right] : [right, left];
      next.push(keccak256(`0x${a.slice(2)}${b.slice(2)}`));
    }
    layers.push(next);
    layer = next;
  }
  return { root: layer[0], salt: leafSalt, verifier, verifierCodeHash, leaves, layers };
}

// Read the account's live safety posture straight from the chain: whether it is
// guardian-protected, frozen, or has a migration pending, and at what config
// version. This is read-only and needs no signature — it is the truth the
// account exposes about itself, not a claim the page makes.
export async function readSafety({ wallet, deployment, rpcUrl, recoveryModule }) {
  const client = createLoomClient({
    chainId: wallet.chainId,
    account: wallet.account,
    signer: { dummySignature: "0x", async signUserOperation() { return "0x"; } },
    stateTransport: createRpcStateTransport({ endpoint: rpcUrl })
  });
  return client.readSafetyState(recoveryModule ? { recoveryModule } : {});
}

// Send through a public ERC-4337 bundler instead of a relay you operate.
//
// This is the walkaway property made concrete: the account is not bound to any
// particular submitter. The same passkey signature is carried by whichever
// bundler you point at, and none of them can alter it — the canonical hash
// covers every field. Only account *creation* needs a direct submitter, because
// the factory fail-closes to the EntryPoint's SenderCreator.
export async function sendViaBundler({ credentials, wallet, deployment, calls, rpcUrl, bundlerUrl, feeTier = "standard" }) {
  const client = walletClient({
    credentials,
    wallet,
    computeUserOperationHash,
    transport: createBundlerTransport({ endpoint: bundlerUrl, entryPoint: deployment.entryPoint }),
    stateTransport: createRpcStateTransport({ endpoint: rpcUrl })
  });
  // Fees are left unset so the SDK asks the bundler for its own price and gas
  // estimates. A bundler rejects operations it considers underpriced, and it is
  // the only party that knows its threshold — guessing here would be a way to
  // overpay a relayer, which we have already measured the cost of once.
  return client.sendTransaction({ calls }, { feeTier });
}

const ERC20_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }
];

// One transfer shape for both kinds of value. Ether moves as the call's `value`;
// a token moves as a `transfer` the account makes itself, since the account is
// the holder and is its own `msg.sender` — no approval, no intermediary.
//
// Callers should not branch on asset type: everything above this line treats a
// transfer as a transfer, which is what keeps the send path from growing a
// parallel implementation per asset.
export function transferCall({ token, to, amount }) {
  if (!token) return { target: to, value: amount, data: "0x" };
  return {
    target: token,
    value: 0n,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to, amount] })
  };
}

// Decimal string to base units, in whatever precision the asset uses. Ether is
// simply the 18-decimal case, not a special one.
export function parseAmount(value, decimals = 18) {
  return parseUnits(String(value).trim(), decimals);
}

export function formatAmount(value, decimals = 18) {
  return formatUnits(value, decimals);
}

// Ask an explorer which tokens this account holds.
//
// An explorer is an *index*, not an authority: it can be stale, incomplete, or
// simply wrong, and it is a third party the wallet does not control. So its
// answer is used only to decide which contracts are worth asking about — every
// balance that matters is then read from the chain by `readAsset`. Discovery is
// a convenience; settlement is never taken on trust.
export async function discoverAssets({ explorerUrl, account }) {
  const response = await fetch(`${explorerUrl.replace(/\/$/, "")}/api/v2/addresses/${account}/token-balances`);
  if (!response.ok) throw new Error(`explorer returned ${response.status}`);
  const entries = await response.json();
  return entries
    // Only fungible tokens can be moved by a `transfer(address,uint256)`.
    .filter(entry => entry?.token?.type === "ERC-20" && entry.token.address_hash)
    .map(entry => ({
      token: entry.token.address_hash,
      symbol: entry.token.symbol ?? "?",
      name: entry.token.name ?? "",
      decimals: Number(entry.token.decimals ?? 18),
      // Reported by the explorer, shown only until the chain is asked.
      reportedBalance: BigInt(entry.value ?? "0")
    }))
    .filter(entry => entry.reportedBalance > 0n);
}

// Describe whichever asset the account is about to move: ether needs no contract
// call, a token is asked for its own identity rather than being assumed.
export async function readAsset({ rpcUrl, token, account }) {
  const client = createPublicClient({ transport: http(rpcUrl) });
  if (!token) {
    const balance = await client.getBalance({ address: account });
    return { symbol: "ETH", decimals: 18, balance, formatted: formatUnits(balance, 18), token: null };
  }
  const [symbol, decimals, balance] = await Promise.all([
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }),
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }),
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [account] })
  ]);
  return { symbol, decimals, balance, formatted: formatUnits(balance, decimals), token };
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
