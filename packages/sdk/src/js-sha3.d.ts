// Ambient declaration for js-sha3@0.8.0, which ships no types. Only the
// surface the wallet engine consumes is declared.
declare module "js-sha3" {
  export function keccak_256(input: string | Uint8Array | ArrayBuffer | readonly number[]): string;
  const sha3: { keccak_256: typeof keccak_256 };
  export default sha3;
}
