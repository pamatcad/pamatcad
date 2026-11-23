import type { DimensionKind, DimensionParameters, SketchDimension, SketchEntityRef, SketchState } from "@pamatcad/sdk";
import { pointOf, distance } from "./tools/sketch-geometry";
import type { Point } from "./viewport";

/** Round numeric presentation only; expressions and stored values retain their precision. */
export function formatDimension(value: number | string): string {
  if (typeof value === "number") return String(Number(value.toFixed(4)));
  const literal = value.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(\s*(?:mm|cm|m|in|deg|rad))?$/i);
  return literal ? formatDimension(Number(literal[1])) + (literal[2] ?? "") : value;
}

const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const mul = (a: Point, n: number): Point => [a[0] * n, a[1] * n];
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1];
const cross = (a: Point, b: Point) => a[0] * b[1] - a[1] * b[0];
const unit = (a: Point): Point => mul(a, 1 / (Math.hypot(...a) || 1));
const normal = (a: Point): Point => [-a[1], a[0]];
const tau = Math.PI * 2;
const positive = (a: number) => (a % tau + tau) % tau;
const geometry = (state: SketchState, ref?: SketchEntityRef) => state.entities.find(e => e.reference.id === ref?.id)?.geometry;
const line = (state: SketchState, ref?: SketchEntityRef): [Point, Point] | undefined => {
  const g = geometry(state, ref);
  return g?.type === "line" ? [pointOf(state, g.from), pointOf(state, g.to)] : undefined;
};
const intersection = (a: [Point, Point], b: [Point, Point]): Point | undefined => {
  const u = sub(a[1], a[0]), v = sub(b[1], b[0]), d = cross(u, v);
  return Math.abs(d) < 1e-12 ? undefined : add(a[0], mul(u, cross(sub(b[0], a[0]), v) / d));
};

/** Only meaningful alternatives for the current selection are offered in the context menu. */
export function dimensionChoices(state: SketchState, ids: Set<string>): DimensionKind[] {
  const entities = [...ids].map(id => state.entities.find(e => e.reference.id === id)).filter(e => !!e);
  const types = entities.map(e => e.geometry.type);
  if (entities.length === 1) {
    if (types[0] === "line") return ["length", "horizontalDistance", "verticalDistance", "angle"];
    if (types[0] === "circle") return ["radius", "diameter"];
    if (types[0] === "arc") return ["radius", "diameter", "angle"];
    if (types[0] === "ellipse") return ["majorRadius", "minorRadius", "angle"];
  }
  if (entities.length === 2) {
    if (types.every(t => t === "point")) return ["distance", "horizontalDistance", "verticalDistance"];
    if (types.includes("point") && types.includes("line")) return ["distance"];
    if (types.every(t => t === "line")) {
      const a = line(state, entities[0].reference)!, b = line(state, entities[1].reference)!;
      return Math.abs(cross(unit(sub(a[1], a[0])), unit(sub(b[1], b[0])))) <= 1e-7 ? ["distance"] : ["angle"];
    }
  }
  return [];
}

