# 希絆雲作所 — Cloud Run 部署指南

> 建立日期：2026-07-21。預計 2026-08 動工。
> 分工：【程式】= Claude 改程式碼；【手動】= 需要本人操作（帳號、綁卡、金鑰）。

## 整體流程總覽

```
階段一 程式碼準備（Claude 做）
  → 階段二 GCP 帳號與環境（手動，約 30 分鐘）
  → 階段三 金鑰設定（手動 + 指令）
  → 階段四 首次部署（一行指令）
  → 階段五 排程設定 Cloud Scheduler
  → 階段六 驗收與切換
```

---

## 階段一：程式碼準備【程式】

Claude 動工時會做以下修改，全部完成後 commit：

1. **密鑰改環境變數**
   - session secret（現在寫死 `hiban-secret-2025`，已在公開 repo 曝光）改讀 `process.env.SESSION_SECRET`
   - `GAS_SECRET` 移除寫死的預設值 `hiban2026`（GAS 那邊也要換一組新密鑰，見階段三）
2. **加 `app.set('trust proxy', 1)`** — Cloud Run 在 HTTPS 代理後面，不加 session cookie 會異常
3. **三個 node-cron 排程改成 HTTP 端點**（Cloud Run 閒置時 CPU 凍結，node-cron 不會執行）：
   - `POST /api/cron/payroll` — 每月薪資通知
   - `POST /api/cron/backup-data` — 每日資料備份
   - `POST /api/cron/backup-full` — 週日完整備份
   - 全部用 `x-cron-key` header 驗證（值 = 環境變數 `CRON_SECRET`）
   - 保留 `ENABLE_CRON=true` 時走原本 node-cron 的模式（本機測試用；雲端設 false）
4. **新增 `Dockerfile`**：

   ```dockerfile
   FROM node:24-slim
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci --omit=dev
   COPY . .
   ENV NODE_ENV=production
   CMD ["node", "server.js"]
   ```

5. **新增 `.dockerignore`**（重點：金鑰檔絕不能打包進映像檔）：

   ```
   node_modules
   .git
   .claude
   *.log
   *.bak
   *.json.bak
   hiban_db.json
   firebase-key.json
   ngrok.exe
   *.md
   ```

6. **從 git 移除 `ngrok.exe`**、package.json 加 `"engines": { "node": ">=24" }`
7. 把手上未 commit 的修改（partner-mobile.html 等）整理 commit

---

## 階段二：GCP 帳號與環境【手動，約 30 分鐘】

1. 開 https://console.cloud.google.com ，用管理 Firebase 的同一個 Google 帳號登入
2. 左上角專案選單 → 選 **hiban-workspace-c6b5c**（Firebase 專案本身就是 GCP 專案，不用新開）
3. **啟用計費**：左側選單「帳單」→ 建立帳單帳戶 → 綁信用卡
   - 新帳戶通常有 US$300 / 90 天試用額度
4. **安裝 gcloud CLI**：https://cloud.google.com/sdk/docs/install 下載 Windows 版安裝
5. 開 PowerShell 登入並選專案：

   ```powershell
   gcloud auth login
   gcloud config set project hiban-workspace-c6b5c
   ```

6. 啟用需要的服務（一次搞定）：

   ```powershell
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com
   ```

---

## 階段三：金鑰設定【手動】

### 3-1 先準備好各金鑰的值

| 名稱 | 值的來源 |
|---|---|
| `FIREBASE_KEY` | 專案裡的 `firebase-key.json`（整個檔案） |
| `SESSION_SECRET` | 產一組新隨機字串（PowerShell：`-join ((48..57)+(65..90)+(97..122) \| Get-Random -Count 48 \| % {[char]$_})`） |
| `CRON_SECRET` | 同上，再產一組 |
| `GAS_URL` | GAS 編輯器 → 部署 → 管理部署作業 → 網頁應用程式網址 |
| `GAS_SECRET` | **換一組新的**（舊值已公開曝光）：先在 GAS 程式碼裡改，再部署新版 GAS，兩邊填同一個值 |
| `GOOGLE_DRIVE_FOLDER_ID` | 備份資料夾網址最後那串 ID |
| `GOOGLE_OAUTH_CLIENT_ID` / `SECRET` / `REFRESH_TOKEN` | 之前設定的值；找不到就用專案裡 `get_refresh_token.js` 重新產 |
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey |

找不到的可以先跳過，對應功能會停用，網站照跑。

### 3-2 存進 Secret Manager（敏感金鑰）

```powershell
cd D:\html\網頁-公司
gcloud secrets create FIREBASE_KEY --data-file=firebase-key.json
echo -n "你產的隨機字串" | gcloud secrets create SESSION_SECRET --data-file=-
echo -n "你產的隨機字串" | gcloud secrets create CRON_SECRET --data-file=-
echo -n "GAS網址" | gcloud secrets create GAS_URL --data-file=-
echo -n "新GAS密鑰" | gcloud secrets create GAS_SECRET --data-file=-
echo -n "REFRESH_TOKEN值" | gcloud secrets create GOOGLE_OAUTH_REFRESH_TOKEN --data-file=-
echo -n "CLIENT_SECRET值" | gcloud secrets create GOOGLE_OAUTH_CLIENT_SECRET --data-file=-
echo -n "GEMINI金鑰" | gcloud secrets create GEMINI_API_KEY --data-file=-
```

