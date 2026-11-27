import * as T from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { dimensionLayout, formatDimension } from "./sketch-dimensions";
import { constraintBuckets, constraintIconSize, layoutConstraintBuckets, type ConstraintBucket } from "./sketch-constraint-layout";
import { constraintHighlights } from "./tools/sketch-constraints";
import type { ConstraintKind, SketchProxy, SketchState } from "@pamatcad/sdk";
import type { ThemeDefinition } from "./theme";
export type SketchPick = {
  kind: "geometry" | "dimension" | "constraint" | "text";
  id: string;
};
export type SketchDisplayOptions = {
  lines: boolean;
  points: boolean;
  constraints: boolean;
  dimensions: boolean;
  construction: boolean;
  projections: boolean;
  highlight: "none" | "constrained" | "partial" | "unconstrained";
};
export const sketchDisplayDefaults: SketchDisplayOptions = { lines: true, points: true, constraints: true, dimensions: true, construction: true, projections: true, highlight: "none" };
const constraintIcons = import.meta.glob<string>("./icons/sketch-constraint-*.svg", { query: "?raw", import: "default", eager: true });
export class SketchDisplay extends T.Group {
  inputs: { element: HTMLElement; position: [number, number, number]; dimension?: string }[] = [];
  private labels: T.Sprite[] = [];
  private arrows: { line: T.LineSegments; tip: T.Vector3; direction: T.Vector3; normal: T.Vector3 }[] = [];
  private pointTexture: T.CanvasTexture;
  private squarePointTexture: T.CanvasTexture;
  private buckets: ConstraintBucket[] = [];
  private constraintSprites = new Map<string, T.Sprite>();
  private iconTextures = new Map<string, T.Texture>();
  private iconTheme = "";
  constructor(private invalidate: () => void = () => {}) {
    super();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "white";
    ctx.beginPath();
    ctx.arc(16, 16, 12, 0, Math.PI * 2);
    ctx.fill();
    this.pointTexture = new T.CanvasTexture(canvas);
    const square = document.createElement("canvas");
    square.width = square.height = 32;
    const squareContext = square.getContext("2d")!;
    squareContext.fillStyle = "white"; squareContext.fillRect(4,4,24,24);
    this.squarePointTexture = new T.CanvasTexture(square);
  }
  clearDisplay() {
    this.traverse(node => {
      if (node instanceof T.Line || node instanceof T.Points || node instanceof T.Sprite || node instanceof LineSegments2) {
        if ("geometry" in node) {
          node.geometry.dispose();
        }
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) {
          if ("map" in material && material.map instanceof T.Texture && material.map !== this.pointTexture && material.map !== this.squarePointTexture && ![...this.iconTextures.values()].includes(material.map)) {
            material.map.dispose();
          }
          material.dispose();
        }
      }
    });
    this.clear();
    this.labels = [];
    this.arrows = [];
    this.buckets = [];
    this.constraintSprites.clear();
  }
  set(state: SketchState, proxy: SketchProxy, selected: Set<string>, options: SketchDisplayOptions, theme: ThemeDefinition, hover?: string) {
    this.clearDisplay();
    const textOwners = new Map(state.texts.flatMap(t => [...t.geometry.points, ...t.geometry.curves].map(r => [r.id, t.id] as const)));
    selected = new Set([...selected, ...[...textOwners].filter(([, owner]) => selected.has(owner)).map(([id]) => id)]);
    for (const text of state.texts) if (selected.has(text.id)) for (const ref of Object.values(text.frame ?? {})) selected.add(ref.id);
    const related = constraintHighlights(state, selected);
    const relatedColor = "#" + new T.Color(theme.colors.geometrySelected).convertLinearToSRGB()
      .lerp(new T.Color(theme.colors.background).convertLinearToSRGB(), 0.5).convertSRGBToLinear().getHexString();
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
    const fixed = new Set(state.constraints.filter(c => c.kind === "fix").flatMap(c =>
      [...(c.parameters.points ?? []), ...(c.parameters.curves ?? [])].flatMap(r => {
        const geometry = entities.get(r.id)?.geometry;
        return [r.id, ...linked(r.id), ...(geometry?.type === "arc" ? [geometry.from, geometry.to] : [])];
      })));
    const freedoms = new Map(state.status.entities.map(e => [e.entity.id, e]));
    const textFreedom = new Map(state.texts.filter(t => t.frame).map(t => [t.id, {
      degreesOfFreedom: freedoms.get(t.frame!.left.id)?.degreesOfFreedom ?? 3,
      unconstrainedDegreesOfFreedom: 3,
    }]));
    const color = (id: string, projected: boolean) => {
      if (selected.has(id) || id === hover || textOwners.get(id) === hover && hover !== undefined) {
        return theme.colors.geometrySelected;
      }
      if (related.geometry.has(id)) return relatedColor;
      if (projected) {
        return theme.colors.foregroundMuted;
      }
      const freedom = textFreedom.get(textOwners.get(id) ?? id) ?? freedoms.get(id);
      const geometry = entities.get(id)?.geometry;
      const isFixed = fixed.has(id) || geometry?.type === "line" && linked(id).every(p => fixed.has(p));
      const status = isFixed || freedom?.degreesOfFreedom === 0 ? "constrained" : freedom && freedom.degreesOfFreedom < freedom.unconstrainedDegreesOfFreedom ? "partial" : "unconstrained";
      if (options.highlight === status) return theme.colors.geometryHighlight;
      if (isFixed) return theme.colors.fixed;
      return status === "constrained" ? theme.colors.constrained : status === "partial" ? theme.colors.partiallyConstrained : theme.colors.unconstrained;
    };
    if (options.lines) {
      for (const curve of proxy.curves) {
        if (curve.construction && !options.construction || curve.projected && !options.projections) {
          continue;
        }
        const material = curve.construction ? new T.LineDashedMaterial({ color: color(curve.entity.id, curve.projected), dashSize: 1, gapSize: 0.7, depthTest: false, toneMapped: false }) : new T.LineBasicMaterial({ color: color(curve.entity.id, curve.projected), depthTest: false, toneMapped: false });
        const line = new T.Line(new T.BufferGeometry().setFromPoints(curve.points.map(p => new T.Vector3(...p))), material);
        // Keep native curve picking; both visible widths use CSS pixels on high-DPI screens.
        material.visible = false;
        line.computeLineDistances();
        const owner = textOwners.get(curve.entity.id);
        line.userData.pick = owner ? { kind: "text", id: owner } : { kind: "geometry", id: curve.entity.id };
        line.renderOrder = selected.has(curve.entity.id) ? 10.5 : related.geometry.has(curve.entity.id) ? 10.25 : 10;
        this.add(line);
        const segments = curve.points.slice(1).flatMap((p, i) => [...curve.points[i], ...p]);
        const stroke = new LineSegments2(new LineSegmentsGeometry().setPositions(segments), new LineMaterial({
          color: material.color, linewidth: selected.has(curve.entity.id) ? 2 : related.geometry.has(curve.entity.id) ? 1.5 : 1, worldUnits: false, depthTest: false, depthWrite: false, transparent: true,
          toneMapped: false, dashed: curve.construction, dashSize: 1, gapSize: 0.7,
        }));
        stroke.computeLineDistances();
        stroke.raycast = () => {};
        stroke.userData.pick = line.userData.pick;
        stroke.renderOrder = line.renderOrder;
        this.add(stroke);
      }
    }
    if (options.points) {
      const independent = new Set(state.splines.flatMap(s => s.fitPoints.filter(p => p.mode === "independent").map(p => p.point.id)));
      for (const point of proxy.points) {
        if (textOwners.has(point.entity.id)) continue;
        if (point.construction && !options.construction || point.projected && !options.projections) {
          continue;
        }
        const marker = new T.Points(new T.BufferGeometry().setFromPoints([new T.Vector3(...point.position)]), new T.PointsMaterial({ color: color(point.entity.id, point.projected), size: selected.has(point.entity.id) ? 14 : related.geometry.has(point.entity.id) ? 10.5 : 7, map: independent.has(point.entity.id) ? this.squarePointTexture : this.pointTexture, alphaTest: 0.4, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, toneMapped: false }));
        marker.userData.pick = { kind: "geometry", id: point.entity.id };
        marker.renderOrder = selected.has(point.entity.id) ? 11.5 : related.geometry.has(point.entity.id) ? 11.25 : 11;
        this.add(marker);
      }
    }
    if (options.points) for (const text of state.texts) {
      if (text.parameters.construction && !options.construction) continue;
      const [x, y] = text.parameters.origin;
      const position = new T.Vector3(...proxy.frame.origin).addScaledVector(new T.Vector3(...proxy.frame.u), x).addScaledVector(new T.Vector3(...proxy.frame.v), y);
      const marker = new T.Points(new T.BufferGeometry().setFromPoints([position]), new T.PointsMaterial({ color: color(text.id, false), size: selected.has(text.id) ? 14 : 7, map: this.pointTexture, alphaTest: 0.4, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, toneMapped: false }));
      marker.userData.pick = { kind: "text", id: text.id }; marker.renderOrder = 10.9;
      this.add(marker);
    }
    if (options.dimensions) {
      for (const dimension of state.dimensions) {
        const layout = dimensionLayout(state, dimension);
        if (!layout) continue;
        const world = (p: [number, number]) => new T.Vector3(...proxy.frame.origin).addScaledVector(new T.Vector3(...proxy.frame.u), p[0]).addScaledVector(new T.Vector3(...proxy.frame.v), p[1]);
        const color = selected.has(dimension.id) || dimension.id === hover ? theme.colors.geometrySelected : theme.colors.foregroundStrong;
        const pick: SketchPick = { kind: "dimension", id: dimension.id };
        const lines = new T.LineSegments(new T.BufferGeometry().setFromPoints(layout.segments.flatMap(s => s.map(world))), new T.LineBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, toneMapped: false }));
        lines.userData.pick = pick;
        lines.renderOrder = 9;
        this.add(lines);
        for (const arrow of layout.arrows) {
          const line = new T.LineSegments(new T.BufferGeometry(), new T.LineBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, toneMapped: false }));
          line.userData.pick = pick; line.renderOrder = 9; this.add(line);
          this.arrows.push({ line, tip: world(arrow.tip), direction: new T.Vector3(...proxy.frame.u).multiplyScalar(arrow.direction[0]).addScaledVector(new T.Vector3(...proxy.frame.v), arrow.direction[1]), normal: new T.Vector3(...proxy.frame.normal) });
        }
        const value = formatDimension(dimension.computed.value);
        const unit = dimension.computed.unit === "deg" ? "°" : " " + dimension.computed.unit;
        this.label(`${dimension.parameters.name ? dimension.parameters.name + " = " : ""}${dimension.parameters.mode === "driven" ? "(" : ""}${layout.prefix}${value}${unit}${dimension.parameters.mode === "driven" ? ")" : ""}`, world(layout.label), pick, theme.colors.foregroundStrong, theme);
      }
    }
    if (options.constraints) {
      this.buckets = constraintBuckets(state, proxy);
      for (const bucket of this.buckets) for (const constraint of bucket.constraints) {
        const color = selected.has(constraint.id) || constraint.id === hover ? theme.colors.geometrySelected
          : related.constraints.has(constraint.id) ? relatedColor : undefined;
        const texture = this.constraintTexture(constraint.kind, color, theme);
        const sprite = new T.Sprite(new T.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false, transparent: true, toneMapped: false }));
        sprite.userData.pick = { kind: "constraint", id: constraint.id };
        sprite.userData.bucket = bucket.key;
        sprite.userData.icon = constraint.kind;
        sprite.renderOrder = 8.5;
        this.constraintSprites.set(`${bucket.key}:${constraint.id}`, sprite);
        this.add(sprite);
      }
    }
  }
  private constraintTexture(kind: ConstraintKind, emphasis: string | undefined, theme: ThemeDefinition): T.Texture {
    const palette = [theme.colors.edge, theme.colors.constructionEdge, theme.colors.geometryHighlight, theme.colors.geometrySelected, theme.colors.background].join("|");
    if (palette !== this.iconTheme) {
      for (const texture of this.iconTextures.values()) texture.dispose();
      this.iconTextures.clear(); this.iconTheme = palette;
    }
    const key = `${kind}:${emphasis ?? "normal"}`, cached = this.iconTextures.get(key);
    if (cached) return cached;
    const name = kind.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase());
    const source = constraintIcons[`./icons/sketch-constraint-${name}.svg`];
    const color = emphasis ?? theme.colors.edge;
    const style = `<style>.icon-solid-edge{stroke:${color}}.icon-solid-edge-fill{fill:${color}}.icon-construction{stroke:${emphasis ?? theme.colors.constructionEdge}}.icon-geometry-highlight{stroke:${emphasis ?? theme.colors.geometryHighlight}}</style>`;
    const image = new Image(), texture = new T.Texture(image);
    texture.colorSpace = T.SRGBColorSpace;
    image.onload = () => { texture.needsUpdate = true; this.invalidate(); };
    // Render the original editable SVG at 4× display resolution, including its fill/dash details.
    image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(source.replace("<svg ", '<svg width="72" height="72" ').replace(">", ">" + style));
    this.iconTextures.set(key, texture);
    return texture;
  }
  private label(text: string, position: T.Vector3, pick: SketchPick, color: string, theme: ThemeDefinition) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    ctx.font = `500 24px ${theme.typography.fontFamily}`;
    canvas.width = Math.ceil(ctx.measureText(text).width) + 12;
    canvas.height = 36;
    ctx.font = `500 24px ${theme.typography.fontFamily}`;
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
    for (const arrow of this.arrows) {
      const back = arrow.tip.clone().addScaledVector(arrow.direction, 7 * scale);
      const side = arrow.direction.clone().cross(arrow.normal).multiplyScalar(2.5 * scale);
      arrow.line.geometry.dispose();
      arrow.line.geometry = new T.BufferGeometry().setFromPoints([back.clone().add(side), arrow.tip, arrow.tip, back.clone().sub(side)]);
    }
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
      label.visible = label.userData.pick.kind !== "dimension" || !this.inputs.some(input => input.dimension === label.userData.pick.id);
      if (!label.visible) continue;
      label.scale.set(label.userData.width * scale, label.userData.height * scale, 1);
      const projected = (label.userData.anchor as T.Vector3).clone().project(camera);
      const x = (projected.x + 1) * width / 2, y = (1 - projected.y) * height / 2;
      const chosen = { x, y, w: label.userData.width + 6, h: label.userData.height + 4 };
      placed.push(chosen);
      label.position.set(chosen.x / width * 2 - 1, 1 - chosen.y / height * 2, projected.z).unproject(camera);
    }
    for (const layout of layoutConstraintBuckets(this.buckets, camera, width, height)) {
      for (const position of layout.positions) {
        const sprite = this.constraintSprites.get(`${layout.bucket.key}:${position.constraint.id}`)!;
        sprite.visible = Number.isFinite(position.x + position.y + position.z) && position.z >= -1 && position.z <= 1;
        if (!sprite.visible) continue;
        sprite.position.set(position.x / width * 2 - 1, 1 - position.y / height * 2, position.z).unproject(camera);
        const pixel = new T.Vector3((position.x + 1) / width * 2 - 1, 1 - position.y / height * 2, position.z).unproject(camera).distanceTo(sprite.position);
        sprite.scale.setScalar(constraintIconSize * pixel);
      }
    }
  }
  picks(ray: T.Raycaster): SketchPick[] {
    const result: SketchPick[] = [];
    // Match visible stacking: a label drawn over geometry is the first selection.
    const hits = ray.intersectObjects(this.children, false).sort((a, b) =>
      b.object.renderOrder - a.object.renderOrder || a.distance - b.distance);
    for (const hit of hits) {
      const pick = hit.object.userData.pick as SketchPick | undefined;
      if (pick?.kind === "constraint" && !hit.object.visible) continue;
      if (pick && !result.some(p => p.id === pick.id && p.kind === pick.kind)) {
        result.push(pick);
      }
    }
    return result;
  }
}
