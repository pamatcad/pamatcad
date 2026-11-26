import * as T from "three";
import type { SketchConstraint, SketchProxy, SketchState } from "@pamatcad/sdk";

export type ConstraintBucket = {
  key: string;
  kind: "point" | "line" | "circle";
  anchor: T.Vector3;
  direction?: T.Vector3;
  ring?: T.Vector3[];
  constraints: SketchConstraint[];
};
export const constraintIconSize = 14;
const spacing = 3, clearance = 6, toleranceSquared = 1e-12;

/** Model-space anchors only; the camera determines the final quadrant and clearance. */
export function constraintBuckets(state: SketchState, proxy: SketchProxy): ConstraintBucket[] {
  const entities = new Map(state.entities.map(e => [e.reference.id, e.geometry]));
  const curves = new Map(proxy.curves.map(c => [c.entity.id, c]));
  const origin = new T.Vector3(...proxy.frame.origin), u = new T.Vector3(...proxy.frame.u), v = new T.Vector3(...proxy.frame.v);
  const point = (id: string) => {
    const g = entities.get(id);
    return g?.type === "point" ? origin.clone().addScaledVector(u, g.position[0]).addScaledVector(v, g.position[1]) : undefined;
  };
  const line = (id: string) => {
    const g = entities.get(id);
    if (g?.type !== "line") return;
    const a = point(g.from), b = point(g.to);
    return a && b ? [a, b] as const : undefined;
  };
  const circular = (id: string) => {
    const g = entities.get(id);
    if (g?.type !== "circle" && g?.type !== "arc") return;
    const center = point(g.center);
    return center ? { center, radius: g.radius } : undefined;
  };
  const buckets = new Map<string, ConstraintBucket>(), pointBuckets: ConstraintBucket[] = [];
  const add = (bucket: ConstraintBucket, constraint: SketchConstraint) => {
    if (!bucket.constraints.some(c => c.id === constraint.id)) bucket.constraints.push(constraint);
    buckets.set(bucket.key, bucket);
  };
  const atPoint = (anchor: T.Vector3 | undefined, constraint: SketchConstraint) => {
    if (!anchor) return;
    let bucket = pointBuckets.find(b => b.anchor.distanceToSquared(anchor) <= toleranceSquared);
    if (!bucket) {
      bucket = { key: `point:${pointBuckets.length}`, kind: "point", anchor, constraints: [] };
      pointBuckets.push(bucket);
    }
    add(bucket, constraint);
  };
  const atCurve = (id: string, constraint: SketchConstraint) => {
    const existing = buckets.get(`curve:${id}`);
    if (existing) { add(existing, constraint); return; }
    const g = entities.get(id);
    if (!g || g.type === "point") return;
    let bucket: ConstraintBucket;
    if (g.type === "circle" || g.type === "arc" || g.type === "ellipse") {
      const center = point(g.center);
      if (!center) return;
      const major = g.type === "ellipse" ? g.major : g.radius, minor = g.type === "ellipse" ? g.minor : g.radius;
      const angle = g.type === "ellipse" ? g.angle : 0;
      const a = u.clone().multiplyScalar(Math.cos(angle)).addScaledVector(v, Math.sin(angle));
      const b = v.clone().multiplyScalar(Math.cos(angle)).addScaledVector(u, -Math.sin(angle));
      const ring = Array.from({ length: 64 }, (_, i) => center.clone().addScaledVector(a, major * Math.cos(i * Math.PI / 32)).addScaledVector(b, minor * Math.sin(i * Math.PI / 32)));
      bucket = { key: `curve:${id}`, kind: "circle", anchor: center, ring, constraints: [] };
    } else {
      const points = g.type === "line" ? line(id) : curves.get(id)?.points.map(p => new T.Vector3(...p));
      if (!points || points.length < 2) return;
      const lengths = points.slice(1).map((p, i) => p.distanceTo(points[i]));
      let remaining = lengths.reduce((a, b) => a + b, 0) / 2, index = 0;
      while (index < lengths.length - 1 && remaining > lengths[index]) remaining -= lengths[index++];
      const direction = points[index + 1].clone().sub(points[index]);
      const anchor = points[index].clone().addScaledVector(direction, lengths[index] ? remaining / lengths[index] : 0);
      bucket = { key: `curve:${id}`, kind: "line", anchor, direction, constraints: [] };
    }
    add(bucket, constraint);
  };
  for (const c of state.constraints) {
    if (c.id.endsWith("-fixed")) continue;
    const points = c.parameters.points ?? [], refs = c.parameters.curves ?? [];
    switch (c.kind) {
      case "coincident": case "pointOnCurve": case "symmetric":
        points.forEach(p => atPoint(point(p.id), c));
        break;
      case "concentric":
        refs.forEach(r => { const g = entities.get(r.id); if (g && "center" in g) atPoint(point(g.center), c); });
        break;
      case "horizontal": case "vertical": case "fix":
        points.forEach(p => atPoint(point(p.id), c));
        refs.forEach(r => atCurve(r.id, c));
        break;
      case "perpendicular": {
        const a = refs[0] && line(refs[0].id), b = refs[1] && line(refs[1].id);
        const shared = a && b && a.find(p => b.some(q => p.distanceToSquared(q) <= toleranceSquared));
        if (shared) atPoint(shared, c);
        else refs.forEach(r => atCurve(r.id, c));
        break;
      }
      case "tangent": {
        const circles = refs.map(r => circular(r.id)).filter(c => !!c);
        const segment = refs.map(r => line(r.id)).find(l => !!l);
        if (segment && circles.length) {
          const direction = segment[1].clone().sub(segment[0]);
          const t = circles[0].center.clone().sub(segment[0]).dot(direction) / direction.lengthSq();
          atPoint(segment[0].clone().addScaledVector(direction, t), c);
        } else if (circles.length === 2) {
          const [a, b] = circles, direction = b.center.clone().sub(a.center).normalize();
          const candidates = [1, -1].map(sign => a.center.clone().addScaledVector(direction, sign * a.radius));
          candidates.sort((p, q) => Math.abs(p.distanceTo(b.center) - b.radius) - Math.abs(q.distanceTo(b.center) - b.radius));
          atPoint(candidates[0], c);
        }
        break;
      }
      case "equal": case "parallel": case "collinear": case "midpoint":
        refs.forEach(r => atCurve(r.id, c));
    }
  }
  for (const bucket of buckets.values()) bucket.constraints.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return [...buckets.values()];
}