/** Local inference/measurement is for annotation previews; the core validates and solves on commit. */
export function inferDimension(state: SketchState, ids: Set<string>, position?: Point, override?: DimensionKind): { kind: DimensionKind; parameters: DimensionParameters; value: number } | undefined {
  const choices = dimensionChoices(state, ids), kind = override && choices.includes(override) ? override : choices[0];
  if (!kind) return;
  const entities = [...ids].map(id => state.entities.find(e => e.reference.id === id)).filter(e => !!e);
  const points = entities.filter(e => e.geometry.type === "point").map(e => e.reference);
  const curves = entities.filter(e => e.geometry.type !== "point").map(e => e.reference);
  const parameters: DimensionParameters = { mode: "driving", ...(position ? { annotation: { position } } : {}) };
  let value = 0;
  if (entities.length === 1) {
    const e = entities[0], g = e.geometry;
    if (g.type === "line") {
      parameters.line = e.reference;
      const a = pointOf(state, g.from), b = pointOf(state, g.to), v = sub(b, a);
      if (kind === "horizontalDistance" || kind === "verticalDistance") {
        parameters.points = [g.from, g.to].map(id => state.entities.find(e => e.reference.id === id)!.reference);
        delete parameters.line;
        if (v[kind === "horizontalDistance" ? 0 : 1] < 0) parameters.points.reverse();
        value = Math.abs(v[kind === "horizontalDistance" ? 0 : 1]);
      } else value = kind === "angle" ? Math.atan2(v[1], v[0]) * 180 / Math.PI : distance(a, b);
    } else if (g.type === "circle" || g.type === "arc" || g.type === "ellipse") {
      parameters.curve = e.reference;
      value = g.type === "ellipse" ? kind === "angle" ? g.angle * 180 / Math.PI : kind === "minorRadius" ? g.minor : g.major : kind === "angle" && g.type === "arc" ? (g.end - g.start) * 180 / Math.PI : g.radius * (kind === "diameter" ? 2 : 1);
    }
  } else if (points.length === 2) {
    parameters.points = points;
    const a = pointOf(state, points[0].id), b = pointOf(state, points[1].id);
    if (kind !== "distance" && b[kind === "horizontalDistance" ? 0 : 1] < a[kind === "horizontalDistance" ? 0 : 1]) parameters.points.reverse();
    value = kind === "distance" ? distance(a, b) : Math.abs(b[kind === "horizontalDistance" ? 0 : 1] - a[kind === "horizontalDistance" ? 0 : 1]);
  } else if (points.length === 1) {
    parameters.points = points; parameters.line = curves[0];
    const [a, b] = line(state, curves[0])!;
    value = Math.abs(cross(unit(sub(b, a)), sub(pointOf(state, points[0].id), a)));
  } else {
    parameters.curves = curves;
    const a = line(state, curves[0])!, b = line(state, curves[1])!, u = unit(sub(a[1], a[0])), v = unit(sub(b[1], b[0]));
    if (kind === "distance") value = Math.abs(cross(u, sub(b[0], a[0])));
    else {
      const signed = Math.atan2(cross(u, v), dot(u, v));
      const origin = intersection(a, b)!;
      // A cursor chooses one of the four sectors of the two infinite lines.
      const base = Math.atan2(u[1], u[0]), cursor = position ? Math.atan2(position[1] - origin[1], position[0] - origin[0]) : base + signed / 2;
      const rays = [base, base + Math.PI, base + signed, base + signed + Math.PI].map(positive).sort((a, b) => a - b);
      const start = rays.findLast(r => r <= positive(cursor)) ?? rays.at(-1)!;
      const end = rays[(rays.indexOf(start) + 1) % 4];
      const span = positive(end - start), direct = Math.abs(span - Math.abs(signed)) < 1e-7;
      parameters.angleBranch = direct ? signed >= 0 ? "direct" : "reversed" : signed >= 0 ? "supplementary" : "reversedSupplementary";
      value = span * 180 / Math.PI;
    }
  }
  return { kind, parameters, value };
}

