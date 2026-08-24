import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

type ProjectionImage = { id?: string; url: string; posterUrl?: string; mediaType: "image" | "video"; playbackTime: number; name: string; note: string; transform: { scale: number; x: number; y: number; brightness: number; contrast: number; saturation: number; hue: number; temperature: number; fit: "width" | "height" } };
type PresetName = "自由視角" | "前排" | "左側" | "右側" | "俯視";
export type CameraPose = { fov: number; position: [number, number, number]; target: [number, number, number] };
type Person = { id: string; x: number; z: number; rotation: number; heightCm: number; visible: boolean };
type BackdropStyle = "solid" | "fence";
type Backdrop = { style: BackdropStyle; x: number; z: number; rotation: number; count: number; widthCm: number; heightCm: number; gapCm: number; color: string; visible: boolean };
type Layout = { version: 6; people: Person[]; backdrop: Backdrop };
type Selection = { kind: "person"; id: string } | { kind: "backdrop" };
type DragState = { selection: Selection; lastX: number; lastZ: number; x: number; z: number; personIds?: string[] };
type Legacy = { peopleVisible?: boolean; personHeightCm?: number; backdrop252Visible?: boolean; backdrop202Visible?: boolean; backdrop158Visible?: boolean };
type LayoutHistory = { past: Layout[]; future: Layout[] };

