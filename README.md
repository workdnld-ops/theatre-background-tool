# 劇場投影背景模擬器

公開、免登入、可離線安裝的劇場投影背景比較工具。使用者匯入的圖片、名稱、備註與調整值只會保存在目前瀏覽器的 IndexedDB，不會上傳到伺服器。

## 功能

- 一次匯入多張 JPG、PNG、WEBP
- 本機圖庫、搜尋、重新命名、備註與刪除
- 每張圖片分別保存位置、縮放、亮度與填滿方式
- 最多四張並排比較
- 匯出 1798 × 1008 劇場模擬 PNG
- 首次完整開啟後支援斷網使用與桌面安裝

## 本機開發

```bash
npm install
npm run dev
```

正式建置：

```bash
npm run build
npm run preview
```

## 發佈

推送到 `main` 後，`.github/workflows/deploy-pages.yml` 會自動建置並部署至 GitHub Pages。Vite base path 固定為 `/theatre-background-tool/`。

## 資料說明

- 圖庫綁定網站來源與瀏覽器，無法在不同裝置間自動同步。
- 清除網站資料會刪除本機圖庫。
- 更新網站程式不會主動清除既有 IndexedDB 圖庫。