export type DimensionLayout = { segments: [Point, Point][]; arrows: { tip: Point; direction: Point }[]; label: Point; prefix: string };
/** Layout uses sketch millimetres; the renderer supplies screen-scaled arrowheads. */
export function dimensionLayout(state: SketchState, dimension: Pick<SketchDimension, "kind" | "parameters">): DimensionLayout | undefined {
  const { kind, parameters: p } = dimension;
  const result: DimensionLayout = { segments: [], arrows: [], label: [0, 0], prefix: "" };
  const segment = (a: Point, b: Point) => result.segments.push([a, b]);
  const arrow = (tip: Point, direction: Point) => result.arrows.push({ tip, direction: unit(direction) });
  const linear = (a: Point, b: Point, direction = unit(sub(b, a))) => {
    if (Math.hypot(...direction) < 1e-9) direction = [1, 0];
    const n = normal(direction), mid = mul(add(a, b), 0.5);
    result.label = p.annotation?.position ?? add(mid, mul(n, 1.5));
    const at = add(a, mul(n, dot(sub(result.label, a), n))), bt = add(b, mul(n, dot(sub(result.label, b), n)));
    segment(a, at); segment(b, bt); segment(at, bt);
    const t = dot(sub(result.label, at), direction), extent = dot(sub(bt, at), direction);
    if (t < Math.min(0, extent)) segment(at, result.label);
    else if (t > Math.max(0, extent)) segment(bt, result.label);
    const inward = unit(sub(bt, at)); arrow(at, inward); arrow(bt, mul(inward, -1));
  };
  const angular = (center: Point, start: number, span: number, radius = 5) => {
    result.label = p.annotation?.position ?? add(center, [Math.cos(start + span / 2) * radius, Math.sin(start + span / 2) * radius]);
    radius = Math.max(distance(result.label, center), 1e-6);
    const at = (angle: number): Point => add(center, [Math.cos(angle) * radius, Math.sin(angle) * radius]);
    const count = Math.max(8, Math.ceil(Math.abs(span) * 20));
    for (let i = 0; i < count; i++) segment(at(start + span * i / count), at(start + span * (i + 1) / count));
    segment(center, at(start)); segment(center, at(start + span));
    arrow(at(start), mul([-Math.sin(start), Math.cos(start)], Math.sign(span)));
    arrow(at(start + span), mul([Math.sin(start + span), -Math.cos(start + span)], Math.sign(span)));
  };
  const g = geometry(state, p.curve), a = line(state, p.line ?? p.curves?.[0]);
  if (kind === "angle") {
    if (p.curves?.length === 2 && a) {
      const b = line(state, p.curves[1]); if (!b) return;
      const center = intersection(a, b) ?? mul(add(a[0], b[0]), 0.5);
      const u = sub(a[1], a[0]), v = sub(b[1], b[0]), base = Math.atan2(u[1], u[0]), signed = Math.atan2(cross(u, v), dot(u, v));
      const branch = p.angleBranch ?? "direct";
      const span = branch === "direct" ? signed : branch === "reversed" ? -signed : branch === "supplementary" ? Math.PI - signed : Math.PI + signed;
      let start = branch === "direct" || branch === "reversedSupplementary" ? base : base + signed;
      if (branch === "reversedSupplementary") start += Math.PI;
      if (p.annotation) {
        const cursor = Math.atan2(p.annotation.position[1] - center[1], p.annotation.position[0] - center[0]);
        const difference = (x: number) => Math.abs(Math.atan2(Math.sin(cursor - x), Math.cos(cursor - x)));
        if (difference(start + span / 2 + Math.PI) < difference(start + span / 2)) start += Math.PI;
      }
      angular(center, start, span);
    } else if (g?.type === "arc") angular(pointOf(state, g.center), g.start, g.end - g.start, g.radius + 1.5);
    else if (g?.type === "ellipse") angular(pointOf(state, g.center), 0, g.angle, g.major + 1.5);
    else if (a) angular(a[0], 0, Math.atan2(a[1][1] - a[0][1], a[1][0] - a[0][0]), distance(...a) / 2);
    else return;
  } else if (g && (g.type === "circle" || g.type === "arc" || g.type === "ellipse")) {
    const center = pointOf(state, g.center);
    const radius = g.type === "ellipse" ? kind === "minorRadius" ? g.minor : g.major : g.radius;
    const angle = g.type === "ellipse" ? g.angle + (kind === "minorRadius" ? Math.PI / 2 : 0) : g.type === "arc" ? (g.start + g.end) / 2 : Math.PI / 4;
    result.label = p.annotation?.position ?? add(center, [Math.cos(angle) * (radius + 3), Math.sin(angle) * (radius + 3)]);
    let direction = g.type === "ellipse" ? [Math.cos(angle), Math.sin(angle)] as Point : unit(sub(result.label, center));
    if (g.type === "arc" && Math.abs(g.end - g.start) < tau) {
      const cursorAngle = Math.atan2(direction[1], direction[0]), sign = Math.sign(g.end - g.start);
      if (positive((cursorAngle - g.start) * sign) > Math.abs(g.end - g.start)) {
        const delta = (a: number) => Math.abs(Math.atan2(Math.sin(cursorAngle - a), Math.cos(cursorAngle - a)));
        const endpoint = delta(g.start) < delta(g.end) ? g.start : g.end;
        direction = [Math.cos(endpoint), Math.sin(endpoint)];
      }
    }
    const tip = add(center, mul(direction, radius));
    const opposite = kind === "diameter" ? sub(center, mul(direction, radius)) : center;
    segment(opposite, tip); segment(tip, result.label); arrow(tip, mul(direction, -1));
    if (kind === "diameter") arrow(opposite, direction);
    result.prefix = kind === "diameter" ? "Ø" : "R";
  } else if (p.points?.length === 2) {
    linear(pointOf(state, p.points[0].id), pointOf(state, p.points[1].id), kind === "horizontalDistance" ? [1, 0] : kind === "verticalDistance" ? [0, 1] : undefined);
  } else if (a && p.points?.length === 1) {
    const point = pointOf(state, p.points[0].id), u = unit(sub(a[1], a[0]));
    const projection = dot(sub(point, a[0]), u), foot = add(a[0], mul(u, projection));
    linear(foot, point);
    if (projection < 0) segment(a[0], foot);
    else if (projection > distance(...a)) segment(a[1], foot);
  } else if (a && p.curves?.length === 2) {
    const b = line(state, p.curves[1]); if (!b) return;
    const u = unit(sub(a[1], a[0])), n = normal(u), origin = p.annotation?.position ?? mul(add(a[0], b[0]), 0.5);
    const start = add(a[0], mul(u, dot(sub(origin, a[0]), u))), end = add(start, mul(n, dot(sub(b[0], a[0]), n)));
    linear(start, end);
    segment(a[0], start); segment(b[0], end);
  } else if (a) linear(...a);
  else return;
  return result;
}
