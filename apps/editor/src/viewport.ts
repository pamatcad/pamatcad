import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { BodyProxy, EdgeRef, FaceRef } from "@pamatcad/sdk";
import type { ThemeDefinition } from "./theme";

export type Point = [number, number];
export type Rectangle = { from: Point; to: Point };
export type TopologyPick = { face: FaceRef } | { edge: EdgeRef };
type Hit = { point: Point | null; sketch?: string; body?: string; plane?: string; pick?: TopologyPick };
export type ViewState = {
  mode: "orthographic" | "perspective";
  position: [number, number, number];
  target: [number, number, number];
  span: number;
  zoom: number;
};

const iso = new T.Vector3(1, -1, 1);
const gizmoSize = 120;
const cubeSize = 1.45;
const xy = new T.Plane(new T.Vector3(0, 0, 1), 0);

function discard(group: T.Object3D) {
  group.traverse((object) => {
    if (object instanceof T.Mesh || object instanceof T.Line) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    }
  });
  group.clear();
}

function styleProfile(profile: T.Mesh<T.BufferGeometry, T.MeshBasicMaterial>, theme: ThemeDefinition) {
  const selected = profile.userData.selected;
  profile.material.color.set(selected ? theme.colors.selection : theme.colors.surface);
  profile.material.opacity = selected ? theme.opacity.selectedFill : theme.opacity.fill;
  for (const edge of profile.children) {
    if (edge instanceof T.Line) edge.material.color.set(theme.colors.accent);
  }
}

function rectangleObject({ from: [x, y], to: [u, v] }: Rectangle, selected: boolean, theme: ThemeDefinition) {
  const geometry = new T.PlaneGeometry(Math.abs(u - x), Math.abs(v - y));
  const profile = new T.Mesh(
    geometry,
    new T.MeshBasicMaterial({
      transparent: true,
      side: T.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    }),
  );
  profile.position.set((x + u) / 2, (y + v) / 2, 0);
  profile.add(
    new T.LineSegments(new T.EdgesGeometry(geometry), new T.LineBasicMaterial()),
  );
  profile.userData.selected = selected;
  styleProfile(profile, theme);
  return profile;
}

class SolidDisplay extends T.Mesh<T.BufferGeometry, T.MeshStandardMaterial[]> {
  private pick?: TopologyPick;

