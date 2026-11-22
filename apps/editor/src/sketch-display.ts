import * as T from "three";
import type { SketchProxy, SketchState } from "@pamatcad/sdk";
import type { ThemeDefinition } from "./theme";
export type SketchPick = {
  kind: "geometry" | "dimension" | "constraint";
  id: string;
};
export type SketchDisplayOptions = {
  lines: boolean;
  points: boolean;
  constraints: boolean;
  dimensions: boolean;
  construction: boolean;
  projections: boolean;
  highlight: "all" | "constrained" | "partial" | "unconstrained";
};
export const sketchDisplayDefaults: SketchDisplayOptions = { lines: true, points: true, constraints: true, dimensions: true, construction: true, projections: true, highlight: "all" };
const symbols: Record<string, string> = { coincident: "●", fix: "⊙", equal: "=", horizontal: "H", vertical: "V", parallel: "∥", perpendicular: "⊥", tangent: "T", concentric: "◎", midpoint: "M", symmetric: "↔", collinear: "—", pointOnCurve: "⊙" };
export class SketchDisplay extends T.Group {
  inputs: { element: HTMLElement; position: [number, number, number] }[] = [];
  private labels: T.Sprite[] = [];
  private pointTexture: T.CanvasTexture;
  constructor() {
    super();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "white";
    ctx.beginPath();
    ctx.arc(16, 16, 12, 0, Math.PI * 2);
    ctx.fill();
    this.pointTexture = new T.CanvasTexture(canvas);
  }
  clearDisplay() {
    this.traverse(node => {
      if (node instanceof T.Line || node instanceof T.Points || node instanceof T.Sprite) {
        if ("geometry" in node) {
          node.geometry.dispose();
        }
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) {
          if (material.map && material.map !== this.pointTexture) {
            material.map.dispose();
          }
          material.dispose();
        }
      }
    });
    this.clear();
    this.labels = [];
  }
  set(state: SketchState, proxy: SketchProxy, selected: Set<string>, options: SketchDisplayOptions, theme: ThemeDefinition, hover?: string) {
    this.clearDisplay();
    const positions = new Map(proxy.points.map(p => [p.entity.id, new T.Vector3(...p.position)]));
    const entities = new Map(state.entities.map(e => [e.reference.id, e]));
    const linked = (id: string) => {
      const geometry = entities.get(id)?.geometry;
      if (!geometry) {
        return [];
      }
      if (geometry.type === "point") {
        return [id];
      }
      if (geometry.type === "line") {
        return [geometry.from, geometry.to];
      }
      if (geometry.type === "spline") {
        return geometry.points;
      }
      return [geometry.center];
    };
    const center = (id: string): T.Vector3 => {
      const points = linked(id).map(id => positions.get(id)).filter((p): p is T.Vector3 => !!p);
      return points.length ? points.reduce((sum, p) => sum.add(p), new T.Vector3()).multiplyScalar(1 / points.length) : new T.Vector3(...proxy.frame.origin);
    };
    const color = (id: string, projected: boolean) => {
      if (selected.has(id) || id === hover) {
        return theme.colors.highlight;
      }
      if (projected) {
        return theme.colors.foregroundMuted;
      }
      const freedom = state.status.entities.find(e => e.entity.id === id);
      const status = !freedom || freedom.degreesOfFreedom === 0 ? "constrained" : freedom.degreesOfFreedom < freedom.unconstrainedDegreesOfFreedom ? "partial" : "unconstrained";
      if (options.highlight !== "all" && options.highlight !== status) {
        return theme.colors.constructionEdge;
      }
      return status === "constrained" ? theme.colors.success : status === "partial" ? theme.colors.handleEdge : theme.colors.sketchHighlight;
    };
    if (options.lines) {
      for (const curve of proxy.curves) {
        if (curve.construction && !options.construction || curve.projected && !options.projections) {
          continue;
        }
        const material = curve.construction ? new T.LineDashedMaterial({ color: color(curve.entity.id, curve.projected), dashSize: 1, gapSize: 0.7, depthTest: false }) : new T.LineBasicMaterial({ color: color(curve.entity.id, curve.projected), depthTest: false });
        const line = new T.Line(new T.BufferGeometry().setFromPoints(curve.points.map(p => new T.Vector3(...p))), material);
        line.computeLineDistances();
        line.userData.pick = { kind: "geometry", id: curve.entity.id };
        line.renderOrder = 10;
        this.add(line);
      }
    }
    if (options.points) {
      for (const point of proxy.points) {
        if (point.construction && !options.construction || point.projected && !options.projections) {
          continue;
        }
        const marker = new T.Points(new T.BufferGeometry().setFromPoints([new T.Vector3(...point.position)]), new T.PointsMaterial({ color: color(point.entity.id, point.projected), size: selected.has(point.entity.id) ? 9 : 7, map: this.pointTexture, alphaTest: 0.4, sizeAttenuation: false, depthTest: false }));
        marker.userData.pick = { kind: "geometry", id: point.entity.id };
        marker.renderOrder = 11;
        this.add(marker);
      }
    }
    if (options.dimensions) {
      for (const dimension of state.dimensions) {
        const p = dimension.parameters;
        const references = [...(p.points ?? []), ...(p.curves ?? []), ...(p.line ? [p.line] : []), ...(p.curve ? [p.curve] : [])];
        if (!references.length) {
          continue;
        }
        const location = references.map(r => center(r.id)).reduce((sum, p) => sum.add(p), new T.Vector3()).multiplyScalar(1 / references.length);
        location.addScaledVector(new T.Vector3(...proxy.frame.v), 1.5);
        const value = Number(dimension.computed.value.toPrecision(6));
        this.label(`${dimension.parameters.name ? dimension.parameters.name + " = " : ""}${dimension.parameters.mode === "driven" ? "(" : ""}${value} ${dimension.computed.unit}${dimension.parameters.mode === "driven" ? ")" : ""}`, location, { kind: "dimension", id: dimension.id }, selected.has(dimension.id) ? theme.colors.highlight : theme.colors.foreground, theme);
      }
    }
    if (options.constraints) {
      for (const constraint of state.constraints) {
        if (constraint.id.endsWith("-fixed")) {
          continue;
        }
        const references = [...(constraint.parameters.points ?? []), ...(constraint.parameters.curves ?? [])];
        if (!references.length) {
          continue;
        }
        const location = references.map(r => center(r.id)).reduce((sum, p) => sum.add(p), new T.Vector3()).multiplyScalar(1 / references.length);
        location.addScaledVector(new T.Vector3(...proxy.frame.u), -1);
        const shared = references.every(r => selected.has(r.id) || [...selected].some(id => linked(id).includes(r.id)));
        this.label(symbols[constraint.kind] ?? constraint.kind, location, { kind: "constraint", id: constraint.id }, shared || selected.has(constraint.id) ? theme.colors.highlight : theme.colors.foregroundMuted, theme);
      }
    }
  }
  private label(text: string, position: T.Vector3, pick: SketchPick, color: string, theme: ThemeDefinition) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    ctx.font = `24px ${theme.typography.fontFamily}`;
    canvas.width = Math.ceil(ctx.measureText(text).width) + 12;
    canvas.height = 36;
    ctx.font = `24px ${theme.typography.fontFamily}`;
    ctx.fillStyle = theme.colors.panelBackground;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    ctx.fillText(text, 6, 18);
    const texture = new T.CanvasTexture(canvas);
    texture.colorSpace = T.SRGBColorSpace;
    const sprite = new T.Sprite(new T.SpriteMaterial({ map: texture, depthTest: false, transparent: true, toneMapped: false }));
    sprite.position.copy(position);
    sprite.userData.anchor = position.clone();
    sprite.userData.pick = pick;
    sprite.userData.width = canvas.width / 2;
    sprite.userData.height = 18;
    sprite.renderOrder = 12;
    this.labels.push(sprite);
    this.add(sprite);
  }
  updateScale(scale: number, camera: T.Camera, width: number, height: number) {
    const placed: {
      x: number;
      y: number;
      w: number;
      h: number;
    }[] = [];
    for (const { element, position } of this.inputs) {
      const p = new T.Vector3(...position).project(camera);
      const w = element.offsetWidth, h = element.offsetHeight;
      const x = Math.max(w / 2 + 4, Math.min(width - w / 2 - 4, (p.x + 1) * width / 2));
      let y = Math.max(h / 2 + 4, Math.min(height - h / 2 - 4, (1 - p.y) * height / 2));
      while (placed.some(r => Math.abs(r.x - x) < (r.w + w) / 2 && Math.abs(r.y - y) < (r.h + h) / 2)) y += h + 4;
      element.style.left = x + "px";
      element.style.top = y + "px";
      placed.push({ x, y, w, h });
    }
    for (const label of this.labels) {
      label.scale.set(label.userData.width * scale, label.userData.height * scale, 1);
      const projected = (label.userData.anchor as T.Vector3).clone().project(camera);
      const x = (projected.x + 1) * width / 2, y = (1 - projected.y) * height / 2;
      let chosen = { x, y, w: label.userData.width + 6, h: label.userData.height + 4 };
      for (let attempt = 0; attempt < 24; attempt++) {
        const offset = attempt === 0 ? 0 : Math.ceil(attempt / 2) * 24 * (attempt % 2 ? 1 : -1);
        chosen = { ...chosen, y: y + offset };
        if (!placed.some(p => Math.abs(p.x - chosen.x) < (p.w + chosen.w) / 2 && Math.abs(p.y - chosen.y) < (p.h + chosen.h) / 2)) {
          break;
        }
      }
      placed.push(chosen);
      label.position.set(chosen.x / width * 2 - 1, 1 - chosen.y / height * 2, projected.z).unproject(camera);
    }
  }
  picks(ray: T.Raycaster): SketchPick[] {
    const result: SketchPick[] = [];
    // Match visible stacking: a label drawn over geometry is the first selection.
    const hits = ray.intersectObjects(this.children, false).sort((a, b) =>
      b.object.renderOrder - a.object.renderOrder || a.distance - b.distance);
    for (const hit of hits) {
      const pick = hit.object.userData.pick as SketchPick | undefined;
      if (pick && !result.some(p => p.id === pick.id && p.kind === pick.kind)) {
        result.push(pick);
      }
    }
    return result;
  }
}