### 3-3 授權 Cloud Run 讀取密鑰

```powershell
# 先查專案編號
gcloud projects describe hiban-workspace-c6b5c --format="value(projectNumber)"
# 用上面查到的編號取代 <編號>
gcloud projects add-iam-policy-binding hiban-workspace-c6b5c --member="serviceAccount:<編號>-compute@developer.gserviceaccount.com" --role="roles/secretmanager.secretAccessor"
```

---

## 階段四：首次部署

在專案資料夾執行（PowerShell 的續行符號是反引號 `` ` ``）：

```powershell
cd D:\html\網頁-公司
gcloud run deploy hiban-workspace `
  --source . `
  --region asia-east1 `
  --allow-unauthenticated `
  --min-instances 1 `
  --max-instances 1 `
  --memory 512Mi `
  --set-env-vars "ENABLE_CRON=false,GOOGLE_DRIVE_FOLDER_ID=<資料夾ID>,GOOGLE_OAUTH_CLIENT_ID=<CLIENT_ID>" `
  --set-secrets "FIREBASE_KEY=FIREBASE_KEY:latest,SESSION_SECRET=SESSION_SECRET:latest,CRON_SECRET=CRON_SECRET:latest,GAS_URL=GAS_URL:latest,GAS_SECRET=GAS_SECRET:latest,GOOGLE_OAUTH_REFRESH_TOKEN=GOOGLE_OAUTH_REFRESH_TOKEN:latest,GOOGLE_OAUTH_CLIENT_SECRET=GOOGLE_OAUTH_CLIENT_SECRET:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest"
```

- 第一次跑會問「要不要啟用 API / 建立 Artifact Registry」→ 都回 `Y`
- 跑完會顯示 `Service URL: https://hiban-workspace-xxxx.run.app` ← 這就是網站網址
- **重要**：`--max-instances 1` 是刻意的——登入 session 存在記憶體，多台主機會互相看不到對方的 session。300 人規模一台綽綽有餘。

之後每次更新程式，重跑同一行指令即可（參數會沿用，其實只要 `gcloud run deploy hiban-workspace --source . --region asia-east1`）。

---

## 階段五：Cloud Scheduler 排程（3 個，免費額度內）

`<URL>` 換成階段四拿到的 Service URL，`<CRON_SECRET>` 換成階段三產的值：

```powershell
gcloud scheduler jobs create http payroll-monthly --location asia-east1 --schedule "0 8 1 * *" --time-zone "Asia/Taipei" --uri "<URL>/api/cron/payroll" --http-method POST --headers "x-cron-key=<CRON_SECRET>"

gcloud scheduler jobs create http backup-daily --location asia-east1 --schedule "0 3 * * 1-6" --time-zone "Asia/Taipei" --uri "<URL>/api/cron/backup-data" --http-method POST --headers "x-cron-key=<CRON_SECRET>"

gcloud scheduler jobs create http backup-weekly --location asia-east1 --schedule "0 4 * * 0" --time-zone "Asia/Taipei" --uri "<URL>/api/cron/backup-full" --http-method POST --headers "x-cron-key=<CRON_SECRET>"
```

驗證：GCP 控制台 → Cloud Scheduler → 對 `backup-daily` 按「強制執行」→ 去 Google Drive 看有沒有多一份備份檔。

---

## 階段六：驗收與切換

1. **部署前先手動備份一次 Firestore**（自動備份目前在本機是停用狀態，務必先備）
2. 用測試帳號在新網址走一遍：登入 → 接任務 → 回報 → 督導審核 → 薪資頁
3. 手動觸發一次備份排程、寄一封測試信，確認 Drive 備份與 GAS 寄信正常
4. 都正常後，把新網址告訴測試夥伴，本機伺服器留著當備援
5. 觀察一兩週沒問題 → 之後想掛自己的網域再處理（Cloud Run → 網域對應，需要先買網域）

## 常見狀況

| 狀況 | 處理 |
|---|---|
| 部署失敗說權限不足 | 回頭做階段三 3-3 的授權指令 |
| 網站打得開但登入後跳掉 | 確認程式有 `trust proxy`（階段一第 2 項） |
| 排程沒反應 | Cloud Scheduler 控制台看執行紀錄；確認 header 的 CRON_SECRET 跟部署的一致 |
| 想回滾到上一版 | 控制台 → Cloud Run → hiban-workspace → 修訂版本 → 選舊版 → 100% 流量 |
| 費用監控 | 控制台 → 帳單 → 預算與快訊，設一個月 US$10 的警示 |
