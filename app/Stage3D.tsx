import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

type ProjectionTransform = {
  scale: number;
  x: number;
  y: number;
  brightness: number;
  fit: "cover" | "contain";
};

type ProjectionImage = {
  url: string;
  name: string;
  note: string;
  transform: ProjectionTransform;
};

type PresetName = "模板視角" | "前排" | "左側" | "右側" | "俯視";

type CameraPose = {
  fov: number;
  position: [number, number, number];
  target: [number, number, number];
};

type StageObjectSettings = {
  peopleVisible: boolean;
  personHeightCm: number;
  backdrop252Visible: boolean;
  backdrop202Visible: boolean;
};

const STAGE = {
  openingWidth: 15.42,
  openingHeight: 8.5,
  apronDepth: 2.6,
  backWallDepth: 18.81,
  cycloramaDepth: 10.65,
  stageHeight: 0.88,
};

// The reference photos show the 16:9 projection occupying about 86% of the
// 15.42 m proscenium opening. The last side legs meet the projection edges.
const SIDE_LEG_INNER_EDGE = 6.6;
const SIDE_LEG_WIDTH = STAGE.openingWidth / 2 - SIDE_LEG_INNER_EDGE;
const SIDE_LEG_DEPTHS = [1.1, 3.05, 5.0, 6.95, 8.9];
const SCREEN_WIDTH = SIDE_LEG_INNER_EDGE * 2;
const SCREEN_HEIGHT = SCREEN_WIDTH * 9 / 16;
const DANCE_MAT_SEAM_SPACING = 0.92;
const TEMPLATE_CAMERA_STORAGE_KEY = "stage-view-template-camera-v3";
const STAGE_OBJECT_STORAGE_KEY = "stage-view-objects-v1";
const PERSON_MODEL_HEIGHT = 1.7;
const DEFAULT_OBJECT_SETTINGS: StageObjectSettings = {
  peopleVisible: true,
  personHeightCm: 172,
  backdrop252Visible: true,
  backdrop202Visible: true,
};

export type Stage3DHandle = {
  exportView: () => void;
};

// Long-lens audience view matching the frontal proportions in 參考圖1 while
// keeping the renderer at the same 16:9 export ratio as the projected image.
const TEMPLATE_CAMERA: CameraPose = {
  fov: 20,
  position: [0, 1.25, -22],
  target: [0, 3.5, 7],
};

function fitSixteenByNine(width: number, height: number) {
  const aspect = 16 / 9;
  if (width / Math.max(1, height) > aspect) return { width: height * aspect, height };
  return { width, height: width / aspect };
}

function isVectorTuple(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function readTemplateCamera(): CameraPose | null {
  try {
    const value = JSON.parse(localStorage.getItem(TEMPLATE_CAMERA_STORAGE_KEY) || "null") as Partial<CameraPose> | null;
    if (!value || typeof value.fov !== "number" || value.fov < 5 || value.fov > 90) return null;
    if (!isVectorTuple(value.position) || !isVectorTuple(value.target)) return null;
    return { fov: value.fov, position: value.position, target: value.target };
  } catch {
    return null;
  }
}

function readObjectSettings(): StageObjectSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(STAGE_OBJECT_STORAGE_KEY) || "null") as (Partial<StageObjectSettings> & { backdrop158Visible?: boolean }) | null;
    if (!stored) return DEFAULT_OBJECT_SETTINGS;
    return {
      peopleVisible: stored.peopleVisible ?? DEFAULT_OBJECT_SETTINGS.peopleVisible,
      personHeightCm: Math.min(185, Math.max(158, Number(stored.personHeightCm) || DEFAULT_OBJECT_SETTINGS.personHeightCm)),
      backdrop252Visible: stored.backdrop252Visible ?? stored.backdrop158Visible ?? DEFAULT_OBJECT_SETTINGS.backdrop252Visible,
      backdrop202Visible: stored.backdrop202Visible ?? DEFAULT_OBJECT_SETTINGS.backdrop202Visible,
    };
  } catch {
    return DEFAULT_OBJECT_SETTINGS;
  }
}

function writeTemplateCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls) {
  const pose: CameraPose = {
    fov: camera.fov,
    position: camera.position.toArray() as [number, number, number],
    target: controls.target.toArray() as [number, number, number],
  };
  try {
    localStorage.setItem(TEMPLATE_CAMERA_STORAGE_KEY, JSON.stringify(pose));
  } catch {
    // The view still works when browser storage is unavailable.
  }
}

function applyCameraPose(camera: THREE.PerspectiveCamera, controls: OrbitControls, pose: CameraPose) {
  camera.fov = pose.fov;
  camera.position.set(...pose.position);
  controls.target.set(...pose.target);
  camera.updateProjectionMatrix();
  controls.update();
}

function makeMaterial(color: number, roughness = 0.78, metalness = 0.02) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function makeUnlitMaterial(color: number) {
  return new THREE.MeshBasicMaterial({ color, toneMapped: false });
}

function makeBox(
  scene: THREE.Scene,
  size: [number, number, number],
  position: [number, number, number],
  material: THREE.Material,
  castShadow = false,
  receiveShadow = true,
) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  scene.add(mesh);
  return mesh;
}

function createPerson(material: THREE.Material, x: number, z: number, rotation = 0) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.68, 5, 10), material);
  body.position.y = 0.98;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 10), material);
  head.position.y = 1.54;
  const legGeometry = new THREE.CylinderGeometry(0.055, 0.065, 0.78, 8);
  const leftLeg = new THREE.Mesh(legGeometry, material);
  leftLeg.position.set(-0.09, 0.39, 0);
  leftLeg.rotation.z = -0.05;
  const rightLeg = leftLeg.clone();
  rightLeg.position.x = 0.09;
  rightLeg.rotation.z = 0.05;
  const armGeometry = new THREE.CylinderGeometry(0.055, 0.07, 0.68, 8);
  const leftArm = new THREE.Mesh(armGeometry, material);
  leftArm.position.set(-0.255, 1.04, 0);
  leftArm.rotation.z = -0.08;
  const rightArm = leftArm.clone();
  rightArm.position.x = 0.255;
  rightArm.rotation.z = 0.08;
  group.add(body, head, leftLeg, rightLeg, leftArm, rightArm);
  group.position.set(x, 0, z);
  group.rotation.y = rotation;
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) object.castShadow = true;
  });
  return group;
}

function createBackdropPanel(
  panelMaterial: THREE.Material,
  frameMaterial: THREE.Material,
  width: number,
  height: number,
  x: number,
  z: number,
  rotation: number,
) {
  const group = new THREE.Group();
  const panel = new THREE.Mesh(new THREE.BoxGeometry(width, height, 0.08), panelMaterial);
  panel.position.y = height / 2;
  panel.castShadow = false;
  panel.receiveShadow = false;
  group.add(panel);

  const sideGeometry = new THREE.BoxGeometry(0.045, height, 0.12);
  const leftFrame = new THREE.Mesh(sideGeometry, frameMaterial);
  leftFrame.position.set(-width / 2 + 0.0225, height / 2, 0);
  leftFrame.castShadow = true;
  const rightFrame = leftFrame.clone();
  rightFrame.position.x = width / 2 - 0.0225;
  const footGeometry = new THREE.BoxGeometry(0.28, 0.06, 0.48);
  const leftFoot = new THREE.Mesh(footGeometry, frameMaterial);
  leftFoot.position.set(-width * 0.32, 0.03, 0.08);
  leftFoot.castShadow = true;
  const rightFoot = leftFoot.clone();
  rightFoot.position.x = width * 0.32;
  const wheelGeometry = new THREE.CylinderGeometry(0.045, 0.045, 0.035, 10);
  const leftWheel = new THREE.Mesh(wheelGeometry, frameMaterial);
  leftWheel.position.set(-width * 0.32, 0.045, 0.18);
  leftWheel.rotation.x = Math.PI / 2;
  const rightWheel = leftWheel.clone();
  rightWheel.position.x = width * 0.32;
  group.add(leftFrame, rightFrame, leftFoot, rightFoot, leftWheel, rightWheel);
  group.position.set(x, 0, z);
  group.rotation.y = rotation;
  return group;
}