  constructor(
    readonly proxy: BodyProxy,
    private preview: boolean,
    private theme: ThemeDefinition,
  ) {
    const geometry = new T.BufferGeometry();
    geometry.setAttribute("position", new T.BufferAttribute(proxy.positions, 3));
    geometry.setAttribute("normal", new T.BufferAttribute(proxy.normals, 3));
    geometry.setIndex(new T.BufferAttribute(proxy.triangles, 1));
    geometry.addGroup(0, proxy.triangles.length, 0);
    const material = new T.MeshStandardMaterial({
      side: T.DoubleSide,
      roughness: 0.82,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const highlighted = material.clone();
    super(geometry, [material, highlighted]);
    for (const range of proxy.edges) {
      const line = new T.BufferGeometry();
      const begin = range.firstPoint * 3;
      line.setAttribute(
        "position",
        new T.BufferAttribute(proxy.edgePoints.subarray(begin, begin + range.pointCount * 3), 3),
      );
      const stroke = new T.LineBasicMaterial();
      const edge = range.closed ? new T.LineLoop(line, stroke) : new T.Line(line, stroke);
      edge.userData.edge = range.edge;
      this.add(edge);
    }
    this.setTheme(theme);
  }

  setTheme(theme: ThemeDefinition) {
    this.theme = theme;
    this.material[0].color.set(this.preview ? theme.colors.preview : theme.colors.surface);
    this.material[1].color.set(theme.colors.selection);
    const opacity = this.preview ? theme.opacity.preview : 1;
    for (const material of this.material) {
      material.opacity = opacity;
      if (material.transparent !== (opacity < 1)) material.needsUpdate = true;
      material.transparent = opacity < 1;
      material.depthWrite = opacity === 1;
    }
    for (const edge of this.children) {
      if (!(edge instanceof T.Line)) continue;
      const selected = this.pick && "edge" in this.pick && this.pick.edge.edgeId === edge.userData.edge.edgeId;
      edge.material.color.set(selected ? theme.colors.highlight : this.preview ? theme.colors.accent : theme.colors.edge);
      edge.material.opacity = opacity;
      if (edge.material.transparent !== (opacity < 1)) edge.material.needsUpdate = true;
      edge.material.transparent = opacity < 1;
      edge.material.depthWrite = opacity === 1;
    }
  }

  highlight(selected: boolean, pick?: TopologyPick) {
    this.pick = pick;
    const indices = this.proxy.triangles.length;
    this.geometry.clearGroups();
    const face = pick && "face" in pick ? pick.face : undefined;
    const range =
      face &&
      "faceId" in face &&
      this.proxy.faces.find((f) => "faceId" in f.face && f.face.faceId === face.faceId);
    if (range) {
      const start = range.firstTriangle * 3,
        count = range.triangleCount * 3;
      if (start) this.geometry.addGroup(0, start, 0);
      this.geometry.addGroup(start, count, 1);
      if (start + count < indices) this.geometry.addGroup(start + count, indices - start - count, 0);
    } else {
      this.geometry.addGroup(0, indices, selected && !pick ? 1 : 0);
    }
    this.setTheme(this.theme);
  }
}

function cubeFace(label: string, theme: ThemeDefinition, material = new T.MeshLambertMaterial({
  polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
})) {
  const canvas = (material.map?.image as HTMLCanvasElement | undefined) ?? document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const c = canvas.getContext("2d")!;
  c.fillStyle = theme.colors.panelBackground;
  c.fillRect(0, 0, 128, 128);
  c.strokeStyle = theme.colors.edge;
  c.lineWidth = 5;
  c.strokeRect(1, 1, 126, 126);
  c.fillStyle = theme.colors.foreground;
  c.font = `bold 25px ${theme.typography.fontFamily}`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(label, 64, 64);
  material.map ??= new T.CanvasTexture(canvas);
  material.map.colorSpace = T.SRGBColorSpace;
  material.map.needsUpdate = true;
  return material;
}

function cubeAxes(theme: ThemeDefinition) {
  const length = cubeSize * 1.18;
  const axes = new T.AxesHelper(length);
  axes.position.setScalar(-cubeSize / 2);
  // Keep the axis leading to a far corner visible through the cube at lower contrast.
  axes.add(new T.LineSegments(axes.geometry, new T.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: theme.opacity.occluded, depthFunc: T.GreaterDepth, depthWrite: false,
  })));
  for (let i = 0; i < 3; i++) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const map = new T.CanvasTexture(canvas);
    map.colorSpace = T.SRGBColorSpace;
    const label = new T.Sprite(new T.SpriteMaterial({ map, depthWrite: false }));
    label.userData.axis = i;
    label.position.setComponent(i, length + 0.16);
    label.scale.setScalar(0.36);
    axes.add(label);
  }
  return axes;
}

function styleAxes(axes: T.AxesHelper, theme: ThemeDefinition) {
  const colors = [theme.colors.axisX, theme.colors.axisY, theme.colors.axisZ] as const;
  axes.setColors(...colors);
  for (const child of axes.children) {
    if (child instanceof T.Line) child.material.opacity = theme.opacity.occluded;
    if (!(child instanceof T.Sprite)) continue;
    const map = child.material.map!;
    const canvas = map.image as HTMLCanvasElement;
    const c = canvas.getContext("2d")!;
    const i = child.userData.axis as number;
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.fillStyle = colors[i];
    c.font = `bold 48px ${theme.typography.fontFamily}`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText("XYZ"[i], 32, 32);
    map.needsUpdate = true;
  }
}

export class Viewport {
  readonly scene = new T.Scene();
  private renderer = new T.WebGLRenderer({ antialias: true });
  private orthographic = new T.OrthographicCamera(-30, 30, 30, -30, 0.01, 100000);
  private perspective = new T.PerspectiveCamera(45, 1, 0.01, 100000);
  private camera: T.OrthographicCamera | T.PerspectiveCamera = this.orthographic;
  private orbit: OrbitControls;
  private grid = new T.GridHelper(400, 80);
  private axes = new T.AxesHelper(14);
  private triad: T.AxesHelper;
  private sketches = new T.Group();
  private construction = new T.Group();
  private hidden = new Set<string>();
  private previewHidden = new Set<string>();
  private bodies = new T.Group();
  private draft = new T.Group();
  private preview = new T.Group();
  private gizmo = new T.Scene();
  private gizmoCamera = new T.OrthographicCamera(-1.75, 1.75, 1.75, -1.75, 0.1, 20);
  private cube: T.Mesh<T.BoxGeometry, T.MeshLambertMaterial[]>;
  private hemisphere = new T.HemisphereLight(undefined, undefined, 2);
  private light = new T.DirectionalLight(undefined, 2.1);
  private cubeLight = new T.DirectionalLight(undefined, 2.3);
  private ambient = new T.AmbientLight(undefined, 1.25);
  private ray = new T.Raycaster();
  private span = 60;
  private down = new T.Vector2();
  private sketchMode = false;

