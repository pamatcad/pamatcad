import type { ConstraintKind, SketchEntity, SketchState } from "@pamatcad/sdk";

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

/** Actual selection, including owned helpers; unrelated constraint relationships do not connect curves. */
export function connectedSelection(state: SketchState, seed: string): Set<string> {
  const text = new Set(state.texts.flatMap(t => [...t.geometry.points, ...t.geometry.curves, ...Object.values(t.frame ?? {})].map(r => r.id)));
  const entities = new Map(state.entities.filter(e => !text.has(e.reference.id)).map(e => [e.reference.id, e]));
  const splineHelpers = new Set(state.splines.flatMap(s => s.envelope.map(r => r.id)));
  const links = new Map<string, Set<string>>(), endpoints = new Set<string>();
  const link = (a: string, b: string) => {
    if (!entities.has(a) || !entities.has(b)) return;
    if (!links.has(a)) links.set(a, new Set());
    if (!links.has(b)) links.set(b, new Set());
    links.get(a)!.add(b); links.get(b)!.add(a);
  };
  for (const e of entities.values()) {
    const g = e.geometry, id = e.reference.id;
    const points = g.type === "line" ? [g.from, g.to] : g.type === "arc" ? [g.center, g.from, g.to]
      : g.type === "spline" ? g.points : "center" in g ? [g.center] : [];
    for (const p of points) link(id, p);
    const ends = g.type === "line" || g.type === "arc" ? [g.from, g.to]
      : g.type === "spline" ? [g.points[0], g.points.at(-1)!] : [];
    if (!splineHelpers.has(id)) for (const p of ends) endpoints.add(p);
  }
  for (const spline of state.splines) {
    for (const r of spline.envelope) link(spline.curve.id, r.id);
    for (const node of spline.fitPoints) for (const r of [node.point, node.incoming, node.outgoing]) if (r) link(spline.curve.id, r.id);
  }
  for (const c of state.constraints) if (["coincident", "pointOnCurve", "midpoint"].includes(c.kind)) {
    const refs = [...(c.parameters.points ?? []), ...(c.parameters.curves ?? [])];
    for (const r of refs.slice(1)) link(refs[0].id, r.id);
  }
  // Endpoint contact uses model precision, independent of zoom or the screen pick radius.
  const positions = [...endpoints].flatMap(id => {
    const g = entities.get(id)?.geometry;
    return g?.type === "point" ? [{id, point: g.position}] : [];
  }).sort((a,b) => a.point[0]-b.point[0]);
  for (let i=0;i<positions.length;i++) for (let j=i+1;j<positions.length && positions[j].point[0]-positions[i].point[0]<=1e-7;j++) {
    if (Math.hypot(positions[i].point[0]-positions[j].point[0],positions[i].point[1]-positions[j].point[1])<=1e-7) link(positions[i].id,positions[j].id);
  }
  const result = new Set<string>(), pending = entities.has(seed) ? [seed] : [];
  while (pending.length) {
    const id = pending.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    for (const next of links.get(id) ?? []) if (!result.has(next)) pending.push(next);
  }
  result.delete("origin");
  return result;
}

/** Visual relationships only; these sets never become command operands. */
export function constraintHighlights(state: SketchState, selected: ReadonlySet<string>) {
  const geometry = new Set<string>(), constraints = new Set<string>();
  const operands = new Set(selected), coincidentPoints = new Set<string>();
  for (const e of state.entities) if (selected.has(e.reference.id) && e.geometry.type === "line") {
    operands.add(e.geometry.from); operands.add(e.geometry.to);
  }
  for (const c of state.constraints) {
    const points = c.parameters.points ?? [], curves = c.parameters.curves ?? [];
    if ([...points, ...curves].some(r => operands.has(r.id))) constraints.add(c.id);
    if (!selected.has(c.id)) continue;
    for (const r of [...points, ...curves]) geometry.add(r.id);
    if (c.kind === "coincident" || c.kind === "pointOnCurve") for (const p of points) coincidentPoints.add(p.id);
  }
  let previousSize = -1;
  while (previousSize !== coincidentPoints.size) {
    previousSize = coincidentPoints.size;
    for (const c of state.constraints) if (c.kind === "coincident" && c.parameters.points?.some(p => coincidentPoints.has(p.id))) {
      for (const p of c.parameters.points) coincidentPoints.add(p.id);
    }
  }
  for (const p of coincidentPoints) geometry.add(p);
  for (const c of state.constraints) if (c.kind === "pointOnCurve" && c.parameters.points?.some(p => coincidentPoints.has(p.id))) {
    for (const r of c.parameters.curves ?? []) geometry.add(r.id);
  }
  for (const e of state.entities) {
    const g = e.geometry;
    const points = g.type === "line" ? [g.from, g.to] : g.type === "arc" ? [g.center, g.from, g.to]
      : g.type === "spline" ? g.points : "center" in g ? [g.center] : [];
    if (points.some(id => coincidentPoints.has(id))) geometry.add(e.reference.id);
  }
  return { geometry, constraints };
}
