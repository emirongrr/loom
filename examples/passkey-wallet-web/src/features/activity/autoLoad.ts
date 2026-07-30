import type { ActivityCursor } from "../wallet/activity";

/** Pages from the two indexer sources overlap, so a page can legitimately add no
 * new entries. Tolerate a few, then stop auto-loading and hand control back to
 * the reader rather than looping against a rate-limited public endpoint. */
export const MAX_EMPTY_PAGES = 3;

export interface AutoLoadState {
  readonly phase: "loading" | "ready" | "loading-more";
  readonly cursor: ActivityCursor | null;
  readonly autoPaused: boolean;
}

/**
 * Whether the end-of-list sentinel coming into view should fetch another page.
 * A request is only ever started from a settled state with a live cursor, so
 * overlapping observer callbacks cannot stack up concurrent page loads.
 */
export function shouldAutoLoad(state: AutoLoadState, intersecting: boolean): boolean {
  return intersecting && state.phase === "ready" && state.cursor !== null && !state.autoPaused;
}

/** Consecutive pages that added nothing; resets as soon as a page contributes. */
export function nextEmptyPageCount(previous: number, added: number): number {
  return added === 0 ? previous + 1 : 0;
}

/** Auto-loading pauses once the indexer stops making progress. */
export function shouldPauseAutoLoad(emptyPages: number): boolean {
  return emptyPages >= MAX_EMPTY_PAGES;
}
