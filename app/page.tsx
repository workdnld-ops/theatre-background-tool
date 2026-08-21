"use client";

import { PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { registerSW } from "virtual:pwa-register";

type ViewMode = "single" | "compare";
type FitMode = "cover" | "contain";
type Transform = { scale: number; x: number; y: number; brightness: number; fit: FitMode };
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
type OfflineState = "preparing" | "ready" | "offline" | "disabled";
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DB_NAME = "stage-view-library";
const STORE_NAME = "backgrounds";
const CATEGORY_STORE_NAME = "categories";
const OFFLINE_DISABLED_KEY = "stage-view-offline-disabled";
const DEFAULT_TRANSFORM: Transform = { scale: 100, x: 0, y: 0, brightness: 100, fit: "cover" };
const MAX_COMPARE = 4;
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

function StageCanvas({
  image,
  interactive = false,
  label,
  onActivate,
  onTransform,
}: {
  image: LibraryImage;
  interactive?: boolean;
  label?: string;
  onActivate?: () => void;
  onTransform?: (transform: Transform) => void;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const transformRef = useRef(image.transform);
  transformRef.current = image.transform;

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!interactive) return;
    lastPointer.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const last = lastPointer.current;
    const element = canvasRef.current;
    if (!interactive || !last || !element || !onTransform) return;
    const next = {
      ...transformRef.current,
      x: transformRef.current.x + ((event.clientX - last.x) / element.clientWidth) * 100,
      y: transformRef.current.y + ((event.clientY - last.y) / element.clientHeight) * 100,
    };
    transformRef.current = next;
    lastPointer.current = { x: event.clientX, y: event.clientY };
    onTransform(next);
  }

  return (
    <div
      ref={canvasRef}
      className={`stage-canvas ${interactive ? "is-interactive" : ""}`}
      onClick={onActivate}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={() => (lastPointer.current = null)}
      onPointerCancel={() => (lastPointer.current = null)}
    >
      <img
        className="background-image"
        src={image.url}
        alt={image.name}
        draggable={false}
        style={{
          objectFit: image.transform.fit,
          filter: `brightness(${image.transform.brightness}%)`,
          transform: `translate3d(${image.transform.x}%, ${image.transform.y}%, 0) scale(${image.transform.scale / 100})`,
        }}
      />
      <img className="stage-overlay" src={STAGE_OVERLAY_URL} alt="劇場舞台比例模擬框" draggable={false} />
      {label && <span className="compare-label">{label}</span>}
    </div>
  );
}