  constructor(
    private host: HTMLElement,
    onClick: (hit: Hit) => void,
    onMove: (point: Point | null) => void,
    private theme: ThemeDefinition,
  ) {
    this.triad = cubeAxes(theme);
    this.cube = new T.Mesh(
      // BoxGeometry's four upright side textures use Y-up. Rotate that frame into CAD's Z-up frame.
      new T.BoxGeometry(cubeSize, cubeSize, cubeSize).rotateX(Math.PI / 2),
      ["RIGHT", "LEFT", "TOP", "BOTTOM", "FRONT", "BACK"].map((label) => cubeFace(label, theme)),
    );
    const canvas = this.renderer.domElement;
    host.style.setProperty("--gizmo-size", `${gizmoSize}px`);
    canvas.id = "model-canvas";
    host.prepend(canvas);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.autoClear = false;
    this.orthographic.up.set(0, 0, 1);
    this.perspective.up.copy(this.orthographic.up);
    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.minZoom = 0.02;
    this.orbit.maxZoom = 200;
    this.orbit.addEventListener("change", () => this.render());
    this.grid.rotation.x = Math.PI / 2;
    this.grid.position.z = -0.02;
    this.scene.add(this.grid, this.axes, this.bodies, this.sketches, this.construction, this.draft, this.preview);
    this.light.position.set(-3, -5, 8);
    this.scene.add(this.hemisphere, this.light);
    this.cubeLight.position.set(-3, 4, 6);
    this.gizmoCamera.add(this.cubeLight);
    this.gizmo.add(this.cube, this.triad, this.gizmoCamera, this.ambient);
    this.setTheme(theme);
    const observer = new ResizeObserver(() => this.resize());
    observer.observe(host);
    this.home();
    canvas.addEventListener("pointerdown", (e) => this.down.set(e.clientX, e.clientY));
    canvas.addEventListener("pointerup", (e) => {
      if (e.button !== 0 || this.down.distanceTo(new T.Vector2(e.clientX, e.clientY)) > 4) return;
      const { right, top } = canvas.getBoundingClientRect();
      const x = e.clientX - (right - gizmoSize);
      const y = e.clientY - top;
      if (!this.sketchMode && x >= 0 && x < gizmoSize && y >= 0 && y < gizmoSize) {
        this.ray.setFromCamera(
          new T.Vector2((x / gizmoSize) * 2 - 1, 1 - (y / gizmoSize) * 2),
          this.gizmoCamera,
        );
        const face = this.ray.intersectObject(this.cube)[0]?.face;
        if (face) this.orient(face.normal);
        return;
      }
      const point = this.point(e);
      const bodies = this.bodies.children.filter((body) => body.visible);
      const tolerance = (4 * this.span) / (this.viewZoom * canvas.clientHeight);
      this.ray.params.Line.threshold = tolerance;
      const hits = this.ray.intersectObjects(bodies, true);
      const sketch = this.ray.intersectObjects(this.sketches.children.filter((node) => node.visible), false)[0];
      if (sketch && (!hits.length || sketch.distance < hits[0].distance - 1e-6)) {
        onClick({ point, sketch: sketch.object.userData.sketch });
        return;
      }
      const nearest = hits[0];
      const hit =
        hits.find((h) => h.object instanceof T.Line && h.distance <= nearest.distance + tolerance) ?? nearest;
      if (hit?.object instanceof T.Line && hit.object.parent instanceof SolidDisplay) {
        onClick({ point, body: hit.object.parent.proxy.body.id, pick: { edge: hit.object.userData.edge } });
      } else if (hit?.object instanceof SolidDisplay && hit.faceIndex != null) {
        const triangle = hit.faceIndex;
        const range = hit.object.proxy.faces.find(
          (f) => triangle >= f.firstTriangle && triangle < f.firstTriangle + f.triangleCount,
        );
        onClick({ point, body: hit.object.proxy.body.id, pick: range && { face: range.face } });
      } else {
        const plane = this.ray.intersectObjects(this.construction.children.filter((node) => node.visible), false)[0];
        onClick({ point, plane: plane?.object.userData.plane });
      }
    });
    canvas.addEventListener("pointermove", (e) => onMove(this.point(e)));
  }

