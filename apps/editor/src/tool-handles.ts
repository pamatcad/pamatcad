import * as T from "three";
import { SVGLoader, type StrokeStyle } from "three/addons/loaders/SVGLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import lengthArrow from "./icons/handle-length.svg?raw";
import sketchArrow from "./icons/handle-sketch-length.svg?raw";
import moveAxis from "./icons/handle-move-axis.svg?raw";
import moveRotate from "./icons/handle-move-rotate.svg?raw";
import movePlane from "./icons/handle-move-plane.svg?raw";
import type { FormulaUnit } from "@pamatcad/sdk";
import { lengthStep, unitScale } from "./formula-input";

type XYZ = [number, number, number];
export type ToolHandle = {
  id: string;
  label: string;
  kind: "length" | "angle" | "plane";
  origin: XYZ;
  direction: XYZ;
  tangent: XYZ;
  value: number;
  unit: FormulaUnit;
  /** World travel per input unit (one half for symmetric total length). */
  factor?: number;
  style?: "thin" | "move";
  value2?: number;
  activate?(): void;
  begin?(): void;
  inputs?: { element: HTMLElement; offset: [number, number] }[];
  /** Change the gesture direction without relocating the handle. */
  dragSign?: 1 | -1;
  min?: number;
  max?: number;
  change(value: number, second?: number): void;
  finish?(cancelled: boolean): void;
  reposition?: {
    start(event: PointerEvent): boolean;
    move(event: PointerEvent): void;
    finish(cancelled: boolean): void;
  };
  showLabel?: boolean;
};

/** Screen-sized 3D controls. Pointer capture takes precedence over camera orbit. */
export class ToolHandles {
  readonly group = new T.Group();
  private items: ToolHandle[] = [];
  private drag?: { handle: ToolHandle; pointer: number; start: T.Vector2; axis: T.Vector2; scale: number; step: number; value: number;
    reposition?: boolean; requested?: number; requested2?: number; second?: number; plane?: { plane: T.Plane; start: T.Vector3 }; angular?: { center: T.Vector2; a: T.Vector2; b: T.Vector2; start: number; last: number; total: number } };
  private ray = new T.Raycaster();
  private labels = new Map<string, HTMLButtonElement>();

