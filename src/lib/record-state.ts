export interface WindowRecordState {
  textsJson: string;
  lastChangeAt: number;
  recorded: boolean;
}

export type RecordAction =
  | { kind: "first" }
  | { kind: "update"; nextState: WindowRecordState }
  | { kind: "commit" }
  | { kind: "skip" };

// Pure decision function for the record loop's debounce/settle logic.
// - "first":  no prior state → caller records immediately and sets state recorded=true
// - "update": content changed since last poll → caller updates state (recorded=false)
// - "commit": content has been stable for >= settleMs → caller records and sets recorded=true
// - "skip":   content unchanged but not yet settled, or already recorded
export function decideRecordAction(
  state: WindowRecordState | undefined,
  currTextsJson: string,
  now: number,
  settleMs: number,
): RecordAction {
  if (!state) return { kind: "first" };

  if (state.textsJson !== currTextsJson) {
    return {
      kind: "update",
      nextState: { textsJson: currTextsJson, lastChangeAt: now, recorded: false },
    };
  }

  if (!state.recorded && now - state.lastChangeAt >= settleMs) {
    return { kind: "commit" };
  }

  return { kind: "skip" };
}