  setTheme(theme: ThemeDefinition) {
    this.theme = theme;
    this.hemisphere.color.set(theme.colors.light);
    this.hemisphere.groundColor.set(theme.colors.groundLight);
    for (const light of [this.light, this.cubeLight, this.ambient]) light.color.set(theme.colors.light);
    styleAxes(this.axes, theme);
    styleAxes(this.triad, theme);
    ["RIGHT", "LEFT", "TOP", "BOTTOM", "FRONT", "BACK"].forEach((label, i) => {
      cubeFace(label, theme, this.cube.material[i]);
    });
    const positions = this.grid.geometry.getAttribute("position");
    const colors = this.grid.geometry.getAttribute("color");
    const major = new T.Color(theme.colors.gridMajor);
    const minor = new T.Color(theme.colors.grid);
    for (let i = 0; i < positions.count; i += 2) {
      const center = (positions.getX(i) === 0 && positions.getX(i + 1) === 0) ||
        (positions.getZ(i) === 0 && positions.getZ(i + 1) === 0);
      const color = center ? major : minor;
      colors.setXYZ(i, color.r, color.g, color.b);
      colors.setXYZ(i + 1, color.r, color.g, color.b);
    }
    colors.needsUpdate = true;
    for (const group of [this.sketches, this.draft, this.construction]) {
      for (const profile of group.children) {
        if (profile instanceof T.Mesh) styleProfile(profile, theme);
      }
    }
    for (const group of [this.bodies, this.preview]) {
      for (const solid of group.children) {
        if (solid instanceof SolidDisplay) solid.setTheme(theme);
      }
    }
    this.render();
  }

