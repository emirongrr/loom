import { readFileSync } from "node:fs";
import { join } from "node:path";

/// `foundry.toml` is the compiler pin. Everything else that needs to know the
/// version - the deployment manifest builder, the manifest validator, the bump
/// script - reads it from here rather than repeating the literal, so a bump
/// cannot leave one of them behind asserting a version nothing builds with.
///
/// The `toolchain:check` gate is what keeps this single source honest: it
/// compares this pin against the npm dependency and every workflow invocation
/// and fails when they disagree.
export function pinnedSolidityVersion(base) {
  const source = readFileSync(join(base, "foundry.toml"), "utf8");
  const match = source.match(/^solc_version\s*=\s*"([^"]+)"/mu);
  if (match === null) throw new Error("foundry.toml has no solc_version pin");
  return match[1];
}
