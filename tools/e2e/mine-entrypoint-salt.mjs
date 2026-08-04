import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import sha3 from "js-sha3";

const { keccak_256 } = sha3;
const root = fileURLToPath(new URL("../../", import.meta.url));

// Bundlers infer the EntryPoint version from the leading bytes of its address,
// so the devnet deploys it through the canonical CREATE2 deployer at a salt
// mined to produce that prefix. The salt is only valid for one exact creation
// code, and the creation code changes whenever the pinned compiler does - which
// is why `loom devnet up` fails closed rather than deploying to some other
// address that no bundler would recognise as v0.9.
//
// That failure told you to re-mine the salt but left you to work out how. This
// is the how: it reads the freshly built artifact, searches for a salt, and
// verifies the address it derives before writing anything.
//
// Run `forge build` first, then:
//
//   node tools/e2e/mine-entrypoint-salt.mjs [--write]
//
// Without `--write` it prints the result and changes nothing.

const CREATE2_DEPLOYER = "4e59b44847b379578588920ca78fbf26c0b4956c";
const versionsPath = join(root, "devnet", "versions.json");

function creationCode() {
  const artifactPath = join(root, "out", "EntryPoint.sol", "EntryPoint.json");
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  } catch {
    throw new Error(`no EntryPoint artifact at ${artifactPath}; run \`forge build\` first`);
  }
  return artifact.bytecode.object;
}

/// The address the canonical deployer produces for a salt, derived the same way
/// the EVM does rather than trusted from the search loop.
export function create2Address(saltHex, initCodeHash) {
  const preimage = Buffer.concat([
    Buffer.from("ff", "hex"),
    Buffer.from(CREATE2_DEPLOYER, "hex"),
    Buffer.from(saltHex, "hex"),
    Buffer.from(initCodeHash, "hex")
  ]);
  return `0x${keccak_256(preimage).slice(24)}`;
}

/// Counts up from zero rather than sampling randomly, so the same creation code
/// and prefix always yield the same salt and two people re-mining independently
/// get the same answer.
export function mineSalt(initCodeHash, prefix, limit = 1 << 28) {
  const target = prefix.replace(/^0x/u, "").toLowerCase();
  const preimage = Buffer.concat([
    Buffer.from("ff", "hex"),
    Buffer.from(CREATE2_DEPLOYER, "hex"),
    Buffer.alloc(32),
    Buffer.from(initCodeHash, "hex")
  ]);
  const saltAt = 21;

  for (let candidate = 0; candidate < limit; candidate += 1) {
    preimage.writeUInt32BE(candidate, saltAt + 28);
    const address = keccak_256(preimage).slice(24);
    if (address.startsWith(target)) {
      const salt = `0x${candidate.toString(16).padStart(64, "0")}`;
      return { salt, address: `0x${address}`, attempts: candidate + 1 };
    }
  }
  throw new Error(`no salt below ${limit} produces the ${prefix} prefix`);
}

function main() {
  const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
  const prefix = versions.entryPoint.address.slice(0, 8);

  const code = creationCode();
  const initCodeHash = keccak_256(Buffer.from(code.slice(2), "hex"));
  const creationCodeHash = `0x${initCodeHash}`;

  if (creationCodeHash === versions.entryPoint.creationCodeHash) {
    console.log(`creation code unchanged (${creationCodeHash}); the pinned salt is still valid`);
    return;
  }

  console.log(`==> creation code moved`);
  console.log(`    was ${versions.entryPoint.creationCodeHash}`);
  console.log(`    now ${creationCodeHash}`);
  console.log(`==> mining a salt for the ${prefix} prefix`);

  const started = Date.now();
  const found = mineSalt(initCodeHash, prefix);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  // Re-derive independently of the search loop: a miner that reported an
  // address its own optimised inner loop computed would be checking itself.
  const verified = create2Address(found.salt.slice(2), initCodeHash);
  if (verified !== found.address) throw new Error(`mined address ${found.address} does not re-derive to ${verified}`);
  if (!verified.startsWith(prefix)) throw new Error(`mined address ${verified} does not carry the ${prefix} prefix`);

  console.log(`    salt    ${found.salt}`);
  console.log(`    address ${verified}`);
  console.log(`    ${found.attempts.toLocaleString("en-US")} attempts in ${seconds}s`);

  if (!process.argv.includes("--write")) {
    console.log("\nre-run with --write to update devnet/versions.json");
    return;
  }

  versions.entryPoint.salt = found.salt;
  versions.entryPoint.address = verified;
  versions.entryPoint.creationCodeHash = creationCodeHash;
  writeFileSync(versionsPath, `${JSON.stringify(versions, null, 2)}\n`, "utf8");
  console.log("\nwrote devnet/versions.json");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
