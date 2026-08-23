import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

type ProjectionImage = { id?: string; url: string; name: string; note: string; transform: { scale: number; x: number; y: number; brightness: number; fit: "cover" | "contain" } };
type PresetName = "自由視角" | "前排" | "左側" | "右側" | "俯視";
export type CameraPose = { fov: number; position: [number, number, number]; target: [number, number, number] };
type Person = { id: string; x: number; z: number; rotation: number; heightCm: number; visible: boolean };
type BackdropStyle = "solid" | "fence";
type Backdrop = { style: BackdropStyle; x: number; z: number; rotation: number; count: number; widthCm: number; heightCm: number; gapCm: number; color: string; visible: boolean };
type Layout = { version: 5; people: Person[]; backdrop: Backdrop };
type Selection = { kind: "person"; id: string } | { kind: "backdrop" };
type Legacy = { peopleVisible?: boolean; personHeightCm?: number; backdrop252Visible?: boolean; backdrop202Visible?: boolean; backdrop158Visible?: boolean };

const STAGE = { width: 27, openingWidth: 15.42, openingHeight: 8.5, apronDepth: 2.6, depth: 18.81, cycloramaDepth: 10.65 };
const INNER = 6.6, LEG_WIDTH = STAGE.openingWidth / 2 - INNER, SCREEN_WIDTH = INNER * 2, SCREEN_HEIGHT = SCREEN_WIDTH * 9 / 16;
const LEG_DEPTHS = [1.1, 3.05, 5, 6.95, 8.9], LINE_GAP = .92, LINE_COUNT = 12, PERSON_HEIGHT = 1.7, MAX_PEOPLE = 50, BACKDROP_DEPTH = .48;
const LEGACY_CAMERA_KEY = "stage-view-template-camera-v3", CAMERA_KEY_PREFIX = "stage-view-free-camera-v1:", OLD_KEY = "stage-view-objects-v1", LAYOUT_KEY = "stage-view-layout-v2";
const DEFAULT_PEOPLE: Person[] = [
  ["person-1", -5, 3.2, -10], ["person-2", -4.15, 5.8, 7], ["person-3", -1.25, 4.2, -5],
  ["person-4", 1.25, 4.2, 5], ["person-5", 4.15, 5.8, -7], ["person-6", 5, 3.2, 10],
].map(([id, x, z, rotation]) => ({ id: String(id), x: Number(x), z: Number(z), rotation: Number(rotation), heightCm: 172, visible: true }));
const DEFAULT_BACKDROP: Backdrop = { style: "solid", x: 0, z: 7.36, rotation: 0, count: 1, widthCm: 122, heightCm: 252, gapCm: 0, color: "#765548", visible: true };
const TEMPLATE_CAMERA: CameraPose = { fov: 20, position: [0, 1.25, -22], target: [0, 3.5, 7] };
export type Stage3DHandle = { exportView: () => void; captureView: () => string | null; getCameraPose: () => CameraPose | null };
type Stage3DProps = {
  image: ProjectionImage | null;
  compact?: boolean;
  showObjectControls?: boolean;
  syncId?: string;
  syncCamera?: { sourceId: string; serial: number; pose: CameraPose } | null;
  onCameraChange?: (sourceId: string, pose: CameraPose) => void;
};

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
const normalizeRotation = (n: number) => { let r = n % 360; if (r > 180) r -= 360; if (r < -180) r += 360; return round(r, 1) };
const copyDefaults = (): Layout => ({ version: 5, people: DEFAULT_PEOPLE.map(p => ({ ...p })), backdrop: { ...DEFAULT_BACKDROP } });
const fit169 = (w: number, h: number) => w / Math.max(1, h) > 16 / 9 ? { width: h * 16 / 9, height: h } : { width: w, height: w * 9 / 16 };
const validTuple = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === "number" && Number.isFinite(n));

function cleanPerson(value: Partial<Person>, fallback: Person): Person {
  return {
    id: typeof value.id === "string" && value.id ? value.id : fallback.id,
    x: clamp(Number.isFinite(value.x) ? Number(value.x) : fallback.x, -13.5, 13.5),
    z: clamp(Number.isFinite(value.z) ? Number(value.z) : fallback.z, 0, STAGE.depth),
    rotation: normalizeRotation(Number.isFinite(value.rotation) ? Number(value.rotation) : fallback.rotation),
    heightCm: clamp(Math.round(Number(value.heightCm) || fallback.heightCm), 158, 185),
    visible: value.visible ?? fallback.visible,
  };
}
function cleanBackdrop(value: Partial<Backdrop>): Backdrop {
  return {
    style: value.style === "fence" ? "fence" : "solid",
    x: clamp(Number.isFinite(value.x) ? Number(value.x) : 0, -13.5, 13.5),
    z: clamp(Number.isFinite(value.z) ? Number(value.z) : 7.36, 0, STAGE.depth),
    rotation: normalizeRotation(Number.isFinite(value.rotation) ? Number(value.rotation) : 0),
    count: clamp(Math.round(Number(value.count) || 1), 1, 30),
    widthCm: clamp(Math.round(Number(value.widthCm) || 122), 30, 500),
    heightCm: clamp(Math.round(Number(value.heightCm) || 252), 30, 800),
    gapCm: clamp(Math.round(Number(value.gapCm) || 0), 0, 300),
    color: typeof value.color === "string" && /^#[0-9a-f]{6}$/i.test(value.color) ? value.color : DEFAULT_BACKDROP.color,
    visible: value.visible ?? true,
  };
}
function backdropExtent(b: Backdrop) {
  const total = b.count * b.widthCm / 100 + (b.count - 1) * b.gapCm / 100, r = THREE.MathUtils.degToRad(b.rotation);
  return { total, x: Math.abs(Math.cos(r)) * total / 2 + Math.abs(Math.sin(r)) * BACKDROP_DEPTH / 2, z: Math.abs(Math.sin(r)) * total / 2 + Math.abs(Math.cos(r)) * BACKDROP_DEPTH / 2 };
}
function backdropFits(b: Backdrop) { const e = backdropExtent(b); return e.x <= 13.5 && e.z <= STAGE.depth / 2 }
function clampBackdrop(b: Backdrop) { const e = backdropExtent(b); return { ...b, x: round(clamp(b.x, -13.5 + e.x, 13.5 - e.x)), z: round(clamp(b.z, e.z, STAGE.depth - e.z)) } }
function clampPerson(p: Person) { const r = .32 * p.heightCm / 170; return { ...p, x: round(clamp(p.x, -13.5 + r, 13.5 - r)), z: round(clamp(p.z, r, STAGE.depth - r)) } }