function renderProjectionTexture(image: ProjectionImage) {
  return new Promise<THREE.CanvasTexture>((resolve, reject) => {
    const source = new Image();
    source.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 1920;
      canvas.height = 1080;
      const context = canvas.getContext("2d");
      if (!context) return reject(new Error("Canvas unavailable"));
      context.fillStyle = "#050505";
      context.fillRect(0, 0, canvas.width, canvas.height);
      const baseScale = image.transform.fit === "cover"
        ? Math.max(canvas.width / source.naturalWidth, canvas.height / source.naturalHeight)
        : Math.min(canvas.width / source.naturalWidth, canvas.height / source.naturalHeight);
      const scale = baseScale * image.transform.scale / 100;
      const width = source.naturalWidth * scale;
      const height = source.naturalHeight * scale;
      const x = (canvas.width - width) / 2 + image.transform.x / 100 * canvas.width;
      const y = (canvas.height - height) / 2 + image.transform.y / 100 * canvas.height;
      context.filter = `brightness(${image.transform.brightness}%)`;
      context.drawImage(source, x, y, width, height);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 4;
      resolve(texture);
    };
    source.onerror = () => reject(new Error("Projection image unavailable"));
    source.src = image.url;
  });
}

const Stage3D = forwardRef<Stage3DHandle, { image: ProjectionImage | null }>(function Stage3D({ image }, ref) {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const screenMaterialRef = useRef<THREE.MeshBasicMaterial | null>(null);
  const textureRef = useRef<THREE.Texture | null>(null);
  const peopleRef = useRef<THREE.Group[]>([]);
  const backdrop252Ref = useRef<THREE.Group | null>(null);
  const backdrop202Ref = useRef<THREE.Group | null>(null);
  const presetRef = useRef<PresetName>("模板視角");
  const [preset, setPreset] = useState<PresetName>("模板視角");
  const [objectSettings, setObjectSettings] = useState<StageObjectSettings>(readObjectSettings);
  const [error, setError] = useState("");

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let animationFrame = 0;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    } catch {
      setError("這個瀏覽器目前無法啟動 3D 畫面，請確認硬體加速已開啟。");
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const initialSize = fitSixteenByNine(mount.clientWidth, mount.clientHeight);
    renderer.setSize(initialSize.width, initialSize.height, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.9;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070809);

    const startingCamera = readTemplateCamera() ?? TEMPLATE_CAMERA;
    const camera = new THREE.PerspectiveCamera(startingCamera.fov, 16 / 9, 0.1, 180);
    camera.position.set(...startingCamera.position);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.target.set(...startingCamera.target);
    controls.minDistance = 2.5;
    controls.maxDistance = 140;
    controls.maxPolarAngle = Math.PI * 0.92;
    controlsRef.current = controls;

    const rememberManualView = () => {
      writeTemplateCamera(camera, controls);
      presetRef.current = "模板視角";
      setPreset("模板視角");
    };
    controls.addEventListener("end", rememberManualView);

    scene.add(new THREE.HemisphereLight(0x9cb5ca, 0x19120f, 1.1));
    const keyLight = new THREE.SpotLight(0xffe4c5, 760, 52, Math.PI / 4.5, 0.42, 1.4);
    keyLight.position.set(-5, 15, -5);
    keyLight.target.position.set(0, 0, 7);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    scene.add(keyLight, keyLight.target);
    const fillLight = new THREE.DirectionalLight(0x8aa9d7, 1.6);
    fillLight.position.set(7, 9, -8);
    scene.add(fillLight);

    const black = makeMaterial(0x090909, 0.92);
    const curtain = makeMaterial(0x050505, 1);
    const floor = makeMaterial(0x3b3936, 0.88);
    const apron = makeMaterial(0x3c241b, 0.9);
    const frame = makeMaterial(0xaaa5ba, 0.35, 0.2);
    const line = makeMaterial(0xc8c3ba, 0.82);
    const audienceFloor = makeMaterial(0x111113, 0.95);
    const personMaterial = makeMaterial(0x747678, 0.72, 0.05);
    const backdrop252Material = makeUnlitMaterial(0x765548);
    const backdrop202Material = makeUnlitMaterial(0x5f4940);
    const backdropFrameMaterial = makeMaterial(0x2b2927, 0.65, 0.08);

    makeBox(scene, [46, 0.35, 36], [0, -1.05, -17], audienceFloor);
    makeBox(scene, [27, 0.24, STAGE.backWallDepth], [0, -0.12, STAGE.backWallDepth / 2], floor);

    const apronShape = new THREE.Shape();
    apronShape.moveTo(-9.1, 0);
    apronShape.lineTo(9.1, 0);
    apronShape.quadraticCurveTo(0, STAGE.apronDepth * 2, -9.1, 0);
    const apronMesh = new THREE.Mesh(new THREE.ShapeGeometry(apronShape, 48), apron);
    apronMesh.rotation.x = -Math.PI / 2;
    apronMesh.position.y = -0.14;
    apronMesh.receiveShadow = true;
    scene.add(apronMesh);

    const floorSeamCount = Math.floor(STAGE.backWallDepth / DANCE_MAT_SEAM_SPACING);
    for (let index = 1; index <= floorSeamCount; index += 1) {
      const z = index * DANCE_MAT_SEAM_SPACING;
      makeBox(scene, [27, 0.025, 0.035], [0, 0.02, z], line, false, false);
    }

    makeBox(scene, [0.58, 9.5, 1.05], [-8.0, 4.55, -0.05], black);
    makeBox(scene, [0.58, 9.5, 1.05], [8.0, 4.55, -0.05], black);
    makeBox(scene, [16.58, 0.65, 1.05], [0, 8.82, -0.05], black);
    makeBox(scene, [0.22, 8.95, 0.2], [-7.82, 4.37, -0.65], frame);
    makeBox(scene, [0.22, 8.95, 0.2], [7.82, 4.37, -0.65], frame);
    makeBox(scene, [15.86, 0.22, 0.2], [0, 8.73, -0.65], frame);

    makeBox(scene, [27, 10.5, 0.28], [0, 5.0, STAGE.backWallDepth], black);
    makeBox(scene, [0.34, 10.5, STAGE.backWallDepth + 2.2], [-12.8, 5.0, 8.3], black);
    makeBox(scene, [0.34, 10.5, STAGE.backWallDepth + 2.2], [12.8, 5.0, 8.3], black);
    makeBox(scene, [27, 0.25, STAGE.backWallDepth + 2.2], [0, 10.15, 8.3], black);

    const sideLegCenter = SIDE_LEG_INNER_EDGE + SIDE_LEG_WIDTH / 2;
    SIDE_LEG_DEPTHS.forEach((z) => {
      makeBox(scene, [SIDE_LEG_WIDTH, 8.5, 0.13], [-sideLegCenter, 4.25, z], curtain, true);
      makeBox(scene, [SIDE_LEG_WIDTH, 8.5, 0.13], [sideLegCenter, 4.25, z], curtain, true);
      makeBox(scene, [STAGE.openingWidth, 0.78, 0.16], [0, 8.11, z], curtain, true);
    });

    const screenMaterial = new THREE.MeshBasicMaterial({ color: 0x25282d, side: THREE.DoubleSide, toneMapped: false, fog: false });
    screenMaterialRef.current = screenMaterial;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_WIDTH, SCREEN_HEIGHT), screenMaterial);
    screen.position.set(0, SCREEN_HEIGHT / 2, STAGE.cycloramaDepth);
    screen.rotation.y = Math.PI;
    scene.add(screen);
    makeBox(
      scene,
      [STAGE.openingWidth, STAGE.openingHeight - SCREEN_HEIGHT, 0.12],
      [0, SCREEN_HEIGHT + (STAGE.openingHeight - SCREEN_HEIGHT) / 2, STAGE.cycloramaDepth + 0.04],
      black,
    );

    const people = [
      [-5.0, 3.2, -0.18],
      [-4.15, 5.8, 0.12],
      [-1.25, 4.2, -0.08],
      [1.25, 4.2, 0.08],
      [4.15, 5.8, -0.12],
      [5.0, 3.2, 0.18],
    ].map(([x, z, rotation]) => createPerson(personMaterial, x, z, rotation));
    people.forEach((person) => scene.add(person));
    peopleRef.current = people;

    const backdrop252 = createBackdropPanel(backdrop252Material, backdropFrameMaterial, 1.22, 2.52, -2.9, 5.8, -0.06);
    const backdrop202 = createBackdropPanel(backdrop202Material, backdropFrameMaterial, 1.22, 2.02, 2.9, 5.8, 0.06);
    backdrop252Ref.current = backdrop252;
    backdrop202Ref.current = backdrop202;
    scene.add(backdrop252, backdrop202);

    const initialPersonScale = objectSettings.personHeightCm / 100 / PERSON_MODEL_HEIGHT;
    people.forEach((person) => {
      person.visible = objectSettings.peopleVisible;
      person.scale.setScalar(initialPersonScale);
    });
    backdrop252.visible = objectSettings.backdrop252Visible;
    backdrop202.visible = objectSettings.backdrop202Visible;

    const grid = new THREE.GridHelper(30, 30, 0x784a37, 0x292a2b);
    grid.position.y = -0.99;
    grid.position.z = -16;
    scene.add(grid);

    const resizeObserver = new ResizeObserver(() => {
      const availableWidth = Math.max(1, mount.clientWidth);
      const availableHeight = Math.max(1, mount.clientHeight);
      const size = fitSixteenByNine(availableWidth, availableHeight);
      renderer.setSize(size.width, size.height, false);
      camera.aspect = 16 / 9;
      camera.updateProjectionMatrix();
    });
    resizeObserver.observe(mount);

    function animate() {
      controls.update();
      renderer.render(scene, camera);
      animationFrame = requestAnimationFrame(animate);
    }
    animate();

    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      controls.removeEventListener("end", rememberManualView);
      controls.dispose();
      textureRef.current?.dispose();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
      rendererRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
      screenMaterialRef.current = null;
      peopleRef.current = [];
      backdrop252Ref.current = null;
      backdrop202Ref.current = null;
    };
  }, []);

  useEffect(() => {
    const personScale = objectSettings.personHeightCm / 100 / PERSON_MODEL_HEIGHT;
    peopleRef.current.forEach((person) => {
      person.visible = objectSettings.peopleVisible;
      person.scale.setScalar(personScale);
    });
    if (backdrop252Ref.current) backdrop252Ref.current.visible = objectSettings.backdrop252Visible;
    if (backdrop202Ref.current) backdrop202Ref.current.visible = objectSettings.backdrop202Visible;
    try {
      localStorage.setItem(STAGE_OBJECT_STORAGE_KEY, JSON.stringify(objectSettings));
    } catch {
      // The controls still work when browser storage is unavailable.
    }
  }, [objectSettings]);

  useEffect(() => {
    const material = screenMaterialRef.current;
    if (!material) return;
    let cancelled = false;
    if (!image) {
      textureRef.current?.dispose();
      textureRef.current = null;
      material.map = null;
      material.color.set(0x25282d);
      material.needsUpdate = true;
      return;
    }
    void renderProjectionTexture(image).then((texture) => {
      if (cancelled) return texture.dispose();
      textureRef.current?.dispose();
      textureRef.current = texture;
      material.color.set(0xffffff);
      material.map = texture;
      material.needsUpdate = true;
    }).catch(() => setError("目前選取的圖片無法放入 3D 投影面。"));
    return () => { cancelled = true; };
  }, [image]);

  function moveCamera(name: PresetName) {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    const presets: Record<Exclude<PresetName, "模板視角">, CameraPose> = {
      前排: { fov: 48, position: [0, 0.78, -5.2], target: [0, 3.8, 8.0] },
      左側: { fov: 38, position: [-11.5, 2.8, -13.5], target: [0, 3.8, 7.2] },
      右側: { fov: 38, position: [11.5, 2.8, -13.5], target: [0, 3.8, 7.2] },
      俯視: { fov: 42, position: [0, 27, -2], target: [0, 0, 7.2] },
    };
    const next = name === "模板視角" ? readTemplateCamera() ?? TEMPLATE_CAMERA : presets[name];
    applyCameraPose(camera, controls, next);
    presetRef.current = name;
    setPreset(name);
  }

  function resetTemplateView() {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    try {
      localStorage.removeItem(TEMPLATE_CAMERA_STORAGE_KEY);
    } catch {
      // Reset the live view even when browser storage is unavailable.
    }
    applyCameraPose(camera, controls, TEMPLATE_CAMERA);
    presetRef.current = "模板視角";
    setPreset("模板視角");
  }

  function exportView() {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const link = document.createElement("a");
    link.download = `${image?.name || "舞台"}-3D視角.png`;
    link.href = renderer.domElement.toDataURL("image/png");
    link.click();
  }

  useImperativeHandle(ref, () => ({ exportView }), [image]);

  return (
    <div className="stage3d-shell">
      <div ref={mountRef} className="stage3d-canvas" aria-label="臺中市港區藝術中心 3D 舞台預覽" />
      {error && <div className="stage3d-error">{error}</div>}
      <div className="stage3d-badges">
        <span>鏡框 15.42 × 8.50 m</span>
        <span>天幕深度 10.65 m</span>
        <span>投影 13.20 × 7.43 m・16:9</span>
        <span>地墊接縫間距 0.92 m</span>
        <span className="prototype">參考照片校正版 V4</span>
      </div>
      <div className="stage3d-presets" aria-label="3D 預設視角">
        {(["模板視角", "前排", "左側", "右側", "俯視"] as PresetName[]).map((name) => (
          <button key={name} className={preset === name ? "active" : ""} onClick={() => moveCamera(name)}>{name}</button>
        ))}
        <button className="reset-view" onClick={resetTemplateView}>重設模板</button>
      </div>
      <div className="stage3d-objects" aria-label="3D 物件控制">
        <div className="stage3d-objects-title"><strong>3D 物件</strong><span>顯示／隱藏</span></div>
        <div className="stage3d-object-toggles">
          <label><input type="checkbox" checked={objectSettings.backdrop252Visible} onChange={(event) => setObjectSettings((current) => ({ ...current, backdrop252Visible: event.target.checked }))} /><span>背板</span><b>122 × 252 cm</b></label>
          <label><input type="checkbox" checked={objectSettings.backdrop202Visible} onChange={(event) => setObjectSettings((current) => ({ ...current, backdrop202Visible: event.target.checked }))} /><span>背板</span><b>122 × 202 cm</b></label>
          <label><input type="checkbox" checked={objectSettings.peopleVisible} onChange={(event) => setObjectSettings((current) => ({ ...current, peopleVisible: event.target.checked }))} /><span>人物</span><b>{objectSettings.personHeightCm} cm</b></label>
        </div>
        <label className={`stage3d-person-height ${objectSettings.peopleVisible ? "" : "disabled"}`}>
          <span>人物身高</span>
          <input type="range" min="158" max="185" step="1" disabled={!objectSettings.peopleVisible} value={objectSettings.personHeightCm} onChange={(event) => setObjectSettings((current) => ({ ...current, personHeightCm: Number(event.target.value) }))} />
          <b>{objectSettings.personHeightCm} cm</b>
        </label>
      </div>
      <div className="stage3d-help">
        <strong>{image ? image.name : "請先從左側選擇背景圖片"}</strong>
        <span>左鍵旋轉 · 右鍵平移 · 滾輪縮放 · 視角自動保存在本機</span>
      </div>
    </div>
  );
});

export default Stage3D;
