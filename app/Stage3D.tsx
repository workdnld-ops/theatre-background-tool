import { useEffect, useRef, useState } from "react";
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

const STAGE = {
  openingWidth: 15.42,
  openingHeight: 8.5,
  apronDepth: 2.6,
  backWallDepth: 18.81,
  cycloramaDepth: 10.65,
  stageHeight: 0.88,
};

const SCREEN_HEIGHT = STAGE.openingHeight;
const SCREEN_WIDTH = SCREEN_HEIGHT * 16 / 9;

// Calibrated against 快速模擬2.png (1920 × 1080). Its transparent projection
// area occupies approximately x 343–1584 and y 243–934. Keeping this camera
// and the renderer at 16:9 makes the projected plane line up with that mask.
const TEMPLATE_CAMERA = {
  fov: 25.9,
  position: [0, 1.13, -18.25] as [number, number, number],
  target: [0, 4.25, 6.5] as [number, number, number],
};

function fitSixteenByNine(width: number, height: number) {
  const aspect = 16 / 9;
  if (width / Math.max(1, height) > aspect) return { width: height * aspect, height };
  return { width, height: width / aspect };
}

function makeMaterial(color: number, roughness = 0.78, metalness = 0.02) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
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
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.82, 5, 10), material);
  body.position.y = 0.78;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 14, 10), material);
  head.position.y = 1.48;
  const legGeometry = new THREE.CylinderGeometry(0.055, 0.065, 0.75, 8);
  const leftLeg = new THREE.Mesh(legGeometry, material);
  leftLeg.position.set(-0.09, 0.18, 0);
  leftLeg.rotation.z = -0.05;
  const rightLeg = leftLeg.clone();
  rightLeg.position.x = 0.09;
  rightLeg.rotation.z = 0.05;
  group.add(body, head, leftLeg, rightLeg);
  group.position.set(x, 0, z);
  group.rotation.y = rotation;
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) object.castShadow = true;
  });
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

export default function Stage3D({ image }: { image: ProjectionImage | null }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const screenMaterialRef = useRef<THREE.MeshBasicMaterial | null>(null);
  const textureRef = useRef<THREE.Texture | null>(null);
  const [preset, setPreset] = useState<PresetName>("模板視角");
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
    scene.fog = new THREE.FogExp2(0x070809, 0.016);

    const camera = new THREE.PerspectiveCamera(TEMPLATE_CAMERA.fov, 16 / 9, 0.1, 100);
    camera.position.set(...TEMPLATE_CAMERA.position);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.target.set(...TEMPLATE_CAMERA.target);
    controls.minDistance = 2.5;
    controls.maxDistance = 48;
    controls.maxPolarAngle = Math.PI * 0.92;
    controlsRef.current = controls;

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

    makeBox(scene, [46, 0.35, 36], [0, -1.05, -17], audienceFloor);
    makeBox(scene, [27, 0.24, STAGE.backWallDepth + STAGE.apronDepth], [0, -0.12, (STAGE.backWallDepth - STAGE.apronDepth) / 2], floor);
    makeBox(scene, [18.2, 0.3, STAGE.apronDepth], [0, -0.15, -STAGE.apronDepth / 2], apron);

    for (let z = -2.45; z <= STAGE.backWallDepth; z += 1.45) {
      makeBox(scene, [24.5, 0.025, 0.055], [0, 0.02, z], line, false, false);
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

    [1.25, 3.55, 5.85, 8.15].forEach((z, index) => {
      const inset = 0.18 * index;
      makeBox(scene, [3.25, 8.25, 0.13], [-6.1 - inset, 4.1, z], curtain, true);
      makeBox(scene, [3.25, 8.25, 0.13], [6.1 + inset, 4.1, z], curtain, true);
      makeBox(scene, [15.3, 0.86, 0.16], [0, 8.1, z], curtain, true);
    });

    const screenMaterial = new THREE.MeshBasicMaterial({ color: 0x25282d, side: THREE.DoubleSide, toneMapped: false });
    screenMaterialRef.current = screenMaterial;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_WIDTH, SCREEN_HEIGHT), screenMaterial);
    screen.position.set(0, SCREEN_HEIGHT / 2, STAGE.cycloramaDepth);
    screen.rotation.y = Math.PI;
    scene.add(screen);
    makeBox(scene, [SCREEN_WIDTH + 0.2, 0.1, 0.1], [0, SCREEN_HEIGHT + 0.05, STAGE.cycloramaDepth - 0.03], frame);

    [
      [-4.7, 2.7, -0.2],
      [-2.5, 5.1, 0.15],
      [0.2, 3.6, -0.1],
      [2.6, 6.1, 0.22],
      [4.8, 2.9, -0.18],
      [5.8, 7.3, 0.12],
    ].forEach(([x, z, rotation]) => scene.add(createPerson(personMaterial, x, z, rotation)));

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
    };
  }, []);

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
    const presets: Record<PresetName, { fov: number; position: [number, number, number]; target: [number, number, number] }> = {
      模板視角: { ...TEMPLATE_CAMERA },
      前排: { fov: 48, position: [0, 0.78, -5.2], target: [0, 3.8, 8.0] },
      左側: { fov: 38, position: [-11.5, 2.8, -13.5], target: [0, 3.8, 7.2] },
      右側: { fov: 38, position: [11.5, 2.8, -13.5], target: [0, 3.8, 7.2] },
      俯視: { fov: 42, position: [0, 27, -2], target: [0, 0, 7.2] },
    };
    const next = presets[name];
    camera.fov = next.fov;
    camera.position.set(...next.position);
    camera.updateProjectionMatrix();
    controls.target.set(...next.target);
    controls.update();
    setPreset(name);
  }

  function exportView() {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const link = document.createElement("a");
    link.download = `${image?.name || "舞台"}-3D視角.png`;
    link.href = renderer.domElement.toDataURL("image/png");
    link.click();
  }

  return (
    <div className="stage3d-shell">
      <div ref={mountRef} className="stage3d-canvas" aria-label="臺中市港區藝術中心 3D 舞台預覽" />
      {error && <div className="stage3d-error">{error}</div>}
      <div className="stage3d-badges">
        <span>鏡框 15.42 × 8.50 m</span>
        <span>天幕深度 10.65 m</span>
        <span>投影圖面 16:9</span>
        <span className="prototype">已依快速模擬2校正</span>
      </div>
      <div className="stage3d-presets" aria-label="3D 預設視角">
        {(["模板視角", "前排", "左側", "右側", "俯視"] as PresetName[]).map((name) => (
          <button key={name} className={preset === name ? "active" : ""} onClick={() => moveCamera(name)}>{name}</button>
        ))}
        <button className="export" onClick={exportView}>↓ 匯出視角</button>
      </div>
      <div className="stage3d-help">
        <strong>{image ? image.name : "請先從左側選擇背景圖片"}</strong>
        <span>左鍵旋轉 · 右鍵平移 · 滾輪縮放</span>
      </div>
    </div>
  );
}