function cameraKey(image?: ProjectionImage | null) { return `${CAMERA_KEY_PREFIX}${image?.id ?? "default"}` }
function readCamera(key: string): CameraPose | null {
  try {
    const raw = localStorage.getItem(key) ?? localStorage.getItem(LEGACY_CAMERA_KEY);
    const v = JSON.parse(raw || "null") as Partial<CameraPose> | null;
    return v && typeof v.fov === "number" && validTuple(v.position) && validTuple(v.target) ? { fov: v.fov, position: v.position, target: v.target } : null;
  } catch { return null }
}
function readLayout(): Layout {
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null") as { version?: number; people?: Partial<Person>[]; backdrop?: Partial<Backdrop> } | null;
    if ((v?.version === 2 || v?.version === 3 || v?.version === 4 || v?.version === 5) && Array.isArray(v.people) && v.backdrop) {
      const seen = new Set<string>();
      const people = v.people.slice(0, MAX_PEOPLE).map((p, i) => {
        const fallback = DEFAULT_PEOPLE[i] ?? { ...DEFAULT_PEOPLE[0], id: `person-${i + 1}`, x: 0, z: 3.2 };
        const next = cleanPerson(p, fallback);
        while (seen.has(next.id)) next.id += `-${i + 1}`;
        seen.add(next.id); return next;
      });
      const backdrop = cleanBackdrop(v.backdrop);
      if (v.version === 2 && backdrop.gapCm === 20) backdrop.gapCm = 0;
      return { version: 5, people, backdrop: clampBackdrop(backdrop) };
    }
  } catch { /* migrate below */ }
  const next = copyDefaults();
  try {
    const old = JSON.parse(localStorage.getItem(OLD_KEY) || "null") as Legacy | null;
    if (old) {
      const heightCm = clamp(Math.round(Number(old.personHeightCm) || 172), 158, 185);
      next.people = next.people.map(p => ({ ...p, heightCm, visible: old.peopleVisible ?? true }));
      next.backdrop.visible = old.backdrop252Visible ?? old.backdrop158Visible ?? old.backdrop202Visible ?? true;
    }
  } catch { /* defaults */ }
  return next;
}
function writeCamera(key: string, camera: THREE.PerspectiveCamera, controls: OrbitControls) {
  try { localStorage.setItem(key, JSON.stringify({ fov: camera.fov, position: camera.position.toArray(), target: controls.target.toArray() })) } catch { /* optional */ }
}
function applyPose(camera: THREE.PerspectiveCamera, controls: OrbitControls, pose: CameraPose) {
  camera.fov = pose.fov; camera.position.set(...pose.position); controls.target.set(...pose.target); camera.updateProjectionMatrix(); controls.update();
}
function currentPose(camera: THREE.PerspectiveCamera, controls: OrbitControls): CameraPose {
  return { fov: camera.fov, position: camera.position.toArray() as [number, number, number], target: controls.target.toArray() as [number, number, number] };
}
const lit = (color: number, roughness = .78, metalness = .02) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
const unlit = (color: number) => new THREE.MeshBasicMaterial({ color, toneMapped: false });
function box(parent: THREE.Object3D, size: [number, number, number], position: [number, number, number], material: THREE.Material, cast = false, receive = true) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material); mesh.position.set(...position); mesh.castShadow = cast; mesh.receiveShadow = receive; parent.add(mesh); return mesh;
}
function makePerson(material: THREE.Material) {
  const g = new THREE.Group(), body = new THREE.Mesh(new THREE.CapsuleGeometry(.2, .68, 5, 10), material), head = new THREE.Mesh(new THREE.SphereGeometry(.16, 14, 10), material);
  body.position.y = .98; head.position.y = 1.54;
  const legGeo = new THREE.CylinderGeometry(.055, .065, .78, 8), armGeo = new THREE.CylinderGeometry(.055, .07, .68, 8);
  const ll = new THREE.Mesh(legGeo, material); ll.position.set(-.09, .39, 0); ll.rotation.z = -.05; const rl = ll.clone(); rl.position.x = .09; rl.rotation.z = .05;
  const la = new THREE.Mesh(armGeo, material); la.position.set(-.255, 1.04, 0); la.rotation.z = -.08; const ra = la.clone(); ra.position.x = .255; ra.rotation.z = .08;
  g.add(body, head, ll, rl, la, ra); g.traverse(o => { if (o instanceof THREE.Mesh) o.castShadow = true }); return g;
}
function makePanel(panelMat: THREE.Material, frameMat: THREE.Material, width: number, height: number, style: BackdropStyle) {
  const g = new THREE.Group();
  if (style === "fence") {
    const inset = Math.min(.05, width * .08), picketCount = Math.max(4, Math.round(width / .14)), usableWidth = Math.max(.1, width - inset * 2), spacing = usableWidth / (picketCount - 1), picketWidth = Math.min(.065, spacing * .48);
    const picketGeo = new THREE.BoxGeometry(picketWidth, height, .08);
    for (let i = 0; i < picketCount; i++) { const picket = new THREE.Mesh(picketGeo, panelMat); picket.position.set(-usableWidth / 2 + i * spacing, height / 2, 0); g.add(picket) }
    const railGeo = new THREE.BoxGeometry(width, Math.min(.09, height * .07), .1);
    [height * .34, height * .72].forEach(y => { const rail = new THREE.Mesh(railGeo, panelMat); rail.position.set(0, y, .015); g.add(rail) });
  } else {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(width, height, .08), panelMat); panel.position.y = height / 2; g.add(panel);
  }
  const sideGeo = new THREE.BoxGeometry(.045, height, .12), left = new THREE.Mesh(sideGeo, frameMat); left.position.set(-width / 2 + .0225, height / 2, 0); const right = left.clone(); right.position.x *= -1;
  const footGeo = new THREE.BoxGeometry(Math.min(.28, width * .45), .06, BACKDROP_DEPTH), lf = new THREE.Mesh(footGeo, frameMat); lf.position.set(-width * .32, .03, .08); const rf = lf.clone(); rf.position.x *= -1;
  const wheelGeo = new THREE.CylinderGeometry(.045, .045, .035, 10), lw = new THREE.Mesh(wheelGeo, frameMat); lw.position.set(-width * .32, .045, .18); lw.rotation.x = Math.PI / 2; const rw = lw.clone(); rw.position.x *= -1;
  g.add(left, right, lf, rf, lw, rw); return g;
}
function projectionTexture(image: ProjectionImage) {
  return new Promise<THREE.CanvasTexture>((resolve, reject) => {
    const source = new Image();
    source.onload = () => {
      const c = document.createElement("canvas"); c.width = 1920; c.height = 1080; const ctx = c.getContext("2d"); if (!ctx) return reject();
      ctx.fillStyle = "#050505"; ctx.fillRect(0, 0, c.width, c.height);
      const base = image.transform.fit === "cover" ? Math.max(c.width / source.naturalWidth, c.height / source.naturalHeight) : Math.min(c.width / source.naturalWidth, c.height / source.naturalHeight);
      const scale = base * image.transform.scale / 100, w = source.naturalWidth * scale, h = source.naturalHeight * scale;
      ctx.filter = `brightness(${image.transform.brightness}%)`; ctx.drawImage(source, (c.width - w) / 2 + image.transform.x / 100 * c.width, (c.height - h) / 2 + image.transform.y / 100 * c.height, w, h);
      const texture = new THREE.CanvasTexture(c); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4; resolve(texture);
    };
    source.onerror = reject; source.src = image.url;
  });
}