  private point(e: PointerEvent): Point | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ray.setFromCamera(
      new T.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2),
      this.camera,
    );
    const p = this.ray.ray.intersectPlane(xy, new T.Vector3());
    return p ? [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10] : null;
  }

  private resize() {
    const w = this.host.clientWidth,
      h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.orthographic.top = this.span / 2;
    this.orthographic.bottom = -this.orthographic.top;
    this.orthographic.right = (this.span * w) / h / 2;
    this.orthographic.left = -this.orthographic.right;
    this.orthographic.updateProjectionMatrix();
    this.perspective.aspect = w / h;
    this.perspective.updateProjectionMatrix();
    this.render();
  }

  // Distance at which the perspective frustum is one home-view span tall at the orbit target.
  private get perspectiveHomeDistance() {
    return this.span / (2 * Math.tan(T.MathUtils.degToRad(this.perspective.fov / 2)));
  }

  private get viewZoom() {
    return this.camera === this.orthographic
      ? this.orthographic.zoom
      : this.perspectiveHomeDistance / this.orbit.getDistance();
  }

  setCameraMode(mode: "orthographic" | "perspective") {
    const next = mode === "orthographic" ? this.orthographic : this.perspective;
    if (this.camera === next) return;
    const direction = this.camera.position.clone().sub(this.orbit.target);
    const zoom = this.viewZoom;
    this.camera = next;
    this.orbit.object = next;
    this.orient(direction, zoom);
  }

  private orient(direction: T.Vector3, zoom = this.viewZoom) {
    const normal = direction.clone().normalize();
    // At a pole, a small Y offset keeps world X horizontal and world Y vertical.
    if (Math.abs(normal.z) === 1) normal.setY(-0.000001).normalize();
    let distance = this.perspectiveHomeDistance / zoom;
    if (this.camera === this.orthographic) {
      distance = Math.max(100, this.span * 2);
      this.orthographic.zoom = zoom;
      this.orthographic.updateProjectionMatrix();
    }
    this.camera.position.copy(this.orbit.target).addScaledVector(normal, distance);
    this.camera.lookAt(this.orbit.target);
    this.orbit.update();
    this.render();
  }

  home() {
    const bounds = new T.Box3();
    for (const group of [this.sketches, this.bodies, this.preview]) {
      for (const child of group.children) if (child.visible) bounds.expandByObject(child);
    }
    this.orbit.target.set(0, 0, 0);
    this.span = 60;
    if (!bounds.isEmpty()) {
      bounds.getCenter(this.orbit.target);
      const aspect = this.host.clientWidth / Math.max(1, this.host.clientHeight);
      this.span = Math.max(12, (bounds.getSize(new T.Vector3()).length() * 1.4) / Math.min(1, aspect));
    }
    this.orbit.minDistance = this.perspectiveHomeDistance / this.orbit.maxZoom;
    this.orbit.maxDistance = this.perspectiveHomeDistance / this.orbit.minZoom;
    this.orient(this.sketchMode ? new T.Vector3(0, 0, 1) : iso, 1);
    this.resize();
  }

  sketching(enabled: boolean) {
    this.sketchMode = enabled;
    this.orbit.enableRotate = !enabled;
    this.home();
    this.renderer.domElement.style.cursor = enabled ? "crosshair" : "";
  }
  captureView(): ViewState {
    return { mode: this.camera === this.orthographic ? "orthographic" : "perspective",
      position: this.camera.position.toArray(), target: this.orbit.target.toArray(),
      span: this.span, zoom: this.camera.zoom };
  }
  restoreView(view: ViewState) {
    this.camera = view.mode === "orthographic" ? this.orthographic : this.perspective;
    this.orbit.object = this.camera;
    this.span = view.span;
    this.camera.position.fromArray(view.position);
    this.camera.zoom = view.zoom;
    this.orbit.target.fromArray(view.target);
    this.orbit.minDistance = this.perspectiveHomeDistance / this.orbit.maxZoom;
    this.orbit.maxDistance = this.perspectiveHomeDistance / this.orbit.minZoom;
    this.orbit.update();
    this.resize();
  }
  setVisibility(hidden: Set<string>) {
    this.hidden = new Set(hidden);
    for (const node of this.sketches.children) node.visible = !hidden.has(node.userData.sketch);
    for (const node of this.construction.children) node.visible = !hidden.has(node.userData.plane);
    for (const node of this.bodies.children) {
      if (node instanceof SolidDisplay) node.visible = !hidden.has(node.proxy.body.id) && !this.previewHidden.has(node.proxy.body.id);
    }
    for (const node of this.preview.children) {
      if (node instanceof SolidDisplay) node.visible = !hidden.has(node.proxy.body.id);
    }
    this.render();
  }
  setConstruction(planes: { id: string; plane: "xy" | "xz" | "yz" }[], selected?: string) {
    discard(this.construction);
    for (const plane of planes) {
      const node = rectangleObject({ from: [-10, -10], to: [10, 10] }, plane.id === selected, this.theme);
      if (plane.plane === "xz") node.rotation.x = Math.PI / 2;
      if (plane.plane === "yz") node.rotation.y = Math.PI / 2;
      node.userData.plane = plane.id;
      node.visible = !this.hidden.has(plane.id);
      this.construction.add(node);
    }
    this.render();
  }
  setSketches(records: Map<string, Rectangle>, selected?: string) {
    discard(this.sketches);
    for (const [id, rect] of records) {
      const profile = rectangleObject(rect, id === selected, this.theme);
      profile.userData.sketch = id;
      profile.visible = !this.hidden.has(id);
      this.sketches.add(profile);
    }
    this.render();
  }
  setBodies(records: Map<string, BodyProxy>, selected?: string, pick?: TopologyPick) {
    const present = new Set<string>();
    for (const child of [...this.bodies.children]) {
      if (!(child instanceof SolidDisplay)) continue;
      const id = child.proxy.body.id;
      if (child.proxy === records.get(id)) {
        present.add(id);
        child.highlight(id === selected, id === selected ? pick : undefined);
      } else {
        child.removeFromParent();
        discard(child);
      }
    }
    for (const [id, proxy] of records) {
      if (present.has(id)) continue;
      const solid = new SolidDisplay(proxy, false, this.theme);
      solid.highlight(id === selected, id === selected ? pick : undefined);
      this.bodies.add(solid);
    }
    this.setVisibility(this.hidden);
  }
  setDraft(rect?: Rectangle) {
    discard(this.draft);
    if (rect) this.draft.add(rectangleObject(rect, true, this.theme));
    this.render();
  }
  setPreview(proxies: BodyProxy[] = [], removed: string[] = []) {
    discard(this.preview);
    this.previewHidden = new Set([...removed, ...proxies.map((proxy) => proxy.body.id)]);
    proxies.forEach((proxy) => this.preview.add(new SolidDisplay(proxy, true, this.theme)));
    this.setVisibility(this.hidden);
  }

  private render() {
    const w = this.host.clientWidth,
      h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setViewport(0, 0, w, h);
    this.renderer.setClearColor(this.theme.colors.background);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.gizmoCamera.quaternion.copy(this.camera.quaternion);
    this.gizmoCamera.position.set(0, 0, 5).applyQuaternion(this.camera.quaternion);
    this.renderer.clearDepth();
    this.renderer.setViewport(w - gizmoSize, h - gizmoSize, gizmoSize, gizmoSize);
    this.renderer.render(this.gizmo, this.gizmoCamera);
  }
}