export default function Home() {
  const [images, setImages] = useState<LibraryImage[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [newCategoryName, setNewCategoryName] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>("single");
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [ready, setReady] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [storageText, setStorageText] = useState("本機儲存");
  const [toast, setToast] = useState("");
  const [offlineState, setOfflineState] = useState<OfflineState>(() => localStorage.getItem(OFFLINE_DISABLED_KEY) === "1" ? "disabled" : navigator.onLine ? "preparing" : "offline");
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const urlsRef = useRef<string[]>([]);

  useEffect(() => {
    Promise.all([readLibrary(), readCategories()])
      .then(([records, storedCategories]) => {
        const restored = records
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((record) => {
            const url = URL.createObjectURL(record.blob);
            urlsRef.current.push(url);
            return { ...record, note: record.note ?? "", categoryId: record.categoryId ?? null, transform: { ...DEFAULT_TRANSFORM, ...record.transform }, url };
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
  const comparedImages = images.filter((image) => compareIds.has(image.id));
  const libraryGroups = useMemo(() => [
    ...categories.map((category) => ({ id: category.id, name: category.name, removable: true, images: filteredImages.filter((image) => image.categoryId === category.id) })),
    { id: "uncategorized", name: "未分類", removable: false, images: filteredImages.filter((image) => !image.categoryId || !categories.some((category) => category.id === image.categoryId)) },
  ], [categories, filteredImages]);

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

  async function importFiles(fileList: FileList | File[]) {
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
          categoryId: null,
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
      const next = new Set(current);
      added.forEach((image) => { if (next.size < MAX_COMPARE) next.add(image.id); });
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

  function updateTransform(id: string, transform: Transform) {
    patchImage(id, { transform });
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
    setCompareIds((current) => { const next = new Set(current); next.delete(image.id); return next; });
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
    setCompareIds((current) => new Set([...current].filter((id) => !removedIds.has(id))));
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
    setCompareIds(new Set());
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
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_COMPARE) next.add(id);
      else showToast(`一次最多比較 ${MAX_COMPARE} 張，請先取消一張。`);
      return next;
    });
  }

  function commitRename(image: LibraryImage) {
    const name = editingName.trim();
    if (name) patchImage(image.id, { name });
    setEditingId(null);
  }

  function resetActive() {
    if (activeImage) updateTransform(activeImage.id, { ...DEFAULT_TRANSFORM });
  }

  async function exportComposite(image: LibraryImage) {
    const [background, overlay] = await Promise.all([loadHtmlImage(image.url), loadHtmlImage(STAGE_OVERLAY_URL)]);
    const canvas = document.createElement("canvas");
    canvas.width = 1798;
    canvas.height = 1008;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = "#000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const baseScale = image.transform.fit === "cover"
      ? Math.max(canvas.width / background.naturalWidth, canvas.height / background.naturalHeight)
      : Math.min(canvas.width / background.naturalWidth, canvas.height / background.naturalHeight);
    const scale = baseScale * (image.transform.scale / 100);
    const width = background.naturalWidth * scale;
    const height = background.naturalHeight * scale;
    const x = (canvas.width - width) / 2 + (image.transform.x / 100) * canvas.width;
    const y = (canvas.height - height) / 2 + (image.transform.y / 100) * canvas.height;
    context.filter = `brightness(${image.transform.brightness}%)`;
    context.drawImage(background, x, y, width, height);
    context.filter = "none";
    context.drawImage(overlay, 0, 0, canvas.width, canvas.height);
    const link = document.createElement("a");
    link.download = `${image.name}-劇場模擬.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
    showToast("模擬圖已匯出。" );
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
      onDragEnter={(event) => { event.preventDefault(); setDraggingFiles(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDraggingFiles(false); }}
      onDrop={(event) => { event.preventDefault(); setDraggingFiles(false); void importFiles(event.dataTransfer.files); }}
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
                <section className="library-group" key={group.id}>
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
                        <article key={image.id} className={`library-item ${activeImage?.id === image.id ? "active" : ""}`} onClick={() => setActiveId(image.id)}>
                          <div className="thumb"><img src={image.url} alt="" /><img src={STAGE_OVERLAY_URL} alt="" /></div>
                          <div className="item-copy">
                            {editingId === image.id ? (
                              <input
                                className="rename-input"
                                autoFocus
                                value={editingName}
                                onChange={(e) => setEditingName(e.target.value)}
                                onBlur={() => commitRename(image)}
                                onKeyDown={(e) => { if (e.key === "Enter") commitRename(image); if (e.key === "Escape") setEditingId(null); }}
                                onClick={(e) => e.stopPropagation()}
                              />
                            ) : <strong>{image.name}</strong>}
                            <small>{image.note || "尚未加入備註"}</small>
                          </div>
                          <label className="compare-check" title="加入比較" onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox" checked={compareIds.has(image.id)} onChange={() => toggleCompare(image.id)} /><span>比較</span>
                          </label>
                          <div className="item-actions">
                            <button title="重新命名" onClick={(e) => { e.stopPropagation(); setEditingId(image.id); setEditingName(image.name); }}>✎</button>
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
            <div><p className="eyebrow">PREVIEW</p><h2>{viewMode === "single" ? "舞台預覽" : `比較背景（${comparedImages.length}/${MAX_COMPARE}）`}</h2></div>
            <div className="view-tabs">
              <button className={viewMode === "single" ? "active" : ""} onClick={() => setViewMode("single")}>單張調整</button>
              <button className={viewMode === "compare" ? "active" : ""} onClick={() => setViewMode("compare")}>並排比較 <b>{compareIds.size || ""}</b></button>
            </div>
          </div>

          {viewMode === "single" ? (
            <div className="single-view">
              <div className="canvas-wrap">
                {activeImage ? (
                  <StageCanvas image={activeImage} interactive onTransform={(transform) => updateTransform(activeImage.id, transform)} />
                ) : (
                  <button className="empty-stage" onClick={() => inputRef.current?.click()}>
                    <span>＋</span><strong>把背景圖放進舞台</strong><small>可一次選取多張 JPG、PNG 或 WEBP</small>
                  </button>
                )}
              </div>

              {activeImage && (
                <div className="editor-panel">
                  <div className="control-row">
                    <div className="range-control"><label>縮放 <b>{activeImage.transform.scale}%</b></label><input type="range" min="60" max="220" value={activeImage.transform.scale} onChange={(e) => updateTransform(activeImage.id, { ...activeImage.transform, scale: Number(e.target.value) })} /></div>
                    <div className="range-control"><label>亮度 <b>{activeImage.transform.brightness}%</b></label><input type="range" min="30" max="140" value={activeImage.transform.brightness} onChange={(e) => updateTransform(activeImage.id, { ...activeImage.transform, brightness: Number(e.target.value) })} /></div>
                    <div className="fit-control"><label>填滿方式</label><div><button className={activeImage.transform.fit === "cover" ? "active" : ""} onClick={() => updateTransform(activeImage.id, { ...activeImage.transform, fit: "cover" })}>填滿</button><button className={activeImage.transform.fit === "contain" ? "active" : ""} onClick={() => updateTransform(activeImage.id, { ...activeImage.transform, fit: "contain" })}>完整</button></div></div>
                    <button className="secondary" onClick={resetActive}>重設</button>
                    <button className="primary export-button" onClick={() => void exportComposite(activeImage)}>↓ 匯出 PNG</button>
                  </div>
                  <div className="note-row">
                    <label htmlFor="image-category">圖片分類</label>
                    <select id="image-category" value={activeImage.categoryId ?? ""} onChange={(event) => patchImage(activeImage.id, { categoryId: event.target.value || null })}>
                      <option value="">未分類</option>
                      {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                    </select>
                    <label htmlFor="image-note">背景備註</label>
                    <input id="image-note" value={activeImage.note} placeholder="例如：第二幕／暖色版本／導演首選" onChange={(e) => patchImage(activeImage.id, { note: e.target.value })} />
                    <span>直接拖曳舞台中的圖片可調整位置</span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="compare-wrap">
              {comparedImages.length ? (
                <div className={`compare-grid count-${comparedImages.length}`}>
                  {comparedImages.map((image, index) => (
                    <article key={image.id} className={`compare-card ${activeImage?.id === image.id ? "active" : ""}`}>
                      <StageCanvas image={image} label={String.fromCharCode(65 + index)} onActivate={() => setActiveId(image.id)} />
                      <div className="compare-meta"><div><strong>{image.name}</strong><small>{image.note || "無備註"}</small></div><button onClick={() => { setActiveId(image.id); setViewMode("single"); }}>調整</button></div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="compare-empty"><span>▦</span><h3>尚未選擇比較圖片</h3><p>在左側圖庫勾選「比較」，最多可同時查看四張。</p></div>
              )}
            </div>
          )}
        </section>
      </section>

      {draggingFiles && <div className="drop-overlay"><div><span>＋</span><strong>放開以加入圖庫</strong><small>可同時加入多張背景圖片</small></div></div>}
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