const STAGE = { width: 27, openingWidth: 15.42, openingHeight: 8.5, apronDepth: 2.6, depth: 18.81, cycloramaDepth: 10.65 };
const INNER = 6.6, LEG_WIDTH = STAGE.openingWidth / 2 - INNER, SCREEN_WIDTH = INNER * 2, SCREEN_HEIGHT = SCREEN_WIDTH * 9 / 16;
const LEG_DEPTHS = [1.1, 3.05, 5, 6.95, 8.9], LINE_GAP = .92, LINE_COUNT = 12, PERSON_HEIGHT = 1.7, MAX_PEOPLE = 50, BACKDROP_DEPTH = .48;
const SELECTION_MARKER_NAME = "selection-marker";
const MAX_LAYOUT_HISTORY = 15, LAYOUT_HISTORIES = new Map<string, LayoutHistory>();
const LEGACY_CAMERA_KEY = "stage-view-template-camera-v3", CAMERA_KEY_PREFIX = "stage-view-free-camera-v1:", OLD_KEY = "stage-view-objects-v1", LAYOUT_KEY = "stage-view-layout-v2", LAYOUT_KEY_PREFIX = "stage-view-layout-v3:", LAYOUT_CLIPBOARD_KEY = "stage-view-layout-clipboard-v1";
const DEFAULT_PEOPLE: Person[] = [
  ["person-1", -5, 3.2, -10], ["person-2", -4.15, 5.8, 7], ["person-3", -1.25, 4.2, -5],
  ["person-4", 1.25, 4.2, 5], ["person-5", 4.15, 5.8, -7], ["person-6", 5, 3.2, 10],
].map(([id, x, z, rotation]) => ({ id: String(id), x: Number(x), z: Number(z), rotation: Number(rotation), heightCm: 165, visible: true }));
const FENCE_DEFAULT_COLOR = "#B7BDC3";
const DEFAULT_BACKDROP: Backdrop = { style: "solid", x: 0, z: 7.36, rotation: 0, count: 1, widthCm: 122, heightCm: 252, gapCm: 0, color: "#765548", visible: true };
const CAMERA_FOV_50MM = 22.3;
const TEMPLATE_CAMERA: CameraPose = { fov: CAMERA_FOV_50MM, position: [-6.8, 4.2, -18], target: [0, 3.4, 7.2] };
export type Stage3DHandle = { exportView: () => void; captureView: () => string | null; getCameraPose: () => CameraPose | null };
type Stage3DProps = {
  image: ProjectionImage | null;
  compact?: boolean;
  showObjectControls?: boolean;
  syncId?: string;
  syncCamera?: { sourceId: string; serial: number; pose: CameraPose } | null;
  onCameraChange?: (sourceId: string, pose: CameraPose) => void;
  onVideoFrame?: (time: number, posterBlob: Blob) => void;
  onVideoError?: () => void;
};

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
const normalizeRotation = (n: number) => { let r = n % 360; if (r > 180) r -= 360; if (r < -180) r += 360; return round(r, 1) };
const copyDefaults = (): Layout => ({ version: 6, people: DEFAULT_PEOPLE.map(p => ({ ...p })), backdrop: { ...DEFAULT_BACKDROP } });
const copyLayout = (layout: Layout): Layout => ({ version: 6, people: layout.people.map(person => ({ ...person })), backdrop: { ...layout.backdrop } });
const fit169 = (w: number, h: number) => w / Math.max(1, h) > 16 / 9 ? { width: h * 16 / 9, height: h } : { width: w, height: w * 9 / 16 };
const renderPixelRatio = (width: number, height: number, compact: boolean) => {
  const pixelBudget = compact ? 450_000 : 2_600_000, dprLimit = compact ? 1.25 : 1.5;
  return Math.max(.75, Math.min(devicePixelRatio || 1, dprLimit, Math.sqrt(pixelBudget / Math.max(1, width * height))));
};
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
function objectLayoutKey(image?: ProjectionImage | null) { return `${LAYOUT_KEY_PREFIX}${image?.id ?? "default"}` }
function readCamera(key: string): CameraPose | null {
  try {
    const raw = localStorage.getItem(key) ?? (key === cameraKey(null) ? localStorage.getItem(LEGACY_CAMERA_KEY) : null);
    const v = JSON.parse(raw || "null") as Partial<CameraPose> | null;
    return v && typeof v.fov === "number" && validTuple(v.position) && validTuple(v.target) ? { fov: CAMERA_FOV_50MM, position: v.position, target: v.target } : null;
  } catch { return null }
}
function normalizeLayout(value: unknown): Layout | null {
  const v = value as { version?: number; people?: Partial<Person>[]; backdrop?: Partial<Backdrop> } | null;
  if (!v || ![2, 3, 4, 5, 6].includes(v.version ?? 0) || !Array.isArray(v.people) || !v.backdrop) return null;
  const seen = new Set<string>();
  const people = v.people.slice(0, MAX_PEOPLE).map((p, i) => {
    const fallback = DEFAULT_PEOPLE[i] ?? { ...DEFAULT_PEOPLE[0], id: `person-${i + 1}`, x: 0, z: 3.2 }, next = cleanPerson(p, fallback);
    while (seen.has(next.id)) next.id += `-${i + 1}`;
    seen.add(next.id); return next;
  });
  const backdrop = cleanBackdrop(v.backdrop);
  if (v.version === 2 && backdrop.gapCm === 20) backdrop.gapCm = 0;
  if (v.version === 5 && backdrop.style === "fence" && backdrop.color.toLowerCase() === DEFAULT_BACKDROP.color) backdrop.color = FENCE_DEFAULT_COLOR;
  return { version: 6, people, backdrop: clampBackdrop(backdrop) };
}
function readLayout(storageKey: string): Layout {
  try { const stored = localStorage.getItem(storageKey) ?? (storageKey === objectLayoutKey(null) ? localStorage.getItem(LAYOUT_KEY) : null), normalized = normalizeLayout(JSON.parse(stored || "null")); if (normalized) return normalized } catch { /* migrate below */ }
  const next = copyDefaults();
  if (storageKey !== objectLayoutKey(null)) return next;
  try {
    const old = JSON.parse(localStorage.getItem(OLD_KEY) || "null") as Legacy | null;
    if (old) {
      const heightCm = clamp(Math.round(Number(old.personHeightCm) || 165), 158, 185);
      next.people = next.people.map(p => ({ ...p, heightCm, visible: old.peopleVisible ?? true }));
      next.backdrop.visible = old.backdrop252Visible ?? old.backdrop158Visible ?? old.backdrop202Visible ?? true;
    }
  } catch { /* defaults */ }
  return next;
}
function writeCamera(key: string, camera: THREE.PerspectiveCamera, controls: OrbitControls) {
  try { localStorage.setItem(key, JSON.stringify({ fov: CAMERA_FOV_50MM, position: camera.position.toArray(), target: controls.target.toArray() })) } catch { /* optional */ }
}
function applyPose(camera: THREE.PerspectiveCamera, controls: OrbitControls, pose: CameraPose) {
  camera.fov = CAMERA_FOV_50MM; camera.position.set(...pose.position); controls.target.set(...pose.target); camera.updateProjectionMatrix(); controls.update();
}
function currentPose(camera: THREE.PerspectiveCamera, controls: OrbitControls): CameraPose {
  return { fov: CAMERA_FOV_50MM, position: camera.position.toArray() as [number, number, number], target: controls.target.toArray() as [number, number, number] };
}
const lit = (color: number, roughness = .78, metalness = .02) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
const unlit = (color: number) => new THREE.MeshBasicMaterial({ color, toneMapped: false });
function box(parent: THREE.Object3D, size: [number, number, number], position: [number, number, number], material: THREE.Material, cast = false, receive = true) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material); mesh.position.set(...position); mesh.castShadow = cast; mesh.receiveShadow = receive; parent.add(mesh); return mesh;
}
function instancedBoxes(parent: THREE.Object3D, size: [number, number, number], positions: [number, number, number][], material: THREE.Material, cast = false) {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(...size), material, positions.length), matrix = new THREE.Matrix4(); positions.forEach((position, i) => { matrix.makeTranslation(...position); mesh.setMatrixAt(i, matrix) }); mesh.castShadow = cast; parent.add(mesh); return mesh;
}
function makePerson(material: THREE.Material, markerMaterial: THREE.Material) {
  const part = (geometry: THREE.BufferGeometry, x: number, y: number, z = 0, rotationZ = 0) => { if (rotationZ) geometry.rotateZ(rotationZ); geometry.translate(x, y, z); return geometry };
  const parts = [
    part(new THREE.CapsuleGeometry(.2, .68, 3, 6), 0, .98), part(new THREE.SphereGeometry(.16, 8, 6), 0, 1.54),
    part(new THREE.CylinderGeometry(.055, .065, .78, 6), -.09, .39, 0, -.05), part(new THREE.CylinderGeometry(.055, .065, .78, 6), .09, .39, 0, .05),
    part(new THREE.CylinderGeometry(.055, .07, .68, 6), -.255, 1.04, 0, -.08), part(new THREE.CylinderGeometry(.055, .07, .68, 6), .255, 1.04, 0, .08),
  ];
  const geometry = mergeGeometries(parts, false); parts.forEach(g => g.dispose());
  const group = new THREE.Group(); if (geometry) { const mesh = new THREE.Mesh(geometry, material); mesh.castShadow = true; group.add(mesh) }
  const marker = new THREE.Mesh(new THREE.RingGeometry(.28, .35, 24), markerMaterial); marker.name = SELECTION_MARKER_NAME; marker.rotation.x = -Math.PI / 2; marker.position.y = .025; marker.renderOrder = 8; marker.visible = false; group.add(marker); return group;
}
function makePanel(panelMat: THREE.Material, frameMat: THREE.Material, width: number, height: number, style: BackdropStyle) {
  const g = new THREE.Group();
  if (style === "fence") {
    const bar = Math.min(.065, width * .08), verticalGeo = new THREE.BoxGeometry(bar, height, .1), horizontalGeo = new THREE.BoxGeometry(width, bar, .1);
    for (let i = 1; i <= 5; i++) { const picket = new THREE.Mesh(verticalGeo, panelMat); picket.position.set(-width / 2 + width * i / 6, height / 2, 0); g.add(picket) }
    const left = new THREE.Mesh(verticalGeo, panelMat); left.position.set(-width / 2 + bar / 2, height / 2, 0); const right = left.clone(); right.position.x *= -1;
    const bottom = new THREE.Mesh(horizontalGeo, panelMat); bottom.position.set(0, bar / 2, 0); const top = bottom.clone(); top.position.y = height - bar / 2;
    g.add(left, right, bottom, top);
  } else {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(width, height, .08), panelMat); panel.position.y = height / 2; g.add(panel);
    const sideGeo = new THREE.BoxGeometry(.045, height, .12), left = new THREE.Mesh(sideGeo, frameMat); left.position.set(-width / 2 + .0225, height / 2, 0); const right = left.clone(); right.position.x *= -1; g.add(left, right);
  }
  const footGeo = new THREE.BoxGeometry(Math.min(.28, width * .45), .06, BACKDROP_DEPTH), lf = new THREE.Mesh(footGeo, frameMat); lf.position.set(-width * .32, .03, .08); const rf = lf.clone(); rf.position.x *= -1;
  const wheelGeo = new THREE.CylinderGeometry(.045, .045, .035, 6), lw = new THREE.Mesh(wheelGeo, frameMat); lw.position.set(-width * .32, .045, .18); lw.rotation.x = Math.PI / 2; const rw = lw.clone(); rw.position.x *= -1;
  g.add(lf, rf, lw, rw); return g;
}
function projectionTexture(image: ProjectionImage) {
  return new Promise<THREE.CanvasTexture>((resolve, reject) => {
    const source = new Image();
    source.onload = () => {
      const c = document.createElement("canvas"); c.width = 1920; c.height = 1080; const ctx = c.getContext("2d"); if (!ctx) return reject();
      ctx.fillStyle = "#050505"; ctx.fillRect(0, 0, c.width, c.height);
      const base = image.transform.fit === "height" ? c.height / source.naturalHeight : c.width / source.naturalWidth;
      const scale = base * image.transform.scale / 100, w = source.naturalWidth * scale, h = source.naturalHeight * scale;
      const flatProjectionRatio = 1551 / 1920;
      const warmth = Math.abs(image.transform.temperature), temperatureHue = image.transform.temperature > 0 ? -warmth * .1 : warmth * .1;
      ctx.filter = image.mediaType === "image" ? `brightness(${image.transform.brightness}%) contrast(${image.transform.contrast}%) saturate(${image.transform.saturation + warmth * .18}%) sepia(${warmth * .16}%) hue-rotate(${image.transform.hue + temperatureHue}deg)` : "none";
      ctx.drawImage(source, (c.width - w) / 2 + image.transform.x / 100 * c.width / flatProjectionRatio, (c.height - h) / 2 + image.transform.y / 100 * c.height / flatProjectionRatio, w, h);
      const texture = new THREE.CanvasTexture(c); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4; resolve(texture);
    };
    source.onerror = reject; source.src = image.mediaType === "video" ? image.posterUrl ?? "" : image.url;
  });
}

function captureVideoPoster(video: HTMLVideoElement) {
  return new Promise<Blob>((resolve, reject) => {
    if (!video.videoWidth || !video.videoHeight) return reject(new Error("video frame unavailable"));
    const scale = Math.min(1, 1920 / video.videoWidth, 1080 / video.videoHeight), canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d"); if (!context) return reject(new Error("canvas unavailable")); context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("poster capture failed")), "image/jpeg", .9);
  });
}

