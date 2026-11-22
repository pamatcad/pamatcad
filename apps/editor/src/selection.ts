import type { EdgeRef, FaceRef, RegionRef, VertexRef } from "@pamatcad/sdk";

export type SelectionItem =
  | { kind: "region"; ref: RegionRef }
  | { kind: "face"; ref: FaceRef; revision: string }
  | { kind: "edge"; ref: EdgeRef }
  | { kind: "vertex"; ref: VertexRef }
  | { kind: "body"; id: string }
  | { kind: "sketch"; id: string }
  | { kind: "plane"; id: string };
export type SelectionFilter = "all" | "profiles" | "faces" | "bodies" | "none";

export function selectionKey(item: SelectionItem): string {
  if ("id" in item) return item.kind + ":" + item.id;
  if (item.kind === "region") return "region:" + item.ref.sketchId + ":" + item.ref.id;
  if (item.kind === "vertex") return "vertex:" + item.ref.bodyId + ":" + item.ref.vertexId;
  if (item.kind === "edge") return "edge:" + item.ref.bodyId + ":" + item.ref.edgeId;
  return "face:" + item.ref.bodyId + ":" + ("faceId" in item.ref ? item.ref.faceId : JSON.stringify(item.ref.origin));
}

export function selectionOwner(item: SelectionItem): string {
  return "id" in item ? item.id : item.kind === "region" ? item.ref.sketchId : item.ref.bodyId;
}

export function accepts(filter: SelectionFilter, item: SelectionItem): boolean {
  return filter === "all" || (filter === "profiles" && ["region", "sketch", "face"].includes(item.kind)) ||
    (filter === "faces" && item.kind === "face") || (filter === "bodies" && item.kind === "body");
}

export function changeSelection(current: SelectionItem[], item: SelectionItem | undefined, additive: boolean): SelectionItem[] {
  if (!item) return additive ? current : [];
  if (!additive) return [item];
  const key = selectionKey(item);
  return current.some((selected) => selectionKey(selected) === key)
    ? current.filter((selected) => selectionKey(selected) !== key) : [...current, item];
}
