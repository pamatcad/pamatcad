import type { Primitive, SketchEntity, SketchState } from "@pamatcad/sdk";
import type { Point } from "../viewport";
export const variants = {
  select: ["Select"], point: ["Point"], line: ["Two points"],
  rectangle: ["Two corners", "Three points", "Centered"],
  circle: ["Center and radius", "Two points and radius", "Three points", "Two tangents and radius", "Three tangents"],
  arc: ["Center, point and angle", "Three points"],
  ellipse: ["Center, width and height", "Rectangle", "Center, side point and radius"],
  slot: ["Three points", "Center and line", "Center to center"],
  spline: ["Fit points", "Control points"], text: ["Text"],
  dimension: ["Dimension"],
  project: ["Project"], offset: ["One sided", "Symmetric", "Independent"], rounding: ["Fillet"],
  scale: ["Scale"], move: ["Move and rotate"], split: ["Split"], remove: ["Remove"],
} as const;
export type SketchToolName = keyof typeof variants;
export function drawingClicks(tool: SketchToolName, variant: number) {
  if (tool === "point" || tool === "text" || tool === "circle" && variant >= 3) return 1;
  if (tool === "arc" || tool === "rectangle" && variant === 1 || tool === "circle" && [1, 2].includes(variant) || tool === "ellipse" && variant === 2 || tool === "slot") return 3;
  return 2;
}
export type DrawingFields = {
  width: number;
  height: number;
  radius: number;
  radiusTyped?: boolean;
  widthTyped?: boolean;
  heightTyped?: boolean;
  angle: number;
  text: string;
  size: import("@pamatcad/sdk").Formula<import("@pamatcad/sdk").LengthUnit>;
  fontIndex?: number;
  fontFamily?: string;
  italic?: boolean;
  weight: number;
  fontBase64?: string;
  horizontal?: "left" | "center" | "right";
  vertical?: "baseline" | "bottom" | "middle" | "top";
};
export const distance = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);
export const bearing = (a: Point, b: Point) => Math.atan2(b[1] - a[1], b[0] - a[0]);
const degrees = (n: number) => n * 180 / Math.PI;
function circumcircle(a: Point, b: Point, c: Point) {
  const x = b[0] - a[0], y = b[1] - a[1], u = c[0] - a[0], v = c[1] - a[1];
  const d = 2 * (x * v - y * u);
  if (Math.abs(d) < 1e-9) {
    throw new Error("Choose three non-collinear points.");
  }
  const center: Point = [a[0] + (v * (x * x + y * y) - y * (u * u + v * v)) / d, a[1] + (x * (u * u + v * v) - u * (x * x + y * y)) / d];
  return { center, radius: distance(a, center) };
}
export function pointOf(state: SketchState, id: string): Point {
  const e = state.entities.find(e => e.reference.id === id);
  if (e?.geometry.type !== "point") {
    throw new Error("Select a point.");
  }
  return e.geometry.position;
}
/** Constructors produce ordinary core primitives. Persistent relations are added by the tool. */
export function drawing(tool: SketchToolName, variant: number, points: Point[], f: DrawingFields, construction: boolean, selected: SketchEntity[], state: SketchState): Primitive {
  const a = points[0] ?? [0, 0], b = points[1] ?? [a[0] + f.width, a[1] + f.height], c = points[2];
  switch (tool) {
    case "point": return { type: "point", parameters: { position: a, construction } };
    case "line": return { type: "line", parameters: { from: a, to: b, construction } };
    case "rectangle": {
      let to = b, angle = 0;
      if (variant === 1) {
        angle = bearing(a, b);
        const height = c ? -(c[0] - b[0]) * Math.sin(angle) + (c[1] - b[1]) * Math.cos(angle) : f.height;
        to = [a[0] + distance(a, b), a[1] + height];
      }
      return { type: "rectangle", parameters: { from: a, to, centered: variant === 2, angle: degrees(angle), construction } };
    }
    case "circle": {
      let center = a, radius = points[1] ? distance(a, b) : f.radius;
      if (variant === 1 || variant === 2 && f.radiusTyped) {
        radius = f.radius;
        const d = distance(a, b);
        const offset = c && d ? ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / d : 0;
        if (!f.radiusTyped) radius = c ? Math.hypot(d / 2, offset) : Math.max(radius, d / 2);
        if (!d || d > 2 * radius) {
          throw new Error("Radius must be at least half the distance between the points.");
        }
        const h = Math.sqrt(radius * radius - d * d / 4);
        const side = offset < 0 ? -1 : 1;
        center = [(a[0] + b[0]) / 2 - side * (b[1] - a[1]) * h / d, (a[1] + b[1]) / 2 + side * (b[0] - a[0]) * h / d];
      }
      else if (variant === 2) {
        if (!c) {
          throw new Error("Pick three points.");
        }
        ({ center, radius } = circumcircle(a, b, c));
      }
      else if (variant >= 3) {
        ({ center, radius } = tangentCircle(selected, state, a, f.radius, variant === 3));
      }
      return { type: "circle", parameters: { center, diameter: 2 * radius, construction } };
    }
    case "arc": {
      let center = a, radius = points[1] ? distance(a, b) : f.radius;
      let start = degrees(bearing(a, b)), sweep = c ? (degrees(bearing(a, c)) - start + 360) % 360 : f.angle;
      if (variant === 1) {
        if (!c) {
          throw new Error("Pick three points.");
        }
        ({ center, radius } = circumcircle(a, b, c));
        start = degrees(bearing(center, a));
        const end = degrees(bearing(center, b));
        const middle = (degrees(bearing(center, c)) - start + 360) % 360;
        sweep = (end - start + 360) % 360;
        if (middle > sweep) {
          sweep -= 360;
        }
      }
      // Keep three-point arcs counterclockwise; explicit center-arc angles retain their sign.
      if (variant === 1 && sweep < 0) { start += sweep; sweep = -sweep; }
      const end = start + sweep;
      return { type: "arc", parameters: { center, radius, start, end, construction } };
    }
    case "ellipse": {
      let center = a, width = f.width, height = f.height;
      if (variant === 2) {
        const angle = bearing(a, b);
        width = f.widthTyped ? f.width : 2 * distance(a, b);
        height = f.heightTyped ? f.height : c ? 2 * Math.abs(-(c[0] - a[0]) * Math.sin(angle) + (c[1] - a[1]) * Math.cos(angle)) : f.height;
        return { type: "ellipse", parameters: { center, major: Math.max(width, height) / 2, minor: Math.min(width, height) / 2, angle: degrees(angle) + (width >= height ? 0 : 90), construction } };
      }
      if (points[1]) {
        width = Math.abs(b[0] - a[0]) * (variant === 0 ? 2 : 1);
        height = Math.abs(b[1] - a[1]) * (variant === 0 ? 2 : 1);
        if (variant === 1) {
          center = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        }
      }
      return { type: "ellipse", parameters: { center, major: Math.max(width, height) / 2, minor: Math.min(width, height) / 2, angle: width >= height ? 0 : 90, construction } };
    }
    case "slot": {
      let from = a, to = b;
      if (variant === 1) {
        from = [2 * a[0] - b[0], 2 * a[1] - b[1]];
      }
      const length = distance(a, b);
      if (length <= 1e-7) throw new Error("Choose two distinct points for the slot axis.");
      const u: Point = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
      const radius = c ? Math.abs(u[0] * (c[1] - a[1]) - u[1] * (c[0] - a[0])) : f.radius;
      if (radius <= 1e-7) throw new Error("Slot radius must be positive.");
      if (variant === 0) {
        if (2 * radius >= length - 1e-7) throw new Error("Slot diameter must be less than the distance between its outer tips.");
        from = [a[0] + radius * u[0], a[1] + radius * u[1]];
        to = [b[0] - radius * u[0], b[1] - radius * u[1]];
      }
      return { type: "slot", parameters: { from, to, radius, construction } };
    }
    case "spline": {
      const all = [...points];
      const closed = all.length > 2 && distance(all[0], all.at(-1)!) < 1e-7;
      return { type: "spline", parameters: { points: all, fit: variant === 0, closed, construction } };
    }
    case "text": return { type: "text", parameters: { text: f.text, origin: a, size: f.size, weight: f.weight, fontBase64: f.fontBase64, fontIndex: f.fontIndex, fontFamily: f.fontFamily, italic: f.italic, horizontal: f.horizontal, vertical: f.vertical, guide: selected.find(e => e.geometry.type !== "point")?.reference, construction } };
    default: throw new Error("Choose a drawing tool.");
  }
}
/** Solve the signed tangency branches nearest the cursor; the core validates the resulting constraints. */
function tangentCircle(curves: SketchEntity[], state: SketchState, seed: Point, radius: number, fixedRadius: boolean) {
  const count = fixedRadius ? 2 : 3;
  if (curves.length !== count) {
    throw new Error(`Select ${count} lines or circles, then pick a center near the wanted solution.`);
  }
  const signedDistance = curves.map(({ geometry: g }) => {
    if (g.type === "line") {
      const a = pointOf(state, g.from), b = pointOf(state, g.to), d = distance(a, b);
      return (x: number, y: number) => ((x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0])) / d;
    }
    if (g.type === "circle" || g.type === "arc") {
      const a = pointOf(state, g.center);
      return (x: number, y: number) => Math.hypot(x - a[0], y - a[1]) - g.radius;
    }
    throw new Error("Tangent-circle construction accepts lines, circles and arcs.");
  });
  let best: {
    center: Point;
    radius: number;
    score: number;
  } | undefined;
  for (let branch = 0; branch < 1 << count; branch++) {
    let values = [seed[0], seed[1], radius];
    const residual = (v: number[]) => signedDistance.map((d, i) => d(v[0], v[1]) - (branch & 1 << i ? 1 : -1) * v[2]);
    for (let iteration = 0; iteration < 50; iteration++) {
      const r = residual(values), n = fixedRadius ? 2 : 3;
      if (Math.max(...r.map(Math.abs)) < 1e-7) {
        break;
      }
      const rows = r.map((value, i) => [...Array(n)].map((_, j) => {
        const next = [...values];
        next[j] += 1e-5;
        return (residual(next)[i] - value) / 1e-5;
      }).concat(-value));
      let singular = false;
      for (let k = 0; k < n; k++) {
        let pivot = k;
        for (let i = k + 1; i < n; i++) {
          if (Math.abs(rows[i][k]) > Math.abs(rows[pivot][k])) {
            pivot = i;
          }
        }
        [rows[k], rows[pivot]] = [rows[pivot], rows[k]];
        const divisor = rows[k][k];
        if (Math.abs(divisor) < 1e-10) {
          singular = true;
          break;
        }
        for (let j = k; j <= n; j++) {
          rows[k][j] /= divisor;
        }
        for (let i = 0; i < n; i++) {
          if (i !== k) {
            const factor = rows[i][k];
            for (let j = k; j <= n; j++) {
              rows[i][j] -= factor * rows[k][j];
            }
          }
        }
      }
      if (singular) {
        break;
      }
      values = values.map((v, i) => i < n ? v + rows[i][n] : v);
    }
    const [x, y, r] = values;
    if (r > 1e-7 && values.every(Number.isFinite) && Math.max(...residual(values).map(Math.abs)) < 1e-6) {
      const score = Math.hypot(x - seed[0], y - seed[1]);
      if (!best || score < best.score) {
        best = { center: [x, y], radius: r, score };
      }
    }
  }
  if (!best) {
    throw new Error("No tangent circle near this point. Choose another position or radius.");
  }
  return best;
}
