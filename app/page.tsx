"use client";

import { PointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { registerSW } from "virtual:pwa-register";
import Stage3D, { type CameraPose, type Stage3DHandle } from "./Stage3D";

type ViewMode = "single" | "compare" | "threeD";
type ComparePreviewMode = "flat" | "threeD";
type CompareCameraMode = "sync" | "individual";
type FitMode = "width" | "height";
type Transform = {
  scale: number;
  x: number;
  y: number;
  brightness: number;
  contrast: number;
  saturation: number;
  hue: number;
  temperature: number;
  fit: FitMode;
};
type StoredImage = {
  id: string;
  name: string;
  note: string;
  blob: Blob;
  createdAt: number;
  updatedAt: number;
  transform: Transform;
  categoryId: string | null;
};
type LibraryImage = StoredImage & { url: string };
type Category = { id: string; name: string; createdAt: number };
type TransformHistory = { past: Transform[]; future: Transform[] };
type OfflineState = "preparing" | "ready" | "offline" | "disabled";
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DB_NAME = "stage-view-library";
const STORE_NAME = "backgrounds";
const CATEGORY_STORE_NAME = "categories";
const OFFLINE_DISABLED_KEY = "stage-view-offline-disabled";
const DEFAULT_TRANSFORM: Transform = { scale: 100, x: 0, y: 0, brightness: 100, contrast: 100, saturation: 100, hue: 0, temperature: 0, fit: "width" };
const MAX_COMPARE = 4;
const MAX_HISTORY = 15;
const STAGE_CANVAS_WIDTH = 1920;
const STAGE_CANVAS_HEIGHT = 1080;
const STAGE_CANVAS_RATIO = STAGE_CANVAS_WIDTH / STAGE_CANVAS_HEIGHT;
const TRANSPARENT_BOUNDS = { left: 183, top: 75, right: 1733, bottom: 944 };
const PROJECTION_FRAME_WIDTH = TRANSPARENT_BOUNDS.right - TRANSPARENT_BOUNDS.left + 1;
const PROJECTION_FRAME_HEIGHT = PROJECTION_FRAME_WIDTH / STAGE_CANVAS_RATIO;
const PROJECTION_FRAME = {
  left: ((TRANSPARENT_BOUNDS.left + TRANSPARENT_BOUNDS.right) / 2 - PROJECTION_FRAME_WIDTH / 2) / STAGE_CANVAS_WIDTH,
  top: ((TRANSPARENT_BOUNDS.top + TRANSPARENT_BOUNDS.bottom) / 2 - PROJECTION_FRAME_HEIGHT / 2) / STAGE_CANVAS_HEIGHT,
  width: PROJECTION_FRAME_WIDTH / STAGE_CANVAS_WIDTH,
  height: PROJECTION_FRAME_HEIGHT / STAGE_CANVAS_HEIGHT,
};
const STAGE_OVERLAY_URL = `${import.meta.env.BASE_URL}stage-overlay.png`;

function openLibrary() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
      if (!request.result.objectStoreNames.contains(CATEGORY_STORE_NAME)) {
        request.result.createObjectStore(CATEGORY_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readLibrary(): Promise<StoredImage[]> {
  const db = await openLibrary();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result as StoredImage[]);
    request.onerror = () => reject(request.error);
  });
}

