import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_EMPTY_PAGES,
  nextEmptyPageCount,
  shouldAutoLoad,
  shouldPauseAutoLoad
} from "../src/features/activity/autoLoad.ts";
import type { ActivityCursor } from "../src/features/wallet/activity.ts";

const CURSOR: ActivityCursor = { transactions: { block_number: "19" }, transfers: null };
const READY = { phase: "ready", cursor: CURSOR, autoPaused: false } as const;

test("reaching the end of the list loads the next page", () => {
  assert.equal(shouldAutoLoad(READY, true), true);
});

test("nothing loads until the sentinel is actually in view", () => {
  assert.equal(shouldAutoLoad(READY, false), false);
});

// Overlapping observer callbacks are normal while scrolling; without this gate
// they would stack up concurrent requests for the same cursor.
test("a page already in flight is never requested a second time", () => {
  assert.equal(shouldAutoLoad({ ...READY, phase: "loading-more" }, true), false);
  assert.equal(shouldAutoLoad({ ...READY, phase: "loading" }, true), false);
});

test("an exhausted history does not keep polling the indexer", () => {
  assert.equal(shouldAutoLoad({ ...READY, cursor: null }, true), false);
});

test("a paused reader is not auto-resumed by scrolling", () => {
  assert.equal(shouldAutoLoad({ ...READY, autoPaused: true }, true), false);
});

// Indexer pages overlap, so an occasional page that adds nothing is expected and
// must not stop paging; a run of them means the indexer stopped making progress.
test("an occasional page that adds nothing does not pause auto-loading", () => {
  let empty = 0;
  empty = nextEmptyPageCount(empty, 0);
  assert.equal(shouldPauseAutoLoad(empty), false);
  empty = nextEmptyPageCount(empty, 12);
  assert.equal(empty, 0, "a page that contributes resets the run");
  assert.equal(shouldPauseAutoLoad(empty), false);
});

test("a run of pages that add nothing pauses auto-loading", () => {
  let empty = 0;
  for (let page = 0; page < MAX_EMPTY_PAGES; page += 1) empty = nextEmptyPageCount(empty, 0);
  assert.equal(empty, MAX_EMPTY_PAGES);
  assert.equal(shouldPauseAutoLoad(empty), true);
});