/** Keep each square block at its geometry anchor, independent of nearby geometry. */
export function layoutConstraintBuckets(buckets: ConstraintBucket[], camera: T.Camera, width: number, height: number) {
  if (!buckets.length) return [];
  const project = (p: T.Vector3) => {
    const q = p.clone().project(camera);
    return { x: (q.x + 1) * width / 2, y: (1 - q.y) * height / 2, z: q.z };
  };
  return buckets.map(bucket => {
    const anchor = project(bucket.anchor), columns = Math.ceil(Math.sqrt(bucket.constraints.length));
    const size = columns * constraintIconSize + (columns - 1) * spacing;
    let dx = 1, dy = -1;
    if (bucket.ring) {
      const ring = bucket.ring.map(project);
      anchor.x = Math.max(...ring.map(p => p.x)); anchor.y = Math.min(...ring.map(p => p.y));
    } else if (bucket.direction) {
      const end = project(bucket.anchor.clone().add(bucket.direction));
      const length = Math.hypot(end.x - anchor.x, end.y - anchor.y);
      if (length > 1e-6) {
        dx = (end.y - anchor.y) / length; dy = -(end.x - anchor.x) / length;
        if (dy > 1e-6 || Math.abs(dy) <= 1e-6 && dx < 0) { dx = -dx; dy = -dy; }
      }
    }
    const offset = bucket.kind === "line" ? clearance + size / 2 * (Math.abs(dx) + Math.abs(dy)) : clearance + size / 2;
    const box = { x: anchor.x + dx * offset, y: anchor.y + dy * offset, w: size, h: size };
    return { bucket, box, columns, positions: bucket.constraints.map((constraint, index) => ({
      constraint,
      x: box.x - size / 2 + constraintIconSize / 2 + index % columns * (constraintIconSize + spacing),
      y: box.y + size / 2 - constraintIconSize / 2 - Math.floor(index / columns) * (constraintIconSize + spacing),
      z: anchor.z,
    })) };
  });
}
