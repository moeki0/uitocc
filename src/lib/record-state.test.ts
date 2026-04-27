import { describe, expect, test } from "bun:test";
import { decideRecordAction } from "./record-state";

const SETTLE_MS = 5000;

describe("decideRecordAction", () => {
  test("first sighting → 'first'", () => {
    expect(decideRecordAction(undefined, "[\"a\"]", 1000, SETTLE_MS)).toEqual({ kind: "first" });
  });

  test("content changed → 'update' with reset state and lastChangeAt=now", () => {
    const state = { textsJson: "[\"a\"]", lastChangeAt: 1000, recorded: true };
    const action = decideRecordAction(state, "[\"b\"]", 2500, SETTLE_MS);
    expect(action).toEqual({
      kind: "update",
      nextState: { textsJson: "[\"b\"]", lastChangeAt: 2500, recorded: false },
    });
  });

  test("content unchanged but not yet settled → 'skip'", () => {
    const state = { textsJson: "[\"a\"]", lastChangeAt: 1000, recorded: false };
    expect(decideRecordAction(state, "[\"a\"]", 3000, SETTLE_MS)).toEqual({ kind: "skip" });
  });

  test("content unchanged and settled exactly at threshold → 'commit'", () => {
    const state = { textsJson: "[\"a\"]", lastChangeAt: 1000, recorded: false };
    expect(decideRecordAction(state, "[\"a\"]", 6000, SETTLE_MS)).toEqual({ kind: "commit" });
  });

  test("content unchanged, settled, but already recorded → 'skip' (no double-record)", () => {
    const state = { textsJson: "[\"a\"]", lastChangeAt: 1000, recorded: true };
    expect(decideRecordAction(state, "[\"a\"]", 9999, SETTLE_MS)).toEqual({ kind: "skip" });
  });

  test("change resets the settle timer (regression: no commit until next stable window)", () => {
    // Was settled and recorded
    let state = { textsJson: "[\"a\"]", lastChangeAt: 0, recorded: true };

    // Content changes at t=1000
    const a1 = decideRecordAction(state, "[\"b\"]", 1000, SETTLE_MS);
    expect(a1.kind).toBe("update");
    state = (a1 as any).nextState;

    // Same content arrives 4000ms later — still under settle threshold
    expect(decideRecordAction(state, "[\"b\"]", 5000, SETTLE_MS)).toEqual({ kind: "skip" });

    // Once we cross the threshold, we commit
    expect(decideRecordAction(state, "[\"b\"]", 6000, SETTLE_MS)).toEqual({ kind: "commit" });
  });
});
