import type { ConstraintKind, SketchEntity } from "@pamatcad/sdk";

type Operand = "point" | "line" | "circular" | "conic";
// Selection eligibility only; the core remains responsible for solving/validation.
const signatures: Record<Exclude<ConstraintKind, "fix">, readonly (readonly Operand[])[]> = {
  coincident: [["point", "point"]],
  pointOnCurve: [["point", "line"], ["point", "conic"]],
  horizontal: [["line"], ["point", "point"]],
  vertical: [["line"], ["point", "point"]],
  parallel: [["line", "line"]],
  perpendicular: [["line", "line"]],
  collinear: [["line", "line"]],
  equal: [["line", "line"], ["circular", "circular"]],
  concentric: [["conic", "conic"]],
  tangent: [["line", "circular"], ["circular", "circular"]],
  midpoint: [["point", "line"]],
  symmetric: [["point", "point", "line"]],
};

export function constraintSelection(kind: ConstraintKind, entities: readonly SketchEntity[]): "invalid" | "incomplete" | "ready" {
  if (kind === "fix") {
    if (entities.some(e => e.projected || e.reference.id === "origin")) return "invalid";
    return entities.length ? "ready" : "incomplete";
  }
  const matches = signatures[kind].filter(signature => {
    const remaining = [...signature];
    for (const entity of entities) {
      const type = entity.geometry.type;
      const index = remaining.findIndex(role => role === type ||
        role === "circular" && (type === "circle" || type === "arc") ||
        role === "conic" && (type === "circle" || type === "arc" || type === "ellipse"));
      if (index < 0) return false;
      remaining.splice(index, 1);
    }
    return true;
  });
  return matches.some(s => s.length === entities.length) ? "ready" : matches.length ? "incomplete" : "invalid";
}