async function saveImage(image: StoredImage) {
  const db = await openLibrary();
  return new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(image);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function readCategories(): Promise<Category[]> {
  const db = await openLibrary();
  return new Promise((resolve, reject) => {
    const request = db.transaction(CATEGORY_STORE_NAME, "readonly").objectStore(CATEGORY_STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result as Category[]);
    request.onerror = () => reject(request.error);
  });
}

async function saveCategory(category: Category) {
  const db = await openLibrary();
  return new Promise<void>((resolve, reject) => {
    const request = db.transaction(CATEGORY_STORE_NAME, "readwrite").objectStore(CATEGORY_STORE_NAME).put(category);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function removeImage(id: string) {
  const db = await openLibrary();
  return new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function clearStoredLibrary() {
  const db = await openLibrary();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME, CATEGORY_STORE_NAME], "readwrite");
    transaction.objectStore(STORE_NAME).clear();
    transaction.objectStore(CATEGORY_STORE_NAME).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function removeCategoryAndImages(categoryId: string) {
  const db = await openLibrary();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME, CATEGORY_STORE_NAME], "readwrite");
    const imageStore = transaction.objectStore(STORE_NAME);
    const request = imageStore.getAll();
    request.onsuccess = () => {
      (request.result as StoredImage[])
        .filter((image) => image.categoryId === categoryId)
        .forEach((image) => imageStore.delete(image.id));
      transaction.objectStore(CATEGORY_STORE_NAME).delete(categoryId);
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function withoutUrl(image: LibraryImage): StoredImage {
  const { url: _url, ...stored } = image;
  return stored;
}

function loadHtmlImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function normalizeTransform(value: unknown): Transform {
  const transform = value && typeof value === "object" ? value as Partial<Transform> & { fit?: string } : {};
  const numberOr = (candidate: unknown, fallback: number) => typeof candidate === "number" && Number.isFinite(candidate) ? candidate : fallback;
  return {
    scale: numberOr(transform.scale, DEFAULT_TRANSFORM.scale),
    x: numberOr(transform.x, DEFAULT_TRANSFORM.x),
    y: numberOr(transform.y, DEFAULT_TRANSFORM.y),
    brightness: numberOr(transform.brightness, DEFAULT_TRANSFORM.brightness),
    contrast: numberOr(transform.contrast, DEFAULT_TRANSFORM.contrast),
    saturation: numberOr(transform.saturation, DEFAULT_TRANSFORM.saturation),
    hue: numberOr(transform.hue, DEFAULT_TRANSFORM.hue),
    temperature: numberOr(transform.temperature, DEFAULT_TRANSFORM.temperature),
    fit: transform.fit === "height" ? "height" : "width",
  };
}

function pictureFilter(transform: Transform) {
  const warmth = Math.abs(transform.temperature), temperatureHue = transform.temperature > 0 ? -warmth * .1 : warmth * .1;
  return `brightness(${transform.brightness}%) contrast(${transform.contrast}%) saturate(${transform.saturation + warmth * .18}%) sepia(${warmth * .16}%) hue-rotate(${transform.hue + temperatureHue}deg)`;
}

function drawProjectedImage(
  context: CanvasRenderingContext2D,
  image: LibraryImage,
  background: HTMLImageElement,
  frameX: number,
  frameY: number,
  frameWidth: number,
  frameHeight: number,
  referenceWidth: number,
  referenceHeight: number,
) {
  const baseScale = image.transform.fit === "height"
    ? frameHeight / background.naturalHeight
    : frameWidth / background.naturalWidth;
  const scale = baseScale * (image.transform.scale / 100);
  const width = background.naturalWidth * scale;
  const height = background.naturalHeight * scale;
  const imageX = frameX + (frameWidth - width) / 2 + (image.transform.x / 100) * referenceWidth;
  const imageY = frameY + (frameHeight - height) / 2 + (image.transform.y / 100) * referenceHeight;
  context.filter = pictureFilter(image.transform);
  context.drawImage(background, imageX, imageY, width, height);
  context.filter = "none";
}

function drawStageToContext(
  context: CanvasRenderingContext2D,
  image: LibraryImage,
  background: HTMLImageElement,
  overlay: HTMLImageElement,
  x: number,
  y: number,
  canvasWidth: number,
  canvasHeight: number,
) {
  context.fillStyle = "#000";
  context.fillRect(x, y, canvasWidth, canvasHeight);
  const projectionX = x + canvasWidth * PROJECTION_FRAME.left;
  const projectionY = y + canvasHeight * PROJECTION_FRAME.top;
  const projectionWidth = canvasWidth * PROJECTION_FRAME.width;
  const projectionHeight = canvasHeight * PROJECTION_FRAME.height;
  context.save();
  context.beginPath();
  context.rect(x, y, canvasWidth, canvasHeight);
  context.clip();
  drawProjectedImage(context, image, background, projectionX, projectionY, projectionWidth, projectionHeight, canvasWidth, canvasHeight);
  context.drawImage(overlay, x, y, canvasWidth, canvasHeight);
  context.restore();
}

function StageCanvas({
  image,
  interactive = false,
  fitContainer = false,
  label,
  onActivate,
  onTransform,
  onInteractionStart,
  onInteractionEnd,
}: {
  image: LibraryImage;
  interactive?: boolean;
  fitContainer?: boolean;
  label?: string;
  onActivate?: () => void;
  onTransform?: (transform: Transform) => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [fittedSize, setFittedSize] = useState<{ width: number; height: number } | null>(null);
  const lastPointer = useRef<{ x: number; y: number; startX: number; startY: number; axis: "x" | "y" | null } | null>(null);
  const transformRef = useRef(image.transform);
  transformRef.current = image.transform;

  useLayoutEffect(() => {
    if (!fitContainer) return;
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!parent) return;
    const container: HTMLElement = parent;
    const ratio = STAGE_CANVAS_RATIO;

    function measure() {
      const style = window.getComputedStyle(container);
      const availableWidth = container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const availableHeight = container.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const width = Math.max(1, Math.min(availableWidth, availableHeight * ratio, 1120));
      setFittedSize({ width, height: width / ratio });
    }

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [fitContainer]);

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!interactive) return;
    lastPointer.current = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, axis: null };
    onInteractionStart?.();
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const last = lastPointer.current;
    const element = canvasRef.current;
    if (!interactive || !last || !element || !onTransform) return;
    if (event.shiftKey && !last.axis) {
      const totalX = Math.abs(event.clientX - last.startX), totalY = Math.abs(event.clientY - last.startY);
      if (Math.max(totalX, totalY) >= 3) last.axis = totalX >= totalY ? "x" : "y";
    } else if (!event.shiftKey) last.axis = null;
    const deltaX = last.axis === "y" ? 0 : event.clientX - last.x;
    const deltaY = last.axis === "x" ? 0 : event.clientY - last.y;
    const next = {
      ...transformRef.current,
      x: transformRef.current.x + (deltaX / element.clientWidth) * 100,
      y: transformRef.current.y + (deltaY / element.clientHeight) * 100,
    };
    transformRef.current = next;
    last.x = event.clientX;
    last.y = event.clientY;
    onTransform(next);
  }

  return (
    <div
      ref={canvasRef}
      className={`stage-canvas ${interactive ? "is-interactive" : ""} ${fitContainer ? "fits-container" : ""}`}
      style={fitContainer && fittedSize ? { width: fittedSize.width, height: fittedSize.height } : undefined}
      onClick={onActivate}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={() => { lastPointer.current = null; onInteractionEnd?.() }}
      onPointerCancel={() => { lastPointer.current = null; onInteractionEnd?.() }}
    >
      <div
        className="projection-frame"
        style={{
          left: `${PROJECTION_FRAME.left * 100}%`,
          top: `${PROJECTION_FRAME.top * 100}%`,
          width: `${PROJECTION_FRAME.width * 100}%`,
          height: `${PROJECTION_FRAME.height * 100}%`,
          transform: `translate3d(${image.transform.x / PROJECTION_FRAME.width}%, ${image.transform.y / PROJECTION_FRAME.height}%, 0)`,
        }}
      >
        <img
          className={`background-image fit-${image.transform.fit}`}
          src={image.url}
          alt={image.name}
          draggable={false}
          style={{
            filter: pictureFilter(image.transform),
            transform: `translate(-50%, -50%) scale(${image.transform.scale / 100})`,
          }}
        />
      </div>
      <img className="stage-overlay" src={STAGE_OVERLAY_URL} alt="劇場舞台比例模擬框" draggable={false} />
      {label && <span className="compare-label">{label}</span>}
    </div>
  );
}

function InlineNoteEditor({
  note,
  onSave,
  compact = false,
  placeholder = "雙擊新增備註",
}: {
  note: string;
  onSave: (note: string) => void;
  compact?: boolean;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note);

  useEffect(() => {
    if (!editing) setDraft(note);
  }, [note, editing]);

  function commit() {
    const next = draft.trim();
    if (next !== note) onSave(next);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        className={`inline-note-input ${compact ? "compact" : ""}`}
        autoFocus
        draggable={false}
        value={draft}
        aria-label="編輯圖片備註"
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") { setDraft(note); setEditing(false); }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      draggable={false}
      className={`inline-note-display ${compact ? "compact" : ""} ${note ? "" : "empty"}`}
      title="雙擊編輯備註"
      onDoubleClick={(event) => { event.stopPropagation(); setDraft(note); setEditing(true); }}
      onKeyDown={(event) => { if (event.key === "Enter") setEditing(true); }}
    >
      {note || placeholder}
    </button>
  );
}

export default function Home() {
  const [images, setImages] = useState<LibraryImage[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [newCategoryName, setNewCategoryName] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>("single");
  const [comparePreviewMode, setComparePreviewMode] = useState<ComparePreviewMode>("flat");
  const [compareCameraMode, setCompareCameraMode] = useState<CompareCameraMode>("individual");
  const [compareCameraSync, setCompareCameraSync] = useState<{ sourceId: string; serial: number; pose: CameraPose } | null>(null);
  const [search, setSearch] = useState("");
  const [ready, setReady] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [draggingImageId, setDraggingImageId] = useState<string | null>(null);
  const [dragOverCategoryId, setDragOverCategoryId] = useState<string | null>(null);
  const [dragOverCompareId, setDragOverCompareId] = useState<string | null>(null);
  const [storageText, setStorageText] = useState("本機儲存");
  const [toast, setToast] = useState("");
  const [singleControlsCollapsed, setSingleControlsCollapsed] = useState(() => localStorage.getItem("stage-view-single-controls-collapsed") === "1");
  const [adjustmentsCollapsed, setAdjustmentsCollapsed] = useState(() => localStorage.getItem("stage-view-adjustments-collapsed") === "1");
  const [offlineState, setOfflineState] = useState<OfflineState>(() => localStorage.getItem(OFFLINE_DISABLED_KEY) === "1" ? "disabled" : navigator.onLine ? "preparing" : "offline");
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stage3DRef = useRef<Stage3DHandle>(null);
  const compare3DRefs = useRef(new Map<string, Stage3DHandle>());
  const compareCameraSerialRef = useRef(0);
  const urlsRef = useRef<string[]>([]);
  const singleHistoryRef = useRef(new Map<string, TransformHistory>());
  const singleHistoryGroupRef = useRef<{ id: string; captured: boolean } | null>(null);

  useEffect(() => {
    Promise.all([readLibrary(), readCategories()])
      .then(([records, storedCategories]) => {
        const restored = records
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((record) => {
            const url = URL.createObjectURL(record.blob);
            urlsRef.current.push(url);
            return { ...record, note: record.note ?? "", categoryId: record.categoryId ?? null, transform: normalizeTransform(record.transform), url };
          });
        setImages(restored);
        setCategories(storedCategories.sort((a, b) => a.createdAt - b.createdAt));
        setActiveId(restored[0]?.id ?? null);
      })
      .catch(() => showToast("無法開啟本機圖庫，請確認瀏覽器不是私密模式。"))
      .finally(() => setReady(true));
    refreshStorage();
    return () => urlsRef.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  useEffect(() => {
    localStorage.setItem("stage-view-adjustments-collapsed", adjustmentsCollapsed ? "1" : "0");
  }, [adjustmentsCollapsed]);

  useEffect(() => {
    localStorage.setItem("stage-view-single-controls-collapsed", singleControlsCollapsed ? "1" : "0");
  }, [singleControlsCollapsed]);

  useEffect(() => {
    const offlineDisabled = localStorage.getItem(OFFLINE_DISABLED_KEY) === "1";
    const handleOnline = () => setOfflineState(localStorage.getItem(OFFLINE_DISABLED_KEY) === "1" ? "disabled" : "ready");
    const handleOffline = () => setOfflineState(localStorage.getItem(OFFLINE_DISABLED_KEY) === "1" ? "disabled" : "offline");
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("beforeinstallprompt", handleInstallPrompt);

    if (!offlineDisabled) {
      registerSW({
        immediate: true,
        onOfflineReady: () => setOfflineState(navigator.onLine ? "ready" : "offline"),
        onRegisterError: () => showToast("離線功能暫時無法啟用，請重新整理後再試。"),
      });

      if ("serviceWorker" in navigator) {
        void navigator.serviceWorker.ready.then(() => {
          setOfflineState(navigator.onLine ? "ready" : "offline");
        });
      }
    }

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("beforeinstallprompt", handleInstallPrompt);
    };
  }, []);

  const activeImage = images.find((image) => image.id === activeId) ?? images[0] ?? null;
  const filteredImages = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return images;
    return images.filter((image) => `${image.name} ${image.note}`.toLocaleLowerCase().includes(query));
  }, [images, search]);
  const comparedImages = compareIds
    .map((id) => images.find((image) => image.id === id))
    .filter((image): image is LibraryImage => Boolean(image));
  const libraryGroups = useMemo(() => [
    ...categories.map((category) => ({ id: category.id, name: category.name, removable: true, images: filteredImages.filter((image) => image.categoryId === category.id) })),
    { id: "uncategorized", name: "未分類", removable: false, images: filteredImages.filter((image) => !image.categoryId || !categories.some((category) => category.id === image.categoryId)) },
  ], [categories, filteredImages]);

  useEffect(() => {
    if (viewMode !== "single" || !activeImage) return;
    const handleHistoryKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if ((event.target as HTMLElement | null)?.closest("textarea,input[type='text'],input:not([type]),[contenteditable='true']")) return;
      const key = event.key.toLowerCase(), redo = (key === "z" && event.shiftKey) || key === "y";
      if (key !== "z" && key !== "y") return;
      event.preventDefault();
      if (redo) redoTransform(activeImage.id); else undoTransform(activeImage.id);
    };
    window.addEventListener("keydown", handleHistoryKey);
    return () => window.removeEventListener("keydown", handleHistoryKey);
  }, [viewMode, activeImage?.id, images]);

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2800);
  }

  async function refreshStorage() {
    if (!navigator.storage?.estimate) return;
    const estimate = await navigator.storage.estimate();
    const used = ((estimate.usage ?? 0) / 1024 / 1024).toFixed(1);
    setStorageText(`已使用 ${used} MB`);
  }

  async function importFiles(fileList: FileList | File[], categoryId: string | null = null) {
    const files = Array.from(fileList).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return showToast("請選擇 JPG、PNG 或 WEBP 圖片。" );
    const added: LibraryImage[] = [];
    try {
      for (const file of files) {
        const stored: StoredImage = {
          id: crypto.randomUUID(),
          name: file.name.replace(/\.[^.]+$/, ""),
          note: "",
          blob: file,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          transform: { ...DEFAULT_TRANSFORM },
          categoryId,
        };
        await saveImage(stored);
        const url = URL.createObjectURL(file);
        urlsRef.current.push(url);
        added.push({ ...stored, url });
      }
    } catch (error) {
      const isQuotaError = error instanceof DOMException && error.name === "QuotaExceededError";
      showToast(isQuotaError ? "本機儲存空間不足，請刪除部分圖片後再試。" : "圖片無法寫入本機圖庫，請稍後再試。" );
    }
    if (!added.length) return;
    void navigator.storage?.persist?.();
    setImages((current) => [...added, ...current]);
    setActiveId(added[0].id);
    setCompareIds((current) => {
      const next = [...current];
      added.forEach((image) => { if (next.length < MAX_COMPARE && !next.includes(image.id)) next.push(image.id); });
      return next;
    });
    showToast(`已加入 ${added.length} 張背景，並儲存在本機圖庫。`);
    refreshStorage();
  }

  function patchImage(id: string, patch: Partial<StoredImage>) {
    setImages((current) => current.map((image) => {
      if (image.id !== id) return image;
      const next = { ...image, ...patch, updatedAt: Date.now() };
      void saveImage(withoutUrl(next)).catch(() => showToast("變更暫時無法儲存，請確認本機空間。"));
      return next;
    }));
  }

  function transformHistory(id: string) {
    let history = singleHistoryRef.current.get(id);
    if (!history) { history = { past: [], future: [] }; singleHistoryRef.current.set(id, history) }
    return history;
  }

  function beginTransformInteraction(id: string) {
    singleHistoryGroupRef.current = { id, captured: false };
  }

  function endTransformInteraction() {
    singleHistoryGroupRef.current = null;
  }

  function updateTransform(id: string, transform: Transform) {
    const current = images.find(image => image.id === id)?.transform;
    if (!current || JSON.stringify(current) === JSON.stringify(transform)) return;
    const group = singleHistoryGroupRef.current, shouldCapture = !group || group.id !== id || !group.captured;
    if (shouldCapture) {
      const history = transformHistory(id); history.past.push({ ...current }); history.past = history.past.slice(-MAX_HISTORY); history.future = [];
      if (group?.id === id) group.captured = true;
    }
    patchImage(id, { transform });
  }

  function undoTransform(id: string) {
    const image = images.find(item => item.id === id), history = transformHistory(id), previous = history.past.pop();
    if (!image || !previous) return;
    history.future.push({ ...image.transform }); history.future = history.future.slice(-MAX_HISTORY); singleHistoryGroupRef.current = null; patchImage(id, { transform: previous }); showToast("已復原單張圖片的上一步調整。");
  }

  function redoTransform(id: string) {
    const image = images.find(item => item.id === id), history = transformHistory(id), next = history.future.pop();
    if (!image || !next) return;
    history.past.push({ ...image.transform }); history.past = history.past.slice(-MAX_HISTORY); singleHistoryGroupRef.current = null; patchImage(id, { transform: next }); showToast("已重做單張圖片的下一步調整。");
  }

  async function deleteFromLibrary(image: LibraryImage) {
    if (!window.confirm(`要從本機圖庫刪除「${image.name}」嗎？`)) return;
    try {
      await removeImage(image.id);
    } catch {
      return showToast("暫時無法刪除，請重新整理後再試。" );
    }
    URL.revokeObjectURL(image.url);
    setImages((current) => current.filter((item) => item.id !== image.id));
    setCompareIds((current) => current.filter((id) => id !== image.id));
    if (activeId === image.id) setActiveId(images.find((item) => item.id !== image.id)?.id ?? null);
    showToast("已從圖庫刪除。" );
    refreshStorage();
  }

  async function createCategory() {
    const name = newCategoryName.trim();
    if (!name) return;
    if (categories.some((category) => category.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      return showToast("已經有相同名稱的分類。");
    }
    const category: Category = { id: crypto.randomUUID(), name, createdAt: Date.now() };
    try {
      await saveCategory(category);
      setCategories((current) => [...current, category]);
      setNewCategoryName("");
      showToast(`已新增「${name}」分類。`);
    } catch {
      showToast("分類無法儲存，請稍後再試。");
    }
  }

  async function deleteCategory(category: Category) {
    const categoryImages = images.filter((image) => image.categoryId === category.id);
    const detail = categoryImages.length ? `，並永久刪除裡面的 ${categoryImages.length} 張圖片` : "";
    if (!window.confirm(`要刪除「${category.name}」分類${detail}嗎？此動作無法復原。`)) return;
    try {
      await removeCategoryAndImages(category.id);
    } catch {
      return showToast("分類暫時無法刪除，請重新整理後再試。");
    }
    const removedIds = new Set(categoryImages.map((image) => image.id));
    categoryImages.forEach((image) => URL.revokeObjectURL(image.url));
    const remaining = images.filter((image) => !removedIds.has(image.id));
    setImages(remaining);
    setCategories((current) => current.filter((item) => item.id !== category.id));
    setCompareIds((current) => current.filter((id) => !removedIds.has(id)));
    setCollapsedCategories((current) => { const next = new Set(current); next.delete(category.id); return next; });
    if (activeId && removedIds.has(activeId)) setActiveId(remaining[0]?.id ?? null);
    showToast(`已刪除分類與 ${categoryImages.length} 張圖片。`);
    refreshStorage();
  }

  async function clearLibrary() {
    if (!images.length && !categories.length) return showToast("本機圖庫已經是空的。");
    if (!window.confirm(`要清空本機圖庫嗎？將永久刪除 ${images.length} 張圖片與 ${categories.length} 個分類，此動作無法復原。`)) return;
    try {
      await clearStoredLibrary();
    } catch {
      return showToast("暫時無法清空圖庫，請重新整理後再試。");
    }
    images.forEach((image) => URL.revokeObjectURL(image.url));
    setImages([]);
    setCategories([]);
    setCompareIds([]);
    setCollapsedCategories(new Set());
    setActiveId(null);
    showToast("本機圖庫已清空。");
    refreshStorage();
  }

  function toggleCategory(id: string) {
    setCollapsedCategories((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleCompare(id: string) {
    setCompareIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length < MAX_COMPARE) return [...current, id];
      else showToast(`一次最多比較 ${MAX_COMPARE} 張，請先取消一張。`);
      return current;
    });
  }

  function startImageDrag(event: React.DragEvent, imageId: string) {
    setDraggingImageId(imageId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-stage-image", imageId);
    event.dataTransfer.setData("text/plain", imageId);
  }

  function finishImageDrag() {
    setDraggingImageId(null);
    setDragOverCategoryId(null);
    setDragOverCompareId(null);
  }

  function droppedImageId(event: React.DragEvent) {
    return event.dataTransfer.getData("application/x-stage-image") || draggingImageId;
  }

  function handleCategoryDragOver(event: React.DragEvent, groupId: string) {
    const hasFiles = event.dataTransfer.types.includes("Files");
    const hasImage = event.dataTransfer.types.includes("application/x-stage-image") || Boolean(draggingImageId);
    if (!hasFiles && !hasImage) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = hasFiles ? "copy" : "move";
    setDragOverCategoryId(groupId);
  }

  async function handleCategoryDrop(event: React.DragEvent, groupId: string) {
    event.preventDefault();
    event.stopPropagation();
    const categoryId = groupId === "uncategorized" ? null : groupId;
    setDragOverCategoryId(null);
    setDraggingFiles(false);
    if (event.dataTransfer.files.length) {
      await importFiles(event.dataTransfer.files, categoryId);
      if (groupId !== "uncategorized") setCollapsedCategories((current) => { const next = new Set(current); next.delete(groupId); return next; });
      return;
    }
    const imageId = droppedImageId(event);
    const image = images.find((item) => item.id === imageId);
    if (!image || image.categoryId === categoryId) return finishImageDrag();
    patchImage(image.id, { categoryId });
    if (groupId !== "uncategorized") setCollapsedCategories((current) => { const next = new Set(current); next.delete(groupId); return next; });
    showToast(`已將「${image.name}」移到${categoryId ? `「${categories.find((category) => category.id === categoryId)?.name ?? "分類"}」` : "「未分類」"}。`);
    finishImageDrag();
  }

  function handleCompareDrop(event: React.DragEvent, targetId: string) {
    event.preventDefault();
    event.stopPropagation();
    const sourceId = droppedImageId(event);
    setDragOverCompareId(null);
    if (!sourceId || sourceId === targetId) return finishImageDrag();
    setCompareIds((current) => {
      const sourceIndex = current.indexOf(sourceId);
      const targetIndex = current.indexOf(targetId);
      if (targetIndex < 0) return current;
      if (sourceIndex >= 0) {
        const next = [...current];
        [next[sourceIndex], next[targetIndex]] = [next[targetIndex], next[sourceIndex]];
        return next;
      }
      return current.map((id) => id === targetId ? sourceId : id);
    });
    setActiveId(sourceId);
    showToast(compareIds.includes(sourceId) ? "已調整比較順序。" : "已更換比較圖片。");
    finishImageDrag();
  }

  function handleCompareAreaDrop(event: React.DragEvent) {
    if (event.defaultPrevented) return;
    const sourceId = droppedImageId(event);
    if (!sourceId) return;
    event.preventDefault();
    if (compareIds.includes(sourceId)) return finishImageDrag();
    if (compareIds.length >= MAX_COMPARE) return showToast(`一次最多比較 ${MAX_COMPARE} 張，請拖到既有卡片上更換。`);
    setCompareIds((current) => [...current, sourceId]);
    showToast("已加入並排比較。");
    finishImageDrag();
  }

  function resetActive() {
    if (activeImage) updateTransform(activeImage.id, { ...DEFAULT_TRANSFORM });
  }

  async function alignActive(alignment: "left" | "right" | "top" | "bottom" | "center") {
    const image = activeImage;
    if (!image) return;
    if (alignment === "center") return updateTransform(image.id, { ...image.transform, x: 0, y: 0 });
    const source = await loadHtmlImage(image.url);
    const baseScale = image.transform.fit === "height"
      ? PROJECTION_FRAME_HEIGHT / source.naturalHeight
      : PROJECTION_FRAME_WIDTH / source.naturalWidth;
    const scale = baseScale * image.transform.scale / 100;
    const width = source.naturalWidth * scale, height = source.naturalHeight * scale;
    const next = { ...image.transform };
    if (alignment === "left") next.x = ((width - PROJECTION_FRAME_WIDTH) / 2 / STAGE_CANVAS_WIDTH) * 100;
    if (alignment === "right") next.x = ((PROJECTION_FRAME_WIDTH - width) / 2 / STAGE_CANVAS_WIDTH) * 100;
    if (alignment === "top") next.y = ((height - PROJECTION_FRAME_HEIGHT) / 2 / STAGE_CANVAS_HEIGHT) * 100;
    if (alignment === "bottom") next.y = ((PROJECTION_FRAME_HEIGHT - height) / 2 / STAGE_CANVAS_HEIGHT) * 100;
    updateTransform(image.id, next);
  }

  function fillActive(fit: FitMode) {
    if (activeImage) updateTransform(activeImage.id, { ...activeImage.transform, fit, scale: 100 });
  }

  function resetAdjustments() {
    if (!activeImage) return;
    updateTransform(activeImage.id, {
      ...activeImage.transform,
      brightness: DEFAULT_TRANSFORM.brightness,
      contrast: DEFAULT_TRANSFORM.contrast,
      saturation: DEFAULT_TRANSFORM.saturation,
      hue: DEFAULT_TRANSFORM.hue,
      temperature: DEFAULT_TRANSFORM.temperature,
    });
  }

  async function exportComposite(image: LibraryImage) {
    const [background, overlay] = await Promise.all([loadHtmlImage(image.url), loadHtmlImage(STAGE_OVERLAY_URL)]);
    const canvas = document.createElement("canvas");
    canvas.width = STAGE_CANVAS_WIDTH;
    canvas.height = STAGE_CANVAS_HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) return;
    drawStageToContext(context, image, background, overlay, 0, 0, canvas.width, canvas.height);
    const link = document.createElement("a");
    link.download = `${image.name}-劇場預覽.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
    showToast("預覽圖已匯出。" );
  }

  async function exportCroppedProjection(image: LibraryImage) {
    const background = await loadHtmlImage(image.url);
    const canvas = document.createElement("canvas");
    canvas.width = STAGE_CANVAS_WIDTH;
    canvas.height = STAGE_CANVAS_HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = "#000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.beginPath();
    context.rect(0, 0, canvas.width, canvas.height);
    context.clip();
    drawProjectedImage(
      context,
      image,
      background,
      0,
      0,
      canvas.width,
      canvas.height,
      canvas.width / PROJECTION_FRAME.width,
      canvas.height / PROJECTION_FRAME.height,
    );
    context.restore();
    const link = document.createElement("a");
    link.download = `${image.name}-投影裁切.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
    showToast("已匯出套用畫面調整的 16:9 裁切圖。" );
  }

  function syncCompareCamera(sourceId: string, pose: CameraPose) {
    if (compareCameraMode !== "sync") return;
    compareCameraSerialRef.current += 1;
    setCompareCameraSync({ sourceId, serial: compareCameraSerialRef.current, pose });
  }

  function enableSynchronizedComparison() {
    setCompareCameraMode("sync");
    const first = comparedImages.map((item) => compare3DRefs.current.get(item.id)).find(Boolean);
    const pose = first?.getCameraPose();
    if (pose) {
      compareCameraSerialRef.current += 1;
      setCompareCameraSync({ sourceId: "compare-toolbar", serial: compareCameraSerialRef.current, pose });
    }
  }

  async function exportComparison() {
    if (!comparedImages.length) return showToast("請先選擇要比較的圖片。");
    const isThreeD = comparePreviewMode === "threeD";
    let overlay: HTMLImageElement | null = null;
    let backgrounds: HTMLImageElement[];
    try {
      overlay = isThreeD ? null : await loadHtmlImage(STAGE_OVERLAY_URL);
      backgrounds = isThreeD
        ? await Promise.all(comparedImages.map(async (image) => {
          const data = compare3DRefs.current.get(image.id)?.captureView();
          if (!data) throw new Error("3D comparison is not ready");
          return loadHtmlImage(data);
        }))
        : await Promise.all(comparedImages.map((image) => loadHtmlImage(image.url)));
    } catch {
      return showToast("3D 畫面還在準備中，請稍候再匯出。");
    }
    const columns = comparedImages.length === 1 ? 1 : 2;
    const rows = Math.ceil(comparedImages.length / columns);
    const tileWidth = 1200;
    const stageHeight = isThreeD ? Math.round(tileWidth * 9 / 16) : Math.round(tileWidth / STAGE_CANVAS_RATIO);
    const metaHeight = 86;
    const gap = 24;
    const padding = 32;
    const canvas = document.createElement("canvas");
    canvas.width = padding * 2 + columns * tileWidth + (columns - 1) * gap;
    canvas.height = padding * 2 + rows * (stageHeight + metaHeight) + (rows - 1) * gap;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = "#242321";
    context.fillRect(0, 0, canvas.width, canvas.height);

    comparedImages.forEach((image, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = padding + column * (tileWidth + gap);
      const y = padding + row * (stageHeight + metaHeight + gap);
      if (isThreeD) context.drawImage(backgrounds[index], x, y, tileWidth, stageHeight);
      else if (overlay) drawStageToContext(context, image, backgrounds[index], overlay, x, y, tileWidth, stageHeight);
      context.fillStyle = "#fffefa";
      context.fillRect(x, y + stageHeight, tileWidth, metaHeight);
      context.fillStyle = "#d75d36";
      context.beginPath();
      context.arc(x + 42, y + stageHeight + 43, 23, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "#fff";
      context.font = "900 24px sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(String.fromCharCode(65 + index), x + 42, y + stageHeight + 43);
      context.textAlign = "left";
      context.fillStyle = "#1c1a17";
      context.font = '700 24px "Microsoft JhengHei", sans-serif';
      context.fillText(image.name, x + 82, y + stageHeight + 31, tileWidth - 105);
      context.fillStyle = "#80766d";
      context.font = '18px "Microsoft JhengHei", sans-serif';
      context.fillText(image.note || "無備註", x + 82, y + stageHeight + 60, tileWidth - 105);
    });

    const link = document.createElement("a");
    link.download = `劇場背景${isThreeD ? "3D" : ""}並排比較-${new Date().toISOString().slice(0, 10)}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
    showToast(`${isThreeD ? "3D " : ""}並排比較圖已匯出。`);
  }

  async function installApp() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === "accepted") showToast("已加入桌面，可像一般 App 一樣開啟。" );
    setInstallPrompt(null);
  }

  async function disableOfflineInstall() {
    if (!window.confirm("要解除這台裝置的離線功能嗎？這不會刪除圖庫圖片；若已安裝桌面捷徑，仍需從系統或瀏覽器選單移除該捷徑。")) return;
    localStorage.setItem(OFFLINE_DISABLED_KEY, "1");
    try {
      const appScope = new URL(import.meta.env.BASE_URL, window.location.href).href;
      if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.filter((registration) => registration.scope.startsWith(appScope)).map((registration) => registration.unregister()));
      }
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key.includes(appScope)).map((key) => caches.delete(key)));
      }
      setOfflineState("disabled");
      setInstallPrompt(null);
      showToast("已解除離線功能與快取；桌面捷徑需另外移除。");
    } catch {
      showToast("離線資料未能完全移除，請從瀏覽器的網站資料設定清除。");
    }
  }

  function enableOfflineInstall() {
    localStorage.removeItem(OFFLINE_DISABLED_KEY);
    window.location.reload();
  }

  const offlineLabel = offlineState === "offline"
    ? "目前離線"
    : offlineState === "disabled"
      ? "離線功能已解除"
    : offlineState === "ready"
      ? "離線模式已就緒"
      : "正在準備離線模式";

  return (
    <main
      className={`app-shell ${draggingFiles ? "is-file-dragging" : ""}`}
      onDragEnter={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDraggingFiles(true); } }}
      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDraggingFiles(false); }}
      onDrop={(event) => { if (!event.dataTransfer.files.length) return; event.preventDefault(); setDraggingFiles(false); void importFiles(event.dataTransfer.files); }}
    >
      <header className="topbar">
        <div className="brand-mark">劇</div>
        <div className="brand-copy"><p className="eyebrow">STAGE VIEW</p><h1>劇場投影背景模擬器</h1></div>
        <div className="top-actions">
          <span className="privacy-pill"><i /> 圖片只留在這台裝置</span>
          <span className={`offline-pill ${offlineState}`}><i /> {offlineLabel}</span>
          {installPrompt && offlineState !== "disabled" && <button className="install-button" onClick={() => void installApp()}>安裝到桌面</button>}
          {offlineState === "disabled"
            ? <button className="install-button" onClick={enableOfflineInstall}>重新啟用離線</button>
            : <button className="install-button danger-text" onClick={() => void disableOfflineInstall()}>解除離線</button>}
          <button className="primary" onClick={() => inputRef.current?.click()}>＋ 新增背景</button>
          <input
            ref={inputRef}
            hidden
            multiple
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => { if (event.target.files) void importFiles(event.target.files); event.target.value = ""; }}
          />
        </div>
      </header>

      <section className="workspace">
        <aside className="sidebar">
          <div className="section-heading">
            <div><p className="eyebrow">LIBRARY</p><h2>我的圖庫</h2></div>
            <span>{images.length} 張</span>
          </div>
          <label className="search-box"><span>⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜尋名稱或備註" /></label>
          <button className="upload-card" onClick={() => inputRef.current?.click()}>
            <span className="upload-icon">＋</span><span><strong>加入多張背景</strong><small>也可以直接拖曳進來</small></span>
          </button>

          <div className="category-create">
            <input
              value={newCategoryName}
              maxLength={30}
              placeholder="新增分類名稱"
              aria-label="新增分類名稱"
              onChange={(event) => setNewCategoryName(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void createCategory(); }}
            />
            <button disabled={!newCategoryName.trim()} onClick={() => void createCategory()}>＋ 分類</button>
          </div>

          <div className="library-list">
            {!ready && <div className="empty-library">正在開啟本機圖庫…</div>}
            {ready && !filteredImages.length && (
              <div className="empty-library">{images.length ? "沒有符合搜尋條件的圖片。" : "加入過的圖片會保留在這台裝置，下次開啟可直接繼續。"}</div>
            )}
            {ready && libraryGroups.map((group) => {
              const collapsed = collapsedCategories.has(group.id);
              const totalCount = images.filter((image) => group.id === "uncategorized"
                ? !image.categoryId || !categories.some((category) => category.id === image.categoryId)
                : image.categoryId === group.id).length;
              return (
                <section
                  className={`library-group ${dragOverCategoryId === group.id ? "drop-target" : ""}`}
                  key={group.id}
                  onDragEnter={(event) => handleCategoryDragOver(event, group.id)}
                  onDragOver={(event) => handleCategoryDragOver(event, group.id)}
                  onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverCategoryId(null); }}
                  onDrop={(event) => void handleCategoryDrop(event, group.id)}
                >
                  <div className="category-heading">
                    <button className="category-toggle" onClick={() => toggleCategory(group.id)} aria-expanded={!collapsed}>
                      <span>{collapsed ? "▸" : "▾"}</span><strong>{group.name}</strong><small>{totalCount}</small>
                    </button>
                    {group.removable && (
                      <button className="category-delete" title="刪除分類及裡面圖片" onClick={() => {
                        const category = categories.find((item) => item.id === group.id);
                        if (category) void deleteCategory(category);
                      }}>刪除</button>
                    )}
                  </div>
                  {!collapsed && (
                    <div className="category-items">
                      {!group.images.length && <div className="empty-category">{search ? "此分類沒有符合搜尋的圖片" : "尚無圖片"}</div>}
                      {group.images.map((image) => (
                        <article
                          key={image.id}
                          draggable
                          className={`library-item ${activeImage?.id === image.id ? "active" : ""} ${draggingImageId === image.id ? "is-dragging" : ""}`}
                          onClick={() => setActiveId(image.id)}
                          onDragStart={(event) => startImageDrag(event, image.id)}
                          onDragEnd={finishImageDrag}
                        >
                          <label className="compare-check" title="加入比較" onClick={(event) => event.stopPropagation()}>
                            <input type="checkbox" checked={compareIds.includes(image.id)} onChange={() => toggleCompare(image.id)} /><span>比較</span>
                          </label>
                          <div className="thumb"><img src={image.url} alt="" /><img src={STAGE_OVERLAY_URL} alt="" /></div>
                          <div className="item-copy">
                            <strong>{image.name}</strong>
                            <InlineNoteEditor compact note={image.note} onSave={(note) => patchImage(image.id, { note })} />
                          </div>
                          <div className="item-actions">
                            <button title="刪除" onClick={(e) => { e.stopPropagation(); void deleteFromLibrary(image); }}>×</button>
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
          <div className="storage-status"><span>本機圖庫 · {storageText}</span><button onClick={() => void clearLibrary()}>清空圖庫</button></div>
        </aside>

        <section className="stage-panel">
          <div className="stage-toolbar">
            <div><p className="eyebrow">PREVIEW</p><h2>{viewMode === "single" ? "舞台預覽" : viewMode === "compare" ? `${comparePreviewMode === "threeD" ? "3D " : ""}比較背景（${comparedImages.length}/${MAX_COMPARE}）` : "3D 舞台預覽"}</h2></div>
            <div className="stage-toolbar-controls">
              <div className="mode-actions">
                {viewMode === "single" && <>
                  <button className="export-secondary" disabled={!activeImage} onClick={() => activeImage && void exportCroppedProjection(activeImage)}>↓ 匯出裁切圖</button>
                  <button className="export-action" disabled={!activeImage} onClick={() => activeImage && void exportComposite(activeImage)}>↓ 匯出預覽</button>
                </>}
                {viewMode === "compare" && <>
                  <button className="clear-action" disabled={!compareIds.length} onClick={() => { setCompareIds([]); showToast("已清空比較選擇。"); }}>清空重選</button>
                  <button className="export-action" disabled={!comparedImages.length} onClick={() => void exportComparison()}>↓ 匯出{comparePreviewMode === "threeD" ? " 3D" : ""}比較圖</button>
                </>}
                {viewMode === "threeD" && <button className="export-action" onClick={() => stage3DRef.current?.exportView()}>↓ 匯出視角</button>}
              </div>
              <div className="view-tabs">
                <button className={viewMode === "single" ? "active" : ""} onClick={() => setViewMode("single")}>單張調整</button>
                <button className={viewMode === "compare" ? "active" : ""} onClick={() => setViewMode("compare")}>並排比較 <b>{compareIds.length || ""}</b></button>
                <button className={viewMode === "threeD" ? "active" : ""} onClick={() => setViewMode("threeD")}>3D 舞台</button>
              </div>
            </div>
          </div>

          {viewMode === "single" ? (
            <div className={`single-view ${activeImage && !singleControlsCollapsed ? "controls-open" : ""}`}>
              <div className="canvas-wrap">
                {activeImage ? (
                  <StageCanvas image={activeImage} interactive fitContainer onInteractionStart={() => beginTransformInteraction(activeImage.id)} onInteractionEnd={endTransformInteraction} onTransform={(transform) => updateTransform(activeImage.id, transform)} />
                ) : (
                  <button className="empty-stage" onClick={() => inputRef.current?.click()}>
                    <span>＋</span><strong>把背景圖放進舞台</strong><small>可一次選取多張 JPG、PNG 或 WEBP</small>
                  </button>
                )}
              </div>

              {activeImage && singleControlsCollapsed && <button className="single-panel-open" onClick={() => setSingleControlsCollapsed(false)}>‹ 展開圖片控制</button>}
              {activeImage && !singleControlsCollapsed && (
                <div className="editor-panel">
                  <div className="editor-panel-title"><div><strong>圖片調整</strong><span>位置、尺寸與畫面效果</span></div><button onClick={() => setSingleControlsCollapsed(true)}>收合 ›</button></div>
                  <section className="single-control-section">
                    <strong className="single-section-title">縮放</strong>
                    <div className="range-control scale-control"><label>縮放 <b>{activeImage.transform.scale}%</b></label><input aria-label="圖片縮放，雙擊重設為 100%" title="雙擊回到 100%" type="range" min="40" max="220" value={activeImage.transform.scale} onPointerDown={() => beginTransformInteraction(activeImage.id)} onPointerUp={endTransformInteraction} onPointerCancel={endTransformInteraction} onDoubleClick={() => updateTransform(activeImage.id, { ...activeImage.transform, scale: 100 })} onChange={(e) => updateTransform(activeImage.id, { ...activeImage.transform, scale: Number(e.target.value) })} /></div>
                  </section>
                  <section className="single-control-section">
                    <strong className="single-section-title">快速對齊</strong>
                    <div className="alignment-grid"><button onClick={() => void alignActive("left")}>靠左</button><button onClick={() => void alignActive("right")}>靠右</button><button onClick={() => void alignActive("top")}>靠上</button><button onClick={() => void alignActive("bottom")}>靠下</button><button className="center" onClick={() => void alignActive("center")}>置中對齊</button></div>
                  </section>
                  <section className="single-control-section">
                    <strong className="single-section-title">填滿方式</strong>
                    <div className="fill-grid"><button className={activeImage.transform.fit === "width" ? "active" : ""} onClick={() => fillActive("width")}>左右填滿</button><button className={activeImage.transform.fit === "height" ? "active" : ""} onClick={() => fillActive("height")}>上下填滿</button></div>
                  </section>
                  <div className={`image-adjustments ${adjustmentsCollapsed ? "collapsed" : ""}`}>
                    <button className="image-adjustments-toggle" aria-expanded={!adjustmentsCollapsed} onClick={() => setAdjustmentsCollapsed((current) => !current)}>
                      <span><strong>畫面調整</strong><small>亮度、對比、飽和度、色調與色溫</small></span><b>{adjustmentsCollapsed ? "展開 ▾" : "收合 ▴"}</b>
                    </button>
                    {!adjustmentsCollapsed && <div className="image-adjustments-body">
                      <div className="range-control"><label>亮度 <b>{activeImage.transform.brightness}%</b></label><input title="雙擊重設亮度" type="range" min="30" max="160" value={activeImage.transform.brightness} onPointerDown={() => beginTransformInteraction(activeImage.id)} onPointerUp={endTransformInteraction} onPointerCancel={endTransformInteraction} onDoubleClick={() => updateTransform(activeImage.id, { ...activeImage.transform, brightness: 100 })} onChange={(e) => updateTransform(activeImage.id, { ...activeImage.transform, brightness: Number(e.target.value) })} /></div>
                      <div className="range-control"><label>對比 <b>{activeImage.transform.contrast}%</b></label><input title="雙擊重設對比" type="range" min="30" max="200" value={activeImage.transform.contrast} onPointerDown={() => beginTransformInteraction(activeImage.id)} onPointerUp={endTransformInteraction} onPointerCancel={endTransformInteraction} onDoubleClick={() => updateTransform(activeImage.id, { ...activeImage.transform, contrast: 100 })} onChange={(e) => updateTransform(activeImage.id, { ...activeImage.transform, contrast: Number(e.target.value) })} /></div>
                      <div className="range-control"><label>飽和度 <b>{activeImage.transform.saturation}%</b></label><input title="雙擊重設飽和度" type="range" min="0" max="200" value={activeImage.transform.saturation} onPointerDown={() => beginTransformInteraction(activeImage.id)} onPointerUp={endTransformInteraction} onPointerCancel={endTransformInteraction} onDoubleClick={() => updateTransform(activeImage.id, { ...activeImage.transform, saturation: 100 })} onChange={(e) => updateTransform(activeImage.id, { ...activeImage.transform, saturation: Number(e.target.value) })} /></div>
                      <div className="range-control"><label>色調 <b>{activeImage.transform.hue}°</b></label><input title="雙擊重設色調" type="range" min="-180" max="180" value={activeImage.transform.hue} onPointerDown={() => beginTransformInteraction(activeImage.id)} onPointerUp={endTransformInteraction} onPointerCancel={endTransformInteraction} onDoubleClick={() => updateTransform(activeImage.id, { ...activeImage.transform, hue: 0 })} onChange={(e) => updateTransform(activeImage.id, { ...activeImage.transform, hue: Number(e.target.value) })} /></div>
                      <div className="range-control"><label>色溫 <b>{activeImage.transform.temperature > 0 ? "+" : ""}{activeImage.transform.temperature}</b></label><input title="雙擊重設色溫" type="range" min="-100" max="100" value={activeImage.transform.temperature} onPointerDown={() => beginTransformInteraction(activeImage.id)} onPointerUp={endTransformInteraction} onPointerCancel={endTransformInteraction} onDoubleClick={() => updateTransform(activeImage.id, { ...activeImage.transform, temperature: 0 })} onChange={(e) => updateTransform(activeImage.id, { ...activeImage.transform, temperature: Number(e.target.value) })} /></div>
                      <button className="secondary adjustment-reset" onClick={resetAdjustments}>重設修圖</button>
                    </div>}
                  </div>
                  <div className="note-row">
                    <label htmlFor="image-category">圖片分類</label>
                    <select id="image-category" value={activeImage.categoryId ?? ""} onChange={(event) => patchImage(activeImage.id, { categoryId: event.target.value || null })}>
                      <option value="">未分類</option>
                      {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                    </select>
                    <label>背景備註</label>
                    <InlineNoteEditor
                      key={`single-note-${activeImage.id}`}
                      note={activeImage.note}
                      placeholder="雙擊新增備註，例如：第二幕／暖色版本／導演首選"
                      onSave={(note) => patchImage(activeImage.id, { note })}
                    />
                    <span>Shift 拖曳鎖定方向；Ctrl/Cmd＋Z 復原，Ctrl/Cmd＋Shift＋Z 重做。</span>
                  </div>
                  <button className="secondary single-reset-all" onClick={resetActive}>重設全部圖片調整</button>
                </div>
              )}
            </div>
          ) : viewMode === "compare" ? (
            <div
              className={`compare-wrap ${comparePreviewMode === "threeD" ? "three-d" : ""}`}
              onDragOver={(event) => { if (draggingImageId || event.dataTransfer.types.includes("application/x-stage-image")) event.preventDefault(); }}
              onDrop={handleCompareAreaDrop}
            >
              <div className="compare-modebar">
                <div className="compare-view-switch" aria-label="比較顯示模式">
                  <button className={comparePreviewMode === "flat" ? "active" : ""} onClick={() => setComparePreviewMode("flat")}>平面模擬</button>
                  <button className={comparePreviewMode === "threeD" ? "active" : ""} onClick={() => setComparePreviewMode("threeD")}>3D 舞台</button>
                </div>
                {comparePreviewMode === "threeD" && <div className="compare-camera-switch" aria-label="3D 視角控制方式">
                  <span>視角控制</span>
                  <button className={compareCameraMode === "sync" ? "active" : ""} onClick={enableSynchronizedComparison}>同步視角</button>
                  <button className={compareCameraMode === "individual" ? "active" : ""} onClick={() => setCompareCameraMode("individual")}>個別視角</button>
                  <small>{compareCameraMode === "sync" ? "操作任一畫面，其他畫面會一起移動" : "每個畫面可分別旋轉、平移與縮放"}</small>
                </div>}
              </div>
              {comparedImages.length ? (
                <div className={`compare-grid count-${comparedImages.length}`}>
                  {comparedImages.map((image, index) => (
                    <article
                      key={image.id}
                      draggable={comparePreviewMode === "flat"}
                      className={`compare-card ${activeImage?.id === image.id ? "active" : ""} ${dragOverCompareId === image.id ? "drop-target" : ""} ${draggingImageId === image.id ? "is-dragging" : ""}`}
                      onDragStart={(event) => startImageDrag(event, image.id)}
                      onDragEnd={finishImageDrag}
                      onDragOver={(event) => {
                        if (!draggingImageId && !event.dataTransfer.types.includes("application/x-stage-image")) return;
                        event.preventDefault();
                        event.stopPropagation();
                        event.dataTransfer.dropEffect = "move";
                        setDragOverCompareId(image.id);
                      }}
                      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverCompareId(null); }}
                      onDrop={(event) => handleCompareDrop(event, image.id)}
                    >
                      {comparePreviewMode === "flat"
                        ? <StageCanvas image={image} label={String.fromCharCode(65 + index)} onActivate={() => setActiveId(image.id)} />
                        : <div className="compare-3d-frame">
                          <span className="compare-label">{String.fromCharCode(65 + index)}</span>
                          <Stage3D
                            ref={(handle) => { if (handle) compare3DRefs.current.set(image.id, handle); else compare3DRefs.current.delete(image.id); }}
                            image={image}
                            compact
                            showObjectControls={false}
                            syncId={image.id}
                            syncCamera={compareCameraMode === "sync" ? compareCameraSync : null}
                            onCameraChange={syncCompareCamera}
                          />
                        </div>}
                      <div className="compare-meta">
                        <div>
                          <strong>{image.name}</strong>
                          <InlineNoteEditor compact note={image.note} onSave={(note) => patchImage(image.id, { note })} />
                        </div>
                        <button onClick={() => { setActiveId(image.id); setViewMode("single"); }}>調整</button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="compare-empty"><span>▦</span><h3>尚未選擇比較圖片</h3><p>勾選「比較」，或直接把左側圖片拖到這裡，最多四張。</p></div>
              )}
            </div>
          ) : (
            <Stage3D ref={stage3DRef} image={activeImage} />
          )}
        </section>
      </section>

      {draggingFiles && <div className="drop-overlay"><div><span>＋</span><strong>放開以加入圖庫</strong><small>可同時加入多張背景圖片</small></div></div>}
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