  constructor(private host: HTMLElement, private canvas: HTMLCanvasElement,
    private camera: () => T.Camera, private orbit: (enabled: boolean) => void, private render: () => void,
    public color: string, public edgeColor: string) {
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const bounds = canvas.getBoundingClientRect();
      this.ray.setFromCamera(new T.Vector2((event.clientX - bounds.left) / bounds.width * 2 - 1,
        1 - (event.clientY - bounds.top) / bounds.height * 2), camera());
      const hit = this.ray.intersectObjects(this.group.children, true)[0];
      if (!hit) return;
      let object: T.Object3D | null = hit.object;
      while (object && !object.userData.handle) object = object.parent;
      const handle = object?.userData.handle as ToolHandle | undefined;
      if (handle) this.start(event, handle);
    }, true);
    canvas.addEventListener("pointermove", (event) => this.move(event), true);
    const stop = (event: PointerEvent) => {
      if (!this.drag || this.drag.pointer !== event.pointerId) return;
      if (event.type === "pointerup") this.move(event);
      event.stopImmediatePropagation();
      const handle = this.drag.handle;
      const reposition = this.drag.reposition;
      this.drag = undefined;
      this.orbit(true);
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      this.render();
      if (reposition) handle.reposition?.finish(event.type !== "pointerup");
      else handle.finish?.(event.type !== "pointerup");
    };
    canvas.addEventListener("pointerup", stop, true);
    canvas.addEventListener("pointercancel", stop, true);
    canvas.addEventListener("lostpointercapture", stop, true);
  }

  private project(point: T.Vector3): T.Vector2 {
    const p = point.clone().project(this.camera());
    return new T.Vector2((p.x + 1) * this.canvas.clientWidth / 2, (1 - p.y) * this.canvas.clientHeight / 2);
  }

  private mmPerPixel(point: T.Vector3): number {
    const camera = this.camera();
    if (camera instanceof T.OrthographicCamera) return (camera.top - camera.bottom) / camera.zoom / this.canvas.clientHeight;
    if (camera instanceof T.PerspectiveCamera) {
      const depth = -point.clone().applyMatrix4(camera.matrixWorldInverse).z;
      return 2 * Math.max(depth, camera.near) * Math.tan(T.MathUtils.degToRad(camera.fov / 2)) / this.canvas.clientHeight;
    }
    return 1;
  }

  private start(event: PointerEvent, handle: ToolHandle) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const origin = new T.Vector3(...handle.origin);
    const direction = new T.Vector3(...handle.direction);
    const tip = origin.clone().addScaledVector(direction, handle.style !== "move" && handle.kind === "length" ? handle.value * (handle.factor ?? 1) : 0);
    const mm = this.mmPerPixel(tip);
    let axis = this.project(tip.clone().addScaledVector(direction, mm * 100)).sub(this.project(tip));
    // Looking along the axis still permits a predictable vertical drag.
    const projected = axis.length();
    if (projected < 10) axis = new T.Vector2(0, -1);
    else axis.normalize();
    const scale = handle.kind === "angle" ? 1 : (projected < 10 ? mm : mm * 100 / projected) / (handle.factor ?? 1);
    if (handle.kind === "angle") axis = new T.Vector2(1, 0);
    this.drag = { handle, pointer: event.pointerId, start: new T.Vector2(event.clientX, event.clientY), axis, scale,
      step: handle.kind === "angle" ? 5 : lengthStep(scale, this.canvas.clientHeight, handle.unit, handle.value), value: handle.value };
    this.drag.second = handle.value2;
    if (handle.kind === "plane") {
      const plane = new T.Plane().setFromNormalAndCoplanarPoint(direction.clone().cross(new T.Vector3(...handle.tangent)).normalize(), origin);
      const bounds = this.canvas.getBoundingClientRect();
      this.ray.setFromCamera(new T.Vector2((event.clientX-bounds.left)/bounds.width*2-1,1-(event.clientY-bounds.top)/bounds.height*2),this.camera());
      const start = this.ray.ray.intersectPlane(plane,new T.Vector3());
      if (!start) { this.drag = undefined; return; }
      this.drag.plane = { plane, start };
    }
    if (event.altKey && handle.reposition) {
      if (!handle.reposition.start(event)) { this.drag = undefined; return; }
      this.drag.reposition = true;
    }
    if (handle.kind === "angle") {
      const bounds = this.canvas.getBoundingClientRect();
      const center = this.project(origin).add(new T.Vector2(bounds.left, bounds.top));
      const a = this.project(origin.clone().addScaledVector(direction, mm * 42)).sub(this.project(origin));
      const b = this.project(origin.clone().addScaledVector(new T.Vector3(...handle.tangent), mm * 42)).sub(this.project(origin));
      if (Math.abs(a.cross(b)) > 20) {
        const start = this.angle(new T.Vector2(event.clientX, event.clientY).sub(center), a, b);
        this.drag.angular = { center, a, b, start, last: start, total: 0 };
      }
    }
    this.orbit(false);
    this.canvas.setPointerCapture(event.pointerId);
    handle.begin?.();
    handle.activate?.();
  }

  private move(event: PointerEvent) {
    const drag = this.drag;
    if (!drag || drag.pointer !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (drag.reposition) { drag.handle.reposition!.move(event); this.render(); return; }
    if (drag.plane) {
      const bounds = this.canvas.getBoundingClientRect();
      this.ray.setFromCamera(new T.Vector2((event.clientX-bounds.left)/bounds.width*2-1,1-(event.clientY-bounds.top)/bounds.height*2),this.camera());
      const point = this.ray.ray.intersectPlane(drag.plane.plane,new T.Vector3());
      if (!point) return;
      const delta = point.sub(drag.plane.start);
      const x = drag.value + Math.round(delta.dot(new T.Vector3(...drag.handle.direction))/drag.step)*drag.step;
      const y = (drag.second ?? 0) + Math.round(delta.dot(new T.Vector3(...drag.handle.tangent))/drag.step)*drag.step;
      if ((x !== drag.requested || y !== drag.requested2) && (x !== drag.value || y !== drag.second || drag.requested !== undefined)) {
        drag.requested = x; drag.requested2 = y; drag.handle.change(x,y);
      }
      return;
    }
    let delta = new T.Vector2(event.clientX, event.clientY).sub(drag.start).dot(drag.axis) * drag.scale;
    if (drag.angular) {
      const { center, a, b, start } = drag.angular;
      const angle = this.angle(new T.Vector2(event.clientX, event.clientY).sub(center), a, b);
      if (drag.handle.style === "move") {
        drag.angular.total += Math.atan2(Math.sin(angle-drag.angular.last),Math.cos(angle-drag.angular.last));
        drag.angular.last = angle; delta = T.MathUtils.radToDeg(drag.angular.total);
      } else delta = T.MathUtils.radToDeg(Math.atan2(Math.sin(angle-start), Math.cos(angle-start)));
    }
    let value = drag.handle.style === "move" ? drag.value + Math.round(delta / drag.step) * drag.step : Math.round((drag.value + delta * (drag.handle.dragSign ?? 1)) / drag.step) * drag.step;
    if (drag.handle.kind === "angle" && drag.handle.style !== "move") value = Math.max(drag.handle.min ?? -85, Math.min(drag.handle.max ?? 85, value));
    if (drag.handle.min !== undefined) value = Math.max(drag.handle.min, value);
    if (drag.handle.max !== undefined) value = Math.min(drag.handle.max, value);
    if (drag.handle.style === "move") {
      if (value !== drag.requested && (value !== drag.value || drag.requested !== undefined)) { drag.requested = value; drag.handle.change(value); }
      return;
    }
    if (value === drag.handle.value) return;
    drag.handle.value = value;
    const current = this.items.find((item) => item.id === drag.handle.id);
    if (current) current.value = value;
    drag.handle.change(value);
    this.render();
  }

  private angle(point: T.Vector2, a: T.Vector2, b: T.Vector2) {
    const determinant = a.cross(b);
    return Math.atan2(a.cross(point) / determinant, point.cross(b) / determinant);
  }

  private updateMove(item: ToolHandle) {
    const origin = new T.Vector3(...item.origin), u = new T.Vector3(...item.direction), v = new T.Vector3(...item.tangent);
    const mm = this.mmPerPixel(origin), angle = item.kind === "angle" ? T.MathUtils.degToRad(item.value) : 0;
    let group = this.group.children.find(node => node.userData.handle.id === item.id);
    if (!group) {
      group = new T.Group();
      const material = (role: "ink" | "fill" | "pick") => {
        const result = new T.MeshBasicMaterial({color:role === "fill" ? this.color : this.edgeColor,side:T.DoubleSide,depthTest:false,depthWrite:false,transparent:true,opacity:role === "pick" ? 0 : 1});
        result.userData.role = role; return result;
      };
      const paths = new SVGLoader().parse(item.kind === "angle" ? moveRotate : item.kind === "plane" ? movePlane : moveAxis).paths;
      for (const path of paths) {
        const style = path.userData!.style as StrokeStyle & { fill?: string; stroke?: string };
        if (style.fill && style.fill !== "none") {
          const fill = new T.Mesh(new T.ShapeGeometry(SVGLoader.createShapes(path)).scale(1,-1,1),material(style.fill === "#fff" ? "fill" : "ink"));
          fill.raycast = () => {}; group.add(fill);
        }
        if (style.stroke && style.stroke !== "none") for (const subpath of path.subPaths) {
          const line = new T.Mesh(SVGLoader.pointsToStroke(subpath.getPoints(),style).scale(1,-1,1),material("ink"));
          line.raycast = () => {}; group.add(line);
          if (item.kind === "angle") group.add(new T.Mesh(SVGLoader.pointsToStroke(subpath.getPoints(),{...style,strokeWidth:16}).scale(1,-1,1),material("pick")));
        }
      }
      if (item.kind !== "angle") group.add(new T.Mesh(new T.PlaneGeometry(item.kind === "plane" ? 28 : 42,28).translate(item.kind === "plane" ? 18 : 92,item.kind === "plane" ? 18 : 0,0),material("pick")));
      group.children.forEach(node => { node.renderOrder = 20; }); this.group.add(group);
    }
    group.userData.handle = item;
    group.position.copy(origin); group.scale.setScalar(mm);
    group.quaternion.setFromRotationMatrix(new T.Matrix4().makeBasis(u,v,u.clone().cross(v))).multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(0,0,1),angle));
    for (const node of group.children) if (node instanceof T.Mesh) node.material.color.set(node.material.userData.role === "fill" ? this.color : this.edgeColor);
    const anchor = origin.clone();
    if (item.kind === "angle") anchor.addScaledVector(u,mm*64*Math.cos(Math.PI/4+angle)).addScaledVector(v,mm*64*Math.sin(Math.PI/4+angle));
    else if (item.kind === "plane") anchor.addScaledVector(u,mm*18).addScaledVector(v,mm*18);
    else anchor.addScaledVector(u,mm*96);
    const p = this.project(anchor);
    let label = this.labels.get(item.id);
    if (!label) {
      label = document.createElement("button"); label.type = "button"; label.className = "tool-move-access"; label.dataset.handle = item.id;
      label.onpointerdown = event => { const current = this.items.find(h => h.id === item.id); if (current) this.start(event,current); };
      label.onfocus = () => this.items.find(h => h.id === item.id)?.activate?.();
      label.onkeydown = event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault(); const current = this.items.find(h => h.id === item.id); current?.activate?.();
        const field = this.items.find(h => h.id === item.id)?.inputs?.[0]?.element.querySelector("input"); field?.focus(); field?.select();
      };
      this.labels.set(item.id,label); this.host.append(label);
    }
    label.dataset.tooltip = item.label; label.setAttribute("aria-label",item.label);
    label.style.left = p.x+"px"; label.style.top = p.y+"px"; label.hidden = anchor.clone().project(this.camera()).z > 1;
    for (const {element,offset} of item.inputs ?? []) {
      const x = Math.max(element.offsetWidth/2+4,Math.min(this.canvas.clientWidth-element.offsetWidth/2-4,p.x+offset[0]));
      const y = Math.max(element.offsetHeight/2+4,Math.min(this.canvas.clientHeight-element.offsetHeight/2-4,p.y+offset[1]));
      element.style.left=x+"px"; element.style.top=y+"px";
    }
  }

  set(items: ToolHandle[]) {
    if (this.drag && !items.some((item) => item.id === this.drag!.handle.id)) {
      this.drag = undefined;
      this.orbit(true);
    }
    this.items = items;
    for (const group of [...this.group.children]) {
      const previous = group.userData.handle as ToolHandle;
      if (items.some((item) => item.id === previous.id && item.kind === previous.kind && item.style === previous.style)) continue;
      group.traverse((object) => {
        if (object instanceof T.Mesh || object instanceof T.Line) {
          object.geometry.dispose();
          object.material.dispose();
        }
      });
      group.removeFromParent();
    }
    for (const [id, label] of this.labels) if (!items.some((item) => item.id === id)) { label.remove(); this.labels.delete(id); }
  }

  update() {
    for (const supplied of this.items) {
      if (supplied.style === "move") { this.updateMove(supplied); continue; }
      const item = this.drag?.handle.id === supplied.id && !this.drag.reposition ? this.drag.handle : supplied;
      const origin = new T.Vector3(...item.origin), direction = new T.Vector3(...item.direction).normalize();
      const tip = origin.clone().addScaledVector(direction, item.kind === "length" ? item.value * (item.factor ?? 1) : 0);
      const mm = this.mmPerPixel(tip);
      let group = this.group.children.find((node) => node.userData.handle.id === item.id);
      if (!group) {
        group = new T.Group();
        // Geometry stays in pixel-sized units; the group supplies its world scale.
        const material = new T.MeshBasicMaterial({ color: this.color, depthTest: false, depthWrite: false, side: T.DoubleSide, transparent: true });
        if (item.kind === "length") {
          const path = new SVGLoader().parse(lengthArrow).paths[0];
          const fill = new T.ShapeGeometry(SVGLoader.createShapes(path)).scale(1, -1, 1);
          // The existing broad arrow remains an invisible pick target for thin arrows.
          if (item.style === "thin") material.opacity = 0;
          group.add(new T.Mesh(fill, material));
          const stroke = item.style === "thin" ? new SVGLoader().parse(sketchArrow).paths[0] : path;
          const parts = stroke.subPaths.map(p => SVGLoader.pointsToStroke(p.getPoints(), stroke.userData!.style as StrokeStyle));
          const outline = mergeGeometries(parts)!.scale(1, -1, 1);
          parts.forEach(p => p.dispose());
          const ink = material.clone(); ink.opacity = 1;
          group.add(new T.Mesh(outline, ink));
          const connector = new T.BufferGeometry();
          connector.setAttribute("position", new T.Float32BufferAttribute(new Float32Array(6), 3));
          connector.setAttribute("lineDistance", new T.Float32BufferAttribute([0, 0], 1));
          const line = new T.Line(connector, new T.LineDashedMaterial({ color: this.edgeColor, dashSize: 2, gapSize: 4, depthTest: false, depthWrite: false }));
          line.raycast = () => {};
          group.add(line);
        } else {
          const translucent = material.clone();
          translucent.transparent = true;
          translucent.opacity = 0.45;
          group.add(new T.Mesh(new T.CircleGeometry(28, 64), translucent));
          const sector = new T.CircleGeometry(28, 64);
          // Keep the full disk bounds as the sweep changes, including across zero.
          sector.computeBoundingSphere();
          (sector.attributes.position as T.BufferAttribute).setUsage(T.DynamicDrawUsage);
          group.add(new T.Mesh(sector, material));
          group.add(new T.Mesh(new T.RingGeometry(27, 28.5, 64), material.clone()));
          group.add(new T.Mesh(new T.CircleGeometry(5.5, 24), material.clone()));
          group.add(new T.Mesh(new T.RingGeometry(4.5, 5.5, 24), material.clone()));
        }
        group.children.forEach((node, index) => { node.renderOrder = 10 + index; });
        this.group.add(group);
      }
      group.userData.handle = item;
      group.scale.setScalar(mm * (item.kind === "angle" ? 1.5 : 1));
      for (const [index, child] of group.children.entries()) if (child instanceof T.Mesh || child instanceof T.Line) {
        const filled = item.kind === "length" ? index === 0 : index === 0 || index === 1 || index === 3;
        child.material.color.set(filled ? this.color : this.edgeColor);
      }
      if (item.kind === "length") {
        group.position.copy(tip);
        const axis = this.project(tip.clone().addScaledVector(direction, mm * 100 * (item.value < 0 ? -1 : 1))).sub(this.project(tip));
        const rotation = axis.length() < 10 ? (item.value < 0 ? Math.PI : 0) : Math.atan2(-axis.x, -axis.y);
        group.quaternion.copy(this.camera().quaternion).multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 0, 1), rotation));
        group.updateMatrix();
        const start = origin.clone().applyMatrix4(group.matrix.clone().invert());
        const line = group.children[2] as T.Line<T.BufferGeometry, T.LineDashedMaterial>;
        line.geometry.attributes.position.setXYZ(0, start.x, start.y, start.z);
        line.geometry.attributes.position.needsUpdate = true;
        line.geometry.attributes.lineDistance.setX(1, start.length());
        line.geometry.attributes.lineDistance.needsUpdate = true;
        line.geometry.computeBoundingSphere();
      } else {
        const tangent = new T.Vector3(...item.tangent).normalize();
        const normal = new T.Vector3().crossVectors(direction, tangent).normalize();
        group.position.copy(origin);
        group.quaternion.setFromRotationMatrix(new T.Matrix4().makeBasis(direction, tangent, normal));
        const angle = T.MathUtils.degToRad(item.value);
        const sector = group.children[1] as T.Mesh<T.CircleGeometry>;
        sector.visible = angle !== 0;
        const points = sector.geometry.attributes.position;
        for (let i = 1; i < points.count; i++) {
          const theta = angle * (i - 1) / (points.count - 2);
          points.setXYZ(i, Math.cos(theta) * 28, Math.sin(theta) * 28, 0);
        }
        points.needsUpdate = true;
        for (const knob of group.children.slice(3)) knob.position.set(Math.cos(angle) * 28, Math.sin(angle) * 28, 0);
      }
      let label = this.labels.get(item.id);
      if (!label) {
        label = document.createElement("button");
        label.type = "button";
        label.className = "tool-handle-label";
        label.dataset.handle = item.id;
        label.onpointerdown = (event) => { const current = this.items.find((h) => h.id === item.id); if (current) this.start(event, current); };
        label.onkeydown = (event) => {
          const current = this.items.find((h) => h.id === item.id);
          if (!current || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
          event.preventDefault();
          const step = current.kind === "angle" ? 5 : lengthStep(this.mmPerPixel(new T.Vector3(...current.origin)), this.canvas.clientHeight, current.unit, current.value);
          current.change(current.value + (["ArrowUp", "ArrowRight"].includes(event.key) ? step : -step));
        };
        this.labels.set(item.id, label);
        this.host.append(label);
      }
      const text = `${Number((item.value / unitScale[item.unit]).toPrecision(6))}${item.unit === "scalar" ? "×" : " " + item.unit}`;
      if (label.textContent !== text) label.textContent = text;
      label.title = item.label;
      label.dataset.kind = item.kind;
      label.setAttribute("aria-label", "Drag " + item.label);
      const p = this.project(item.kind === "length" ? origin.clone().lerp(tip, 0.5) : origin);
      const halfWidth = label.offsetWidth / 2, halfHeight = label.offsetHeight / 2;
      label.style.left = Math.max(halfWidth, Math.min(this.canvas.clientWidth - halfWidth, p.x)) + "px";
      label.style.top = Math.max(halfHeight, Math.min(this.canvas.clientHeight - halfHeight, p.y)) + "px";
      label.hidden = item.showLabel === false || tip.clone().project(this.camera()).z > 1;
    }
  }
}
