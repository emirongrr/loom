/**
 * Addresses and hashes, shortened for reading.
 *
 * Nine files had written one of these out by hand, in two widths, and the two
 * had drifted apart by accident rather than by decision. Both widths are kept
 * because both are deliberate, but they are named here so the choice is one a
 * caller makes rather than one it re-derives.
 *
 * Shortening is for reading only. Anything a person has to check against
 * another screen, paste into an explorer, or compare with a chain value must
 * show the whole address -- a truncated one cannot be retyped, and two
 * addresses can agree on both ends.
 */

/** For a dense row where the address sits beside other text. */
export function shortAddress(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/**
 * For a line the reader is expected to compare against something else, where
 * six characters of prefix is not enough to tell two accounts apart.
 */
export function mediumAddress(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}