function drawVideoProjection(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, image: ProjectionImage, video: HTMLVideoElement) {
  context.fillStyle = "#050505"; context.fillRect(0, 0, canvas.width, canvas.height);
  const base = image.transform.fit === "height" ? canvas.height / video.videoHeight : canvas.width / video.videoWidth, scale = base * image.transform.scale / 100, width = video.videoWidth * scale, height = video.videoHeight * scale, flatProjectionRatio = 1551 / 1920;
  context.drawImage(video, (canvas.width - width) / 2 + image.transform.x / 100 * canvas.width / flatProjectionRatio, (canvas.height - height) / 2 + image.transform.y / 100 * canvas.height / flatProjectionRatio, width, height);
}

const Stage3D = forwardRef<Stage3DHandle, Stage3DProps>(function Stage3D({ image, compact = false, showObjectControls = true, syncId = "main", syncCamera = null, onCameraChange, onVideoFrame, onVideoError }, ref) {
  const objectKeyRef = useRef(objectLayoutKey(image));
  const mountRef = useRef<HTMLDivElement>(null), rendererRef = useRef<THREE.WebGLRenderer | null>(null), cameraRef = useRef<THREE.PerspectiveCamera | null>(null), controlsRef = useRef<OrbitControls | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null), videoFrameRef = useRef(0), drawVideoRef = useRef<() => void>(() => {}), videoSavedTimeRef = useRef(0), imageRef = useRef(image);
  const sceneRef = useRef<THREE.Scene | null>(null), screenMatRef = useRef<THREE.MeshBasicMaterial | null>(null), textureRef = useRef<THREE.Texture | null>(null), personMatRef = useRef<THREE.Material | null>(null), markerMatRef = useRef<THREE.Material | null>(null);
  const backdropMatsRef = useRef<{ panel: THREE.Material; frame: THREE.Material } | null>(null), peopleRef = useRef(new Map<string, THREE.Group>()), backdropRef = useRef<THREE.Group | null>(null), backdropSpecRef = useRef("");
  const dragRef = useRef<DragState | null>(null), renderRef = useRef<() => void>(() => {}), flashSelectionRef = useRef<(duration?: number) => void>(() => {}), markerVisibleRef = useRef(false), visibleMarkersRef = useRef<THREE.Object3D[]>([]), markerTimerRef = useRef<number | null>(null), timerRef = useRef<number | null>(null), applyingSyncRef = useRef(false), onCameraChangeRef = useRef(onCameraChange), onVideoFrameRef = useRef(onVideoFrame), onVideoErrorRef = useRef(onVideoError);
  const [preset, setPreset] = useState<PresetName>("自由視角"), [layout, rawSetLayout] = useState<Layout>(() => readLayout(objectKeyRef.current)), [selection, setSelection] = useState<Selection>({ kind: "backdrop" }), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [controlsCollapsed, setControlsCollapsed] = useState(() => localStorage.getItem("stage3d-controls-collapsed") === "1");
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [clipboardReady, setClipboardReady] = useState(() => { try { return Boolean(localStorage.getItem(LAYOUT_CLIPBOARD_KEY)) } catch { return false } });
  const [activePersonId, setActivePersonId] = useState(() => layout.people[0]?.id ?? "");
  const [selectedPersonIds, setSelectedPersonIds] = useState<string[]>([]);
  const layoutRef = useRef(layout), selectionRef = useRef(selection), selectedPersonIdsRef = useRef(selectedPersonIds), cameraKeyRef = useRef(cameraKey(image)), layoutHistoryGroupRef = useRef<{ key: string; captured: boolean; snapshot: Layout } | null>(null); layoutRef.current = layout; selectionRef.current = selection; selectedPersonIdsRef.current = selectedPersonIds; cameraKeyRef.current = cameraKey(image);
  onCameraChangeRef.current = onCameraChange;
  onVideoFrameRef.current = onVideoFrame; onVideoErrorRef.current = onVideoError;
  imageRef.current = image;
  const showNotice = (message: string) => { setNotice(message); if (timerRef.current) clearTimeout(timerRef.current); timerRef.current = window.setTimeout(() => setNotice(""), 2600) };
  const getLayoutHistory = (key = objectKeyRef.current) => { let history = LAYOUT_HISTORIES.get(key); if (!history) { history = { past: [], future: [] }; LAYOUT_HISTORIES.set(key, history) } return history };
  const pushLayoutHistory = (snapshot: Layout, key = objectKeyRef.current) => { const history = getLayoutHistory(key); history.past.push(snapshot); history.past = history.past.slice(-MAX_LAYOUT_HISTORY); history.future = [] };
  const beginLayoutInteraction = () => { layoutHistoryGroupRef.current = { key: objectKeyRef.current, captured: false, snapshot: copyLayout(layoutRef.current) } };
  const endLayoutInteraction = () => { layoutHistoryGroupRef.current = null };
  const setLayout = (action: SetStateAction<Layout>) => rawSetLayout(current => {
    const next = typeof action === "function" ? action(current) : action;
    if (next === current || JSON.stringify(next) === JSON.stringify(current)) return current;
    const key = objectKeyRef.current, group = layoutHistoryGroupRef.current, shouldCapture = !group || group.key !== key || !group.captured;
    if (shouldCapture) { pushLayoutHistory(group?.key === key ? group.snapshot : copyLayout(current), key); if (group?.key === key) group.captured = true }
    return next;
  });
  const updatePerson = (id: string, patch: Partial<Person>) => setLayout(current => ({ ...current, people: current.people.map(p => p.id === id ? clampPerson(cleanPerson({ ...p, ...patch }, p)) : p) }));
  const updatePeople = (ids: string[], patch: Partial<Person>) => { const chosen = new Set(ids); setLayout(current => ({ ...current, people: current.people.map(p => chosen.has(p.id) ? clampPerson(cleanPerson({ ...p, ...patch }, p)) : p) })) };
  const movePeopleBy = (ids: string[], dx: number, dz: number) => { const chosen = new Set(ids); setLayout(current => { const people = current.people.filter(p => chosen.has(p.id)); if (!people.length) return current; let minX = -Infinity, maxX = Infinity, minZ = -Infinity, maxZ = Infinity; people.forEach(p => { const r = .32 * p.heightCm / 170; minX = Math.max(minX, -13.5 + r - p.x); maxX = Math.min(maxX, 13.5 - r - p.x); minZ = Math.max(minZ, r - p.z); maxZ = Math.min(maxZ, STAGE.depth - r - p.z) }); const mx = clamp(dx, minX, maxX), mz = clamp(dz, minZ, maxZ); return { ...current, people: current.people.map(p => chosen.has(p.id) ? { ...p, x: round(p.x + mx), z: round(p.z + mz) } : p) } }) };
  const updateBackdrop = (patch: Partial<Backdrop>, reject = true) => setLayout(current => {
    const candidate = cleanBackdrop({ ...current.backdrop, ...patch });
    if (reject && !backdropFits(candidate)) { setTimeout(() => showNotice("這個背板列的尺寸或角度無法放入舞台。"), 0); return current }
    return { ...current, backdrop: clampBackdrop(candidate) };
  });

  useLayoutEffect(() => { const nextKey = objectLayoutKey(image); if (nextKey === objectKeyRef.current) return; objectKeyRef.current = nextKey; layoutHistoryGroupRef.current = null; const next = readLayout(nextKey); rawSetLayout(next); setActivePersonId(next.people[0]?.id ?? ""); setSelectedPersonIds([]); setSelection({ kind: "backdrop" }) }, [image?.id]);
  useEffect(() => { try { localStorage.setItem(objectKeyRef.current, JSON.stringify(layout)) } catch { /* optional */ } }, [layout]);
  useEffect(() => { if (showObjectControls) try { localStorage.setItem("stage3d-controls-collapsed", controlsCollapsed ? "1" : "0") } catch { /* optional */ } }, [controlsCollapsed, showObjectControls]);
  useEffect(() => {
    const mount = mountRef.current; if (!mount) return; let frame = 0, renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false, powerPreference: "high-performance" }) } catch { setError("這個瀏覽器目前無法啟動 3D 畫面，請確認硬體加速已開啟。"); return }
    const size = fit169(mount.clientWidth, mount.clientHeight); renderer.setPixelRatio(renderPixelRatio(size.width, size.height, compact)); renderer.setSize(size.width, size.height, false); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = .9; renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = true; renderer.domElement.tabIndex = 0; mount.appendChild(renderer.domElement); rendererRef.current = renderer;
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x070809); sceneRef.current = scene;
    const pose = readCamera(cameraKeyRef.current) ?? TEMPLATE_CAMERA, camera = new THREE.PerspectiveCamera(pose.fov, 16 / 9, .1, 180); camera.position.set(...pose.position); cameraRef.current = camera;
    const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = false; controls.target.set(...pose.target); controls.minDistance = 2.5; controls.maxDistance = 140; controls.maxPolarAngle = Math.PI * .92; controls.update(); controlsRef.current = controls;
    const draw = () => { visibleMarkersRef.current.forEach(marker => { marker.visible = false }); visibleMarkersRef.current = []; if (showObjectControls && markerVisibleRef.current) { const s = selectionRef.current; if (s.kind === "backdrop") { const marker = backdropRef.current?.getObjectByName(SELECTION_MARKER_NAME); if (marker && backdropRef.current?.visible) { marker.visible = true; visibleMarkersRef.current.push(marker) } } else selectedPersonIdsRef.current.forEach(id => { const group = peopleRef.current.get(id), marker = group?.getObjectByName(SELECTION_MARKER_NAME); if (marker && group?.visible) { marker.visible = true; visibleMarkersRef.current.push(marker) } }) } renderer.render(scene, camera) };
    const requestRender = () => { if (frame) return; frame = requestAnimationFrame(() => { frame = 0; draw() }) }; renderRef.current = requestRender;
    const flashSelection = (duration = 900) => { markerVisibleRef.current = true; if (markerTimerRef.current) clearTimeout(markerTimerRef.current); requestRender(); if (duration > 0) markerTimerRef.current = window.setTimeout(() => { if (!dragRef.current) { markerVisibleRef.current = false; requestRender() } }, duration) }; flashSelectionRef.current = flashSelection;
    const emitCamera = () => { requestRender(); if (!applyingSyncRef.current) onCameraChangeRef.current?.(syncId, currentPose(camera, controls)) };
    const remember = () => { if (!dragRef.current) { writeCamera(cameraKeyRef.current, camera, controls); setPreset("自由視角") } };
    controls.addEventListener("change", emitCamera); controls.addEventListener("end", remember);
    scene.add(new THREE.HemisphereLight(0x9cb5ca, 0x19120f, 1.1)); const key = new THREE.SpotLight(0xffe4c5, 760, 52, Math.PI / 4.5, .42, 1.4); key.position.set(-5, 15, -5); key.target.position.set(0, 0, 7); key.castShadow = true; key.shadow.mapSize.set(1024, 1024); scene.add(key, key.target); const fill = new THREE.DirectionalLight(0x8aa9d7, 1.6); fill.position.set(7, 9, -8); scene.add(fill);
    const black = lit(0x090909, .92), curtain = lit(0x050505, 1), floor = lit(0x3b3936, .88), apron = lit(0x3c241b, .9), frameMat = lit(0xaaa5ba, .35, .2), line = lit(0xc8c3ba, .82); personMatRef.current = lit(0x747678, .72, .05); markerMatRef.current = new THREE.MeshBasicMaterial({ color: 0xff754c, transparent: true, opacity: .82, toneMapped: false, depthWrite: false }); backdropMatsRef.current = { panel: unlit(0x765548), frame: unlit(0x2b2927) };
    box(scene, [27, .24, STAGE.depth], [0, -.12, STAGE.depth / 2], floor);
    const shape = new THREE.Shape(); shape.moveTo(-9.1, 0); shape.lineTo(9.1, 0); shape.quadraticCurveTo(0, STAGE.apronDepth * 2, -9.1, 0); const apronMesh = new THREE.Mesh(new THREE.ShapeGeometry(shape, 48), apron); apronMesh.rotation.x = -Math.PI / 2; apronMesh.position.y = -.14; scene.add(apronMesh);
    instancedBoxes(scene, [27, .025, .035], Array.from({ length: LINE_COUNT }, (_, i) => [0, .02, i * LINE_GAP] as [number, number, number]), line);
    const blueTape = unlit(0x2878db), whiteTape = unlit(0xf4f2ea), yellowTape = unlit(0xf3df28), markerLines = [0, 2, 4, 6, 8].map(i => i * LINE_GAP);
    box(scene, [.055, .03, STAGE.cycloramaDepth], [0, .035, STAGE.cycloramaDepth / 2], blueTape, false, false);
    instancedBoxes(scene, [.46, .035, .075], [...markerLines.map(z => [0, .052, z] as [number, number, number]), [-4.6, .052, .03], [4.6, .052, .03]], whiteTape);
    instancedBoxes(scene, [.07, .035, .3], [[-4.6, .053, .15], [0, .053, .15], [4.6, .053, .15]], whiteTape);
    box(scene, [.085, .04, .3], [0, .047, 6 * LINE_GAP], yellowTape, false, false);
    box(scene, [.58, 9.5, 1.05], [-8, 4.55, -.05], black); box(scene, [.58, 9.5, 1.05], [8, 4.55, -.05], black); box(scene, [16.58, .65, 1.05], [0, 8.82, -.05], black);
    box(scene, [.22, 8.95, .2], [-7.82, 4.37, -.65], frameMat); box(scene, [.22, 8.95, .2], [7.82, 4.37, -.65], frameMat); box(scene, [15.86, .22, .2], [0, 8.73, -.65], frameMat);
    box(scene, [27, 10.5, .28], [0, 5, STAGE.depth], black); box(scene, [.34, 10.5, STAGE.depth + 2.2], [-12.8, 5, 8.3], black); box(scene, [.34, 10.5, STAGE.depth + 2.2], [12.8, 5, 8.3], black);
    const legCenter = INNER + LEG_WIDTH / 2; instancedBoxes(scene, [LEG_WIDTH, 8.5, .13], LEG_DEPTHS.flatMap(z => [[-legCenter, 4.25, z], [legCenter, 4.25, z]] as [number, number, number][]), curtain, true);
    const screenMat = new THREE.MeshBasicMaterial({ color: 0x25282d, side: THREE.DoubleSide, toneMapped: false, fog: false }); screenMatRef.current = screenMat; const screen = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_WIDTH, SCREEN_HEIGHT), screenMat); screen.position.set(0, SCREEN_HEIGHT / 2, STAGE.cycloramaDepth); screen.rotation.y = Math.PI; scene.add(screen); box(scene, [STAGE.openingWidth, STAGE.openingHeight - SCREEN_HEIGHT, .12], [0, SCREEN_HEIGHT + (STAGE.openingHeight - SCREEN_HEIGHT) / 2, STAGE.cycloramaDepth + .04], black);
    const ray = new THREE.Raycaster(), pointer = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const setRay = (e: PointerEvent) => { const r = renderer.domElement.getBoundingClientRect(); pointer.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1); ray.setFromCamera(pointer, camera) };
    const pick = (e: PointerEvent) => { setRay(e); const targets: THREE.Object3D[] = [...peopleRef.current.values()]; if (backdropRef.current) targets.push(backdropRef.current); let o: THREE.Object3D | null = ray.intersectObjects(targets, true)[0]?.object ?? null; while (o) { if (o.userData.selection) return o.userData.selection as Selection; o = o.parent } return null };
    const floorPoint = (e: PointerEvent) => { setRay(e); return ray.ray.intersectPlane(plane, new THREE.Vector3()) };
    const down = (e: PointerEvent) => {
      if (!showObjectControls || e.button !== 0) return;
      const selected = pick(e), point = floorPoint(e);
      if (!selected || !point) return;
      if (selected.kind === "person" && e.altKey) {
        const current = layoutRef.current, source = current.people.find(p => p.id === selected.id);
        if (!source) return;
        controls.enabled = false; requestAnimationFrame(() => { controls.enabled = true });
        if (current.people.length >= MAX_PEOPLE) showNotice(`人物最多 ${MAX_PEOPLE} 位。`);
        else {
          const id = `person-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, next = clampPerson({ ...source, id, x: source.x + .5 });
          setLayout(value => ({ ...value, people: [...value.people, next] }));
          setActivePersonId(id); setSelectedPersonIds([id]); setSelection({ kind: "person", id }); flashSelection(900); showNotice("已複製人物；視角與其他物件不變。");
        }
        e.preventDefault(); return;
      }
      beginLayoutInteraction();
      if (selected.kind === "backdrop") {
        const b = layoutRef.current.backdrop; setSelectedPersonIds([]); dragRef.current = { selection: selected, lastX: point.x, lastZ: point.z, x: b.x, z: b.z };
      } else {
        const currentIds = selectedPersonIdsRef.current, personIds = e.shiftKey ? Array.from(new Set([...currentIds, selected.id])) : currentIds.includes(selected.id) ? currentIds : [selected.id], person = layoutRef.current.people.find(p => p.id === selected.id);
        if (!person) return;
        setSelectedPersonIds(personIds); setActivePersonId(selected.id); dragRef.current = { selection: selected, lastX: point.x, lastZ: point.z, x: person.x, z: person.z, personIds };
      }
      controls.enabled = false; setSelection(selected); flashSelection(0); renderer.domElement.setPointerCapture(e.pointerId); e.preventDefault();
    };
    const move = (e: PointerEvent) => { const drag = dragRef.current, point = floorPoint(e); if (!drag || !point) return; const dx = point.x - drag.lastX, dz = e.shiftKey ? 0 : point.z - drag.lastZ; drag.lastX = point.x; drag.lastZ = point.z; if (drag.selection.kind === "backdrop") { drag.x += dx; drag.z += dz; updateBackdrop({ x: drag.x, z: drag.z }, false) } else movePeopleBy(drag.personIds ?? [drag.selection.id], dx, dz); e.preventDefault() };
    const up = (e: PointerEvent) => { if (!dragRef.current) return; dragRef.current = null; endLayoutInteraction(); controls.enabled = true; flashSelection(550); if (renderer.domElement.hasPointerCapture(e.pointerId)) renderer.domElement.releasePointerCapture(e.pointerId); e.preventDefault() };
    const focusCanvas = () => renderer.domElement.focus({ preventScroll: true });
    renderer.domElement.addEventListener("pointerdown", focusCanvas);
    renderer.domElement.addEventListener("pointerdown", down, true); renderer.domElement.addEventListener("pointermove", move, true); renderer.domElement.addEventListener("pointerup", up, true); renderer.domElement.addEventListener("pointercancel", up, true);
    const ro = new ResizeObserver(() => { const s = fit169(Math.max(1, mount.clientWidth), Math.max(1, mount.clientHeight)); renderer.setPixelRatio(renderPixelRatio(s.width, s.height, compact)); renderer.setSize(s.width, s.height, false); camera.aspect = 16 / 9; camera.updateProjectionMatrix(); requestRender() }); ro.observe(mount); requestRender();
    return () => { cancelAnimationFrame(frame); if (markerTimerRef.current) clearTimeout(markerTimerRef.current); ro.disconnect(); renderer.domElement.removeEventListener("pointerdown", focusCanvas); controls.removeEventListener("change", emitCamera); controls.removeEventListener("end", remember); controls.dispose(); renderRef.current = () => {}; flashSelectionRef.current = () => {}; visibleMarkersRef.current = []; textureRef.current?.dispose(); scene.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()) } }); renderer.dispose(); renderer.domElement.remove(); rendererRef.current = cameraRef.current = controlsRef.current = sceneRef.current = screenMatRef.current = personMatRef.current = markerMatRef.current = backdropMatsRef.current = null; peopleRef.current.clear(); backdropRef.current = null };
  }, []);

  useEffect(() => {
    const scene = sceneRef.current, mat = personMatRef.current, markerMat = markerMatRef.current; if (!scene || !mat || !markerMat) return; const ids = new Set(layout.people.map(p => p.id));
    peopleRef.current.forEach((g, id) => { if (!ids.has(id)) { scene.remove(g); g.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() }); peopleRef.current.delete(id) } });
    layout.people.forEach(p => { let g = peopleRef.current.get(p.id); if (!g) { g = makePerson(mat, markerMat); g.userData.selection = { kind: "person", id: p.id } satisfies Selection; scene.add(g); peopleRef.current.set(p.id, g) } g.position.set(p.x, 0, p.z); g.rotation.y = THREE.MathUtils.degToRad(p.rotation); g.scale.setScalar(p.heightCm / 100 / PERSON_HEIGHT); g.visible = p.visible });
    if (rendererRef.current) rendererRef.current.shadowMap.needsUpdate = true;
    renderRef.current();
  }, [layout.people]);
  useEffect(() => {
    const scene = sceneRef.current, mats = backdropMatsRef.current, markerMat = markerMatRef.current; if (!scene || !mats || !markerMat) return; const b = layout.backdrop, spec = `${b.style}-${b.count}-${b.widthCm}-${b.heightCm}-${b.gapCm}`; let g = backdropRef.current;
    if (mats.panel instanceof THREE.MeshBasicMaterial) mats.panel.color.set(b.color);
    if (!g) { g = new THREE.Group(); g.userData.selection = { kind: "backdrop" } satisfies Selection; scene.add(g); backdropRef.current = g }
    if (backdropSpecRef.current !== spec) { while (g.children.length) g.children.pop()?.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() }); const width = b.widthCm / 100, height = b.heightCm / 100, gap = b.gapCm / 100, total = b.count * width + (b.count - 1) * gap; for (let i = 0; i < b.count; i++) { const panel = makePanel(mats.panel, mats.frame, width, height, b.style); panel.position.x = -total / 2 + width / 2 + i * (width + gap); g.add(panel) } const marker = new THREE.Mesh(new THREE.BoxGeometry(total + .12, .025, .055), markerMat); marker.name = SELECTION_MARKER_NAME; marker.position.set(0, .03, -BACKDROP_DEPTH / 2 - .035); marker.renderOrder = 8; marker.visible = false; g.add(marker); backdropSpecRef.current = spec }
    g.position.set(b.x, 0, b.z); g.rotation.y = THREE.MathUtils.degToRad(b.rotation); g.visible = b.visible;
    if (rendererRef.current) rendererRef.current.shadowMap.needsUpdate = true;
    renderRef.current();
  }, [layout.backdrop]);
  useEffect(() => { const valid = new Set(layout.people.map(p => p.id)), next = selectedPersonIds.filter(id => valid.has(id)); if (next.length !== selectedPersonIds.length) setSelectedPersonIds(next); if (selection.kind === "person" && !valid.has(selection.id)) setSelection({ kind: "backdrop" }) }, [layout.people, selectedPersonIds, selection]);
  useEffect(() => { flashSelectionRef.current(900) }, [selection, selectedPersonIds]);
  useEffect(() => { if (!layout.people.some(p => p.id === activePersonId)) setActivePersonId(layout.people[0]?.id ?? "") }, [activePersonId, layout.people]);
  const applyLayoutHistory = (direction: "undo" | "redo") => {
    const history = getLayoutHistory(), source = direction === "undo" ? history.past : history.future, target = source.pop();
    if (!target) return;
    const destination = direction === "undo" ? history.future : history.past; destination.push(copyLayout(layoutRef.current)); if (destination.length > MAX_LAYOUT_HISTORY) destination.shift(); layoutHistoryGroupRef.current = null; rawSetLayout(copyLayout(target));
    showNotice(direction === "undo" ? "已復原這張圖片的上一個 3D 物件調整。" : "已重做這張圖片的下一個 3D 物件調整。");
  };
  useEffect(() => {
    if (!showObjectControls) return;
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest("input,textarea,select,button,[contenteditable='true']")) return;
      const historyKey = e.key.toLowerCase(), historyShortcut = (e.ctrlKey || e.metaKey) && !e.altKey && (historyKey === "z" || historyKey === "y");
      if (historyShortcut) { e.preventDefault(); applyLayoutHistory(e.shiftKey || historyKey === "y" ? "redo" : "undo"); return }
      const selected = selectionRef.current;
      if ((e.key === "Delete" || e.key === "Backspace") && selected.kind === "person" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const ids = selectedPersonIdsRef.current.length ? selectedPersonIdsRef.current : [selected.id], deleted = new Set(ids), remaining = layoutRef.current.people.filter(person => !deleted.has(person.id));
        e.preventDefault(); setLayout(current => ({ ...current, people: current.people.filter(person => !deleted.has(person.id)) })); setActivePersonId(remaining[0]?.id ?? ""); setSelectedPersonIds([]); setSelection({ kind: "backdrop" }); showNotice(`已刪除 ${ids.length} 位人物。`); return;
      }
      if (!e.key.startsWith("Arrow") || e.ctrlKey || e.metaKey || e.altKey) return;
      const step = e.shiftKey ? .01 : .1, delta = ({ ArrowUp: [0, step], ArrowDown: [0, -step], ArrowLeft: [step, 0], ArrowRight: [-step, 0] } as Record<string, [number, number]>)[e.key];
      if (!delta) return;
      e.preventDefault(); const current = layoutRef.current;
      if (selected.kind === "backdrop") updateBackdrop({ x: current.backdrop.x + delta[0], z: current.backdrop.z + delta[1] }, false);
      else movePeopleBy(selectedPersonIdsRef.current.length ? selectedPersonIdsRef.current : [selected.id], delta[0], delta[1]);
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [showObjectControls]);
  useEffect(() => {
    if (!syncCamera || syncCamera.sourceId === syncId) return;
    const camera = cameraRef.current, controls = controlsRef.current;
    if (!camera || !controls) return;
    applyingSyncRef.current = true;
    applyPose(camera, controls, syncCamera.pose);
    writeCamera(cameraKeyRef.current, camera, controls);
    renderRef.current();
    const release = requestAnimationFrame(() => { applyingSyncRef.current = false });
    return () => cancelAnimationFrame(release);
  }, [syncCamera?.serial, syncCamera?.sourceId, syncId]);
  useEffect(() => {
    const camera = cameraRef.current, controls = controlsRef.current;
    if (!camera || !controls) return;
    applyingSyncRef.current = true;
    applyPose(camera, controls, readCamera(cameraKey(image)) ?? TEMPLATE_CAMERA);
    setPreset("自由視角");
    renderRef.current();
    const release = requestAnimationFrame(() => { applyingSyncRef.current = false });
    return () => cancelAnimationFrame(release);
  }, [image?.id]);
  useEffect(() => {
    const mat = screenMatRef.current;
    if (!mat || image?.mediaType !== "video" || !showObjectControls) return;
    const video = document.createElement("video"), canvas = document.createElement("canvas"), context = canvas.getContext("2d");
    if (!context) return;
    canvas.width = 1920; canvas.height = 1080; video.preload = "auto"; video.playsInline = true; video.src = image.url; videoRef.current = video; videoSavedTimeRef.current = image.playbackTime; let disposed = false, lastDraw = 0;
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4; textureRef.current?.dispose(); textureRef.current = texture; mat.color.set(0xffffff); mat.map = texture; mat.needsUpdate = true;
    const draw = () => { const current = imageRef.current; if (!current || current.mediaType !== "video" || video.readyState < 2) return; drawVideoProjection(context, canvas, current, video); texture.needsUpdate = true; renderRef.current() };
    drawVideoRef.current = draw;
    const persist = async () => { if (video.readyState < 2) return; const time = Number.isFinite(video.currentTime) ? video.currentTime : 0; if (Math.abs(time - videoSavedTimeRef.current) < .02) return; videoSavedTimeRef.current = time; try { onVideoFrameRef.current?.(time, await captureVideoPoster(video)) } catch { /* keep previous frame */ } };
    const tick = (time: number) => { if (disposed || video.paused) return; if (time - lastDraw >= 30) { lastDraw = time; draw() } videoFrameRef.current = requestAnimationFrame(tick) };
    video.onloadedmetadata = () => { video.currentTime = Math.min(Math.max(0, image.playbackTime), Math.max(0, video.duration - .04)) };
    video.onloadeddata = draw; video.onseeked = draw;
    video.onplay = () => { setVideoPlaying(true); cancelAnimationFrame(videoFrameRef.current); videoFrameRef.current = requestAnimationFrame(tick) };
    video.onpause = () => { setVideoPlaying(false); cancelAnimationFrame(videoFrameRef.current); draw(); void persist() };
    video.onended = () => { setVideoPlaying(false); draw(); void persist() };
    video.onerror = () => { setVideoPlaying(false); onVideoErrorRef.current?.() };
    video.load(); renderRef.current();
    return () => { disposed = true; cancelAnimationFrame(videoFrameRef.current); drawVideoRef.current = () => {}; video.pause(); void persist(); video.removeAttribute("src"); video.load(); if (videoRef.current === video) videoRef.current = null; setVideoPlaying(false) };
  }, [image?.id, image?.mediaType, showObjectControls]);
  useEffect(() => {
    if (image?.mediaType === "video" && showObjectControls) { drawVideoRef.current(); return }
    const mat = screenMatRef.current; if (!mat) return; let cancelled = false;
    if (!image) { textureRef.current?.dispose(); textureRef.current = null; mat.map = null; mat.color.set(0x25282d); mat.needsUpdate = true; renderRef.current(); return }
    void projectionTexture(image).then(texture => { if (cancelled) return texture.dispose(); textureRef.current?.dispose(); textureRef.current = texture; mat.color.set(0xffffff); mat.map = texture; mat.needsUpdate = true; renderRef.current() }).catch(() => { setError("目前選取的素材無法放入 3D 投影面。"); onVideoErrorRef.current?.() }); return () => { cancelled = true };
  }, [image, showObjectControls]);
  useEffect(() => {
    const video = videoRef.current;
    if (image?.mediaType !== "video" || !showObjectControls || !video || !video.paused || video.readyState < 1 || Math.abs(video.currentTime - image.playbackTime) < .05) return;
    videoSavedTimeRef.current = image.playbackTime; video.currentTime = Math.min(Math.max(0, image.playbackTime), Math.max(0, video.duration - .04));
  }, [image?.playbackTime, image?.mediaType, showObjectControls]);

  const moveCamera = (name: PresetName) => { const camera = cameraRef.current, controls = controlsRef.current; if (!camera || !controls) return; const poses: Record<Exclude<PresetName, "自由視角">, CameraPose> = { 前排: { fov: CAMERA_FOV_50MM, position: [0, 1.1, -19], target: [0, 3.7, 7.5] }, 左側: { fov: CAMERA_FOV_50MM, position: [-20, 2.1, -29], target: [0, 3.8, 7.2] }, 右側: { fov: CAMERA_FOV_50MM, position: [20, 2.1, -29], target: [0, 3.8, 7.2] }, 俯視: { fov: CAMERA_FOV_50MM, position: [0, 53, -11], target: [0, 0, 7.2] } }; applyPose(camera, controls, name === "自由視角" ? readCamera(cameraKeyRef.current) ?? TEMPLATE_CAMERA : poses[name]); setPreset(name) };
  const resetCamera = () => { const camera = cameraRef.current, controls = controlsRef.current; if (!camera || !controls) return; try { localStorage.removeItem(cameraKeyRef.current) } catch { /* optional */ } applyPose(camera, controls, TEMPLATE_CAMERA); writeCamera(cameraKeyRef.current, camera, controls); setPreset("自由視角") };
  const captureView = () => { const renderer = rendererRef.current, scene = sceneRef.current, camera = cameraRef.current; if (!renderer || !scene || !camera) return null; renderer.render(scene, camera); return renderer.domElement.toDataURL("image/png") };
  const getCameraPose = () => cameraRef.current && controlsRef.current ? currentPose(cameraRef.current, controlsRef.current) : null;
  const exportView = () => { const data = captureView(); if (!data) return; const a = document.createElement("a"); a.download = `${image?.name || "舞台"}-3D視角.png`; a.href = data; a.click() };
  useImperativeHandle(ref, () => ({ exportView, captureView, getCameraPose }), [image]);
  const copyObjectLayout = () => { try { localStorage.setItem(LAYOUT_CLIPBOARD_KEY, JSON.stringify(layout)); setClipboardReady(true); showNotice("已複製這張圖片的人物與背板狀態，不包含視角。") } catch { showNotice("物件狀態暫時無法複製。") } };
  const pasteObjectLayout = () => { try { const copied = normalizeLayout(JSON.parse(localStorage.getItem(LAYOUT_CLIPBOARD_KEY) || "null")); if (!copied) return showNotice("目前沒有可貼上的物件狀態。"); setLayout(copied); setActivePersonId(copied.people[0]?.id ?? ""); setSelectedPersonIds([]); setSelection({ kind: "backdrop" }); showNotice("已貼上人物與背板狀態，這張圖片的視角保持不變。") } catch { showNotice("複製的物件狀態無法讀取。") } };

  const addPerson = (source?: Person) => { if (layout.people.length >= MAX_PEOPLE) return showNotice(`人物最多 ${MAX_PEOPLE} 位。`); const id = `person-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, base = source ?? { ...DEFAULT_PEOPLE[0], x: 0, z: 3.2, rotation: 0 }, next = clampPerson({ ...base, id, x: base.x + (source ? .5 : 0) }); setLayout(c => ({ ...c, people: [...c.people, next] })); setActivePersonId(id); setSelectedPersonIds([id]); setSelection({ kind: "person", id }) };
  const deletePerson = (id: string) => { setLayout(c => ({ ...c, people: c.people.filter(p => p.id !== id) })); setSelectedPersonIds([]); setSelection({ kind: "backdrop" }) };
  const randomizePeople = () => {
    if (!layout.people.length) return showNotice("目前沒有可排列的人物。");
    setLayout(current => {
      const placed: { x: number; z: number; radius: number }[] = [];
      const people = current.people.map(person => {
        const radius = .32 * person.heightCm / 170; let x = 0, z = 1, found = false;
        for (let attempt = 0; attempt < 140; attempt++) {
          x = -INNER + radius + Math.random() * (INNER * 2 - radius * 2);
          z = .4 + radius + Math.random() * (STAGE.cycloramaDepth - .8 - radius * 2);
          if (placed.every(other => Math.hypot(x - other.x, z - other.z) >= radius + other.radius + .22)) { found = true; break }
        }
        if (!found) { const index = placed.length; x = -INNER + .6 + index % 10 * 1.25; z = .7 + Math.floor(index / 10) * 1.25 }
        const next = clampPerson({ ...person, x: round(x), z: round(z) }); placed.push({ x: next.x, z: next.z, radius }); return next;
      });
      return { ...current, people };
    });
    showNotice("人物已隨機排列在觀眾可見的舞台區域。");
  };
  const resetPerson = (id: string) => { const initial = DEFAULT_PEOPLE.find(p => p.id === id) ?? { ...DEFAULT_PEOPLE[0], id, x: 0, z: 3.2, rotation: 0 }; setLayout(c => ({ ...c, people: c.people.map(p => p.id === id ? { ...initial } : p) })); showNotice("人物位置與身高已重設。") };
  const resetBackdrop = () => { setLayout(c => ({ ...c, backdrop: { ...DEFAULT_BACKDROP } })); setSelection({ kind: "backdrop" }); showNotice("背板列已重設到第 9 線中央。") };
  const resetAll = () => { if (confirm("要把全部人物與背板恢復為初始配置嗎？")) { const next = copyDefaults(); setLayout(next); setActivePersonId(next.people[0]?.id ?? ""); setSelectedPersonIds([]); setSelection({ kind: "backdrop" }); showNotice("全部 3D 物件已重設。") } };
  const snapPerson = (id: string) => { const z = layout.people.find(p => p.id === id)?.z; if (z == null) return; const i = clamp(Math.round(z / LINE_GAP), 0, LINE_COUNT - 1); updatePerson(id, { z: i * LINE_GAP }); showNotice(`人物已對齊第 ${i + 1} 線。`) };
  const snapBackdrop = () => { const i = clamp(Math.round(layout.backdrop.z / LINE_GAP), 0, LINE_COUNT - 1); updateBackdrop({ z: i * LINE_GAP }, false); showNotice(`背板已對齊第 ${i + 1} 線。`) };
  const person = layout.people.find(p => p.id === activePersonId) ?? layout.people[0] ?? null;
  const selectedPeople = selection.kind === "person" ? layout.people.filter(p => selectedPersonIds.includes(p.id)) : [];
  const controlledPeople = selectedPeople.length ? selectedPeople : person ? [person] : [];
  const anyPersonVisible = layout.people.some(person => person.visible);
  const toggleAllPeople = () => { const visible = !anyPersonVisible; setLayout(current => ({ ...current, people: current.people.map(person => ({ ...person, visible })) })); showNotice(visible ? "已顯示全部人物。" : "已隱藏全部人物。"); };

  return <div className={`stage3d-shell ${compact ? "compact" : ""} ${showObjectControls && !controlsCollapsed ? "controls-open" : ""}`}>
    <div ref={mountRef} className="stage3d-canvas" aria-label="臺中市港區藝術中心 3D 舞台預覽" />
    {error && <div className="stage3d-error">{error}</div>}{notice && <div className="stage3d-notice" role="status">{notice}</div>}
    {!compact && <div className="stage3d-badges"><span>鏡框 15.42 × 8.50 m</span><span>天幕深度 10.65 m</span><span>投影 13.20 × 7.43 m・16:9</span></div>}
    <div className="stage3d-presets">{(["自由視角", "前排", "左側", "右側", "俯視"] as PresetName[]).map(name => <button key={name} className={preset === name ? "active" : ""} onClick={() => moveCamera(name)}>{name}</button>)}<button className="reset-view" onClick={resetCamera}>重設自由視角</button></div>
    {image?.mediaType === "video" && showObjectControls && <div className={`stage3d-video-controls ${controlsCollapsed ? "" : "controls-open"}`}><button disabled={videoPlaying} onClick={() => { const video = videoRef.current; if (video) void video.play().catch(() => onVideoErrorRef.current?.()) }}>▶ 播放</button><button disabled={!videoPlaying} onClick={() => videoRef.current?.pause()}>Ⅱ 暫停</button><span>{videoPlaying ? "影片播放中" : "影片已暫停"}</span></div>}
    {showObjectControls && controlsCollapsed && <button className="stage3d-panel-open" onClick={() => setControlsCollapsed(false)}>‹ 展開物件控制</button>}
    {showObjectControls && !controlsCollapsed && <div className="stage3d-objects" aria-label="3D 物件調整" onPointerDownCapture={event => { if ((event.target as HTMLElement).matches("input[type='range'],input[type='number'],input[type='color']")) beginLayoutInteraction() }} onPointerUpCapture={() => endLayoutInteraction()} onPointerCancelCapture={() => endLayoutInteraction()} onBlurCapture={() => endLayoutInteraction()}>
      <div className="stage3d-objects-title"><div><strong>物件調整</strong><span>人物與背板分區控制</span></div><button onClick={() => setControlsCollapsed(true)}>收合 ›</button></div>
      <div className="stage3d-layout-actions"><button disabled={!image} onClick={copyObjectLayout}>複製物件狀態</button><button disabled={!image || !clipboardReady} onClick={pasteObjectLayout}>貼上物件狀態</button></div>

      <section className={`stage3d-control-section person-section ${selection.kind === "person" ? "active" : ""}`} onPointerDown={() => { if (person) { setSelection({ kind: "person", id: person.id }); if (!selectedPersonIds.includes(person.id)) setSelectedPersonIds([person.id]) } }}>
        <div className="stage3d-section-heading">
          <div><strong>人物調整</strong><span>{selectedPeople.length > 1 ? `${selectedPeople.length} 位已選取` : `${layout.people.length} 位人物`}</span></div>
          <div className="stage3d-title-actions"><button disabled={!layout.people.length} onClick={toggleAllPeople}>{anyPersonVisible ? "全部隱藏" : "全部顯示"}</button><button onClick={randomizePeople}>隨機排列</button><button onClick={() => addPerson()}>＋ 新增人物</button></div>
        </div>
        {person ? <>
          <div className="stage3d-person-picker">
            <label><span>選擇人物</span><select value={person.id} onChange={e => { setActivePersonId(e.target.value); setSelectedPersonIds([e.target.value]); setSelection({ kind: "person", id: e.target.value }); }}>{layout.people.map((p, i) => <option key={p.id} value={p.id}>人物 {i + 1}{p.visible ? "" : "（隱藏）"}</option>)}</select></label>
            <label className="stage3d-visible-check"><input type="checkbox" checked={controlledPeople.every(p => p.visible)} onChange={e => updatePeople(controlledPeople.map(p => p.id), { visible: e.target.checked })} />顯示</label>
          </div>
          <label className="stage3d-range-field"><span>{selectedPeople.length > 1 ? `身高（${selectedPeople.length}人）` : "人物身高"}</span><input title="雙擊重設為 165 cm" type="range" min="158" max="185" value={person.heightCm} onDoubleClick={() => updatePeople(controlledPeople.map(p => p.id), { heightCm: 165 })} onChange={e => updatePeople(controlledPeople.map(p => p.id), { heightCm: +e.target.value })} /><b>{person.heightCm} cm</b></label>
          <div className="stage3d-quick-actions"><button onClick={() => snapPerson(person.id)}>對齊地墊線</button><button onClick={() => resetPerson(person.id)}>重設人物</button></div>
          <div className="stage3d-person-actions"><button onClick={() => addPerson(person)} disabled={layout.people.length >= MAX_PEOPLE}>複製人物</button><button className="danger" onClick={() => deletePerson(person.id)}>刪除人物</button></div>
        </> : <button className="stage3d-empty-person" onClick={() => addPerson()}>＋ 新增第一位人物</button>}
      </section>

      <section className={`stage3d-control-section backdrop-section ${selection.kind === "backdrop" ? "active" : ""}`} onPointerDown={() => { setSelectedPersonIds([]); setSelection({ kind: "backdrop" }) }}>
        <div className="stage3d-section-heading">
          <div><strong>背板列調整</strong><span>整列共同移動與旋轉</span></div>
          <label className="stage3d-visible-check"><input type="checkbox" checked={layout.backdrop.visible} onChange={e => updateBackdrop({ visible: e.target.checked })} />顯示</label>
        </div>
        <label className="stage3d-backdrop-type"><span>物件類型</span><select value={layout.backdrop.style} onChange={e => { const style = e.target.value as BackdropStyle; updateBackdrop(style === "fence" ? { style, widthCm: 112, heightCm: 202, color: FENCE_DEFAULT_COLOR } : { style, widthCm: 122, heightCm: 252, color: DEFAULT_BACKDROP.color }) }}><option value="solid">實心背板</option><option value="fence">柵欄</option></select></label>
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
        <div className="stage3d-quick-actions backdrop-actions"><button onClick={() => updateBackdrop({ z: 8 * LINE_GAP }, false)}>對齊第九線</button><button onClick={() => updateBackdrop({ x: 0 }, false)}>置中對齊</button><button onClick={snapBackdrop}>對齊地墊線</button><button onClick={resetBackdrop}>重設背板</button></div>
      </section>

      <button className="stage3d-reset-all" onClick={resetAll}>重設全部配置</button>
    </div>}
    {!compact && <div className="stage3d-help"><strong>{image ? image.name : "請先從左側選擇背景圖片"}</strong><span>{showObjectControls ? "Shift 鎖定橫移 · Alt/Option 複製 · Delete/Backspace 刪除 · Ctrl/Cmd＋Z 復原" : "左鍵旋轉 · 右鍵平移 · 滾輪縮放"}</span></div>}
  </div>;
});
export default Stage3D;
