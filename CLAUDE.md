# 希絆雲作所 — 專案說明

## 專案概述
希絆雲作所是一個多角色工作管理平台，使用 Node.js + Express 後端，純 HTML/CSS/JS 前端。

## 技術架構
- **後端**: Node.js + Express + lowdb（JSON 檔案資料庫）
- **認證**: express-session（Cookie session）
- **密碼**: bcryptjs 雜湊
- **前端**: 純 HTML + CSS + JS，無框架

## 檔案結構
```
D:\html\網頁-公司\
├── server.js          # Express 後端，所有 API
├── db.js              # lowdb 資料庫，資料存在 hiban_db.json
├── shared.js          # 前端共用：API 函式、requireAuth、showToast、signOut
├── index.html         # 登入頁（分頁選角色、下拉選帳號、忘記密碼）
├── register.html      # 申請帳號（三步驟表單、日曆選日期）
├── partner.html       # 工作夥伴介面
├── supervisor.html    # 督導人員介面
├── staff.html         # 工作人員介面（帳號管理、審核、重設密碼）
└── hiban_db.json      # 資料庫檔案（自動產生）
```

## API 端點
| 方法 | 路徑 | 說明 | 權限 |
|------|------|------|------|
| GET  | /api/users-list | 取得啟用帳號下拉清單 | 公開 |
| POST | /api/login | 登入 | 公開 |
| POST | /api/logout | 登出 | 已登入 |
| GET  | /api/me | 取得目前登入者資訊 | 已登入 |
| POST | /api/change-password | 修改密碼 | 已登入 |
| POST | /api/forgot-password | 送出忘記密碼申請 | 公開 |
| POST | /api/register | 申請帳號（後端自動產生帳號） | 公開 |
| GET  | /api/admin/users | 取得所有帳號 | staff |
| PUT  | /api/admin/users/:id/approve | 核准帳號 | staff |
| PUT  | /api/admin/users/:id/deactivate | 停用帳號 | staff |
| DELETE | /api/admin/users/:id | 刪除帳號 | staff |
| PUT  | /api/admin/users/:id/reset-password | 重設密碼為 0000 | staff |
| GET  | /api/admin/forgot-requests | 取得忘記密碼申請清單 | staff |

## 角色說明
- **partner（工作夥伴）**: 接任務、賺收入、查看成長
- **supervisor（督導人員）**: 管理夥伴、審核 WorkLog、督導紀錄
- **staff（工作人員）**: 帳號管理、薪資、全局設定

## 資料庫結構（hiban_db.json）
```js
users: [{
  id, username, real_name, password_hash, role, status,
  is_first_login, id_number, birthday, phone, address,
  identity, bank_name, bank_branch, bank_account, bank_holder,
  created_at
}]
forgot_requests: [{ id, user_id, status, created_at }]
```

## 預設帳號（密碼均為 0000）
- staff01 / 工作人員
- supervisor01 / 督導人員
- partner01 / 工作夥伴（首次登入需改密碼）
- partner02 / 工作夥伴

## 開發注意事項
- 所有修改直接寫入 `D:\html\網頁-公司\`
- 前端頁面需在 server 啟動後透過 http://localhost:3000 瀏覽
- 使用 bash 寫入檔案時避免中文字符在 heredoc 造成截斷，error 訊息改用英文
- shared.js 的 `requireAuth(['role'])` 會在未登入時自動導回 index.html

## 啟動方式
```
cd D:\html\網頁-公司
node server.js
```