const Stage3D = forwardRef<Stage3DHandle, Stage3DProps>(function Stage3D({ image, compact = false, showObjectControls = true, syncId = "main", syncCamera = null, onCameraChange }, ref) {
  const mountRef = useRef<HTMLDivElement>(null), rendererRef = useRef<THREE.WebGLRenderer | null>(null), cameraRef = useRef<THREE.PerspectiveCamera | null>(null), controlsRef = useRef<OrbitControls | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null), screenMatRef = useRef<THREE.MeshBasicMaterial | null>(null), textureRef = useRef<THREE.Texture | null>(null), personMatRef = useRef<THREE.Material | null>(null);
  const backdropMatsRef = useRef<{ panel: THREE.Material; frame: THREE.Material } | null>(null), peopleRef = useRef(new Map<string, THREE.Group>()), backdropRef = useRef<THREE.Group | null>(null), backdropSpecRef = useRef("");
  const boxRef = useRef<{ box: THREE.Box3; helper: THREE.Box3Helper } | null>(null), dragRef = useRef<{ selection: Selection; dx: number; dz: number } | null>(null), timerRef = useRef<number | null>(null), applyingSyncRef = useRef(false), onCameraChangeRef = useRef(onCameraChange);
  const [preset, setPreset] = useState<PresetName>("自由視角"), [layout, setLayout] = useState<Layout>(readLayout), [selection, setSelection] = useState<Selection>({ kind: "backdrop" }), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [controlsCollapsed, setControlsCollapsed] = useState(() => localStorage.getItem("stage3d-controls-collapsed") === "1");
  const [activePersonId, setActivePersonId] = useState(() => layout.people[0]?.id ?? "");
  const layoutRef = useRef(layout), selectionRef = useRef(selection), cameraKeyRef = useRef(cameraKey(image)); layoutRef.current = layout; selectionRef.current = selection; cameraKeyRef.current = cameraKey(image);
  onCameraChangeRef.current = onCameraChange;
  const showNotice = (message: string) => { setNotice(message); if (timerRef.current) clearTimeout(timerRef.current); timerRef.current = window.setTimeout(() => setNotice(""), 2600) };
  const updatePerson = (id: string, patch: Partial<Person>) => setLayout(current => ({ ...current, people: current.people.map(p => p.id === id ? clampPerson(cleanPerson({ ...p, ...patch }, p)) : p) }));
  const updateBackdrop = (patch: Partial<Backdrop>, reject = true) => setLayout(current => {
    const candidate = cleanBackdrop({ ...current.backdrop, ...patch });
    if (reject && !backdropFits(candidate)) { setTimeout(() => showNotice("這個背板列的尺寸或角度無法放入舞台。"), 0); return current }
    return { ...current, backdrop: clampBackdrop(candidate) };
  });

  useEffect(() => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)) } catch { /* optional */ } }, [layout]);
  useEffect(() => { if (showObjectControls) try { localStorage.setItem("stage3d-controls-collapsed", controlsCollapsed ? "1" : "0") } catch { /* optional */ } }, [controlsCollapsed, showObjectControls]);
  useEffect(() => {
    const mount = mountRef.current; if (!mount) return; let frame = 0, renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" }) } catch { setError("這個瀏覽器目前無法啟動 3D 畫面，請確認硬體加速已開啟。"); return }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); const size = fit169(mount.clientWidth, mount.clientHeight); renderer.setSize(size.width, size.height, false); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = .9; renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.domElement.tabIndex = 0; mount.appendChild(renderer.domElement); rendererRef.current = renderer;
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x070809); sceneRef.current = scene;
    const pose = readCamera(cameraKeyRef.current) ?? TEMPLATE_CAMERA, camera = new THREE.PerspectiveCamera(pose.fov, 16 / 9, .1, 180); camera.position.set(...pose.position); cameraRef.current = camera;
    const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.dampingFactor = .07; controls.target.set(...pose.target); controls.minDistance = 2.5; controls.maxDistance = 140; controls.maxPolarAngle = Math.PI * .92; controlsRef.current = controls;
    const emitCamera = () => { if (!applyingSyncRef.current) onCameraChangeRef.current?.(syncId, currentPose(camera, controls)) };
    const remember = () => { if (!dragRef.current) { writeCamera(cameraKeyRef.current, camera, controls); setPreset("自由視角") } };
    controls.addEventListener("change", emitCamera); controls.addEventListener("end", remember);
    scene.add(new THREE.HemisphereLight(0x9cb5ca, 0x19120f, 1.1)); const key = new THREE.SpotLight(0xffe4c5, 760, 52, Math.PI / 4.5, .42, 1.4); key.position.set(-5, 15, -5); key.target.position.set(0, 0, 7); key.castShadow = true; key.shadow.mapSize.set(1024, 1024); scene.add(key, key.target); const fill = new THREE.DirectionalLight(0x8aa9d7, 1.6); fill.position.set(7, 9, -8); scene.add(fill);
    const black = lit(0x090909, .92), curtain = lit(0x050505, 1), floor = lit(0x3b3936, .88), apron = lit(0x3c241b, .9), frameMat = lit(0xaaa5ba, .35, .2), line = lit(0xc8c3ba, .82); personMatRef.current = lit(0x747678, .72, .05); backdropMatsRef.current = { panel: unlit(0x765548), frame: unlit(0x2b2927) };
    box(scene, [27, .24, STAGE.depth], [0, -.12, STAGE.depth / 2], floor);
    const shape = new THREE.Shape(); shape.moveTo(-9.1, 0); shape.lineTo(9.1, 0); shape.quadraticCurveTo(0, STAGE.apronDepth * 2, -9.1, 0); const apronMesh = new THREE.Mesh(new THREE.ShapeGeometry(shape, 48), apron); apronMesh.rotation.x = -Math.PI / 2; apronMesh.position.y = -.14; scene.add(apronMesh);
    for (let i = 0; i < LINE_COUNT; i++) box(scene, [27, .025, .035], [0, .02, i * LINE_GAP], line, false, false);
    box(scene, [.58, 9.5, 1.05], [-8, 4.55, -.05], black); box(scene, [.58, 9.5, 1.05], [8, 4.55, -.05], black); box(scene, [16.58, .65, 1.05], [0, 8.82, -.05], black);
    box(scene, [.22, 8.95, .2], [-7.82, 4.37, -.65], frameMat); box(scene, [.22, 8.95, .2], [7.82, 4.37, -.65], frameMat); box(scene, [15.86, .22, .2], [0, 8.73, -.65], frameMat);
    box(scene, [27, 10.5, .28], [0, 5, STAGE.depth], black); box(scene, [.34, 10.5, STAGE.depth + 2.2], [-12.8, 5, 8.3], black); box(scene, [.34, 10.5, STAGE.depth + 2.2], [12.8, 5, 8.3], black);
    const legCenter = INNER + LEG_WIDTH / 2; LEG_DEPTHS.forEach(z => { box(scene, [LEG_WIDTH, 8.5, .13], [-legCenter, 4.25, z], curtain, true); box(scene, [LEG_WIDTH, 8.5, .13], [legCenter, 4.25, z], curtain, true) });
    const screenMat = new THREE.MeshBasicMaterial({ color: 0x25282d, side: THREE.DoubleSide, toneMapped: false, fog: false }); screenMatRef.current = screenMat; const screen = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_WIDTH, SCREEN_HEIGHT), screenMat); screen.position.set(0, SCREEN_HEIGHT / 2, STAGE.cycloramaDepth); screen.rotation.y = Math.PI; scene.add(screen); box(scene, [STAGE.openingWidth, STAGE.openingHeight - SCREEN_HEIGHT, .12], [0, SCREEN_HEIGHT + (STAGE.openingHeight - SCREEN_HEIGHT) / 2, STAGE.cycloramaDepth + .04], black);
    const selectionBox = new THREE.Box3(), helper = new THREE.Box3Helper(selectionBox, 0xff6f42); helper.visible = false; helper.renderOrder = 10; scene.add(helper); boxRef.current = { box: selectionBox, helper };
    const ray = new THREE.Raycaster(), pointer = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const setRay = (e: PointerEvent) => { const r = renderer.domElement.getBoundingClientRect(); pointer.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1); ray.setFromCamera(pointer, camera) };
    const pick = (e: PointerEvent) => { setRay(e); const targets: THREE.Object3D[] = [...peopleRef.current.values()]; if (backdropRef.current) targets.push(backdropRef.current); let o: THREE.Object3D | null = ray.intersectObjects(targets, true)[0]?.object ?? null; while (o) { if (o.userData.selection) return o.userData.selection as Selection; o = o.parent } return null };
    const floorPoint = (e: PointerEvent) => { setRay(e); return ray.ray.intersectPlane(plane, new THREE.Vector3()) };
    const down = (e: PointerEvent) => { if (!showObjectControls || e.button !== 0) return; const selected = pick(e), point = floorPoint(e); if (!selected || !point) return; const pos = selected.kind === "backdrop" ? layoutRef.current.backdrop : layoutRef.current.people.find(p => p.id === selected.id); if (!pos) return; dragRef.current = { selection: selected, dx: pos.x - point.x, dz: pos.z - point.z }; controls.enabled = false; setSelection(selected); if (selected.kind === "person") setActivePersonId(selected.id); renderer.domElement.setPointerCapture(e.pointerId); e.preventDefault() };
    const move = (e: PointerEvent) => { const drag = dragRef.current, point = floorPoint(e); if (!drag || !point) return; if (drag.selection.kind === "backdrop") updateBackdrop({ x: point.x + drag.dx, z: point.z + drag.dz }, false); else updatePerson(drag.selection.id, { x: point.x + drag.dx, z: point.z + drag.dz }); e.preventDefault() };
    const up = (e: PointerEvent) => { if (!dragRef.current) return; dragRef.current = null; controls.enabled = true; if (renderer.domElement.hasPointerCapture(e.pointerId)) renderer.domElement.releasePointerCapture(e.pointerId); e.preventDefault() };
    renderer.domElement.addEventListener("pointerdown", down, true); renderer.domElement.addEventListener("pointermove", move, true); renderer.domElement.addEventListener("pointerup", up, true); renderer.domElement.addEventListener("pointercancel", up, true);
    const ro = new ResizeObserver(() => { const s = fit169(Math.max(1, mount.clientWidth), Math.max(1, mount.clientHeight)); renderer.setSize(s.width, s.height, false); camera.aspect = 16 / 9; camera.updateProjectionMatrix() }); ro.observe(mount);
    const animate = () => { controls.update(); const s = selectionRef.current, obj = s.kind === "backdrop" ? backdropRef.current : peopleRef.current.get(s.id); if (boxRef.current) { boxRef.current.helper.visible = showObjectControls && Boolean(obj?.visible); if (showObjectControls && obj?.visible) boxRef.current.box.setFromObject(obj) } renderer.render(scene, camera); frame = requestAnimationFrame(animate) }; animate();
    return () => { cancelAnimationFrame(frame); ro.disconnect(); controls.removeEventListener("change", emitCamera); controls.removeEventListener("end", remember); controls.dispose(); textureRef.current?.dispose(); scene.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()) } }); renderer.dispose(); renderer.domElement.remove(); rendererRef.current = cameraRef.current = controlsRef.current = sceneRef.current = screenMatRef.current = personMatRef.current = backdropMatsRef.current = boxRef.current = null; peopleRef.current.clear(); backdropRef.current = null };
  }, []);

  useEffect(() => {
    const scene = sceneRef.current, mat = personMatRef.current; if (!scene || !mat) return; const ids = new Set(layout.people.map(p => p.id));
    peopleRef.current.forEach((g, id) => { if (!ids.has(id)) { scene.remove(g); g.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() }); peopleRef.current.delete(id) } });
    layout.people.forEach(p => { let g = peopleRef.current.get(p.id); if (!g) { g = makePerson(mat); g.userData.selection = { kind: "person", id: p.id } satisfies Selection; scene.add(g); peopleRef.current.set(p.id, g) } g.position.set(p.x, 0, p.z); g.rotation.y = THREE.MathUtils.degToRad(p.rotation); g.scale.setScalar(p.heightCm / 100 / PERSON_HEIGHT); g.visible = p.visible });
  }, [layout.people]);
  useEffect(() => {
    const scene = sceneRef.current, mats = backdropMatsRef.current; if (!scene || !mats) return; const b = layout.backdrop, spec = `${b.style}-${b.count}-${b.widthCm}-${b.heightCm}-${b.gapCm}`; let g = backdropRef.current;
    if (mats.panel instanceof THREE.MeshBasicMaterial) mats.panel.color.set(b.color);
    if (!g) { g = new THREE.Group(); g.userData.selection = { kind: "backdrop" } satisfies Selection; scene.add(g); backdropRef.current = g }
    if (backdropSpecRef.current !== spec) { while (g.children.length) g.children.pop()?.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() }); const width = b.widthCm / 100, height = b.heightCm / 100, gap = b.gapCm / 100, total = b.count * width + (b.count - 1) * gap; for (let i = 0; i < b.count; i++) { const panel = makePanel(mats.panel, mats.frame, width, height, b.style); panel.position.x = -total / 2 + width / 2 + i * (width + gap); g.add(panel) } backdropSpecRef.current = spec }
    g.position.set(b.x, 0, b.z); g.rotation.y = THREE.MathUtils.degToRad(b.rotation); g.visible = b.visible;
  }, [layout.backdrop]);
  useEffect(() => { if (selection.kind === "person" && !layout.people.some(p => p.id === selection.id)) setSelection({ kind: "backdrop" }) }, [layout.people, selection]);
  useEffect(() => { if (!layout.people.some(p => p.id === activePersonId)) setActivePersonId(layout.people[0]?.id ?? "") }, [activePersonId, layout.people]);
  useEffect(() => {
    if (!showObjectControls) return;
    const key = (e: KeyboardEvent) => { if (!e.key.startsWith("Arrow") || (e.target as HTMLElement | null)?.closest("input,textarea,select,button,[contenteditable='true']")) return; const step = e.shiftKey ? .01 : .1, delta = ({ ArrowUp: [0, step], ArrowDown: [0, -step], ArrowLeft: [step, 0], ArrowRight: [-step, 0] } as Record<string, [number, number]>)[e.key]; if (!delta) return; e.preventDefault(); const s = selectionRef.current, current = layoutRef.current; if (s.kind === "backdrop") updateBackdrop({ x: current.backdrop.x + delta[0], z: current.backdrop.z + delta[1] }, false); else { const p = current.people.find(x => x.id === s.id); if (p) updatePerson(p.id, { x: p.x + delta[0], z: p.z + delta[1] }) } }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [showObjectControls]);
  useEffect(() => {
    if (!syncCamera || syncCamera.sourceId === syncId) return;
    const camera = cameraRef.current, controls = controlsRef.current;
    if (!camera || !controls) return;
    applyingSyncRef.current = true;
    applyPose(camera, controls, syncCamera.pose);
    writeCamera(cameraKeyRef.current, camera, controls);
    const release = requestAnimationFrame(() => { applyingSyncRef.current = false });
    return () => cancelAnimationFrame(release);
  }, [syncCamera?.serial, syncCamera?.sourceId, syncId]);
  useEffect(() => {
    const camera = cameraRef.current, controls = controlsRef.current;
    if (!camera || !controls) return;
    applyingSyncRef.current = true;
    applyPose(camera, controls, readCamera(cameraKey(image)) ?? TEMPLATE_CAMERA);
    setPreset("自由視角");
    const release = requestAnimationFrame(() => { applyingSyncRef.current = false });
    return () => cancelAnimationFrame(release);
  }, [image?.id]);
  useEffect(() => {
    const mat = screenMatRef.current; if (!mat) return; let cancelled = false;
    if (!image) { textureRef.current?.dispose(); textureRef.current = null; mat.map = null; mat.color.set(0x25282d); mat.needsUpdate = true; return }
    void projectionTexture(image).then(texture => { if (cancelled) return texture.dispose(); textureRef.current?.dispose(); textureRef.current = texture; mat.color.set(0xffffff); mat.map = texture; mat.needsUpdate = true }).catch(() => setError("目前選取的圖片無法放入 3D 投影面。")); return () => { cancelled = true };
  }, [image]);

  const moveCamera = (name: PresetName) => { const camera = cameraRef.current, controls = controlsRef.current; if (!camera || !controls) return; const poses: Record<Exclude<PresetName, "自由視角">, CameraPose> = { 前排: { fov: 48, position: [0, .78, -5.2], target: [0, 3.8, 8] }, 左側: { fov: 38, position: [-11.5, 2.8, -13.5], target: [0, 3.8, 7.2] }, 右側: { fov: 38, position: [11.5, 2.8, -13.5], target: [0, 3.8, 7.2] }, 俯視: { fov: 42, position: [0, 27, -2], target: [0, 0, 7.2] } }; applyPose(camera, controls, name === "自由視角" ? readCamera(cameraKeyRef.current) ?? TEMPLATE_CAMERA : poses[name]); setPreset(name) };
  const resetCamera = () => { const camera = cameraRef.current, controls = controlsRef.current; if (!camera || !controls) return; try { localStorage.removeItem(cameraKeyRef.current) } catch { /* optional */ } applyPose(camera, controls, TEMPLATE_CAMERA); writeCamera(cameraKeyRef.current, camera, controls); setPreset("自由視角") };
  const captureView = () => rendererRef.current?.domElement.toDataURL("image/png") ?? null;
  const getCameraPose = () => cameraRef.current && controlsRef.current ? currentPose(cameraRef.current, controlsRef.current) : null;
  const exportView = () => { const data = captureView(); if (!data) return; const a = document.createElement("a"); a.download = `${image?.name || "舞台"}-3D視角.png`; a.href = data; a.click() };
  useImperativeHandle(ref, () => ({ exportView, captureView, getCameraPose }), [image]);

  const addPerson = (source?: Person) => { if (layout.people.length >= MAX_PEOPLE) return showNotice(`人物最多 ${MAX_PEOPLE} 位。`); const id = `person-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, base = source ?? { ...DEFAULT_PEOPLE[0], x: 0, z: 3.2, rotation: 0 }, next = clampPerson({ ...base, id, x: base.x + (source ? .5 : 0) }); setLayout(c => ({ ...c, people: [...c.people, next] })); setActivePersonId(id); setSelection({ kind: "person", id }) };
  const deletePerson = (id: string) => { setLayout(c => ({ ...c, people: c.people.filter(p => p.id !== id) })); setSelection({ kind: "backdrop" }) };
  const resetPerson = (id: string) => { const initial = DEFAULT_PEOPLE.find(p => p.id === id) ?? { ...DEFAULT_PEOPLE[0], id, x: 0, z: 3.2, rotation: 0 }; setLayout(c => ({ ...c, people: c.people.map(p => p.id === id ? { ...initial } : p) })); showNotice("人物位置與身高已重設。") };
  const resetBackdrop = () => { setLayout(c => ({ ...c, backdrop: { ...DEFAULT_BACKDROP } })); setSelection({ kind: "backdrop" }); showNotice("背板列已重設到第 9 線中央。") };
  const resetAll = () => { if (confirm("要把全部人物與背板恢復為初始配置嗎？")) { const next = copyDefaults(); setLayout(next); setActivePersonId(next.people[0]?.id ?? ""); setSelection({ kind: "backdrop" }); showNotice("全部 3D 物件已重設。") } };
  const snapPerson = (id: string) => { const z = layout.people.find(p => p.id === id)?.z; if (z == null) return; const i = clamp(Math.round(z / LINE_GAP), 0, LINE_COUNT - 1); updatePerson(id, { z: i * LINE_GAP }); showNotice(`人物已對齊第 ${i + 1} 線。`) };
  const snapBackdrop = () => { const i = clamp(Math.round(layout.backdrop.z / LINE_GAP), 0, LINE_COUNT - 1); updateBackdrop({ z: i * LINE_GAP }, false); showNotice(`背板已對齊第 ${i + 1} 線。`) };
  const person = layout.people.find(p => p.id === activePersonId) ?? layout.people[0] ?? null;
  const personIndex = person ? layout.people.findIndex(p => p.id === person.id) : -1;

  return <div className={`stage3d-shell ${compact ? "compact" : ""} ${showObjectControls && !controlsCollapsed ? "controls-open" : ""}`}>
    <div ref={mountRef} className="stage3d-canvas" aria-label="臺中市港區藝術中心 3D 舞台預覽" />
    {error && <div className="stage3d-error">{error}</div>}{notice && <div className="stage3d-notice" role="status">{notice}</div>}
    {!compact && <div className="stage3d-badges"><span>鏡框 15.42 × 8.50 m</span><span>天幕深度 10.65 m</span><span>投影 13.20 × 7.43 m・16:9</span></div>}
    <div className="stage3d-presets">{(["自由視角", "前排", "左側", "右側", "俯視"] as PresetName[]).map(name => <button key={name} className={preset === name ? "active" : ""} onClick={() => moveCamera(name)}>{name}</button>)}<button className="reset-view" onClick={resetCamera}>重設自由視角</button></div>
    {showObjectControls && controlsCollapsed && <button className="stage3d-panel-open" onClick={() => setControlsCollapsed(false)}>‹ 展開物件控制</button>}
    {showObjectControls && !controlsCollapsed && <div className="stage3d-objects" aria-label="3D 物件調整">
      <div className="stage3d-objects-title"><div><strong>物件調整</strong><span>人物與背板分區控制</span></div><button onClick={() => setControlsCollapsed(true)}>收合 ›</button></div>

      <section className={`stage3d-control-section person-section ${selection.kind === "person" ? "active" : ""}`} onPointerDown={() => person && setSelection({ kind: "person", id: person.id })}>
        <div className="stage3d-section-heading">
          <div><strong>人物調整</strong><span>{layout.people.length} 位人物</span></div>
          <button onClick={() => addPerson()}>＋ 新增人物</button>
        </div>
        {person ? <>
          <div className="stage3d-person-picker">
            <label><span>選擇人物</span><select value={person.id} onChange={e => { setActivePersonId(e.target.value); setSelection({ kind: "person", id: e.target.value }); }}>{layout.people.map((p, i) => <option key={p.id} value={p.id}>人物 {i + 1}{p.visible ? "" : "（隱藏）"}</option>)}</select></label>
            <label className="stage3d-visible-check"><input type="checkbox" checked={person.visible} onChange={e => updatePerson(person.id, { visible: e.target.checked })} />顯示</label>
          </div>
          <label className="stage3d-range-field"><span>人物身高</span><input type="range" min="158" max="185" value={person.heightCm} onChange={e => updatePerson(person.id, { heightCm: +e.target.value })} /><b>{person.heightCm} cm</b></label>
          <div className="stage3d-position-fields">
            <label><span>左右 X</span><div><input type="number" step=".1" value={round(person.x)} onChange={e => updatePerson(person.id, { x: +e.target.value })} /><b>m</b></div></label>
            <label><span>前後深度</span><div><input type="number" step=".1" value={round(person.z)} onChange={e => updatePerson(person.id, { z: +e.target.value })} /><b>m</b></div></label>
          </div>
          <label className="stage3d-range-field"><span>面向角度</span><input title="雙擊重設為 0°" type="range" min="-180" max="180" value={person.rotation} onDoubleClick={() => updatePerson(person.id, { rotation: 0 })} onChange={e => updatePerson(person.id, { rotation: +e.target.value })} /><b>{person.rotation}°</b></label>
          <div className="stage3d-quick-actions"><button onClick={() => updatePerson(person.id, { rotation: 0 })}>面向觀眾</button><button onClick={() => snapPerson(person.id)}>對齊地墊線</button><button onClick={() => resetPerson(person.id)}>重設人物</button></div>
          <div className="stage3d-person-actions"><button onClick={() => addPerson(person)} disabled={layout.people.length >= MAX_PEOPLE}>複製人物</button><button className="danger" onClick={() => deletePerson(person.id)}>刪除人物</button></div>
        </> : <button className="stage3d-empty-person" onClick={() => addPerson()}>＋ 新增第一位人物</button>}
      </section>

      <section className={`stage3d-control-section backdrop-section ${selection.kind === "backdrop" ? "active" : ""}`} onPointerDown={() => setSelection({ kind: "backdrop" })}>
        <div className="stage3d-section-heading">
          <div><strong>背板列調整</strong><span>整列共同移動與旋轉</span></div>
          <label className="stage3d-visible-check"><input type="checkbox" checked={layout.backdrop.visible} onChange={e => updateBackdrop({ visible: e.target.checked })} />顯示</label>
        </div>
        <label className="stage3d-backdrop-type"><span>物件類型</span><select value={layout.backdrop.style} onChange={e => { const style = e.target.value as BackdropStyle; updateBackdrop(style === "fence" ? { style, widthCm: 112, heightCm: 202 } : { style, widthCm: 122, heightCm: 252 }) }}><option value="solid">實心背板</option><option value="fence">柵欄</option></select></label>
        <div className="stage3d-backdrop-fields">
          <label><span>片數</span><input type="number" min="1" max="30" value={layout.backdrop.count} onChange={e => updateBackdrop({ count: +e.target.value })} /></label>
          <label><span>單片寬</span><div><input type="number" min="30" max="500" value={layout.backdrop.widthCm} onChange={e => updateBackdrop({ widthCm: +e.target.value })} /><b>cm</b></div></label>
          <label><span>單片高</span><div><input type="number" min="30" max="800" value={layout.backdrop.heightCm} onChange={e => updateBackdrop({ heightCm: +e.target.value })} /><b>cm</b></div></label>
          <label><span>片間距</span><div><input type="number" min="0" max="300" value={layout.backdrop.gapCm} onChange={e => updateBackdrop({ gapCm: +e.target.value })} /><b>cm</b></div></label>
        </div>
        <label className="stage3d-color-field"><span>背板顏色</span><div><input type="color" value={layout.backdrop.color} onChange={e => updateBackdrop({ color: e.target.value })} /><b>{layout.backdrop.color.toUpperCase()}</b></div></label>
        <div className="stage3d-position-fields">
          <label><span>左右 X</span><div><input type="number" step=".1" value={round(layout.backdrop.x)} onChange={e => updateBackdrop({ x: +e.target.value }, false)} /><b>m</b></div></label>
          <label><span>前後深度</span><div><input type="number" step=".1" value={round(layout.backdrop.z)} onChange={e => updateBackdrop({ z: +e.target.value }, false)} /><b>m</b></div></label>
        </div>
        <label className="stage3d-range-field"><span>面向角度</span><input title="雙擊重設為 0°" type="range" min="-180" max="180" value={layout.backdrop.rotation} onDoubleClick={() => updateBackdrop({ rotation: 0 })} onChange={e => updateBackdrop({ rotation: +e.target.value })} /><b>{layout.backdrop.rotation}°</b></label>
        <div className="stage3d-quick-actions backdrop-actions"><button onClick={() => updateBackdrop({ rotation: 0 })}>面向觀眾</button><button onClick={() => updateBackdrop({ x: 0 }, false)}>置中對齊</button><button onClick={snapBackdrop}>對齊地墊線</button><button onClick={resetBackdrop}>重設背板</button></div>
      </section>

      <button className="stage3d-reset-all" onClick={resetAll}>重設全部配置</button>
    </div>}
    {!compact && <div className="stage3d-help"><strong>{image ? image.name : "請先從左側選擇背景圖片"}</strong><span>{showObjectControls ? "點選物件後拖曳 · 方向鍵依觀眾視角移動 10 cm · Shift＋方向鍵 1 cm" : "左鍵旋轉 · 右鍵平移 · 滾輪縮放"}</span></div>}
  </div>;
});
export default Stage3D;
