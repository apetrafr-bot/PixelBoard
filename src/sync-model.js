function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function sameRemoteBoard(left, right) {
  const clean = (record) => {
    const copy = { ...record };
    delete copy.remoteUpdatedAt;
    BOARD_VIEW_FIELDS.forEach((key) => { delete copy[key]; });
    return canonical(copy);
  };
  return JSON.stringify(clean(left)) === JSON.stringify(clean(right));
}

export function pendingBoardAction(entry, baseVersion, serializedDraft) {
  if (entry && sameRemoteBoard(entry.data, serializedDraft)) return "acknowledge";
  if ((entry?.version ?? 0) === baseVersion) return "retry";
  return "conflict";
}
export const BOARD_VIEW_FIELDS = ["zoom", "viewX", "viewY", "originX", "originY", "worldWidth", "worldHeight"];

export function withLocalView(record, view) {
  const result = { ...record };
  for (const key of BOARD_VIEW_FIELDS) {
    if (Number.isFinite(view?.[key])) result[key] = view[key];
  }
  return result;
}
