const express    = require('express');
const session    = require('express-session');
const bcrypt     = require('bcryptjs');
const path       = require('path');
const cron       = require('node-cron');
const https = require('https');
const { Users, ForgotReqs, Assignments, WorklogReports, UserImages, Announcements, GrabTasks, GrabRecords, FreeTasks, Reports, ReportImages, db: firestoreDb, getTrafficStats, LEVELS, LEVEL_THRESHOLDS, calculateLevel, xpToNextLevel, levelInfo, getLevelsWithThresholds, BADGES, XPConfig, XPLogs, grantTaskXP } = require('./db');
const { 產生任務代號, 新增任務, 新增任務批次 } = require('./taskId'); // 任務代號/編號模組
const FREE_CODE_COL = '自由任務代號', FREE_ITEM_COL = '自由任務項目';
const LIMIT_CODE_COL = '限量任務代號', LIMIT_ITEM_COL = '限量任務項目';
const db = firestoreDb;

// ── 記憶體快取（減少 Firestore 讀取次數）─────────────────────
const _cache = {};
function cacheGet(key) {
  const c = _cache[key];
  if (!c) return null;
  if (Date.now() - c.ts > c.ttl) { delete _cache[key]; return null; }
  return c.data;
}
function cacheSet(key, data, ttlMs) { _cache[key] = { data, ts: Date.now(), ttl: ttlMs }; }
function cacheDel(key) { delete _cache[key]; }
function cacheClear(prefix) { Object.keys(_cache).filter(k => k.startsWith(prefix)).forEach(k => delete _cache[k]); }

// ── Google Apps Script 寄件設定 ───────────────────────────
const GAS_URL    = process.env.GAS_URL;
const GAS_SECRET = process.env.GAS_SECRET || 'hiban2026';
if (GAS_URL) console.log('✅ Google Apps Script mailer 已設定');
else         console.log('⚠️  GAS_URL 未設定，寄信功能停用');

async function sendMail({ to, subject, html }) {
  if (!GAS_URL) throw new Error('寄件服務未設定，請聯絡管理員配置 GAS_URL');
  const body = JSON.stringify({ secret: GAS_SECRET, to, subject, html });
  await new Promise((resolve, reject) => {
    const req = https.request(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) reject(new Error(json.error));
          else resolve(json);
        } catch(e) { resolve(); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 統一日期格式：YYYY/MM/DD hh:mm:ss（台北時區）
function nowTW() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 日期正規化為可比較的 "YYYY-MM-DD"（補零＋統一分隔符），支援 "2020/6/5"、"2020/06/05 17:00"、"2020-06-05T..." 等
function dateKey(s) {
  if (!s) return '';
  const datePart = String(s).split('T')[0].split(' ')[0]; // 去掉時間部分
  const parts = datePart.replace(/-/g, '/').split('/');
  if (parts.length < 3) return datePart.replace(/\//g, '-');
  const [y, m, d] = parts;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// 操作紀錄（稽核日誌）：記錄派案人員/管理員對任務的任何動作
async function logTaskAction(req, action, detail, target) {
  try {
    const u = (req && req.session && req.session.user) || {};
    await firestoreDb.collection('task_logs').add({
      actor_id: u.id || null, actor_name: u.real_name || u.username || '系統',
      actor_role: u.role || '', action, detail: detail || '',
      target_type: (target && target.type) || '', target_id: (target && target.id) || null,
      created_at: nowTW(),
    });
  } catch(e) { console.error('[task_log]', e.message); }
}

// 報表共用樣式：所有使用到的儲存格加黑色細框線、字體強制黑色（保留粗體/字級）
function applyReportGrid(ws) {
  const thin = { style: 'thin', color: { argb: 'FF000000' } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  const colCount = (ws.columns && ws.columns.length) || ws.columnCount || 0;
  ws.eachRow({ includeEmpty: false }, row => {
    for (let c = 1; c <= colCount; c++) {
      const cell = row.getCell(c);
      cell.border = border;
      cell.font = { ...(cell.font || {}), color: { argb: 'FF000000' } };
    }
  });
}

const app = express();
app.use(express.json({ limit: '100mb' })); // 附件 base64 較大（20MB 檔約 27MB base64，多檔累加）
app.use(express.static(path.join(__dirname), {
  etag: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));
app.use(session({
  secret: 'hiban-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: (() => {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const midnight = new Date(now); midnight.setHours(23, 59, 59, 999);
    return Math.max(midnight.getTime() - now.getTime() + 1000, 60000);
  })() }
}));

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
    if (!roles.includes(req.session.user.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

app.get('/api/users-list', async (req, res) => {
  const { role } = req.query;
  const cacheKey = 'users-list';
  let users = cacheGet(cacheKey);
  if (!users) {
    try {
      users = await Users.all();
      cacheSet(cacheKey, users, 30 * 60 * 1000); // 快取 30 分鐘
    } catch(e) {
      console.error('[users-list] Firestore error:', e.message);
      // 配額耗盡或其他錯誤：回傳空陣列，讓登入頁仍可顯示（不噴 500）
      return res.json([]);
    }
  }
  let filtered = users.filter(u => u.status === 'active' || u.status === 'suspended').filter(u => {
    // 停用期已過的自動視為 active（不修 DB，僅過濾用）
    if (u.status === 'suspended' && u.suspend_until) {
      return u.suspend_until <= new Date().toISOString().split('T')[0] ? true : false;
    }
    return u.status === 'active';
  });
  if (role) filtered = filtered.filter(u => u.role === role);
  if (req.session.user?.role === 'supervisor' && role === 'partner' && req.query.scope !== 'all') {
    filtered = filtered.filter(u => u.supervisor_id === req.session.user.id);
  }
  res.json(filtered.map(u => ({ id: u.id, username: u.username, real_name: u.real_name, nickname: u.nickname, login_dates: u.login_dates || [], supervisor_id: u.supervisor_id })));
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
    const user = await Users.byName(username);
    if (!user) return res.status(401).json({ error: 'Account not found' });
    if (user.status === 'pending')  return res.status(403).json({ error: 'Account pending approval' });
    if (user.status === 'archived') return res.status(403).json({ error: 'Account archived' });
    if (user.status === 'inactive') return res.status(403).json({ error: 'Account disabled' });
    // 承攬停用：檢查是否已到解除日
    if (user.status === 'suspended') {
      const today = new Date().toISOString().split('T')[0];
      if (user.suspend_until && user.suspend_until <= today) {
        // 自動解除停用
        await Users.update(user.id, { status: 'active', suspended_at: null, suspend_until: null, suspend_days: null, suspend_reason: null });
      } else {
        const until = user.suspend_until ? `（停用至 ${user.suspend_until}）` : '（永久停用）';
        return res.status(403).json({ error: `帳號已停用 ${until}` });
      }
    }
    if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Wrong password' });
    req.session.user = { id: user.id, username: user.username, real_name: user.real_name, nickname: user.nickname, role: user.role, is_admin: !!(user.is_admin || user.username === 'admin'), supervisor_id: user.supervisor_id || null };
        const todayTW = (() => {
      const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
    })();
    const loginDates = user.login_dates || [];
    if (!loginDates.includes(todayTW)) {
      await Users.update(user.id, { login_dates: [...loginDates, todayTW] }).catch(()=>{});
    }
    res.json({ ok: true, role: user.role, is_first_login: !!user.is_first_login });
  } catch(e) {
    const msg = e.message || '';
    if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('Quota')) {
      return res.status(503).json({ error: '系統繁忙，請稍後再試（每日配額暫時耗盡，約台灣時間下午重置）' });
    }
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const u = await Users.byId(req.session.user.id);
    res.json({ ...req.session.user, is_admin: !!req.session.user.is_admin, login_dates: u ? (u.login_dates || []) : [] });
  } catch(e) { res.json({ ...req.session.user, is_admin: !!req.session.user.is_admin, login_dates: [] }); }
});

// ── 公告 API ─────────────────────────────────────────────────
// 取得公告（依角色過濾、過期自動排除）
// 系統自動發布「任務」類公告給工作夥伴（category:'task'，7 天後自動過期）
async function postTaskAnnouncement(title, content) {
  try {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    d.setDate(d.getDate() + 7);
    const p = n => String(n).padStart(2, '0');
    await Announcements.create({
      title, content,
      target: 'partner', category: 'task',
      is_pinned: false,
      expires_at: `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`,
      created_by: '系統（任務通知）', created_by_id: null,
    });
    cacheDel('announcements');
  } catch(e) { console.error('[taskAnnouncement]', e.message); }
}

app.get('/api/announcements', requireAuth, async (req, res) => {
  try {
    const role = req.session.user.role;
    const now  = new Date();
    let list = cacheGet('announcements');
    if (!list) { list = await Announcements.all(); cacheSet('announcements', list, 30 * 60 * 1000); } // 30 分鐘；公告異動時會即時清快取
    list = list.filter(a => {
      if (a.target !== 'all' && a.target !== role) return false;
      if (a.expires_at && new Date(a.expires_at) < now) return false;
      return true;
    });
    // 置頂優先，再依建立時間排序
    list.sort((a, b) => {
      if (a.is_pinned && !b.is_pinned) return -1;
      if (!a.is_pinned && b.is_pinned) return 1;
      return new Date(b.created_at) - new Date(a.created_at);
    });
    res.json(list);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 取得所有公告（staff 管理用）
// ── 任務冒險錄：XP / 等級 / Streak / 徽章 ─────────────────────
app.get('/api/me/xp', requireAuth, async (req, res) => {
  try {
    const u = await Users.byId(req.session.user.id);
    const xp = (u && u.xp) || 0;
    const xpConfig = await XPConfig.get();
    const thresholds = xpConfig.levelThresholds;
    const level = calculateLevel(xp, thresholds);
    const info = levelInfo(level, thresholds);
    const allLogs = await XPLogs.listByUser(req.session.user.id);
    // 本週統計（台灣時間，週一為一週開始）
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const dow = (now.getDay() + 6) % 7; // 0=週一
    const monday = new Date(now); monday.setHours(0,0,0,0); monday.setDate(now.getDate() - dow);
    const weekLogs = allLogs.filter(l => {
      const t = new Date((l.timestamp||'').replace(/\//g,'-').replace(' ','T'));
      return t >= monday;
    });
    res.json({
      xp, level, levelTitle: info.title, levelColor: info.color,
      xpToNext: xpToNextLevel(xp, thresholds), levelMin: info.min,
      streak: (u && u.streak) || 0,
      badges: (u && u.badges) || [],
      recentLogs: allLogs.slice(0, 5),
      weekCount: weekLogs.length,
      weekXP: weekLogs.reduce((s,l) => s + (l.xpFinal||0), 0),
      levels: getLevelsWithThresholds(thresholds),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/badges', requireAuth, (req, res) => res.json(BADGES));

// 管理員：任務 XP 設定
app.get('/api/admin/xp-config', requireRole('staff'), async (req, res) => {
  try {
    const config = await XPConfig.get();
    // 任務名稱與派案人員設定的任務類型一致
    let names = [];
    try {
      const ttSnap = await firestoreDb.collection('task_types').orderBy('sort','asc').get();
      names = ttSnap.docs.map(d => d.data().name).filter(Boolean);
    } catch {
      const ttSnap = await firestoreDb.collection('task_types').get();
      names = ttSnap.docs.map(d => d.data().name).filter(Boolean);
    }
    res.json({ ...config, taskNames: names, levels: getLevelsWithThresholds(config.levelThresholds) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/xp-config', requireRole('staff'), async (req, res) => {
  try {
    const { globalDefault, taskDefaults, levelThresholds } = req.body;
    await XPConfig.set(globalDefault || 10, taskDefaults || {}, levelThresholds);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Firebase 流量統計（staff 專用）─────────────────────────────
app.get('/api/admin/firebase-traffic', requireRole('staff'), (req, res) => {
  const s = getTrafficStats();
  res.json({
    date: s.date,
    reads: s.reads, readsLimit: 50000,
    writes: s.writes, writesLimit: 20000,
    deletes: s.deletes, deletesLimit: 20000,
    history: s.history,
  });
});

app.get('/api/admin/announcements', requireRole('staff'), async (req, res) => {
  try {
    const list = await Announcements.all();
    list.sort((a, b) => {
      if (a.is_pinned && !b.is_pinned) return -1;
      if (!a.is_pinned && b.is_pinned) return 1;
      return new Date(b.created_at) - new Date(a.created_at);
    });
    res.json(list);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 新增公告
app.post('/api/admin/announcements', requireRole('staff'), async (req, res) => {
  try {
    const { title, content, target, is_pinned, expires_at } = req.body;
    if (!title || !content) return res.status(400).json({ error: '標題和內容為必填' });
    const id = await Announcements.create({
      title, content,
      target: target || 'all',
      is_pinned: !!is_pinned,
      expires_at: expires_at || null,
      created_by: req.session.user.real_name,
      created_by_id: req.session.user.id,
    });
    cacheDel('announcements');
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 編輯公告
app.put('/api/admin/announcements/:id', requireRole('staff'), async (req, res) => {
  try {
    const { title, content, target, is_pinned, expires_at } = req.body;
    await Announcements.update(req.params.id, {
      title, content,
      target: target || 'all',
      is_pinned: !!is_pinned,
      expires_at: expires_at || null,
    });
    cacheDel('announcements');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 取得公告的附件陣列（相容舊單一附件格式）
function getAnnAttachments(ann) {
  if (ann.attachments && ann.attachments.length) return ann.attachments;
  if (ann.attachment_drive_id) return [{ drive_id: ann.attachment_drive_id, name: ann.attachment_name, mime: ann.attachment_mime || 'application/octet-stream' }];
  return [];
}

// 刪除公告
app.delete('/api/admin/announcements/:id', requireRole('staff'), async (req, res) => {
  try {
    const ann = await Announcements.byId(req.params.id);
    if (ann) {
      const drive = getDrive();
      if (drive) {
        for (const att of getAnnAttachments(ann)) {
          try { await drive.files.delete({ fileId: att.drive_id, supportsAllDrives: true }); }
          catch(de) { console.error('[Drive delete att]', de.message); }
        }
      }
    }
    await Announcements.delete(req.params.id);
    cacheDel('announcements');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 上傳公告附件（base64，最大 15MB）— 追加到陣列
app.post('/api/admin/announcements/:id/attachment', requireRole('staff'), async (req, res) => {
  try {
    const { name, mime, data } = req.body;
    if (!name || !data) return res.status(400).json({ error: '缺少檔案資料' });
    const buf = Buffer.from(data, 'base64');
    if (buf.byteLength > 15 * 1024 * 1024) return res.status(400).json({ error: '附件大小不得超過 15 MB' });

    const ann = await Announcements.byId(req.params.id);
    if (!ann) return res.status(404).json({ error: '公告不存在' });

    const drive = getDrive();
    if (!drive) return res.status(503).json({ error: 'Drive 未設定，無法上傳附件' });

    const rootId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    const annDirId = await driveEnsureFolder(drive, '公告附件', rootId);

    const { Readable } = require('stream');
    const created = await drive.files.create({
      requestBody: { name, parents: [annDirId] },
      media: { mimeType: mime || 'application/octet-stream', body: Readable.from(buf) },
      fields: 'id',
      supportsAllDrives: true,
    });
    const fileId = created.data.id;

    // 取現有附件陣列並追加
    const existing = getAnnAttachments(ann);
    const updated  = [...existing, { drive_id: fileId, name, mime: mime || 'application/octet-stream' }];
    await Announcements.update(req.params.id, {
      attachments: updated,
      // 清除舊單一附件欄位
      attachment_drive_id: null, attachment_name: null, attachment_mime: null,
    });
    cacheDel('announcements');
    res.json({ ok: true, drive_id: fileId, name });
  } catch(e) { console.error('[attachment upload]', e.message); res.status(500).json({ error: e.message }); }
});

// 刪除特定附件（by drive_id）
app.delete('/api/admin/announcements/:id/attachment/:driveId', requireRole('staff'), async (req, res) => {
  try {
    const ann = await Announcements.byId(req.params.id);
    if (!ann) return res.status(404).json({ error: '公告不存在' });
    const { driveId } = req.params;
    const existing = getAnnAttachments(ann);
    const remaining = existing.filter(a => a.drive_id !== driveId);
    // Drive 刪除
    const drive = getDrive();
    if (drive) {
      try { await drive.files.delete({ fileId: driveId, supportsAllDrives: true }); }
      catch(de) { console.error('[Drive] 附件刪除失敗', de.message); }
    }
    await Announcements.update(req.params.id, {
      attachments: remaining,
      attachment_drive_id: null, attachment_name: null, attachment_mime: null,
    });
    cacheDel('announcements');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 下載附件（by drive_id）
app.get('/api/announcements/:id/attachment/:driveId', requireAuth, async (req, res) => {
  try {
    const ann = await Announcements.byId(req.params.id);
    if (!ann) return res.status(404).json({ error: '公告不存在' });
    const { driveId } = req.params;
    const atts = getAnnAttachments(ann);
    const att = atts.find(a => a.drive_id === driveId);
    if (!att) return res.status(404).json({ error: '附件不存在' });

    const drive = getDrive();
    if (!drive) return res.status(503).json({ error: 'Drive 未設定' });

    const meta = await drive.files.get({ fileId: driveId, fields: 'name,mimeType', supportsAllDrives: true });
    const mime  = meta.data.mimeType || att.mime || 'application/octet-stream';
    const fname = encodeURIComponent(att.name || meta.data.name || 'attachment');

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${fname}`);

    const dl = await drive.files.get(
      { fileId: driveId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );
    dl.data.pipe(res);
  } catch(e) { console.error('[attachment download]', e.message); res.status(500).json({ error: e.message }); }
});

// 派案附件：上傳到雲端硬碟「派案附件/{年月}」，回傳 [{drive_id,name,mime}]
async function uploadTaskAttachments(files) {
  if (!Array.isArray(files) || !files.length) return [];
  const drive = getDrive();
  const rootId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!drive || !rootId) return [];
  const { Readable } = require('stream');
  const baseId = await driveEnsureFolder(drive, '派案附件', rootId);
  const ymId   = await driveEnsureFolder(drive, nowTW().slice(0, 7).replace(/\//g, '-'), baseId);
  const out = [];
  for (const f of files) {
    if (!f || !f.data) continue;
    const b64  = String(f.data).replace(/^data:[^;]+;base64,/, '');
    const mime = f.mime || 'application/octet-stream';
    const name = (f.name || 'file').replace(/[\/\\:*?"<>|]/g, '');
    if (Buffer.byteLength(b64, 'base64') > 20 * 1024 * 1024) { console.warn('[task att] 超過 20MB 略過', name); continue; }
    try {
      const created = await drive.files.create({
        requestBody: { name, parents: [ymId] },
        media: { mimeType: mime, body: Readable.from(Buffer.from(b64, 'base64')) },
        fields: 'id', supportsAllDrives: true,
      });
      out.push({ drive_id: created.data.id, name, mime });
    } catch(e) { console.error('[task att upload]', e.message); }
  }
  return out;
}

// 下載派案附件（登入即可）
app.get('/api/task-attachment/:driveId', requireAuth, async (req, res) => {
  try {
    const driveId = req.params.driveId;
    const drive = getDrive();
    if (!drive) return res.status(503).json({ error: 'Drive 未設定' });
    const meta = await drive.files.get({ fileId: driveId, fields: 'name,mimeType', supportsAllDrives: true });
    res.setHeader('Content-Type', meta.data.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(meta.data.name || 'attachment')}`);
    const dl = await drive.files.get({ fileId: driveId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' });
    dl.data.pipe(res);
  } catch(e) { console.error('[task-att download]', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/profile', requireAuth, async (req, res) => {
  try {
    const u = await Users.byId(req.session.user.id);
    if (!u) return res.status(404).json({ error: 'Not found' });
    const { id, username, real_name, role, status, id_number, birthday, phone, address, mailing_address, email,
            identity, bank_type, bank_code, bank_name, bank_branch, bank_account, bank_holder } = u;
    res.json({ id, username, real_name, role, status, id_number, birthday, phone, address, mailing_address, email,
               identity, bank_type, bank_code, bank_name, bank_branch, bank_account, bank_holder });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/profile', requireAuth, async (req, res) => {
  try {
    const role    = req.session.user.role;
    const allowed = ['phone','address','mailing_address','email'];
    const patch   = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) patch[f] = req.body[f]; });
    await Users.update(req.session.user.id, patch);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/profile/bank', requireAuth, async (req, res) => {
  try {
    if (req.session.user.role !== 'partner') return res.status(403).json({ error: 'Forbidden' });
    const { bank_code, bank_name, bank_branch, bank_account, bank_holder } = req.body;
    await Users.update(req.session.user.id, { bank_code, bank_name, bank_branch, bank_account, bank_holder });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/change-password', requireAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!new_password || new_password.length < 6 || new_password.length > 12) return res.status(400).json({ error: '密碼須為 6～12 位' });
    const user = await Users.byId(req.session.user.id);
    if (!bcrypt.compareSync(current_password, user.password_hash)) return res.status(401).json({ error: 'Wrong current password' });
    await Users.update(user.id, { password_hash: bcrypt.hashSync(new_password, 10), is_first_login: false });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/forgot-password', async (req, res) => {
  try {
    const { real_name, id_number, birthday } = req.body;
    if (!real_name || !id_number || !birthday)
      return res.status(400).json({ error: '請填寫姓名、身分證及生日' });
    const all  = await Users.all();
    const user = all.find(u =>
      u.real_name  === real_name.trim() &&
      u.id_number  === id_number.trim().toUpperCase() &&
      u.birthday   === birthday &&
      u.status     === 'active'
    );
    if (!user) return res.status(404).json({ error: '資料不符，請確認姓名、身分證及生日是否正確' });
    if (await ForgotReqs.byUser(user.id)) return res.json({ ok: true, msg: '申請已送出，請等待管理人員處理' });
    await ForgotReqs.create(user.id);
    res.json({ ok: true, msg: '申請已送出！管理人員將盡快重設密碼' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function generateUsername(prefix) {
  let username;
  do {
    username = prefix + '_' + Math.floor(100000 + Math.random() * 900000);
  } while (await Users.byName(username));
  return username;
}

app.post('/api/register', async (req, res) => {
  try {
    const { real_name, id_number, birthday, phone, address } = req.body;
    if (!real_name) return res.status(400).json({ error: 'Missing real_name' });
    if (!id_number) return res.status(400).json({ error: 'Missing id_number' });
    if (!birthday)  return res.status(400).json({ error: 'Missing birthday' });
    if (!phone)     return res.status(400).json({ error: 'Missing phone' });
    if (!address)   return res.status(400).json({ error: 'Missing address' });
    const { email, gender, nickname, identity, bank_type, bank_code, bank_name, bank_branch, bank_account, bank_holder, post_office_code,
            mailing_address, id_front_b64, id_back_b64, bank_b64, disability_b64 } = req.body;
    if (!email) return res.status(400).json({ error: 'Missing email' });
    const base     = real_name.charCodeAt(0).toString(36);
    const username = await generateUsername('user_' + base);
    const newUser = await Users.create({
      username, real_name, id_number, birthday, phone, address,
      mailing_address: mailing_address || address,
      email: email || null, gender: gender || null,
      nickname: nickname || null, identity: identity || null,
      bank_type: bank_type || null, bank_code: bank_code || null,
      bank_name: bank_name || null, bank_branch: bank_branch || null,
      bank_account: bank_account || null, bank_holder: bank_holder || null,
      post_office_code: post_office_code || null,
      role: 'partner', status: 'pending', is_first_login: true,
      password_hash: bcrypt.hashSync('0000', 10),
    });

    // 儲存圖片（背景，不阻塞）
    console.log(`[UserImages] front=${id_front_b64?.length||0} back=${id_back_b64?.length||0} bank=${bank_b64?.length||0} disability=${disability_b64?.length||0}`);
    if (id_front_b64 || id_back_b64 || bank_b64 || disability_b64) {
      UserImages.save(newUser.id, { front: id_front_b64||'', back: id_back_b64||'', bank: bank_b64||'', disability: disability_b64||'' })
        .catch(e => console.error('[UserImages.save]', e.message));
    } else {
      console.warn('[UserImages] 沒有收到任何圖片 b64，略過儲存');
    }

    // 寄通知信給所有 staff（背景執行，不阻塞回應）
    res.json({ ok: true, username });
    (async () => {
      try {
        const allUsers  = await Users.all();
        const staffList = allUsers.filter(u => u.role === 'staff' && u.status === 'active');
        const staffEmails = staffList.map(u => u.email).filter(Boolean);
        if (!staffEmails.length) return;
        const html = `
<div style="font-family:'Noto Sans TC',sans-serif;max-width:520px;margin:auto">
  <h2 style="color:#1A8AC0;margin-bottom:.5rem">📋 新夥伴申請通知</h2>
  <p>管理人員您好：</p>
  <p><strong>${real_name}</strong> 已完成線上申請，請至網站進行審核。</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px;margin:1rem 0">
    <tr><td style="padding:6px 12px;background:#f0f8fe;font-weight:600;width:90px">姓名</td><td style="padding:6px 12px">${real_name}</td></tr>
    <tr><td style="padding:6px 12px;background:#f0f8fe;font-weight:600">電話</td><td style="padding:6px 12px">${phone}</td></tr>
    <tr><td style="padding:6px 12px;background:#f0f8fe;font-weight:600">信箱</td><td style="padding:6px 12px">${email || '—'}</td></tr>
    <tr><td style="padding:6px 12px;background:#f0f8fe;font-weight:600">戶籍地址</td><td style="padding:6px 12px">${address || '—'}</td></tr>
    <tr><td style="padding:6px 12px;background:#f0f8fe;font-weight:600">通訊地址</td><td style="padding:6px 12px">${mailing_address || address || '—'}</td></tr>
    <tr><td style="padding:6px 12px;background:#f0f8fe;font-weight:600">身份別</td><td style="padding:6px 12px">${identity || '—'}</td></tr>
    <tr><td style="padding:6px 12px;background:#f0f8fe;font-weight:600">申請時間</td><td style="padding:6px 12px">${new Date().toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})}</td></tr>
  </table>
  <p style="margin-top:1rem;color:#7A9AAF;font-size:13px">希絆雲作所　敬上</p>
</div>`;
        await sendMail({
          to: staffEmails.join(','),
          subject: `【希絆雲作所】${real_name} 已完成線上申請，待審核`,
          html
        });
      } catch(e) { console.error('[register notify]', e.message); }
    })();
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', requireRole('staff'), async (req, res) => {
  try {
    const users = await Users.all();
    res.json(users.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users/create', requireRole('staff'), async (req, res) => {
  try {
    const { role, real_name, id_number, birthday, phone, email, address, mailing_address, identity, is_admin } = req.body;
    if (!['supervisor','staff'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (!real_name || !id_number || !birthday || !phone) return res.status(400).json({ error: 'Missing required fields' });
    // 只有 system admin 才能建立 is_admin 帳號
    if (is_admin && !req.session.user.is_admin) return res.status(403).json({ error: '權限不足' });
    const prefix   = role === 'supervisor' ? 'sv' : 'st';
    const username = await generateUsername(prefix);
    const user     = await Users.create({
      username, real_name, id_number, birthday, phone,
      email:    email    || null,
      address:  address  || null,
      mailing_address: mailing_address || address || null,
      identity: identity || null,
      is_admin: role === 'staff' && !!is_admin,
      role, status: 'active', is_first_login: true,
      password_hash: bcrypt.hashSync('0000', 10),
    });
    cacheDel('users-list'); // 清登入下拉快取，讓新帳號立即出現
    res.json({ ok: true, username: user.username });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/users/:id/approve', requireRole('staff'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const user = await Users.byId(id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    // 工作夥伴核准時必須指定派案人員
    if (user.role === 'partner') {
      const { supervisor_id } = req.body;
      if (!supervisor_id) return res.status(400).json({ error: '請選擇負責派案人員' });
      const sv = await Users.byId(parseInt(supervisor_id));
      if (!sv || sv.role !== 'supervisor') return res.status(400).json({ error: '無效的派案人員' });
      await Users.update(id, { status: 'active', supervisor_id: parseInt(supervisor_id) });
      await Users.assignPartnerNo(id);  // 配發永久工作夥伴編號
    } else {
      await Users.update(id, { status: 'active' });
    }
    cacheDel('users-list'); // 清登入下拉快取，讓新核准的帳號立即出現
    res.json({ ok: true });
    // 背景：Drive 上傳 + 寄歡迎信
    (async () => {
      try {
        // Google Drive 上傳
        if (user.role === 'partner') {
          const imgs = await UserImages.get(id);
          console.log(`[Drive] imgs for ${user.real_name}:`, imgs ? `front=${!!imgs.front} back=${!!imgs.back} bank=${!!imgs.bank}` : 'null');
          if (imgs) await uploadUserToDrive(user, imgs);
        }
        // 寄歡迎信給申請人
        if (user.email) {
          let svLine = '';
          if (user.role === 'partner') {
            const { supervisor_id } = req.body;
            if (supervisor_id) {
              const sv = await Users.byId(parseInt(supervisor_id));
              if (sv) svLine = `<p>您的負責派案人員為 <strong>${sv.real_name}</strong>，如有任何問題歡迎與派案人員聯繫。</p>`;
            }
          }
          await sendMail({
            to: user.email,
            subject: `【希絆雲作所】歡迎加入！您的帳號已通過審核`,
            html: `
<div style="font-family:'Noto Sans TC',sans-serif;max-width:520px;margin:auto">
  <h2 style="color:#1A8AC0;margin-bottom:.5rem">🎉 歡迎加入希絆雲作所！</h2>
  <p>您好，<strong>${user.real_name}</strong>，</p>
  <p>恭喜您的帳號申請已通過審核，您現在可以使用系統帳號登入平台。</p>
  ${svLine}
  <p>登入資訊如下：</p>
  <table style="border-collapse:collapse;font-size:14px;margin:.5rem 0">
    <tr><td style="padding:6px 16px 6px 0;color:#555;font-weight:600">預設密碼</td><td style="padding:6px 0;font-weight:700;color:#1A8AC0;letter-spacing:.15em">0000</td></tr>
  </table>
  <p style="color:#E05555;font-size:13px">⚠️ 首次登入後系統將要求您立即變更密碼，請妥善保管新密碼。</p>
  <p>登入後請依照系統提示完成後續設定，期待與您一起創造美好的工作體驗。</p>
  <p>若有任何問題，請隨時聯繫管理人員。</p>
  <p style="margin-top:1.5rem;color:#7A9AAF;font-size:13px">希絆雲作所　敬上</p>
</div>`
          }).catch(e => console.error('[approve mail]', e.message));
        }
      } catch(e) { console.error('[approve background]', e.message); }
    })();
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 取得申請人圖片
app.get('/api/admin/users/:id/images', requireRole('staff'), async (req, res) => {
  try {
    const imgs = await UserImages.get(parseInt(req.params.id));
    res.json({ ok: true, data: imgs || {} });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 退回申請（寄信給申請人）
app.put('/api/admin/users/:id/reject', requireRole('staff'), async (req, res) => {
  try {
    const id   = parseInt(req.params.id);
    const user = await Users.byId(id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { reason } = req.body;
    await Users.update(id, { status: 'rejected', rejected_at: new Date().toISOString(), rejected_reason: reason || '' });
    cacheDel('users-list');
    res.json({ ok: true });
    // 寄信給申請人
    if (user.email) {
      sendMail({
        to: user.email,
        subject: `【希絆雲作所】您的申請未通過審核`,
        html: `
<div style="font-family:'Noto Sans TC',sans-serif;max-width:520px;margin:auto">
  <h2 style="color:#E05555;margin-bottom:.5rem">申請審核結果通知</h2>
  <p>您好，<strong>${user.real_name}</strong>，</p>
  <p>很遺憾，您的加入申請未能通過本次審核。</p>
  ${reason ? `<p><strong>退回原因：</strong>${reason}</p>` : ''}
  <p>如有疑問或需要重新申請，歡迎再次聯繫管理人員。</p>
  <p style="margin-top:1.5rem;color:#7A9AAF;font-size:13px">希絆雲作所　敬上</p>
</div>`
      }).catch(e => console.error('[reject mail]', e.message));
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/users/:id/set-supervisor', requireRole('staff'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { supervisor_id } = req.body;
    if (!supervisor_id) return res.status(400).json({ error: '請選擇派案人員' });
    const sv = await Users.byId(parseInt(supervisor_id));
    if (!sv || sv.role !== 'supervisor') return res.status(400).json({ error: '無效的派案人員' });
    await Users.update(id, { supervisor_id: parseInt(supervisor_id) });
    cacheDel('users-list'); // 改派案人員會影響派案人員範圍的下拉，需清快取
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/users/:id/deactivate', requireRole('staff'), async (req, res) => {
  try {
    const { suspend_days, suspend_reason, suspended_at } = req.body || {};
    const startDate = suspended_at || nowTW().split('T')[0];
    const days = suspend_days === '永久' || !suspend_days ? null : parseInt(suspend_days);
    const suspend_until = days ? (() => {
      const d = new Date(startDate); d.setDate(d.getDate() + days);
      return d.toISOString().split('T')[0];
    })() : null;
    await Users.update(parseInt(req.params.id), {
      status: 'suspended',
      suspended_at: startDate,
      suspend_days: days,
      suspend_reason: suspend_reason || '',
      suspend_until,
    });
    cacheDel('users-list');
    res.json({ ok: true, suspend_until });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 解除停用
app.put('/api/admin/users/:id/unsuspend', requireRole('staff'), async (req, res) => {
  try {
    await Users.update(parseInt(req.params.id), {
      status: 'active',
      suspended_at: null, suspend_days: null, suspend_reason: null, suspend_until: null,
    });
    cacheDel('users-list');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 封存帳號（取代刪除）
app.put('/api/admin/users/:id/archive-user', requireRole('staff'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (id === req.session.user.id) return res.status(400).json({ error: '無法封存自己的帳號' });
    const archiveDate = nowTW().split('T')[0];
    const retainUntil = (() => {
      const d = new Date(archiveDate); d.setFullYear(d.getFullYear() + 5);
      return d.toISOString().split('T')[0];
    })();
    await Users.update(id, {
      status: 'archived',
      archived_at: archiveDate,
      data_retain_until: retainUntil,
      data_anonymized: false,
    });
    cacheDel('users-list');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 解封帳號（恢復為 inactive，再由 staff 手動啟用）
app.put('/api/admin/users/:id/unarchive-user', requireRole('staff'), async (req, res) => {
  try {
    await Users.update(parseInt(req.params.id), {
      status: 'inactive',
      archived_at: null, data_retain_until: null,
    });
    cacheDel('users-list');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:id', requireRole('staff'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (id === req.session.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });

    // 刪 Drive 人員資料夾（身分證、存簿等）
    const user = await Users.byId(id);
    if (user) {
      const drive  = getDrive();
      const rootId = process.env.GOOGLE_DRIVE_FOLDER_ID;
      if (drive && rootId) {
        const escName = (user.real_name || '').replace(/'/g, "\\'");
        const folderIds = [];
        try {
          // 優先用上傳時記錄的資料夾 ID
          if (user.drive_folder_id) folderIds.push(user.drive_folder_id);
          // 後援：靠姓名查找（含舊資料；可能有同名多筆，全部刪）
          if (escName) {
            const staffDirRes = await drive.files.list({
              q: `name='人員資料' and '${rootId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
              fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true,
            });
            const staffDirId = staffDirRes.data.files[0]?.id;
            if (staffDirId) {
              const personRes = await drive.files.list({
                q: `name='${escName}' and '${staffDirId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
                fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true,
              });
              personRes.data.files.forEach(f => folderIds.push(f.id));
            }
          }
          const uniq = [...new Set(folderIds)];
          for (const fid of uniq) {
            try {
              await drive.files.delete({ fileId: fid, supportsAllDrives: true });
              console.log(`[Drive] 已刪除 ${user.real_name} 的人員資料夾 ${fid}`);
            } catch(de) { console.error(`[Drive] 刪除資料夾 ${fid} 失敗`, de.message); }
          }
          if (!uniq.length) console.warn(`[Drive] 找不到 ${user.real_name} 的人員資料夾，略過`);
        } catch(de) { console.error('[Drive] 刪除人員資料夾失敗', de.message); }
      }
    }

    await ForgotReqs.resolveByUser(id);
    await Users.delete(id);
    cacheDel('users-list');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/users/:id/reset-password', requireRole('staff'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await Users.update(id, { password_hash: bcrypt.hashSync('0000', 10), is_first_login: true });
    await ForgotReqs.resolveByUser(id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/forgot-requests', requireRole('staff'), async (req, res) => {
  try {
    const rows = await ForgotReqs.pending();
    const result = await Promise.all(rows.map(async r => {
      const user = await Users.byId(r.user_id);
      return { ...r, username: user ? user.username : '?', real_name: user ? user.real_name : '?' };
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 一次性：修復 admin 角色
app.get('/api/_setup/admin', async (req, res) => {
  const existing = await Users.byName('admin');
  if (!existing) {
    const user = await Users.create({
      username:'admin', real_name:'系統管理員', nickname:null,
      role:'staff', status:'active', is_first_login:false,
      password_hash: bcrypt.hashSync('1234', 10),
    });
    return res.json({ ok: true, msg: 'admin 已建立', role: user.role });
  }
  if (existing.role !== 'staff') {
    await Users.update(existing.id, { role: 'staff' });
    return res.json({ ok: true, msg: `admin role 已從 ${existing.role} 修正為 staff` });
  }
  res.json({ ok: true, msg: 'admin 已正確，role: staff', id: existing.id });
});

// ── 派案 API ──────────────────────────────────────────────────

// ── 公司管理 ──────────────────────────────────────────────────
const coCol = () => require('firebase-admin').firestore().collection('companies');

app.get('/api/companies', async (req, res) => {
  try {
    const snap = await coCol().orderBy('sort','asc').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch {
    const snap = await coCol().get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }
});
app.post('/api/companies', requireRole('supervisor'), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: '請輸入公司名稱' });
    const snap = await coCol().get();
    const ref = coCol().doc();
    await ref.set({ name: name.trim(), sort: snap.size });
    res.json({ ok: true, id: ref.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/companies/:id', requireRole('supervisor'), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: '請輸入公司名稱' });
    await coCol().doc(req.params.id).update({ name: name.trim() });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/companies/:id', requireRole('supervisor'), async (req, res) => {
  try {
    await coCol().doc(req.params.id).delete();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 任務類型管理 ──────────────────────────────────────────────
const ttCol = () => require('firebase-admin').firestore().collection('task_types');

app.get('/api/task-types', async (req, res) => {
  try {
    const snap = await ttCol().orderBy('sort','asc').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch { // fallback：若無資料或無 sort 欄位
    const snap = await ttCol().get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }
});

app.post('/api/task-types', requireRole('supervisor'), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: '請輸入任務名稱' });
    const snap = await ttCol().get();
    const ref = ttCol().doc();
    await ref.set({ name: name.trim(), sort: snap.size });
    res.json({ ok: true, id: ref.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/task-types/:id', requireRole('supervisor'), async (req, res) => {
  try {
    const { name, default_price } = req.body;
    const update = {};
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: '請輸入任務名稱' });
      update.name = name.trim();
    }
    if (default_price !== undefined) {
      update.default_price = (default_price === '' || default_price === null) ? null : parseInt(default_price);
    }
    await ttCol().doc(req.params.id).update(update);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/task-types/:id', requireRole('supervisor'), async (req, res) => {
  try {
    await ttCol().doc(req.params.id).delete();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 自訂欄位管理 ──────────────────────────────────────────────
const cfCol = () => require('firebase-admin').firestore().collection('custom_field_defs');

app.get('/api/custom-field-defs', async (req, res) => {
  try {
    const snap = await cfCol().orderBy('sort','asc').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch {
    const snap = await cfCol().get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }
});

app.post('/api/custom-field-defs', requireRole('supervisor'), async (req, res) => {
  try {
    const { label, type, options, task_name, scope } = req.body;
    if (!label || !label.trim()) return res.status(400).json({ error: '請輸入欄位名稱' });
    const validTypes = ['text','number','date','select'];
    const t = validTypes.includes(type) ? type : 'text';
    const validScopes = ['','assign','grab','hourly'];
    const sc = validScopes.includes(scope) ? scope : '';
    const snap = await cfCol().get();
    const ref = cfCol().doc();
    const data = { label: label.trim(), type: t, sort: snap.size, task_name: task_name || '', scope: sc };
    if (t === 'select') data.options = Array.isArray(options) ? options.map(o=>String(o).trim()).filter(Boolean) : [];
    await ref.set(data);
    res.json({ ok: true, id: ref.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/custom-field-defs/:id', requireRole('supervisor'), async (req, res) => {
  try {
    const { label, type, options, sort, task_name, scope } = req.body;
    const patch = {};
    if (label !== undefined) {
      if (!label.trim()) return res.status(400).json({ error: '請輸入欄位名稱' });
      patch.label = label.trim();
    }
    if (type !== undefined) {
      const validTypes = ['text','number','date','select'];
      patch.type = validTypes.includes(type) ? type : 'text';
    }
    if (options !== undefined) {
      patch.options = Array.isArray(options) ? options.map(o=>String(o).trim()).filter(Boolean) : [];
    }
    if (sort !== undefined) patch.sort = parseInt(sort) || 0;
    if (task_name !== undefined) patch.task_name = task_name || '';
    if (scope !== undefined) {
      const validScopes = ['','assign','grab','hourly'];
      patch.scope = validScopes.includes(scope) ? scope : '';
    }
    await cfCol().doc(req.params.id).update(patch);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/custom-field-defs/:id', requireRole('supervisor'), async (req, res) => {
  try {
    await cfCol().doc(req.params.id).delete();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 派案表單欄位排序 ────────────────────────────────────────
const DEFAULT_FIELD_ORDER = ['target','company','task','qty','price','total','deadline','notes'];

app.get('/api/field-order', async (req, res) => {
  try {
    const doc = await firestoreDb.collection('settings').doc('fieldOrder').get();
    const d = doc.exists ? doc.data() : {};
    // 新格式：各模式各一份 orders；舊格式：單一 order（前端會套到件模式）
    res.json({ orders: (d.orders && typeof d.orders === 'object') ? d.orders : null,
               order: Array.isArray(d.order) ? d.order : null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/field-order', requireRole('supervisor'), async (req, res) => {
  try {
    const { orders } = req.body;
    if (!orders || typeof orders !== 'object' || Array.isArray(orders))
      return res.status(400).json({ error: '欄位順序資料不正確' });
    await firestoreDb.collection('settings').doc('fieldOrder').set({ orders });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/assignments', requireRole('supervisor'), async (req, res) => {
  try {
    const { task_name, company, quantity, unit_price, notes, assign_type, target_partner_id, deadline_days, custom_fields, hourly_wage, work_content, work_date, attachments, dual_report } = req.body;
    const isHourly = assign_type === 'hourly';
    if (!task_name) return res.status(400).json({ error: '缺少必填欄位' });
    if (!isHourly && (!quantity || !unit_price)) return res.status(400).json({ error: '缺少必填欄位' });
    if (isHourly && (hourly_wage === undefined || parseInt(hourly_wage) < 0)) return res.status(400).json({ error: '請填寫時薪' });
    if (assign_type === 'individual' && !target_partner_id) return res.status(400).json({ error: '請選擇指派對象' });
    const assigned_at = nowTW();
    // 指派給特定夥伴時，沿用該夥伴的負責派案人員
    const indivTarget = (assign_type === 'individual' || isHourly) && target_partner_id;
    let supervisor_id = req.session.user.id;
    let supervisor_name = req.session.user.real_name;
    if (indivTarget) {
      const targetPartner = await Users.byId(parseInt(target_partner_id));
      if (targetPartner && targetPartner.supervisor_id && targetPartner.supervisor_id !== req.session.user.id) {
        const ownSupervisor = await Users.byId(targetPartner.supervisor_id);
        if (ownSupervisor) {
          supervisor_id = ownSupervisor.id;
          supervisor_name = ownSupervisor.real_name;
        }
      }
    }

    const taskAtts = await uploadTaskAttachments(attachments); // 派案附件上傳雲端
    let data;
    if (isHourly) {
      data = {
        task_name, company: company || '', notes: notes || '',
        assign_type: 'hourly',
        hourly_wage: parseInt(hourly_wage),
        work_content: work_content || '',
        quantity: null, unit_price: null, total_price: 0,
        work_start: null, work_end: null, work_minutes: null,
        work_date: work_date || null,
        attachments: taskAtts,
        dual_report: !!dual_report, report_stage: 0,
        target_partner_id: target_partner_id ? parseInt(target_partner_id) : null,
        assigned_at, supervisor_id, supervisor_name,
        status: 'pending', rejected_by: [], accepted_by: null, reject_reason: null,
        custom_fields: Array.isArray(custom_fields) ? custom_fields : [],
      };
    } else {
      const qty = parseInt(quantity), price = parseInt(unit_price);
      // 完成期限改為選填：未填或不限 → 無期限
      let ddays = null, deadline_date = null;
      if (parseInt(deadline_days) >= 1) {
        ddays = parseInt(deadline_days);
        const dlBase = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
        dlBase.setDate(dlBase.getDate() + ddays);
        const p = n => String(n).padStart(2,'0');
        deadline_date = `${dlBase.getFullYear()}/${p(dlBase.getMonth()+1)}/${p(dlBase.getDate())}`;
      }
      data = {
        task_name, company: company || '', quantity: qty, unit_price: price, total_price: qty * price,
        notes: notes || '', deadline_days: ddays, deadline_date, work_date: work_date || null, assigned_at,
        assign_type: assign_type || 'individual',
        attachments: taskAtts,
        dual_report: !!dual_report, report_stage: 0,
        target_partner_id: assign_type === 'individual' ? parseInt(target_partner_id) : null,
        supervisor_id, supervisor_name,
        status: 'pending', rejected_by: [], accepted_by: null, reject_reason: null,
        custom_fields: Array.isArray(custom_fields) ? custom_fields : [],
      };
    }
    const item = await Assignments.create(data);
    cacheClear('sup-'); // 新派任務 → 清派案人員儀表板快取
    await logTaskAction(req, data.assign_type === 'hourly' ? '派案(小時)' : '派案(件)', `${data.company ? data.company+'：' : ''}${data.task_name}${item.task_no ? ' #'+item.task_no : ''}`, { type: 'assignment', id: item.id });
    res.json({ ok: true, id: item.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 派案人員的夥伴清單（含統計）
app.get('/api/supervisor/partners', requireRole('supervisor'), async (req, res) => {
  try {
    const supId = req.session.user.id;
    const cacheKey = `sup-partners-${supId}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    const users = await Users.all();
    const partners = users.filter(u => u.role === 'partner' && u.supervisor_id === supId);
    // 只讀旗下夥伴的任務（不讀全表）
    const assignments = await Assignments.forPartners(partners.map(p => p.id));
    const curYM = nowTW().slice(0, 7); // YYYY/MM
    const result = partners.map(p => {
      const mine      = assignments.filter(a => a.accepted_by === p.id);
      const completed = mine.filter(a => a.status === 'completed');
      const active    = mine.filter(a => a.status === 'accepted' && a.review_status !== 'reviewing');
      const reviewing = mine.filter(a => a.review_status === 'reviewing');
      const total_income = completed.reduce((s, a) => s + (a.total_price || 0), 0);
      const month_income = completed.filter(a => (a.completed_at || '').slice(0,7) === curYM).reduce((s, a) => s + (a.total_price || 0), 0);
      const month_tasks  = completed.filter(a => (a.completed_at || '').slice(0,7) === curYM).length;
      const last_report  = completed.map(a => a.completed_at).filter(Boolean).sort().pop() || null;
      return {
        id: p.id, partner_no: p.partner_no || null, real_name: p.real_name,
        phone: p.phone || '', status: p.status, identity: p.identity || '',
        completed_count: completed.length, active_count: active.length, reviewing_count: reviewing.length,
        total_income, month_income, month_tasks, last_report,
      };
    }).sort((a, b) => (a.partner_no || 9999) - (b.partner_no || 9999));
    cacheSet(cacheKey, result, 45 * 1000); // 45 秒快取，降低重複刷新的讀取
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 派案人員預警公告 ──────────────────────────────────────────────
app.get('/api/supervisor/alerts', requireRole('supervisor'), async (req, res) => {
  try {
    const supId = req.session.user.id;
    const alertsCacheKey = `sup-alerts-${supId}`;
    const cachedAlerts = cacheGet(alertsCacheKey);
    if (cachedAlerts) return res.json(cachedAlerts);
    const todayStr = nowTW().split(' ')[0]; // YYYY/MM/DD
    const toDate = s => s ? new Date(s.replace(/\//g, '-').slice(0,10)) : null;
    const today = toDate(todayStr);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate()+1);

    const myAssignments = await Assignments.forSupervisor(supId);
    const allUsers = await Users.all();
    const userName = id => allUsers.find(u => u.id === id)?.real_name || '';

    // 1. 任務逾期 / 即將逾期（pending 或 accepted，尚未完成）
    const overdue = [], dueSoon = [];
    myAssignments.forEach(a => {
      if (!['pending','accepted'].includes(a.status) || !a.deadline_date) return;
      const d = toDate(a.deadline_date);
      if (d < today) overdue.push(a);
      else if (d.getTime() === today.getTime() || d.getTime() === tomorrow.getTime()) dueSoon.push(a);
    });

    // 2. 待審核 WorkLog
    const pendingWorklogs = await WorklogReports.pendingForSupervisor(supId);

    // 3. 被拒絕需重新指派
    const rejected = myAssignments.filter(a => a.status === 'rejected');

    // 4. 搶單名額未滿且即將/已截止
    const myGrabTasks = await GrabTasks.forSupervisor(supId);
    const grabUnfilled = myGrabTasks.filter(t => {
      if (t.status !== 'open') return false;
      if ((t.grabbed_count||0) >= t.total_slots) return false;
      if (!t.deadline) return false;
      const d = toDate(t.deadline);
      return d <= tomorrow;
    });

    // 5. 旗下夥伴久未登入（7天以上未登入或從未登入）
    const myPartners = allUsers.filter(u => u.role === 'partner' && u.status === 'active' && u.supervisor_id === supId);
    const sevenDaysAgo = new Date(today); sevenDaysAgo.setDate(sevenDaysAgo.getDate()-7);
    const inactivePartners = myPartners.filter(u => {
      const dates = u.login_dates || [];
      if (!dates.length) return true;
      const last = toDate(dates[dates.length-1]);
      return !last || last < sevenDaysAgo;
    });

    // 6. 新核准夥伴尚未設定派案人員
    const unassignedPartners = allUsers.filter(u => u.role === 'partner' && u.status === 'active' && !u.supervisor_id);

    // 7. 夥伴當月任務金額接近 19,000 警示
    const INCOME_WARN = 19000;
    const curYM = nowTW().slice(0, 7); // "YYYY/MM"
    // 只讀旗下夥伴的任務（不讀全表）
    const allAssign = await Assignments.forPartners(myPartners.map(p => p.id));
    const incomeWarning = myPartners.map(p => {
      const monthTasks = allAssign.filter(a =>
        a.accepted_by === p.id &&
        a.status !== 'rejected' &&
        ((a.created_at || '').startsWith(curYM) || (a.created_at || '').startsWith(curYM.replace(/\/0(\d)$/, '/$1')))
      );
      const total = monthTasks.reduce((s, a) => s + (Number(a.total_price) || 0), 0);
      if (total < INCOME_WARN) return null;
      return { id: p.id, real_name: p.real_name, amount: total, task_count: monthTasks.length };
    }).filter(Boolean);

    const payload = {
      overdue: overdue.map(a => ({ id: a.id, task_name: a.task_name, deadline_date: a.deadline_date, partner_name: userName(a.target_partner_id) })),
      due_soon: dueSoon.map(a => ({ id: a.id, task_name: a.task_name, deadline_date: a.deadline_date, partner_name: userName(a.target_partner_id) })),
      pending_worklogs: pendingWorklogs.map(r => ({ id: r.id, assignment_id: r.assignment_id })),
      rejected: rejected.map(a => ({ id: a.id, task_name: a.task_name, reject_reason: a.reject_reason })),
      grab_unfilled: grabUnfilled.map(t => ({ id: t.id, task_name: t.task_name, grabbed_count: t.grabbed_count||0, total_slots: t.total_slots, deadline: t.deadline })),
      inactive_partners: inactivePartners.map(u => ({ id: u.id, real_name: u.real_name, login_dates: u.login_dates||[] })),
      unassigned_partners: unassignedPartners.map(u => ({ id: u.id, real_name: u.real_name })),
      income_warning: incomeWarning,
    };
    cacheSet(alertsCacheKey, payload, 45 * 1000); // 45 秒快取
    res.json(payload);
  } catch(e) { console.error('[supervisor/alerts]', e); res.status(500).json({ error: e.message }); }
});

// 管理人員預警：全部夥伴當月金額達 19,000（跨所有派案人員）
app.get('/api/admin/alerts', requireRole('staff'), async (req, res) => {
  try {
    const cacheKey = 'sup-admin-alerts'; // 用 sup- 前綴：任務變動的 cacheClear('sup-') 會一併失效
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    const INCOME_WARN = 19000;
    const curYM = nowTW().slice(0, 7); // "YYYY/MM"
    const [allUsers, allAssign] = await Promise.all([Users.all(), Assignments.all()]);
    const supName = id => allUsers.find(u => u.id === id)?.real_name || '—';
    const partners = allUsers.filter(u => u.role === 'partner' && u.status === 'active');
    const incomeWarning = partners.map(p => {
      const monthTasks = allAssign.filter(a =>
        a.accepted_by === p.id &&
        a.status !== 'rejected' &&
        ((a.created_at || '').startsWith(curYM) || (a.created_at || '').startsWith(curYM.replace(/\/0(\d)$/, '/$1')))
      );
      const total = monthTasks.reduce((s, a) => s + (Number(a.total_price) || 0), 0);
      if (total < INCOME_WARN) return null;
      return { id: p.id, real_name: p.real_name, amount: total, task_count: monthTasks.length,
        supervisor_name: p.supervisor_id ? supName(p.supervisor_id) : '未指派' };
    }).filter(Boolean).sort((a, b) => b.amount - a.amount);
    const payload = { month: curYM, threshold: INCOME_WARN, income_warning: incomeWarning };
    cacheSet(cacheKey, payload, 45 * 1000);
    res.json(payload);
  } catch(e) { console.error('[admin/alerts]', e); res.status(500).json({ error: e.message }); }
});

app.get('/api/assignments/pending', requireRole('partner'), async (req, res) => {
  try {
    res.json(await Assignments.pendingForPartner(req.session.user.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/assignments/active', requireRole('partner'), async (req, res) => {
  try {
    res.json(await Assignments.activeForPartner(req.session.user.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/assignments/completed', requireRole('partner'), async (req, res) => {
  try {
    res.json(await Assignments.completedForPartner(req.session.user.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/assignments/:id/complete', requireRole('partner'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const a  = await Assignments.byId(id);
    if (!a || a.accepted_by !== req.session.user.id || a.status !== 'accepted')
      return res.status(400).json({ error: '無法完成此任務' });
    await Assignments.update(id, { status: 'completed', completed_at: nowTW() });
    cacheClear('sup-'); // 任務狀態變動 → 清派案人員儀表板快取
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/assignments/:id/accept', requireRole('partner'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const a  = await Assignments.byId(id);
    if (!a || a.status !== 'pending') return res.status(400).json({ error: '任務已不可接受' });
    await Assignments.update(id, { status: 'accepted', accepted_by: req.session.user.id, accepted_at: nowTW() });
    cacheClear('sup-');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/assignments/:id/reject', requireRole('partner'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = req.body;
    const a = await Assignments.byId(id);
    if (!a || a.status !== 'pending') return res.status(400).json({ error: '任務已不可操作' });
    if (a.assign_type === 'individual') {
      await Assignments.update(id, { status: 'rejected', reject_reason: reason || '' });
    } else {
      await Assignments.update(id, { rejected_by: [...(a.rejected_by||[]), req.session.user.id] });
    }
    cacheClear('sup-');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/assignments/history', requireRole('supervisor'), async (req, res) => {
  try {
    const list = await Assignments.forSupervisor(req.session.user.id);
    const enriched = await Promise.all(list.map(async a => {
      let partner_name = '全部夥伴';
      if (a.target_partner_id) {
        const u = await Users.byId(a.target_partner_id);
        partner_name = u ? u.real_name : '—';
      }
      return { ...a, partner_name };
    }));
    res.json(enriched);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// 系統設定
// ══════════════════════════════════════════════════════════════

// 取得合約內容（公開）
app.get('/api/system/contract', async (req, res) => {
  try {
    const doc = await firestoreDb.collection('system_config').doc('contract').get();
    res.json({ text: doc.exists ? (doc.data().text || '') : '' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 更新合約內容（is_admin only）
app.put('/api/system/contract', requireRole('staff'), async (req, res) => {
  const u = req.session.user;
  if (u.username !== 'admin' && !u.is_admin) return res.status(403).json({ error: '權限不足' });
  try {
    const { text } = req.body;
    await firestoreDb.collection('system_config').doc('contract').set(
      { text: text || '', updated_at: nowTW() }, { merge: true }
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// 問題回報系統
// ══════════════════════════════════════════════════════════════

// 建立問題回報
app.post('/api/issues', requireAuth, async (req, res) => {
  try {
    const { report_type, title, content, supervisor_id, supervisor_name, assignment_id, assignment_name } = req.body;
    const user = req.session.user;
    if (!title || !content) return res.status(400).json({ error: '請填寫標題與內容' });
    if (report_type === 'supervisor' && !supervisor_id)
      return res.status(400).json({ error: '請選擇派案人員' });
    if (!['supervisor','admin'].includes(report_type))
      return res.status(400).json({ error: '無效的回報類型' });
    const item = await Reports.create({
      report_type, title, content,
      reporter_id: user.id,
      reporter_name: user.real_name,
      reporter_role: user.role,
      supervisor_id: supervisor_id ? parseInt(supervisor_id) : null,
      supervisor_name: supervisor_name || null,
      assignment_id: assignment_id ? parseInt(assignment_id) : null,
      assignment_name: assignment_name || null,
      image_count: 0,
    });
    res.json({ ok: true, id: item.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 我送出的問題
app.get('/api/issues/mine', requireAuth, async (req, res) => {
  try {
    const list = await Reports.forReporter(req.session.user.id);
    res.json(list);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 未讀數量
app.get('/api/issues/unread', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    let from_handler = 0, from_reporter = 0;
    if (user.role === 'partner') {
      const mine = await Reports.forReporter(user.id);
      from_handler = mine.filter(r => r.unread_reporter).length;
    } else if (user.role === 'supervisor') {
      const inbox = await Reports.forSupervisor(user.id);
      from_reporter = inbox.filter(r => r.unread_handler).length;
      const mine = await Reports.forReporter(user.id);
      from_handler = mine.filter(r => r.unread_reporter && r.report_type === 'admin').length;
    } else if (user.role === 'staff') {
      const inbox = await Reports.forAdmin();
      from_reporter = inbox.filter(r => r.unread_handler).length;
    }
    res.json({ from_handler, from_reporter, total: from_handler + from_reporter });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 派案人員收到的問題
app.get('/api/issues/inbox/supervisor', requireRole('supervisor'), async (req, res) => {
  try {
    res.json(await Reports.forSupervisor(req.session.user.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 管理員收到的所有問題
app.get('/api/issues/inbox/admin', requireRole('staff'), async (req, res) => {
  try {
    res.json(await Reports.forAdmin());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 新增回覆
app.post('/api/issues/:id/reply', requireAuth, async (req, res) => {
  try {
    const reportId = parseInt(req.params.id);
    const { text } = req.body;
    const user = req.session.user;
    if (!text || !text.trim()) return res.status(400).json({ error: '回覆不能為空' });
    const report = await Reports.byId(reportId);
    if (!report) return res.status(404).json({ error: '問題不存在' });

    const isReporter = report.reporter_id === user.id;
    if (!isReporter) {
      if (report.report_type === 'supervisor' && (user.role !== 'supervisor' || report.supervisor_id !== user.id))
        return res.status(403).json({ error: '無權限' });
      if (report.report_type === 'admin' && user.role !== 'staff')
        return res.status(403).json({ error: '無權限' });
    }

    const reply = {
      id: Date.now(),
      author_id: user.id,
      author_name: user.real_name,
      author_role: user.role,
      text: text.trim(),
      created_at: nowTW(),
    };
    const replies = [...(report.replies || []), reply];
    await Reports.update(reportId, {
      replies,
      unread_reporter: !isReporter,
      unread_handler: isReporter,
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 更新狀態
app.put('/api/issues/:id/status', requireAuth, async (req, res) => {
  try {
    const reportId = parseInt(req.params.id);
    const { status } = req.body;
    const user = req.session.user;
    if (!['pending','processing','resolved'].includes(status))
      return res.status(400).json({ error: '無效狀態' });
    const report = await Reports.byId(reportId);
    if (!report) return res.status(404).json({ error: '不存在' });
    if (report.report_type === 'supervisor' && (user.role !== 'supervisor' || report.supervisor_id !== user.id))
      return res.status(403).json({ error: '無權限' });
    if (report.report_type === 'admin' && user.role !== 'staff')
      return res.status(403).json({ error: '無權限' });
    await Reports.update(reportId, { status });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 上傳圖片
app.post('/api/issues/:id/image', requireAuth, async (req, res) => {
  try {
    const reportId = parseInt(req.params.id);
    const { index, data, mime } = req.body;
    const idx = parseInt(index);
    if (idx < 0 || idx > 2) return res.status(400).json({ error: '最多3張' });
    await ReportImages.save(reportId, idx, data, mime || 'image/jpeg');
    await Reports.update(reportId, { image_count: idx + 1 });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 取得圖片
app.get('/api/issues/:id/image/:index', requireAuth, async (req, res) => {
  try {
    const img = await ReportImages.get(parseInt(req.params.id), parseInt(req.params.index));
    if (!img) return res.status(404).end();
    const b64 = img.data.replace(/^data:[^;]+;base64,/, '');
    res.setHeader('Content-Type', img.mime || 'image/jpeg');
    res.send(Buffer.from(b64, 'base64'));
  } catch(e) { res.status(500).end(); }
});

// 標記已讀
app.put('/api/issues/:id/read', requireAuth, async (req, res) => {
  try {
    const reportId = parseInt(req.params.id);
    const user = req.session.user;
    const report = await Reports.byId(reportId);
    if (!report) return res.status(404).json({ error: '不存在' });
    const isReporter = report.reporter_id === user.id;
    await Reports.update(reportId, isReporter ? { unread_reporter: false } : { unread_handler: false });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// 搶單系統
// ══════════════════════════════════════════════════════════════

// 派案人員建立搶單任務
app.post('/api/grab-tasks', requireRole('supervisor'), async (req, res) => {
  try {
    const { task_name, company, unit_price, total_slots, deadline, notes, deadline_days, custom_fields, slot_data, per_person_limit, pick_mode, qty_unlimited, work_date, attachments, dual_report } = req.body;
    if (!task_name || !unit_price)
      return res.status(400).json({ error: '缺少必填欄位' });
    // deadline（認領截止）可為 null＝永久開放
    const isPick = !!pick_mode;
    const qtyUnlimited = !!qty_unlimited && !isPick; // 挑選模式不可無限
    const slots = qtyUnlimited ? null : parseInt(total_slots);
    const price = parseInt(unit_price);
    const ddays = parseInt(deadline_days) || null;
    // 數量模式：每人上限＝累計上限，0＝不限；規則統一為「每次一個、完成可再接」
    const perLimit = (parseInt(per_person_limit) >= 0) ? parseInt(per_person_limit) : 1;
    if (!qtyUnlimited && (!slots || slots < 1)) return res.status(400).json({ error: '請填總名額或勾選不限' });
    const task_code = await 產生任務代號(LIMIT_CODE_COL); // 限量任務代號（6碼）

    // 挑選模式：補滿 slot_data 至 total_slots，並預先產生每張卡片的 代號-編號（未認領）
    let finalSlotData = Array.isArray(slot_data) ? slot_data.slice(0, slots || undefined) : [];
    if (isPick) {
      while (finalSlotData.length < slots) finalSlotData.push({ custom_fields: [] });
      const created = await 新增任務批次(
        task_code,
        finalSlotData.map(() => ({ 任務名稱: task_name })),
        { codeCollection: LIMIT_CODE_COL, itemCollection: LIMIT_ITEM_COL }
      );
      finalSlotData = finalSlotData.map((s, i) => ({
        title: s.title || '',
        custom_fields: Array.isArray(s.custom_fields) ? s.custom_fields : [],
        deadline_days: parseInt(s.deadline_days) || null,
        work_date: s.work_date || null,
        full_code: created[i]?.完整編號 || null,
        item_no: created[i]?.任務編號 || null,
        grab_no: created[i]?.任務編號 || null,
        claimed: false, claimed_by: null, claimed_by_name: null, claimed_at: null,
      }));
    }

    const item = await GrabTasks.create({
      task_name, company: company || '',
      unit_price: price, total_price_each: price,
      task_code,
      pick_mode: isPick,
      qty_unlimited: qtyUnlimited,
      total_slots: slots,
      deadline,
      deadline_days: ddays,
      work_date: work_date || null,
      attachments: await uploadTaskAttachments(attachments),
      dual_report: !!dual_report,
      notes: notes || '',
      supervisor_id: req.session.user.id,
      supervisor_name: req.session.user.real_name,
      custom_fields: Array.isArray(custom_fields) ? custom_fields : [],
      slot_data: finalSlotData,
      per_person_limit: perLimit,
    });
    cacheDel('grab-tasks-open');
    await logTaskAction(req, isPick ? '建立限量任務(挑選)' : '建立限量任務', `${company ? company+'：' : ''}${task_name} 名額${slots}`, { type: 'grab_task', id: item.id });
    await postTaskAnnouncement('🎯 新限量任務上架',
      `${company ? company+'：' : ''}${task_name}｜單價 $${price}｜名額 ${qtyUnlimited ? '不限' : slots}${deadline ? `｜認領截止 ${deadline}` : ''}\n歡迎前往「限量任務」查看認領！`);
    res.json({ ok: true, id: item.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 搶單任務列表（所有派案人員皆可見全部搶單）
app.get('/api/grab-tasks/supervisor', requireRole('supervisor'), async (req, res) => {
  try {
    res.json(await GrabTasks.all());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 管理員取得所有搶單任務
app.get('/api/grab-tasks/all', requireRole('staff'), async (req, res) => {
  try {
    res.json(await GrabTasks.all());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 管理員取得所有指派任務（依夥伴分組統計用）
app.get('/api/admin/assignments', requireRole('staff'), async (req, res) => {
  try {
    const [list, allUsers] = await Promise.all([Assignments.all(), Users.all()]);
    const userName = id => allUsers.find(u => u.id === id)?.real_name || null;
    const enriched = list.map(a => ({
      ...a,
      partner_name: a.accepted_by ? userName(a.accepted_by) : (a.target_partner_id ? userName(a.target_partner_id) : null),
    }));
    res.json(enriched);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 夥伴取得開放中的搶單任務
app.get('/api/grab-tasks', requireRole('partner'), async (req, res) => {
  try {
    const partnerId = req.session.user.id;
    const now = nowTW();
    let list = cacheGet('grab-tasks-open');
    if (!list) { list = await GrabTasks.openList(); cacheSet('grab-tasks-open', list, 60 * 1000); } // 快取 1 分鐘
    // 過濾截止的
    list = list.filter(t => !t.deadline || t.deadline >= now.slice(0,16)); // 無 deadline＝永久開放
    // 數量模式：每次只能接一個 → 判斷是否已有「同名+公司」進行中（未完成）
    const mineAll = await Assignments.forPartners([partnerId]);
    const activeKeys = new Set(mineAll
      .filter(a => a.assign_type === 'grab' && a.status === 'accepted')
      .map(a => `${a.task_name || ''} ${a.company || ''}`));
    // 各限量任務：該夥伴已完成筆數（依 grab_task_id）
    const myCompletedByTask = {};
    mineAll.filter(a => a.assign_type === 'grab' && a.status === 'completed' && a.grab_task_id != null)
      .forEach(a => { myCompletedByTask[a.grab_task_id] = (myCompletedByTask[a.grab_task_id] || 0) + 1; });
    // 附上該夥伴已搶的數量與編號
    const result = await Promise.all(list.map(async t => {
      let grabNos = [];
      if (!t.pick_mode) {
        const recSnap = await firestoreDb.collection('grab_tasks').doc(String(t.id))
          .collection('grabbed_by').where('partner_id','==',partnerId).get();
        grabNos = recSnap.docs.map(d => d.data().grab_no).sort();
      }
      // 已接數：挑選模式從卡片 claimed_by 計（挑選不寫 grabbed_by）；數量模式從 grabbed_by 計
      const my_grab_count = t.pick_mode
        ? (t.slot_data || []).filter(s => s.claimed && s.claimed_by === partnerId).length
        : grabNos.length;
      // 挑選模式不套用「每次一個」；數量模式套用
      const my_active = !t.pick_mode && activeKeys.has(`${t.task_name || ''} ${t.company || ''}`);
      const my_completed_count = myCompletedByTask[t.id] || 0;
      return { ...t, my_grab_no: grabNos[0] || null, my_grab_count, my_grab_nos: grabNos, my_active, my_completed_count };
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 取得某搶單任務的搶單紀錄
app.get('/api/grab-tasks/:id/records', requireRole('supervisor','staff'), async (req, res) => {
  try {
    const records = await GrabRecords.forTask(parseInt(req.params.id));
    // 附上對應任務的編號與狀態（完成/進行中）
    const enriched = await Promise.all(records.map(async r => {
      let task_no = null, status = r.status || 'active';
      if (r.assignment_id) { const a = await Assignments.byId(r.assignment_id); if (a) { task_no = a.task_no || null; status = a.status; } }
      return { ...r, task_no, status };
    }));
    res.json(enriched);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 派案人員關閉搶單（需附原因；記錄關閉人並自動發任務公告）
app.put('/api/grab-tasks/:id/close', requireRole('supervisor'), async (req, res) => {
  try {
    const reason = ((req.body && req.body.reason) || '').trim();
    if (!reason) return res.status(400).json({ error: '請選擇或填寫關閉原因' });
    const task = await GrabTasks.byId(parseInt(req.params.id));
    if (!task) return res.status(404).json({ error: '任務不存在' });
    // 搶單為共用任務池，任一派案人員皆可關閉
    await GrabTasks.update(parseInt(req.params.id), {
      status: 'closed',
      closed_by: req.session.user.real_name,
      closed_reason: reason,
      closed_at: nowTW(),
    });
    cacheDel('grab-tasks-open');
    await logTaskAction(req, '關閉搶單', `${task.company ? task.company+'：' : ''}${task.task_name}：${reason.slice(0,30)}`, { type: 'grab_task', id: task.id });
    await postTaskAnnouncement('🎯 限量任務已關閉',
      `${task.company ? task.company+'：' : ''}${task.task_name}｜由 ${req.session.user.real_name} 關閉\n原因：${reason}`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 調整限量任務每人上限（0=不限；發布後仍可調高/調低，立即生效）
app.put('/api/grab-tasks/:id/per-limit', requireRole('supervisor'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const n = parseInt(req.body.per_person_limit);
    if (!(n >= 0)) return res.status(400).json({ error: '請輸入 0（不限）或正整數' });
    const task = await GrabTasks.byId(id);
    if (!task) return res.status(404).json({ error: '任務不存在' });
    await GrabTasks.update(id, { per_person_limit: n });
    cacheDel('grab-tasks-open');
    await logTaskAction(req, '調整每人上限', `${task.company ? task.company+'：' : ''}${task.task_name} → ${n === 0 ? '不限' : n}`, { type: 'grab_task', id });
    await postTaskAnnouncement('🎯 限量任務名額調整',
      `${task.company ? task.company+'：' : ''}${task.task_name}｜每人可接上限調整為 ${n === 0 ? '不限' : n}\n還可以再接，歡迎前往「限量任務」查看！`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 夥伴搶單（Firestore Transaction 防超搶）
app.post('/api/grab-tasks/:id/grab', requireRole('partner'), async (req, res) => {
  const taskId    = parseInt(req.params.id);
  const partnerId = req.session.user.id;
  const partnerName = req.session.user.real_name;
  try {
    // 數量模式：每次只能接一個（同任務名+公司進行中唯一，完成後才能再接）
    const task0 = await GrabTasks.byId(taskId);
    if (task0) {
      const mine = await Assignments.forPartners([partnerId]);
      const dup = mine.find(a => a.assign_type === 'grab' && a.status === 'accepted'
        && (a.task_name || '') === (task0.task_name || '') && (a.company || '') === (task0.company || ''));
      if (dup) return res.status(400).json({ error: '此任務已有進行中的一筆，完成後才能再接' });
    }
    const taskRef    = firestoreDb.collection('grab_tasks').doc(String(taskId));
    const grabbedByCol = taskRef.collection('grabbed_by');
    const counterRef = firestoreDb.collection('_meta').doc('counters');

    const result = await firestoreDb.runTransaction(async t => {
      const [taskDoc, myGrabsSnap, counterDoc] = await Promise.all([
        t.get(taskRef), t.get(grabbedByCol.where('partner_id','==',partnerId)), t.get(counterRef)
      ]);
      if (!taskDoc.exists) throw new Error('搶單任務不存在');
      const task = taskDoc.data();
      if (task.status !== 'open') throw new Error('搶單已關閉');
      const nowStr = nowTW().slice(0,16); // YYYY/MM/DD HH:MM
      if (task.deadline && task.deadline <= nowStr) throw new Error('搶單時間已截止');
      if (!task.qty_unlimited && task.grabbed_count >= task.total_slots) throw new Error('名額已滿');
      const perLimit = task.per_person_limit ?? 1;
      if (perLimit > 0 && myGrabsSnap.size >= perLimit) throw new Error('您已達此搶單每人上限');

      const counters   = counterDoc.exists ? counterDoc.data() : {};
      const nextRecId  = (counters['grab_records'] || 0) + 1;
      const nextGrabNo = (counters[`grab_no_${taskId}`] || 0) + 1;
      const grabNoStr  = String(nextGrabNo).padStart(3, '0');
      const ts = nowTW();

      t.update(taskRef, { grabbed_count: task.grabbed_count + 1 });
      t.set(counterRef, { ...counters, grab_records: nextRecId, [`grab_no_${taskId}`]: nextGrabNo }, { merge: true });
      t.set(grabbedByCol.doc(), { partner_id: partnerId, grab_no: grabNoStr, grabbed_at: ts });
      t.set(firestoreDb.collection('grab_records').doc(String(nextRecId)), {
        id: nextRecId, grab_task_id: taskId,
        grab_no: grabNoStr, partner_id: partnerId, partner_name: partnerName,
        grabbed_at: ts, status: 'active', created_at: ts,
      });

      return { recId: nextRecId, grabNo: grabNoStr, task };
    });

    // 完成期限：卡片自己的 deadline_days 優先，否則用任務整體 deadline_days。
    // 未設定完成期限時 deadline_date 留 null（不可用「認領截止 deadline」頂替）。
    const slot = result.task.slot_data && result.task.slot_data[parseInt(result.grabNo)-1];
    let deadline_days = (slot && parseInt(slot.deadline_days) >= 1) ? parseInt(slot.deadline_days)
                      : (parseInt(result.task.deadline_days) >= 1 ? parseInt(result.task.deadline_days) : null);
    let deadline_date = null;
    if (deadline_days >= 1) {
      const dlBase = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      dlBase.setDate(dlBase.getDate() + deadline_days);
      const p = n => String(n).padStart(2,'0');
      deadline_date = `${dlBase.getFullYear()}/${p(dlBase.getMonth()+1)}/${p(dlBase.getDate())}`;
    }

    // 回報由「夥伴自己的派案人員」審核（非搶單發布者）
    let grabSupName = result.task.supervisor_name;
    if (req.session.user.supervisor_id) { const sv = await Users.byId(req.session.user.supervisor_id); if (sv) grabSupName = sv.real_name; }
    // 在限量任務代號下產生任務編號（完整編號 = 代號-編號）
    let grabFullCode = null, grabItemNo = null;
    if (result.task.task_code) {
      try {
        const ri = await 新增任務(result.task.task_code, { codeCollection: LIMIT_CODE_COL, itemCollection: LIMIT_ITEM_COL, extra: { 夥伴: partnerName, 任務名稱: result.task.task_name, 狀態: '進行中' } });
        grabFullCode = ri.完整編號; grabItemNo = ri.任務編號;
      } catch(e) { console.error('[limitTaskId]', e.message); }
    }
    // Transaction 外建立 assignment（自動接受）
    const assignment = await Assignments.create({
      task_name:       result.task.task_name,
      task_code:       result.task.task_code || null, full_code: grabFullCode, item_no: grabItemNo,
      company:         result.task.company || '',
      quantity:        1,
      unit_price:      result.task.unit_price,
      total_price:     result.task.unit_price,
      notes:           result.task.notes || '',
      deadline_days,
      deadline_date,
      assigned_at:     nowTW(),
      assign_type:     'grab',
      work_date:       (slot && slot.work_date) || result.task.work_date || null,
      attachments:     result.task.attachments || [],
      dual_report:     !!result.task.dual_report, report_stage: 0,
      target_partner_id: partnerId,
      accepted_by:     partnerId,
      accepted_at:     nowTW(),
      supervisor_id:   req.session.user.supervisor_id || result.task.supervisor_id,
      supervisor_name: grabSupName,
      grab_task_id:    taskId,
      grab_no:         result.grabNo,
      status:          'accepted',
      rejected_by: [], reject_reason: null,
      custom_fields:   (result.task.slot_data && result.task.slot_data[parseInt(result.grabNo)-1]?.custom_fields) || result.task.custom_fields || [],
    });
    // 更新 grab_record 存 assignment_id
    await firestoreDb.collection('grab_records').doc(String(result.recId)).update({ assignment_id: assignment.id });
    cacheDel('grab-tasks-open');
    cacheClear('sup-'); // 搶單成案 → 清派案人員儀表板快取

    res.json({ ok: true, grab_no: result.grabNo, assignment_id: assignment.id });
  } catch(e) {
    const userErr = ['搶單任務不存在','搶單已關閉','搶單時間已截止','名額已滿','您已達此搶單每人上限'];
    if (userErr.some(m => e.message.includes(m)))
      return res.status(400).json({ error: e.message });
    console.error('[grab]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 夥伴挑選指定卡片（挑選模式；確認時才結帳，樂觀鎖防衝突）
app.post('/api/grab-tasks/:id/pick', requireRole('partner'), async (req, res) => {
  const taskId    = parseInt(req.params.id);
  const idx       = parseInt(req.body.slot_index);
  const partnerId = req.session.user.id;
  const partnerName = req.session.user.real_name;
  try {
    if (!(idx >= 0)) return res.status(400).json({ error: '未選擇卡片' });
    const taskRef = firestoreDb.collection('grab_tasks').doc(String(taskId));
    const counterRef = firestoreDb.collection('_meta').doc('counters');
    const result = await firestoreDb.runTransaction(async t => {
      const [taskDoc, counterDoc] = await Promise.all([t.get(taskRef), t.get(counterRef)]);
      if (!taskDoc.exists) throw new Error('限量任務不存在');
      const task = taskDoc.data();
      if (!task.pick_mode) throw new Error('此任務非挑選模式');
      if (task.status !== 'open') throw new Error('限量任務已關閉');
      if (task.deadline && task.deadline <= nowTW().slice(0,16)) throw new Error('限量任務已截止');
      const slots = Array.isArray(task.slot_data) ? task.slot_data.map(s => ({ ...s })) : [];
      if (idx >= slots.length) throw new Error('卡片不存在');
      const slot = slots[idx];
      if (slot.claimed) throw new Error(`SLOT_TAKEN::${slot.claimed_by_name || '他人'}::${slot.full_code || ('#'+(idx+1))}`);
      const perLimit = task.per_person_limit ?? 1;
      if (perLimit > 0) {
        const mine = slots.filter(s => s.claimed && s.claimed_by === partnerId).length;
        if (mine >= perLimit) throw new Error('您已達此任務每人上限');
      }
      slot.claimed = true; slot.claimed_by = partnerId; slot.claimed_by_name = partnerName; slot.claimed_at = nowTW();
      const counters  = counterDoc.exists ? counterDoc.data() : {};
      const nextRecId = (counters['grab_records'] || 0) + 1;
      t.update(taskRef, { slot_data: slots, grabbed_count: (task.grabbed_count || 0) + 1 });
      t.set(counterRef, { ...counters, grab_records: nextRecId }, { merge: true });
      return { task, slot, recId: nextRecId };
    });

    const { task, slot, recId } = result;
    // 完成期限：卡片自己的 deadline_days 優先，否則用任務整體 deadline_days。
    // 未設定完成期限時 deadline_date 留 null（不可用「認領截止 deadline」頂替）。
    let deadline_days = (slot.deadline_days && parseInt(slot.deadline_days) >= 1) ? parseInt(slot.deadline_days)
                      : (parseInt(task.deadline_days) >= 1 ? parseInt(task.deadline_days) : null);
    let deadline_date = null;
    if (deadline_days >= 1) {
      const dlBase = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      dlBase.setDate(dlBase.getDate() + deadline_days);
      const p = n => String(n).padStart(2,'0');
      deadline_date = `${dlBase.getFullYear()}/${p(dlBase.getMonth()+1)}/${p(dlBase.getDate())}`;
    }
    // 回報由「夥伴自己的派案人員」審核（非發布者）
    let supName = task.supervisor_name;
    if (req.session.user.supervisor_id) { const sv = await Users.byId(req.session.user.supervisor_id); if (sv) supName = sv.real_name; }
    // 更新限量任務項目狀態（代號-編號）
    if (slot.full_code) {
      try { await firestoreDb.collection(LIMIT_ITEM_COL).doc(slot.full_code).update({ 狀態: '進行中', 夥伴: partnerName }); } catch(e) { console.error('[pickItem]', e.message); }
    }
    const assignment = await Assignments.create({
      task_name: task.task_name,
      task_code: task.task_code || null, full_code: slot.full_code || null, item_no: slot.item_no || null,
      company: task.company || '',
      quantity: 1, unit_price: task.unit_price, total_price: task.unit_price,
      notes: task.notes || '', deadline_days, deadline_date, work_date: slot.work_date || task.work_date || null,
      attachments: task.attachments || [],
      dual_report: !!task.dual_report, report_stage: 0,
      assigned_at: nowTW(), assign_type: 'grab',
      target_partner_id: partnerId, accepted_by: partnerId, accepted_at: nowTW(),
      supervisor_id: req.session.user.supervisor_id || task.supervisor_id, supervisor_name: supName,
      grab_task_id: taskId, grab_no: slot.grab_no || slot.item_no || null,
      status: 'accepted', rejected_by: [], reject_reason: null,
      custom_fields: Array.isArray(slot.custom_fields) && slot.custom_fields.length ? slot.custom_fields : (task.custom_fields || []),
    });
    await firestoreDb.collection('grab_records').doc(String(recId)).set({
      id: recId, grab_task_id: taskId,
      grab_no: slot.grab_no || slot.item_no || null, partner_id: partnerId, partner_name: partnerName,
      grabbed_at: nowTW(), status: 'active', created_at: nowTW(), assignment_id: assignment.id,
    });
    cacheDel('grab-tasks-open');
    cacheClear('sup-');
    await logTaskAction(req, '挑選限量任務', `${task.company ? task.company+'：' : ''}${task.task_name} ${slot.full_code || ''}`, { type: 'assignment', id: assignment.id });
    res.json({ ok: true, full_code: slot.full_code, assignment_id: assignment.id });
  } catch(e) {
    if (e.message.startsWith('SLOT_TAKEN::')) {
      const [, who, code] = e.message.split('::');
      return res.status(409).json({ error: 'taken', taken_by: who, code });
    }
    const userErr = ['限量任務不存在','此任務非挑選模式','限量任務已關閉','限量任務已截止','卡片不存在','您已達此任務每人上限','未選擇卡片'];
    if (userErr.some(m => e.message.includes(m))) return res.status(400).json({ error: e.message });
    console.error('[pick]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
// 自由任務系統（開放任務池；同名+同公司進行中不可重複接，完成後可再接）
// ══════════════════════════════════════════════════════════════

// 派案人員發布自由任務
app.post('/api/free-tasks', requireRole('supervisor'), async (req, res) => {
  try {
    const { task_name, company, unit_price, total_qty, qty_unlimited, publish_end, notes, deadline_days } = req.body;
    if (!task_name || !unit_price) return res.status(400).json({ error: '缺少必填欄位（任務名稱、金額）' });
    const unlimited = !!qty_unlimited;
    const qty = unlimited ? null : parseInt(total_qty);
    if (!unlimited && (!qty || qty < 1)) return res.status(400).json({ error: '請填總名額數量或勾選不限' });
    const task_code = await 產生任務代號(FREE_CODE_COL); // 自由任務代號（6碼）
    const item = await FreeTasks.create({
      task_name, company: company || '',
      unit_price: parseInt(unit_price),
      task_code,
      total_qty: qty, qty_unlimited: unlimited,
      publish_end: publish_end || null, // "YYYY/MM/DD" 或 null=永久
      deadline_days: parseInt(deadline_days) || null,
      notes: notes || '',
      supervisor_id: req.session.user.id,
      supervisor_name: req.session.user.real_name,
    });
    cacheDel('free-tasks-open');
    await logTaskAction(req, '發布自由任務', `${item.company ? item.company+'：' : ''}${item.task_name} ${unlimited ? '不限名額' : '名額'+qty}`, { type: 'free_task', id: item.id });
    res.json({ ok: true, id: item.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 自由任務列表（所有派案人員皆可見全部自由任務）
app.get('/api/free-tasks/supervisor', requireRole('supervisor'), async (req, res) => {
  try { res.json(await FreeTasks.all()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/free-tasks/all', requireRole('staff'), async (req, res) => {
  try { res.json(await FreeTasks.all()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// 派案人員設定「結束發布」日期
app.put('/api/free-tasks/:id/end', requireRole('supervisor'), async (req, res) => {
  try {
    const { publish_end } = req.body; // "YYYY/MM/DD"
    if (!publish_end) return res.status(400).json({ error: '請選擇結束日期' });
    const t = await FreeTasks.byId(parseInt(req.params.id));
    if (!t) return res.status(404).json({ error: '任務不存在' });
    // 自由任務為共用任務池，任一派案人員皆可調整
    await FreeTasks.update(t.id, { publish_end });
    cacheDel('free-tasks-open');
    await logTaskAction(req, '結束自由任務發布', `${t.company ? t.company+'：' : ''}${t.task_name}（至 ${publish_end} 止）`, { type: 'free_task', id: t.id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 夥伴取得開放中的自由任務（附 can_accept 判斷）
app.get('/api/free-tasks', requireRole('partner'), async (req, res) => {
  try {
    const partnerId = req.session.user.id;
    const today = nowTW().slice(0, 10); // YYYY/MM/DD
    let list = await FreeTasks.openList();
    list = list.filter(t => !t.publish_end || t.publish_end >= today); // 過濾已過發布期限
    // 夥伴目前進行中的自由任務（同名+同公司不可重複接）
    const mine = await Assignments.forPartners([partnerId]);
    const activeKeys = new Set(mine
      .filter(a => a.assign_type === 'free' && a.status === 'accepted')
      .map(a => `${a.task_name || ''} ${a.company || ''}`));
    const result = list.map(t => {
      const full = !t.qty_unlimited && (t.filled_count || 0) >= (t.total_qty || 0);
      const inProgress = activeKeys.has(`${t.task_name || ''} ${t.company || ''}`);
      return { ...t, full, in_progress: inProgress, can_accept: !full && !inProgress,
        remaining: t.qty_unlimited ? null : Math.max(0, (t.total_qty || 0) - (t.filled_count || 0)) };
    });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 夥伴接案
app.post('/api/free-tasks/:id/accept', requireRole('partner'), async (req, res) => {
  const taskId = parseInt(req.params.id);
  const partnerId = req.session.user.id;
  try {
    const task0 = await FreeTasks.byId(taskId);
    if (!task0) return res.status(404).json({ error: '自由任務不存在' });
    // 同名 + 同公司，進行中不可重複接
    const mine = await Assignments.forPartners([partnerId]);
    const dup = mine.find(a => a.assign_type === 'free' && a.status === 'accepted'
      && (a.task_name || '') === (task0.task_name || '') && (a.company || '') === (task0.company || ''));
    if (dup) return res.status(400).json({ error: '同任務名稱與公司已有進行中的任務，完成後才能再接' });
    // Transaction：檢查狀態/期限/名額 + filled_count++
    const taskRef = firestoreDb.collection('free_tasks').doc(String(taskId));
    const task = await firestoreDb.runTransaction(async t => {
      const doc = await t.get(taskRef);
      if (!doc.exists) throw new Error('自由任務不存在');
      const tk = doc.data();
      if (tk.status !== 'open') throw new Error('此自由任務已結束發布');
      const today = nowTW().slice(0, 10);
      if (tk.publish_end && tk.publish_end < today) throw new Error('此自由任務已過發布期限');
      if (!tk.qty_unlimited && (tk.filled_count || 0) >= (tk.total_qty || 0)) throw new Error('名額已滿');
      t.update(taskRef, { filled_count: (tk.filled_count || 0) + 1 });
      return tk;
    });
    // 完成期限
    let deadline_date = null;
    if (parseInt(task.deadline_days) >= 1) {
      const dlBase = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      dlBase.setDate(dlBase.getDate() + parseInt(task.deadline_days));
      const p = n => String(n).padStart(2, '0');
      deadline_date = `${dlBase.getFullYear()}/${p(dlBase.getMonth()+1)}/${p(dlBase.getDate())}`;
    }
    // 回報由「夥伴自己的派案人員」審核（非任務發布者）
    let supId = req.session.user.supervisor_id || task.supervisor_id;
    let supName = task.supervisor_name;
    if (req.session.user.supervisor_id) { const sv = await Users.byId(req.session.user.supervisor_id); if (sv) supName = sv.real_name; }
    // 在自由任務代號下產生任務編號（完整編號 = 代號-編號）
    let full_code = null, item_no = null;
    if (task.task_code) {
      try {
        const r = await 新增任務(task.task_code, { codeCollection: FREE_CODE_COL, itemCollection: FREE_ITEM_COL, extra: { 夥伴: req.session.user.real_name, 任務名稱: task.task_name, 狀態: '進行中' } });
        full_code = r.完整編號; item_no = r.任務編號;
      } catch(e) { console.error('[freeTaskId]', e.message); }
    }
    const assignment = await Assignments.create({
      task_name: task.task_name, company: task.company || '',
      quantity: 1, unit_price: task.unit_price, total_price: task.unit_price,
      notes: task.notes || '', deadline_days: parseInt(task.deadline_days) || null, deadline_date,
      assigned_at: nowTW(), assign_type: 'free',
      target_partner_id: partnerId, accepted_by: partnerId, accepted_at: nowTW(),
      supervisor_id: supId, supervisor_name: supName,
      free_task_id: taskId, task_code: task.task_code || null, full_code, item_no,
      status: 'accepted', rejected_by: [], reject_reason: null, custom_fields: [],
    });
    cacheDel('free-tasks-open');
    cacheClear('sup-');
    res.json({ ok: true, assignment_id: assignment.id });
  } catch(e) {
    const userErr = ['自由任務不存在','此自由任務已結束發布','此自由任務已過發布期限','名額已滿'];
    if (userErr.some(m => e.message.includes(m))) return res.status(400).json({ error: e.message });
    console.error('[free-accept]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 自由任務接案明細：誰接了、各幾筆、狀態
app.get('/api/free-tasks/:id/records', requireRole('supervisor','staff'), async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const [snap, allUsers] = await Promise.all([
      firestoreDb.collection('assignments').where('free_task_id', '==', taskId).get(),
      Users.all(),
    ]);
    const name = id => allUsers.find(u => u.id === id)?.real_name || ('夥伴#' + id);
    // 逐筆接案明細（含編號、接案時間、狀態），依接案時間新到舊
    const recs = snap.docs.map(d => ({ id: d.id, ...d.data() })).map(a => ({
      assignment_id: parseInt(a.id), partner_id: a.accepted_by, partner_name: name(a.accepted_by),
      task_no: a.task_no || null, full_code: a.full_code || null, item_no: a.item_no || null,
      unit_price: a.unit_price || 0, total_price: a.total_price || 0,
      accepted_at: a.accepted_at || null,
      completed_at: a.completed_at || null, status: a.status, review_status: a.review_status || null,
    })).sort((a, b) => (b.accepted_at || '').localeCompare(a.accepted_at || ''));
    res.json(recs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 夥伴取消自由任務（進行中、未送審才可取消）
app.put('/api/assignments/:id/cancel', requireRole('partner'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const a = await Assignments.byId(id);
    if (!a || a.accepted_by !== req.session.user.id) return res.status(403).json({ error: '無權限' });
    if (a.assign_type !== 'free') return res.status(400).json({ error: '只有自由任務可取消' });
    if (a.status !== 'accepted' || a.review_status === 'reviewing') return res.status(400).json({ error: '此任務目前無法取消' });
    // 釋放發布端名額
    if (a.free_task_id) {
      const ft = await FreeTasks.byId(a.free_task_id);
      if (ft) await FreeTasks.update(ft.id, { filled_count: Math.max(0, (ft.filled_count || 0) - 1) });
    }
    await firestoreDb.collection('assignments').doc(String(id)).delete();
    cacheClear('sup-');
    cacheDel('free-tasks-open');
    await logTaskAction(req, '取消自由任務', `${a.task_name}${a.task_no ? ' #'+a.task_no : ''}`, { type: 'assignment', id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 操作紀錄（稽核日誌）：派案人員/管理員對任務的所有動作
app.get('/api/task-logs', requireRole('supervisor','staff'), async (req, res) => {
  try {
    const snap = await firestoreDb.collection('task_logs').orderBy('created_at', 'desc').limit(300).get();
    res.json(snap.docs.map(d => d.data()));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 任務回報 ──────────────────────────────────────────────────
app.post('/api/reports', requireRole('partner'), async (req, res) => {
  try {
    const { assignment_id, url, notes, images, completed_qty, work_start, work_end, attachments } = req.body;
    if (!assignment_id) return res.status(400).json({ error: 'Missing assignment_id' });
    const a = await Assignments.byId(parseInt(assignment_id));
    if (!a || a.accepted_by !== req.session.user.id) return res.status(403).json({ error: 'Forbidden' });

    // 雙重回報：stage 1=第一階段(附件) / 2=第二階段(網址或圖片)；非雙重 stage=0
    const dual  = !!a.dual_report;
    const stage = dual ? ((a.report_stage || 0) === 0 ? 1 : 2) : 0;
    const isHourly = a.assign_type === 'hourly';
    let hourlyFields = {};       // 存到 report 的小時資訊
    let assignHourlyPatch = {};  // 同步回寫 assignment 的小時資訊

    if (dual && stage === 1) {
      // 第一階段：只要附件
      if (!Array.isArray(attachments) || !attachments.length) return res.status(400).json({ error: '第一階段回報請至少上傳一個附件' });
    } else {
      // 第二階段 或 非雙重：完整驗證
      if (isHourly) {
        if (!work_start || !work_end) return res.status(400).json({ error: '請填寫開始與完成時間' });
        const s = new Date(work_start), e = new Date(work_end);
        if (isNaN(s) || isNaN(e)) return res.status(400).json({ error: '時間格式不正確' });
        const minutes = Math.round((e - s) / 60000);
        if (minutes <= 0) return res.status(400).json({ error: '完成時間需晚於開始時間' });
        const wage = parseInt(a.hourly_wage) || 0;
        const total = Math.round(minutes / 60 * wage);
        const fmt = d => { const p = n => String(n).padStart(2,'0'); return `${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
        hourlyFields = { work_start: fmt(s), work_end: fmt(e), work_minutes: minutes, hourly_wage: wage, total_price: total };
        assignHourlyPatch = { work_start: fmt(s), work_end: fmt(e), work_minutes: minutes, total_price: total };
      } else if (dual && stage === 2) {
        if (!(url && url.trim()) && !(images && images.length)) return res.status(400).json({ error: '第二階段回報請提供網址或圖片' });
      }
    }

    const common = {
      assignment_id: parseInt(assignment_id),
      supervisor_id: a.supervisor_id || null,
      partner_id: req.session.user.id,
      partner_name: req.session.user.real_name,
      task_name: a.task_name,
      task_no: a.task_no || null,
      company: a.company || '',
      task_quantity: a.quantity,
      completed_qty: parseInt(completed_qty) || 0,
      assign_type: a.assign_type || 'individual',
      dual_report: dual, stage,
    };
    let reportData;
    if (dual && stage === 1) {
      const stageAtts = await uploadTaskAttachments(attachments); // 第一階段附件上傳雲端
      reportData = { ...common, stage_attachments: stageAtts, url: '', notes: notes || '', images: [], status: 'pending' };
    } else {
      reportData = { ...common, url: url || '', notes: notes || '', images: images || [], ...hourlyFields, status: 'pending' };
    }
    const report = await WorklogReports.create(reportData);
    // 標記 assignment 為審核中，避免重複送出；小時任務同步寫入時間與總金額
    // comments_resolved_at：回報即視為已處理先前的修改意見（「需要修改」卡片據此消除）
    await Assignments.update(parseInt(assignment_id), { review_status: 'reviewing', comments_resolved_at: nowTW(), ...assignHourlyPatch });
    cacheClear('sup-'); // 送出 WorkLog → 清派案人員儀表板快取
    res.json({ ok: true, id: report.id, stage });
  } catch(e) {
    const msg = e.message || '';
    if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('Quota')) {
      return res.status(503).json({ error: '系統繁忙，請稍後再試（Firestore 配額暫時耗盡）' });
    }
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/reports/supervisor', requireRole('supervisor'), async (req, res) => {
  try {
    const list = await WorklogReports.pendingForSupervisor(req.session.user.id);
    const enriched = await Promise.all(list.map(async r => {
      const a = await Assignments.byId(r.assignment_id);
      let partner_name = r.partner_name || '—';
      if (a && a.accepted_by) {
        const u = await Users.byId(a.accepted_by);
        partner_name = u ? u.real_name : partner_name;
      }
      return {
        ...r,
        partner_name,
        company:       a ? a.company        : '',
        accepted_at:   a ? a.accepted_at    : null,
        deadline_date: a ? a.deadline_date  : null,
        assigned_at:   a ? a.assigned_at    : null,
        assign_type:   a ? a.assign_type    : (r.assign_type || 'individual'),
        work_content:  a ? a.work_content   : '',
        hourly_wage:   a ? a.hourly_wage    : (r.hourly_wage || null),
        grab_no:       a ? a.grab_no        : (r.grab_no || null),
        total_price:   a ? a.total_price    : (r.total_price || 0),
        unit_price:    a ? a.unit_price     : 0,
        task_no:       a ? a.task_no        : (r.task_no || null),
        full_code:     a ? (a.full_code || null) : null,
        task_code:     a ? (a.task_code || null) : null,
        custom_fields: a ? (a.custom_fields || []) : [],
      };
    }));
    res.json(enriched);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reports/approved', requireRole('supervisor'), async (req, res) => {
  try {
    const list = await WorklogReports.approvedForSupervisor(req.session.user.id);
    const enriched = await Promise.all(list.map(async r => {
      const a = await Assignments.byId(r.assignment_id);
      let partner_name = '—';
      if (a && a.accepted_by) {
        const u = await Users.byId(a.accepted_by);
        partner_name = u ? u.real_name : '—';
      }
      return {
        ...r,
        task_name:     a ? a.task_name     : '—',
        company:       a ? a.company       : '',
        task_quantity: a ? a.task_quantity : null,
        partner_name,
        partner_id:    a ? a.accepted_by   : null,
        assigned_at:   a ? a.assigned_at   : null,
        accepted_at:   a ? a.accepted_at   : null,
        deadline_date: a ? a.deadline_date : null,
        completed_at:  a ? a.completed_at  : null,
        assign_type:   a ? a.assign_type   : (r.assign_type || 'individual'),
        work_content:  a ? a.work_content  : '',
        work_date:     a ? (a.work_date || null) : null,
        hourly_wage:   a ? a.hourly_wage   : (r.hourly_wage || null),
        grab_no:       a ? a.grab_no       : (r.grab_no || null),
        task_no:       a ? (a.task_no || null)   : (r.task_no || null),
        full_code:     a ? (a.full_code || null) : null,
        task_code:     a ? (a.task_code || null) : null,
        custom_fields: a ? (a.custom_fields || []) : [],
      };
    }));
    res.json(enriched);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/reports/:id/approve', requireRole('supervisor'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const extraReward = Math.max(0, parseInt(req.body && req.body.extra_reward) || 0); // 自由任務額外獎勵
    await WorklogReports.update(id, { status: 'approved' });
    // 取回 report 找到 assignment_id，把 assignment 改成 completed
    const snap = await require('./db').WorklogReports;
    const rSnap = await require('firebase-admin').firestore()
      .collection('worklog_reports').where('id','==',id).limit(1).get();
    if (!rSnap.empty) {
      const r   = rSnap.docs[0].data();
      const aPrev = await Assignments.byId(r.assignment_id);
      // 雙重回報第一階段核可：不完成，存派案人員回覆（補充說明＋附件）並解鎖第二階段
      if (r.dual_report && r.stage === 1) {
        const replyNote = (req.body && req.body.reply_note) || '';
        const replyAtts = await uploadTaskAttachments((req.body && req.body.reply_attachments) || []);
        await Assignments.update(r.assignment_id, {
          report_stage: 1, review_status: null,
          stage1_reply_note: replyNote,
          stage1_reply_attachments: replyAtts,
        });
        cacheClear('sup-');
        await logTaskAction(req, '核可第一階段回報', `回報 #${id}`, { type: 'report', id });
        return res.json({ ok: true, stage: 1 });
      }
      const patch = { status: 'completed', completed_at: nowTW(), review_status: 'approved' };
      // 自由任務：額外獎勵與任務金額加總 → 進錢包（total_price = 基本金額 + 額外，重算冪等）
      if (aPrev && aPrev.assign_type === 'free') {
        patch.extra_reward = extraReward;
        patch.total_price  = (aPrev.unit_price || 0) + extraReward;
      }
      await Assignments.update(r.assignment_id, patch);
      const a = await Assignments.byId(r.assignment_id);
      // XP 只發一次（退回再核可不重複計分）
      if (a && a.accepted_by && !(aPrev && aPrev.xp_granted)) {
        await grantTaskXP(a.accepted_by, a.task_name, a.company).catch(e => console.error('[grantTaskXP]', e.message));
        await Assignments.update(r.assignment_id, { xp_granted: true });
        // 自由任務：發布端完成數 +1，達名額上限自動結束發布
        if (a.assign_type === 'free' && a.free_task_id) {
          const ft = await FreeTasks.byId(a.free_task_id);
          if (ft) {
            const completed = (ft.completed_count || 0) + 1;
            const p2 = { completed_count: completed };
            if (!ft.qty_unlimited && ft.total_qty && completed >= ft.total_qty) p2.status = 'ended';
            await FreeTasks.update(ft.id, p2);
            cacheDel('free-tasks-open');
          }
        }
      }

      // 派案人員核可後，背景上傳附件圖片至雲端
      if (r.images && r.images.length) {
        const drive  = getDrive();
        const rootId = process.env.GOOGLE_DRIVE_FOLDER_ID;
        if (drive && rootId) {
          (async () => {
            try {
              const worklogDirId = await driveEnsureFolder(drive, '回報附件', rootId);
              // 資料夾分層：回報附件 / {年月 YYYY-MM} / {夥伴} /
              const _now = nowTW();
              const ym  = _now.slice(0, 7).replace(/\//g, '-'); // YYYY-MM
              const ymd = _now.slice(0, 10).replace(/\//g, ''); // YYYYMMDD
              const ymDirId      = await driveEnsureFolder(drive, ym, worklogDirId);
              const partnerDirId = await driveEnsureFolder(drive, r.partner_name || '未知', ymDirId);
              const { Readable } = require('stream');
              const driveIds = [];
              const cleanSeg = s => String(s == null ? '' : s).replace(/[\/\\:*?"<>|]/g, '').trim();
              for (let i = 0; i < r.images.length; i++) {
                const img  = r.images[i];
                const b64  = img.data ? img.data.replace(/^data:[^;]+;base64,/, '') : img;
                const mime = img.mime || 'image/jpeg';
                const ext  = mime.split('/')[1] || 'jpg';
                // 檔名：{公司}_{任務名}_{姓名}_{年月日}_{序}.副檔名（空欄位自動略過）
                const fname = [cleanSeg(a && a.company), cleanSeg((a && a.task_name) || r.task_name), cleanSeg(r.partner_name), ymd, i + 1]
                  .filter(x => x !== '' && x != null).join('_') + '.' + ext;
                const buf   = Buffer.from(b64, 'base64');
                const created = await drive.files.create({
                  requestBody: { name: fname, parents: [partnerDirId] },
                  media: { mimeType: mime, body: Readable.from(buf) },
                  fields: 'id',
                  supportsAllDrives: true,
                });
                driveIds.push({ drive_id: created.data.id, name: fname, mime });
              }
              await WorklogReports.update(id, { drive_attachments: driveIds });
              console.log(`[Drive] 回報 ${id} 核可後上傳 ${driveIds.length} 張附件完成`);
            } catch(de) { console.error('[Drive] 回報附件上傳失敗', de.message); }
          })();
        }
      }
    }
    cacheClear('sup-'); // 核可 WorkLog → 清派案人員儀表板快取
    await logTaskAction(req, '核可回報' + (extraReward ? `（額外獎勵 $${extraReward}）` : ''), `回報 #${id}`, { type: 'report', id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/reports/:id/reject', requireRole('supervisor'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: '請填寫退回原因' });
    const replyAtts = await uploadTaskAttachments((req.body && req.body.reply_attachments) || []);
    await WorklogReports.update(id, { status: 'rejected' });
    const rSnap = await require('firebase-admin').firestore()
      .collection('worklog_reports').where('id','==',id).limit(1).get();
    if (!rSnap.empty) {
      const r   = rSnap.docs[0].data();
      const a   = await Assignments.byId(r.assignment_id);
      const ts = nowTW(); // YYYY/MM/DD hh:mm:ss
      const [date, time] = ts.split(' ');
      const comments = [...(a.supervisor_comments || []), { date, time, text: reason, attachments: replyAtts }];
      // 退回後清除 review_status，讓夥伴可重新送出
      await Assignments.update(r.assignment_id, { supervisor_comments: comments, review_status: null });
    }
    cacheClear('sup-'); // 退回 WorkLog → 清派案人員儀表板快取
    await logTaskAction(req, '退回回報', `回報 #${id}：${(reason||'').slice(0,30)}`, { type: 'report', id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 已完成任務「重新退回」：target = 'partner'(退回夥伴重做) | 'review'(退回派案人員重新審核)
app.put('/api/reports/:id/rollback', requireRole('supervisor'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { target, reason } = req.body;
    if (!['partner','review'].includes(target)) return res.status(400).json({ error: '請選擇退回關卡' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: '請填寫退回原因' });
    const rSnap = await require('firebase-admin').firestore()
      .collection('worklog_reports').where('id','==',id).limit(1).get();
    if (rSnap.empty) return res.status(404).json({ error: '找不到回報' });
    const r = rSnap.docs[0].data();
    const a = await Assignments.byId(r.assignment_id);
    if (!a) return res.status(404).json({ error: '找不到任務' });
    const ts = nowTW();
    const [date, time] = ts.split(' ');
    const tag = target === 'partner' ? '【退回重做】' : '【退回重新審核】';
    const comments = [...(a.supervisor_comments || []), { date, time, text: tag + reason.trim() }];

    if (target === 'review') {
      // 回到派案人員待審核：報告 pending、任務回到 reviewing
      await WorklogReports.update(id, { status: 'pending' });
      await Assignments.update(r.assignment_id, {
        status: 'accepted', review_status: 'reviewing', completed_at: null, supervisor_comments: comments,
      });
    } else {
      // 回到工作夥伴重做：報告 rejected、任務回到進行中、清除審核狀態
      await WorklogReports.update(id, { status: 'rejected' });
      await Assignments.update(r.assignment_id, {
        status: 'accepted', review_status: null, completed_at: null, supervisor_comments: comments,
      });
    }
    cacheClear('sup-'); // 退回（重做/重審）→ 清派案人員儀表板快取
    await logTaskAction(req, target === 'review' ? '退回重新審核' : '退回夥伴重做', `回報 #${id}：${(reason||'').trim().slice(0,30)}`, { type: 'report', id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reports/:assignmentId', requireRole('partner','supervisor','staff'), async (req, res) => {
  try {
    const list = await WorklogReports.forAssignment(parseInt(req.params.assignmentId));
    res.json(list);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Staff 信箱設定（儲存到 user 記錄）
app.post('/api/staff/set-email', requireRole('staff'), async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email) return res.status(400).json({ error: '請填寫信箱' });
    // 系統設定頁面會帶 password 做驗證，薪資頁不需要
    if (password) {
      const user = await Users.byName(req.session.user.username);
      if (!user) return res.status(404).json({ error: '找不到用戶' });
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return res.status(401).json({ error: '密碼錯誤' });
    }
    await Users.update(req.session.user.id, { email });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 薪資管理：取得所有夥伴的已完成任務（staff 用）
app.get('/api/admin/payroll', requireRole('staff'), async (req, res) => {
  try {
    const { Assignments, Users } = require('./db');
    // 取得所有 partner
    const allUsers = await Users.all();
    const partners = allUsers.filter(u => u.role === 'partner' && u.status === 'active');
    // 取得所有已完成任務
    const snap = await require('firebase-admin').firestore()
      .collection('assignments').where('status', '==', 'completed').get();
    const allCompleted = snap.docs.map(d => d.data());
    // 組合每位夥伴資料
    const result = partners.map(p => ({
      id: p.id,
      real_name: p.real_name,
      username: p.username,
      records: allCompleted
        .filter(a => a.accepted_by === p.id)
        .sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''))
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 薪資 Excel 匯出：GET /api/admin/payroll/export?year_month=2026-06
app.get('/api/admin/payroll/export', requireRole('staff'), async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const { year_month } = req.query;
    const [fy, fm] = (year_month || '').split('-');
    const monthLabel = fy && fm ? `${fy}年${parseInt(fm)}月` : '全部';
    const fileLabel  = fy && fm ? `薪資總表_${fy}年_${parseInt(fm)}月` : '薪資總表_全部';

    const allUsers = await Users.all();
    const partners = allUsers.filter(u => u.role === 'partner' && u.status === 'active');

    const snap = await require('firebase-admin').firestore()
      .collection('assignments').where('status', '==', 'completed').get();
    const allCompleted = snap.docs.map(d => d.data());

    const wb = new ExcelJS.Workbook();
    wb.creator = '希絆雲作所';

    // 總覽分頁
    const summary = wb.addWorksheet('總覽');
    summary.columns = [
      { header: '夥伴姓名', key: 'name',     width: 16 },
      { header: '帳號',     key: 'username', width: 16 },
      { header: '筆數',     key: 'count',    width: 10 },
      { header: '總收入',   key: 'total',    width: 14 },
    ];
    summary.getRow(1).font = { bold: true, size: 14, color:{ argb:'FFFFFFFF' } };
    summary.getRow(1).fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFD9D9D9' } };
    summary.getRow(1).height = 22;

    for (const p of partners) {
      let records = allCompleted.filter(a => a.accepted_by === p.id);
      if (fy && fm) records = records.filter(a => (a.completed_at||'').startsWith(`${fy}/${fm}`));
      if (!records.length) continue;
      records.sort((a,b) => (a.completed_at||'').localeCompare(b.completed_at||''));
      const total = records.reduce((s,a) => s+(a.total_price||0), 0);
      const sRow = summary.addRow({ name: p.real_name, username: p.username, count: records.length, total });
      sRow.font = { size: 14 };

      // 個人分頁
      const ws = wb.addWorksheet(p.real_name);
      ws.columns = [
        { header: '編號',     key: 'no',       width: 8  },
        { header: '完成時間', key: 'completed', width: 24 },
        { header: '公司',     key: 'company',   width: 20 },
        { header: '任務名稱', key: 'task',      width: 20 },
        { header: '數量',     key: 'qty',       width: 10 },
        { header: '單價',     key: 'unit',      width: 12 },
        { header: '總價',     key: 'total',     width: 12 },
        { header: '派案人員名稱', key: 'sv',        width: 14 },
      ];
      ws.getRow(1).font = { bold: true, size: 14, color:{ argb:'FFFFFFFF' } };
      ws.getRow(1).fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFD9D9D9' } };
      ws.getRow(1).height = 22;
      records.forEach((a, i) => {
        const row = ws.addRow({
          no: i+1,
          completed: a.completed_at || '',
          company:   a.company || '',
          task:      a.task_name || '',
          qty:       a.quantity  || 0,
          unit:      a.unit_price  || 0,
          total:     a.total_price || 0,
          sv:        a.supervisor_name || '',
        });
        row.font = { size: 14 };
        if (i % 2 === 1) row.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF5F7FA' } };
      });
      // 合計列
      const totRow = ws.addRow({ no: '', completed: '', company: '', task: '合計', qty: '', unit: '', total, sv: '' });
      totRow.font = { bold: true, size: 14 };
      totRow.getCell('total').fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFFFF8E8' } };
      applyReportGrid(ws);
    }
    applyReportGrid(summary);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="salary.xlsx"; filename*=UTF-8''${encodeURIComponent(fileLabel)}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 工作紀錄彙整 Excel 匯出：GET /api/admin/work-records/export?year_month=2026-06
app.get('/api/admin/work-records/export', requireRole('staff'), async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const { year_month, partner_id } = req.query; // 可選 YYYY-MM、夥伴 id
    const [fy, fm] = (year_month || '').split('-');

    const [allUsers, allAssign] = await Promise.all([Users.all(), Assignments.all()]);
    const uById = id => allUsers.find(u => String(u.id) === String(id));

    const monPart  = (fy && fm) ? `_${fy}年${parseInt(fm)}月` : '';
    const onePartner = partner_id ? uById(partner_id) : null;
    const personPart = onePartner ? `_${onePartner.real_name}` : '';
    const fileLabel = `工作紀錄彙整${personPart}${monPart}`;
    const statusLabel = { pending:'待回覆', accepted:'進行中', completed:'已完成', rejected:'已退回' };
    const weekCh = '日一二三四五六';

    // 取每筆任務的參考開始時間（小時用 work_start，其餘用完成/接案/派案時間）
    const refOf = a => (a.work_start || a.completed_at || a.accepted_at || a.assigned_at || '').trim();

    let rows = allAssign
      .map(a => ({ a, pid: a.accepted_by || a.target_partner_id }))
      .filter(x => x.pid && uById(x.pid)) // 需有「存在的」對應夥伴（排除已刪除夥伴的孤兒任務）
      .filter(x => refOf(x.a)); // 需有日期
    if (partner_id) rows = rows.filter(x => String(x.pid) === String(partner_id));
    if (fy && fm) rows = rows.filter(x => refOf(x.a).slice(0,7) === `${fy}/${fm}`);
    // 依夥伴編號、日期排序
    rows.sort((x, y) => {
      const nx = uById(x.pid)?.partner_no || 9999, ny = uById(y.pid)?.partner_no || 9999;
      if (nx !== ny) return nx - ny;
      return refOf(x.a).localeCompare(refOf(y.a));
    });

    const wb = new ExcelJS.Workbook();
    wb.creator = '希絆雲作所';
    const ws = wb.addWorksheet('工作紀錄彙整');
    ws.views = [{ zoomScale: 130 }]; // 開啟時放大顯示
    ws.columns = [
      { header: '編號', key: 'pno',   width: 12 },
      { header: '姓名', key: 'pname', width: 16 },
      { header: '月份',         key: 'mon',   width: 10 },
      { header: '日期',         key: 'date',  width: 16 },
      { header: '星期',         key: 'week',  width: 10 },
      { header: '時間',         key: 'time',  width: 16 },
      { header: '單位別',       key: 'unit',  width: 20 },
      { header: '工作內容',     key: 'task',  width: 26 },
      { header: '時數/件',      key: 'hours', width: 12 },
      { header: '時薪/單價',    key: 'wage',  width: 12 },
      { header: '小計',         key: 'sub',   width: 14 },
      { header: '工作進度',     key: 'prog',  width: 12 },
      { header: '備註',         key: 'note',  width: 28 },
    ];
    ws.getRow(1).font = { bold: true, size: 16, color:{ argb:'FFFFFFFF' } };
    ws.getRow(1).fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFD9D9D9' } };
    ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
    ws.getRow(1).height = 30;

    rows.forEach((x, i) => {
      const a = x.a, u = uById(x.pid) || {};
      const ref = refOf(a);
      const [yy, mm, dd] = ref.slice(0,10).split('/').map(Number);
      const dow = (yy && mm && dd) ? new Date(yy, mm-1, dd).getDay() : null;
      const isHourly = a.assign_type === 'hourly';
      const timeStr = (isHourly && a.work_start && a.work_end) ? `${a.work_start.slice(11,16)}-${a.work_end.slice(11,16)}` : '';
      const hours = isHourly ? Math.round((a.work_minutes || 0) / 60 * 100) / 100 : (a.quantity || 0);
      const wage  = isHourly ? (a.hourly_wage || 0) : (a.unit_price || 0);
      const r = ws.addRow({
        pno:   u.partner_no ? 'P' + String(u.partner_no).padStart(3,'0') : '',
        pname: u.real_name || '',
        mon:   mm || '',
        date:  ref.slice(0,10),
        week:  dow != null ? '週' + weekCh[dow] : '',
        time:  timeStr,
        unit:  a.company || '',
        task:  a.task_name || '',
        hours: hours,
        wage:  wage,
        sub:   0,
        prog:  (a.review_status === 'reviewing') ? '待審核' : (statusLabel[a.status] || a.status || ''),
        note:  a.notes || '',
      });
      // 小計 = 時數 × 時薪（Excel 公式，I=時數 J=時薪 K=小計；附快取結果確保各種開啟方式都顯示）
      const rn = r.number;
      ws.getCell(`K${rn}`).value = { formula: `I${rn}*J${rn}`, result: Math.round((hours || 0) * (wage || 0) * 100) / 100 };
      r.font = { size: 14 };
      r.height = 24;
      r.alignment = { vertical: 'middle' };
      if (i % 2 === 1) r.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF5F7FA' } };
    });
    applyReportGrid(ws);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="work-records.xlsx"; filename*=UTF-8''${encodeURIComponent(fileLabel)}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 派案人員任務報表 Excel：GET /api/reports/supervisor-summary/export?year_month=2026/06&type=all
// 列出該派案人員發送/負責的項目，分「完成 / 未完成 / 未接」，完成的附回報縮圖
app.get('/api/reports/supervisor-summary/export', requireRole('supervisor'), async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const supervisorId = req.session.user.id;
    const supName = req.session.user.real_name || '';
    const ym = (req.query.year_month || '').replace(/-/g, '/').slice(0, 7); // YYYY/MM 或 ''
    const type = req.query.type || 'all'; // all/individual/hourly/grab

    const [allAssign, approvedReports, grabTasks, allUsers] = await Promise.all([
      Assignments.all(), WorklogReports.approvedForSupervisor(supervisorId),
      GrabTasks.forSupervisor(supervisorId), Users.all(),
    ]);
    const nameOf = id => (allUsers.find(u => u.id === id) || {}).real_name || '';
    const imgByAsg = new Map();
    approvedReports.forEach(r => { if (r.images && r.images.length) imgByAsg.set(parseInt(r.assignment_id), r.images); });

    const typeMatch = a => type === 'all' ? true
      : type === 'individual' ? (a.assign_type === 'individual' || a.assign_type === 'all')
      : type === 'grab' ? a.assign_type === 'grab'
      : a.assign_type === type;
    const repDate = a => ((a.completed_at || a.deadline_date || a.accepted_at || a.assigned_at || '') + '').replace(/-/g, '/');
    const inMonth = a => !ym || repDate(a).slice(0, 7) === ym;

    const asg = allAssign.filter(a => a.supervisor_id === supervisorId).filter(typeMatch).filter(inMonth);
    const completed  = asg.filter(a => a.status === 'completed');
    const inProgress = asg.filter(a => a.status === 'accepted');
    const pending    = asg.filter(a => a.status === 'pending');
    let grabUnclaimed = [];
    if (type === 'all' || type === 'grab') {
      grabUnclaimed = grabTasks
        .filter(t => !ym || ((t.created_at || '') + '').replace(/-/g, '/').slice(0, 7) === ym)
        .map(t => ({ t, remain: t.qty_unlimited ? '不限' : ((t.total_slots || 0) - (t.grabbed_count || 0)) }))
        .filter(x => x.remain === '不限' || x.remain > 0);
    }

    const wb = new ExcelJS.Workbook(); wb.creator = '希絆雲作所';
    const ymLabel = ym ? '（' + ym.replace('/', '年') + '月）' : '（全部）';
    const codeOf = a => a.full_code || (a.task_no ? ('#' + a.task_no) : '');
    const taskKey = a => (a.task_code || a.task_name || '') + '|' + String(a.item_no || a.task_no || '').padStart(4, '0');
    const grouped = arr => arr.slice().sort((x, y) => taskKey(x).localeCompare(taskKey(y))); // 同任務排在一起

    // 建一個分頁（標題＋表頭），回傳 ws
    function makeSheet(tabName, headColor, cols) {
      const ws = wb.addWorksheet(tabName);
      ws.columns = cols.map(c => ({ key: c.key, width: c.width }));
      ws.getCell('A1').value = `${tabName} — ${supName}${ymLabel}`;
      ws.mergeCells(1, 1, 1, cols.length);
      ws.getCell('A1').font = { bold: true, size: 15 };
      ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
      ws.getRow(1).height = 26;
      const hdr = ws.getRow(2);
      cols.forEach((c, i) => hdr.getCell(i + 1).value = c.label);
      hdr.font = { bold: true }; hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headColor } };
      hdr.alignment = { horizontal: 'center', vertical: 'middle' };
      return ws;
    }

    // 頁簽1：完成（附回報縮圖）
    const wsDone = makeSheet('完成', 'FFCBE7D3', [
      { key: 'tcode', label: '任務代號', width: 11 }, { key: 'code', label: '代號-編號', width: 14 }, { key: 'task', label: '任務', width: 22 },
      { key: 'co', label: '公司', width: 15 }, { key: 'who', label: '夥伴', width: 12 }, { key: 'amt', label: '金額', width: 10 },
      { key: 'date', label: '完成日期', width: 13 }, { key: 'img', label: '圖片', width: 16 },
    ]);
    grouped(completed).forEach(a => {
      const r = wsDone.addRow({ tcode: a.task_code || '', code: codeOf(a), task: a.task_name || '', co: a.company || '', who: nameOf(a.accepted_by) || '', amt: a.total_price || 0, date: (a.completed_at || '').slice(0, 10), img: '' });
      r.alignment = { vertical: 'middle' };
      const imgs = imgByAsg.get(parseInt(a.id));
      if (imgs && imgs.length) {
        const img = imgs[0];
        const b64 = img.data ? img.data.replace(/^data:[^;]+;base64,/, '') : img;
        let ext = ((img.mime || 'image/jpeg').split('/')[1] || 'jpeg').toLowerCase(); if (ext === 'jpg') ext = 'jpeg';
        if (['jpeg', 'png', 'gif'].includes(ext)) {
          try { const id = wb.addImage({ buffer: Buffer.from(b64, 'base64'), extension: ext }); r.height = 62; wsDone.addImage(id, { tl: { col: 7.1, row: r.number - 1 + 0.1 }, ext: { width: 78, height: 78 } }); } catch(e) {}
        }
      }
    });
    if (!completed.length) wsDone.addRow({ tcode: '（本期無完成項目）' });
    applyReportGrid(wsDone);

    // 頁簽2：未完成（進行中）
    const wsProg = makeSheet('未完成', 'FFFBE7C6', [
      { key: 'tcode', label: '任務代號', width: 11 }, { key: 'code', label: '代號-編號', width: 14 }, { key: 'task', label: '任務', width: 22 },
      { key: 'co', label: '公司', width: 15 }, { key: 'who', label: '夥伴', width: 12 }, { key: 'amt', label: '金額', width: 10 },
      { key: 'date', label: '接案日期', width: 13 },
    ]);
    grouped(inProgress).forEach(a => {
      wsProg.addRow({ tcode: a.task_code || '', code: codeOf(a), task: a.task_name || '', co: a.company || '', who: nameOf(a.accepted_by) || '', amt: a.total_price || 0, date: (a.accepted_at || a.assigned_at || '').slice(0, 10) }).alignment = { vertical: 'middle' };
    });
    if (!inProgress.length) wsProg.addRow({ tcode: '（本期無進行中項目）' });
    applyReportGrid(wsProg);

    // 頁簽3：未接（個人派案未接受 ＋ 限量任務剩餘名額）
    const wsTodo = makeSheet('未接', 'FFF6CFCF', [
      { key: 'tcode', label: '任務代號', width: 11 }, { key: 'task', label: '任務', width: 22 }, { key: 'co', label: '公司', width: 15 },
      { key: 'who', label: '指派對象／剩餘', width: 16 }, { key: 'amt', label: '金額', width: 10 }, { key: 'date', label: '派案／建立日', width: 13 },
    ]);
    grouped(pending).forEach(a => {
      wsTodo.addRow({ tcode: a.task_code || '', task: a.task_name || '', co: a.company || '', who: nameOf(a.target_partner_id) || '未指定', amt: a.total_price || 0, date: (a.assigned_at || '').slice(0, 10) }).alignment = { vertical: 'middle' };
    });
    grabUnclaimed.forEach(x => {
      wsTodo.addRow({ tcode: x.t.task_code || '', task: x.t.task_name || '', co: x.t.company || '', who: '剩 ' + x.remain + ' 名額', amt: x.t.unit_price || 0, date: (x.t.created_at || '').slice(0, 10) }).alignment = { vertical: 'middle' };
    });
    if (!pending.length && !grabUnclaimed.length) wsTodo.addRow({ tcode: '（本期無未接項目）' });
    applyReportGrid(wsTodo);

    const fileLabel = `派案人員任務報表_${supName}${ym ? '_' + ym.replace('/', '') : ''}`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="supervisor-report.xlsx"; filename*=UTF-8''${encodeURIComponent(fileLabel)}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch(e) { console.error('[sup-report]', e.message); res.status(500).json({ error: e.message }); }
});

// 報稅格式_暨名冊總表 Excel 匯出：GET /api/admin/tax-report/export?year=2026
app.get('/api/admin/tax-report/export', requireRole('staff'), async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const year = String(req.query.year || new Date().getFullYear());
    const fileLabel = `報稅格式_暨名冊總表_${year}年`;

    const [allUsers, allAssign] = await Promise.all([Users.all(), Assignments.all()]);
    const partners = allUsers.filter(u => u.role === 'partner' && u.status === 'active')
      .sort((a, b) => (a.partner_no || 9999) - (b.partner_no || 9999));
    const completed = allAssign.filter(a => a.status === 'completed');

    // 匯款資料：郵局→(700)局號+帳號；銀行→(銀行代號)帳號（代號取獨立欄位，無則從名稱括號擷取）
    const bankInfo = u => {
      if (u.bank_type === 'post') return `(700)${u.bank_account || ''}`;
      let code = u.bank_code || '';
      if (!code) { const m = (u.bank_name || '').match(/[（(]\s*(\d{3,4})\s*[）)]/); if (m) code = m[1]; }
      return code ? `(${code})${u.bank_account || ''}` : `${u.bank_name || ''} ${u.bank_account || ''}`.trim();
    };

    const wb = new ExcelJS.Workbook();
    wb.creator = '希絆雲作所';
    const ws = wb.addWorksheet('報稅格式_暨名冊總表');
    ws.views = [{ zoomScale: 120 }];
    const monthNames = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
    ws.columns = [
      { header: '編號',     key: 'no',    width: 8  },
      { header: '分類',     key: 'cat',   width: 12 },
      { header: '姓名',     key: 'name',  width: 14 },
      { header: '匯款資料', key: 'bank',  width: 28 },
      { header: '身分證字號', key: 'idno', width: 16 },
      { header: '戶籍地址', key: 'addr',  width: 30 },
      { header: '通訊地址', key: 'maddr', width: 30 },
      { header: '電話',     key: 'phone', width: 14 },
      ...monthNames.map(m => ({ header: m, key: m, width: 11 })),
      { header: '合計',     key: 'total', width: 14 },
    ];
    ws.getRow(1).font = { bold: true, size: 14, color:{ argb:'FFFFFFFF' } };
    ws.getRow(1).fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFD9D9D9' } };
    ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
    ws.getRow(1).height = 28;

    partners.forEach((p, idx) => {
      const months = Array(12).fill(0);
      completed.filter(a => a.accepted_by === p.id && (a.completed_at || '').slice(0,4) === year)
        .forEach(a => {
          const m = parseInt((a.completed_at || '').slice(5,7));
          if (m >= 1 && m <= 12) months[m-1] += (a.total_price || 0);
        });
      const total = months.reduce((s, x) => s + x, 0);
      const data = {
        no:    idx + 1,
        cat:   p.identity || '一般',
        name:  p.real_name || '',
        bank:  bankInfo(p),
        idno:  p.id_number || '',
        addr:  p.address || '',
        maddr: (!p.mailing_address || p.mailing_address === p.address) ? '同戶籍地址' : p.mailing_address,
        phone: p.phone || '',
        total: 0,
      };
      monthNames.forEach((m, i) => { data[m] = months[i]; });
      const r = ws.addRow(data);
      // 合計 = SUM(一月:十二月)（I 至 T 欄）；附快取結果
      const rn = r.number;
      ws.getCell(`U${rn}`).value = { formula: `SUM(I${rn}:T${rn})`, result: total };
      r.font = { size: 13 };
      r.height = 22;
      if (idx % 2 === 1) r.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF5F7FA' } };
    });
    applyReportGrid(ws);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="tax-report.xlsx"; filename*=UTF-8''${encodeURIComponent(fileLabel)}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 每月薪資計算總表：GET /api/admin/salary-summary/export?year=YYYY[&month=MM]
//  - 帶 month → 單月一張分頁；不帶 → 整年 12 個月各一張分頁
app.get('/api/admin/salary-summary/export', requireRole('staff'), async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const year = String(req.query.year || new Date().getFullYear());
    const singleMonth = req.query.month ? parseInt(req.query.month, 10) : null;

    const [allUsers, allAssign] = await Promise.all([Users.all(), Assignments.all()]);
    const partners = allUsers.filter(u => u.role === 'partner')
      .sort((a, b) => (a.partner_no || 9999) - (b.partner_no || 9999));
    const completed = allAssign.filter(a => a.status === 'completed');

    const pz = n => String(n).padStart(2, '0');

    // 取銀行代號（郵局=700；其餘優先用欄位，無則從名稱括號擷取）
    const bankCode = u => {
      if (u.bank_type === 'post') return '700';
      let code = u.bank_code || '';
      if (!code) { const m = (u.bank_name || '').match(/[（(]\s*(\d{3,4})\s*[）)]/); if (m) code = m[1]; }
      return code;
    };
    // 匯款資料：(代號)帳號（同報稅總表規則）
    const bankInfo = u => {
      if (u.bank_type === 'post') return `(700)${u.bank_account || ''}`;
      const code = bankCode(u);
      return code ? `(${code})${u.bank_account || ''}` : `${u.bank_name || ''} ${u.bank_account || ''}`.trim();
    };

    // 勞報單編號：希絆 + 今日(YYYYMMDD) + Pno（與 labor-report.html 檔名一致）
    const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const ymdToday = `${today.getFullYear()}${pz(today.getMonth()+1)}${pz(today.getDate())}`;
    const reportNo = u => `希絆${ymdToday}${u.partner_no ? 'P'+String(u.partner_no).padStart(3,'0') : ''}`;

    // 個人某月原始金額（與錢包一致：completed_at 落在該年月之已完成任務 total_price 加總；支援有無補零）
    const monthAmount = (pid, m) => {
      const mm = pz(m);
      return completed.filter(a => a.accepted_by === pid && (
        (a.completed_at || '').startsWith(`${year}/${mm}`) ||
        (a.completed_at || '').startsWith(`${year}/${m}/`)
      )).reduce((s, a) => s + (Number(a.total_price) || 0), 0);
    };

    // 實際匯款金額：原始金額 > 20000 扣所得稅 10%；>= 20000 扣二代健保 2.11%；
    //              非第一銀行(007) 另扣轉帳費 15 元
    const calcNet = (gross, code) => {
      const tax    = gross > 20000  ? Math.round(gross * 0.10)   : 0;   // 所得稅 10%
      const health = gross >= 20000 ? Math.round(gross * 0.0211) : 0;   // 二代健保 2.11%
      const fee    = parseInt(code, 10) === 7 ? 0 : 15;                  // 非第一銀行扣 15 元轉帳費
      return { tax, health, fee, net: gross - tax - health - fee };
    };

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const wb = new ExcelJS.Workbook();
    wb.creator = '希絆雲作所';

    const buildSheet = (ws, m) => {
      ws.views = [{ zoomScale: 110 }];
      ws.columns = [
        { header: '序號',         key: 'no',     width: 6  },
        { header: '姓名',         key: 'name',   width: 14 },
        { header: '匯款資料',     key: 'bank',   width: 30 },
        { header: '原始金額',     key: 'gross',  width: 12 },
        { header: '實際匯款金額', key: 'net',    width: 14 },
        { header: '備註',         key: 'remark', width: 16 },
        { header: '事由',         key: 'reason', width: 14 },
        { header: '勞報單編號',   key: 'rno',    width: 22 },
        { header: '細項',         key: 'link',   width: 14 },
      ];
      const hr = ws.getRow(1);
      hr.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
      hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
      hr.alignment = { vertical: 'middle', horizontal: 'center' };
      hr.height = 26;

      let seq = 0;
      partners.forEach(p => {
        const gross = monthAmount(p.id, m);
        if (gross <= 0) return; // 當月無金額者不列入匯款清單
        seq++;
        const { net } = calcNet(gross, bankCode(p));
        const r = ws.addRow({
          no: seq, name: p.real_name || '', bank: bankInfo(p),
          gross, net, remark: '', reason: '工作紀錄總額', rno: reportNo(p), link: '',
        });
        // 金額格式
        ws.getCell(`D${r.number}`).numFmt = '#,##0';
        ws.getCell(`E${r.number}`).numFmt = '#,##0';
        // 細項：連結到該夥伴該月勞報單（伺服器運行時可直接開啟；之後可改為 Drive PDF 連結）
        const linkCell = ws.getCell(`I${r.number}`);
        linkCell.value = { text: '開啟勞報單', hyperlink: `${baseUrl}/labor-report.html?partner_id=${p.id}&year_month=${year}-${pz(m)}` };
        linkCell.font = { color: { argb: 'FF000000' }, underline: true };
        r.font = r.font || {};
        r.height = 20;
        if (seq % 2 === 0) r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F7FA' } };
      });
      if (seq === 0) ws.addRow({ no: '', name: '（本月無匯款資料）' });
      applyReportGrid(ws);
      // 「實際匯款金額」計算說明（紅字，置於表格下方；在 applyReportGrid 後加入以保留顏色）
      ws.addRow([]);
      const noteLines = [
        { t: '※ 實際匯款金額 計算說明', size: 12, bold: true },
        { t: '達 2 萬須扣除：1. 所得稅 10%（大於 2 萬）  2. 補充保險費 2.11%（大於等於 2 萬）', size: 11 },
        { t: '銀行代號非第一銀行（007）者，另扣轉帳費 15 元', size: 11 },
      ];
      noteLines.forEach(n => {
        const row = ws.addRow([n.t]);
        row.getCell(1).font = { color: { argb: 'FFC00000' }, size: n.size, bold: !!n.bold };
      });
    };

    if (singleMonth) {
      buildSheet(wb.addWorksheet(`${year}年${singleMonth}月`), singleMonth);
    } else {
      for (let m = 1; m <= 12; m++) buildSheet(wb.addWorksheet(`${m}月`), m);
    }

    const fileLabel = singleMonth
      ? `每月薪資計算總表_${year}年${singleMonth}月`
      : `每月薪資計算總表_${year}年`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="salary-summary.xlsx"; filename*=UTF-8''${encodeURIComponent(fileLabel)}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 勞務報酬單資料：GET /api/admin/labor-report?partner_id=X&year_month=YYYY-MM
app.get('/api/admin/labor-report', requireRole('staff'), async (req, res) => {
  try {
    const { partner_id, year_month } = req.query;
    if (!partner_id || !year_month) return res.status(400).json({ error: '缺少夥伴或月份' });
    const [yy, mm] = year_month.split('-');
    const u = await Users.byId(parseInt(partner_id));
    if (!u) return res.status(404).json({ error: '找不到夥伴' });
    const all = await Assignments.all();
    // 支援 completed_at 有無補零兩種格式（2026/06/05 及 2026/6/5）
    const matchYM = (dt) => {
      const d = dt || '';
      return d.startsWith(`${yy}/${mm}`) || d.startsWith(`${yy}/${parseInt(mm)}/`);
    };
    const mine = all.filter(a => a.accepted_by === u.id && a.status === 'completed' && matchYM(a.completed_at));
    const amount = mine.reduce((s, a) => s + (Number(a.total_price) || 0), 0);
    const tasks = [...new Set(mine.map(a => a.task_name).filter(Boolean))];
    res.json({
      company: '希絆股份有限公司',
      year: yy, month: parseInt(mm),
      partner_no: u.partner_no || null,
      real_name: u.real_name || '',
      id_number: u.id_number || '',
      phone: u.phone || '',
      address: u.address || '',
      mailing_address: u.mailing_address || '',
      work_content: tasks.join('、') || '勞務報酬',
      bank_type: u.bank_type || 'bank',
      bank_code: u.bank_type === 'post' ? '700' : (u.bank_code || ''),
      bank_name: u.bank_name || '',
      bank_branch: u.bank_branch || '',
      bank_account: u.bank_account || '',
      bank_holder: u.bank_holder || u.real_name || '',
      post_office_code: u.post_office_code || '',
      amount,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 薪資通知寄信：POST /api/admin/payroll/send-email
app.post('/api/admin/payroll/send-email', requireRole('staff'), async (req, res) => {
  try {
    if (!GAS_URL) return res.status(503).json({ error: '寄件服務未設定，請聯絡管理員配置 GAS_URL' });
    const { partner_id, year_month } = req.body; // year_month = "2026-06"
    if (!partner_id || !year_month) return res.status(400).json({ error: '缺少必要參數' });

    const [fy, fm] = year_month.split('-');
    const monthLabel = `${fy} 年 ${parseInt(fm)} 月`;

    // 取得夥伴資料
    const partner = await Users.byId(Number(partner_id));
    if (!partner) return res.status(404).json({ error: '找不到夥伴' });
    if (!partner.email) return res.status(400).json({ error: `${partner.real_name} 尚未設定 Email` });

    // 取得該月已完成任務
    const allCompleted = await require('firebase-admin').firestore()
      .collection('assignments')
      .where('status', '==', 'completed')
      .where('accepted_by', '==', partner.id)
      .get();
    const records = allCompleted.docs.map(d => d.data())
      .filter(a => (a.completed_at || '').startsWith(`${fy}/${fm}`))
      .sort((a, b) => (a.completed_at || '').localeCompare(b.completed_at || ''));

    if (!records.length) return res.status(400).json({ error: '該月無薪資紀錄' });

    const total = records.reduce((s, a) => s + (a.total_price || 0), 0);

    // 組成 Email HTML
    const rows = records.map((a, i) => `
      <tr style="background:${i%2===0?'#f9f9f9':'#fff'}">
        <td style="padding:8px 12px;border:1px solid #e0e0e0">${a.task_name}</td>
        <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center">${a.quantity}</td>
        <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:right">$${(a.unit_price||0).toLocaleString()}</td>
        <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:right;font-weight:700;color:#c87000">$${(a.total_price||0).toLocaleString()}</td>
        <td style="padding:8px 12px;border:1px solid #e0e0e0;color:#888;font-size:12px">${a.completed_at||'—'}</td>
      </tr>`).join('');

    const html = `
<!DOCTYPE html>
<html lang="zh-TW">
<head><meta charset="UTF-8"></head>
<body style="font-family:'Noto Sans TC',Arial,sans-serif;background:#f5f7fa;margin:0;padding:24px">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#1a6fa0,#48B4E8);padding:28px 32px;color:#fff">
      <div style="font-size:22px;font-weight:700;margin-bottom:4px">💰 ${monthLabel}薪資通知</div>
      <div style="font-size:14px;opacity:.85">希絆雲作所 — 工作夥伴薪資明細</div>
    </div>
    <div style="padding:28px 32px">
      <p style="margin:0 0 20px;font-size:15px;color:#333">親愛的 <strong>${partner.real_name}</strong> 夥伴，您好：</p>
      <p style="margin:0 0 20px;font-size:14px;color:#555">以下是您 ${monthLabel} 的任務完成紀錄與薪資明細：</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
        <thead>
          <tr style="background:#1a6fa0;color:#fff">
            <th style="padding:10px 12px;text-align:left;border:1px solid #1a6fa0">任務名稱</th>
            <th style="padding:10px 12px;text-align:center;border:1px solid #1a6fa0">數量</th>
            <th style="padding:10px 12px;text-align:right;border:1px solid #1a6fa0">單價</th>
            <th style="padding:10px 12px;text-align:right;border:1px solid #1a6fa0">小計</th>
            <th style="padding:10px 12px;text-align:left;border:1px solid #1a6fa0">完成時間</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr style="background:#fff8e8">
            <td colspan="3" style="padding:10px 12px;border:1px solid #e0e0e0;font-weight:700;text-align:right">本月總計</td>
            <td style="padding:10px 12px;border:1px solid #e0e0e0;font-weight:700;color:#c87000;font-size:16px;text-align:right">$${total.toLocaleString()}</td>
            <td style="border:1px solid #e0e0e0"></td>
          </tr>
        </tfoot>
      </table>
      <p style="margin:0;font-size:13px;color:#888">如有疑問請聯繫您的派案人員。感謝您的辛勤付出！</p>
    </div>
    <div style="background:#f5f7fa;padding:16px 32px;font-size:12px;color:#aaa;text-align:center">
      © 希絆雲作所 · 此信件由系統自動發送，請勿直接回覆
    </div>
  </div>
</body>
</html>`;

    await sendMail({ to: partner.email, subject: `【希絆雲作所】${monthLabel}薪資通知 — ${partner.real_name}`, html });

    res.json({ ok: true, message: `已寄送至 ${partner.email}` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 薪資彙整寄給登入管理員自己：POST /api/admin/payroll/send-me
app.post('/api/admin/payroll/send-me', requireRole('staff'), async (req, res) => {
  try {
    if (!GAS_URL) return res.status(503).json({ error: '寄件服務未設定，請聯絡管理員配置 GAS_URL' });
    const { year_month } = req.body;
    if (!year_month) return res.status(400).json({ error: '缺少 year_month 參數' });

    // 取登入管理員的 email（從 DB 抓，確保是最新的）
    const me = await Users.byName(req.session.user.username);
    if (!me || !me.email) return res.status(400).json({ error: '您尚未設定 Email，請先至個人資料填寫信箱' });

    const [fy, fm] = year_month.split('-');
    const monthLabel = `${fy} 年 ${parseInt(fm)} 月`;
    const p2 = n => String(n).padStart(2,'0');
    const prefix = `${fy}/${p2(parseInt(fm))}`;
    // 手動寄送日期範圍 MM/01～今天
    const now = new Date();
    const todayStr = `${p2(now.getMonth()+1)}/${p2(now.getDate())}`;
    const rangeLabel = `（${p2(parseInt(fm))}/01～${todayStr}）`;

    // 取所有活躍夥伴
    const allUsers = await Users.all();
    const partners = allUsers.filter(u => u.role === 'partner' && u.status === 'active');

    // 取該月已完成任務
    const snap = await require('firebase-admin').firestore()
      .collection('assignments').where('status','==','completed').get();
    const allCompleted = snap.docs.map(d => d.data());

    // 組成各夥伴區塊
    let grandTotal = 0;
    let partnerBlocks = '';
    for (const partner of partners) {
      const records = allCompleted
        .filter(a => a.accepted_by === partner.id && (a.completed_at || '').startsWith(prefix))
        .sort((a, b) => (a.completed_at || '').localeCompare(b.completed_at || ''));
      if (!records.length) continue;
      const total = records.reduce((s, a) => s + (a.total_price || 0), 0);
      grandTotal += total;
      const rows = records.map((a, i) => `
        <tr style="background:${i%2===0?'#f9f9f9':'#fff'}">
          <td style="padding:6px 10px;border:1px solid #e0e0e0">${a.task_name}</td>
          <td style="padding:6px 10px;border:1px solid #e0e0e0;text-align:center">${a.quantity}</td>
          <td style="padding:6px 10px;border:1px solid #e0e0e0;text-align:right">$${(a.unit_price||0).toLocaleString()}</td>
          <td style="padding:6px 10px;border:1px solid #e0e0e0;text-align:right;font-weight:700;color:#c87000">$${(a.total_price||0).toLocaleString()}</td>
          <td style="padding:6px 10px;border:1px solid #e0e0e0;color:#888;font-size:12px">${a.completed_at||'—'}</td>
        </tr>`).join('');
      partnerBlocks += `
        <div style="margin-bottom:24px">
          <div style="font-size:15px;font-weight:700;color:#1a6fa0;margin-bottom:8px">👤 ${partner.real_name}</div>
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="background:#1a6fa0;color:#fff">
                <th style="padding:8px 10px;text-align:left;border:1px solid #1a6fa0">任務名稱</th>
                <th style="padding:8px 10px;text-align:center;border:1px solid #1a6fa0">數量</th>
                <th style="padding:8px 10px;text-align:right;border:1px solid #1a6fa0">單價</th>
                <th style="padding:8px 10px;text-align:right;border:1px solid #1a6fa0">小計</th>
                <th style="padding:8px 10px;text-align:left;border:1px solid #1a6fa0">完成時間</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
            <tfoot>
              <tr style="background:#fff8e8">
                <td colspan="3" style="padding:8px 10px;border:1px solid #e0e0e0;font-weight:700;text-align:right">小計</td>
                <td style="padding:8px 10px;border:1px solid #e0e0e0;font-weight:700;color:#c87000;text-align:right">$${total.toLocaleString()}</td>
                <td style="border:1px solid #e0e0e0"></td>
              </tr>
            </tfoot>
          </table>
        </div>`;
    }

    if (!partnerBlocks) return res.status(400).json({ error: '該月無任何薪資紀錄' });

    const html = `<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8"></head>
<body style="font-family:'Noto Sans TC',Arial,sans-serif;background:#f5f7fa;margin:0;padding:24px">
  <div style="max-width:700px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#1a6fa0,#48B4E8);padding:28px 32px;color:#fff">
      <div style="font-size:22px;font-weight:700;margin-bottom:4px">📊 ${monthLabel}薪資彙整</div>
      <div style="font-size:14px;opacity:.85">希絆雲作所 — 管理員薪資總覽</div>
    </div>
    <div style="padding:28px 32px">
      <p style="margin:0 0 6px;font-size:15px;color:#333">收件人：<strong>${me.real_name}</strong></p>
      <p style="margin:0 0 24px;font-size:14px;color:#555">以下是 ${monthLabel} 所有夥伴薪資彙整，合計 <strong style="color:#c87000">$${grandTotal.toLocaleString()}</strong></p>
      ${partnerBlocks}
      <div style="border-top:2px solid #1a6fa0;padding-top:12px;margin-top:8px;font-size:16px;font-weight:700;text-align:right;color:#1a6fa0">
        本月總薪資：$${grandTotal.toLocaleString()}
      </div>
    </div>
    <div style="background:#f5f7fa;padding:16px 32px;font-size:12px;color:#aaa;text-align:center">
      © 希絆雲作所 · 此信件由系統自動發送，請勿直接回覆
    </div>
  </div>
</body></html>`;

    // 先回應，背景寄信避免逾時
    res.json({ ok: true, message: `寄送中，稍後請至 ${me.email} 收信 ✅` });
    sendMail({ to: me.email, subject: `【希絆雲作所】${monthLabel}薪資彙整${rangeLabel} — ${me.real_name}`, html })
      .then(() => console.log('[send-me] 寄信成功 →', me.email))
      .catch(e => console.error('[send-me] 寄信失敗:', e.message));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 薪資通知寄信（全體）：POST /api/admin/payroll/send-all
app.post('/api/admin/payroll/send-all', requireRole('staff'), async (req, res) => {
  try {
    if (!GAS_URL) return res.status(503).json({ error: '寄件服務未設定，請聯絡管理員配置 GAS_URL' });
    const { year_month } = req.body;
    if (!year_month) return res.status(400).json({ error: '缺少 year_month 參數' });

    const [fy, fm] = year_month.split('-');
    const monthLabel = `${fy} 年 ${parseInt(fm)} 月`;
    const p2 = n => String(n).padStart(2,'0');
    const prefix = `${fy}/${p2(parseInt(fm))}`;

    const allUsers = await Users.all();
    const partners = allUsers.filter(u => u.role === 'partner' && u.status === 'active');

    const snap = await require('firebase-admin').firestore()
      .collection('assignments').where('status','==','completed').get();
    const allCompleted = snap.docs.map(d => d.data());

    let sent = 0, skipped = 0;
    for (const partner of partners) {
      if (!partner.email) { skipped++; continue; }
      const records = allCompleted
        .filter(a => a.accepted_by === partner.id && (a.completed_at || '').startsWith(prefix))
        .sort((a, b) => (a.completed_at || '').localeCompare(b.completed_at || ''));
      if (!records.length) { skipped++; continue; }
      const total = records.reduce((s, a) => s + (a.total_price || 0), 0);
      const rows = records.map((a, i) => `
        <tr style="background:${i%2===0?'#f9f9f9':'#fff'}">
          <td style="padding:8px 12px;border:1px solid #e0e0e0">${a.task_name}</td>
          <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center">${a.quantity}</td>
          <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:right">$${(a.unit_price||0).toLocaleString()}</td>
          <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:right;font-weight:700;color:#c87000">$${(a.total_price||0).toLocaleString()}</td>
          <td style="padding:8px 12px;border:1px solid #e0e0e0;color:#888;font-size:12px">${a.completed_at||'—'}</td>
        </tr>`).join('');
      const html = `<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8"></head>
<body style="font-family:'Noto Sans TC',Arial,sans-serif;background:#f5f7fa;margin:0;padding:24px">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#1a6fa0,#48B4E8);padding:28px 32px;color:#fff">
      <div style="font-size:22px;font-weight:700;margin-bottom:4px">💰 ${monthLabel}薪資通知</div>
      <div style="font-size:14px;opacity:.85">希絆雲作所 — 工作夥伴薪資明細</div>
    </div>
    <div style="padding:28px 32px">
      <p style="margin:0 0 20px;font-size:15px;color:#333">親愛的 <strong>${partner.real_name}</strong> 夥伴，您好：</p>
      <p style="margin:0 0 20px;font-size:14px;color:#555">以下是您 ${monthLabel} 的任務完成紀錄與薪資明細：</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
        <thead>
          <tr style="background:#1a6fa0;color:#fff">
            <th style="padding:10px 12px;text-align:left;border:1px solid #1a6fa0">任務名稱</th>
            <th style="padding:10px 12px;text-align:center;border:1px solid #1a6fa0">數量</th>
            <th style="padding:10px 12px;text-align:right;border:1px solid #1a6fa0">單價</th>
            <th style="padding:10px 12px;text-align:right;border:1px solid #1a6fa0">小計</th>
            <th style="padding:10px 12px;text-align:left;border:1px solid #1a6fa0">完成時間</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr style="background:#fff8e8">
            <td colspan="3" style="padding:10px 12px;border:1px solid #e0e0e0;font-weight:700;text-align:right">本月總計</td>
            <td style="padding:10px 12px;border:1px solid #e0e0e0;font-weight:700;color:#c87000;font-size:16px;text-align:right">$${total.toLocaleString()}</td>
            <td style="border:1px solid #e0e0e0"></td>
          </tr>
        </tfoot>
      </table>
      <p style="margin:0;font-size:13px;color:#888">如有疑問請聯繫您的派案人員。感謝您的辛勤付出！</p>
    </div>
    <div style="background:#f5f7fa;padding:16px 32px;font-size:12px;color:#aaa;text-align:center">
      © 希絆雲作所 · 此信件由系統自動發送，請勿直接回覆
    </div>
  </div>
</body></html>`;
      await sendMail({ to: partner.email, subject: `【希絆雲作所】${monthLabel}薪資通知 — ${partner.real_name}`, html });
      sent++;
    }
    res.json({ ok: true, sent, skipped, message: `已寄送 ${sent} 位，${skipped} 位略過` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 每月1號自動寄送薪資通知 ──────────────────────────────────
async function autoSendPayroll(year, month) {
  if (!GAS_URL) return console.log('[cron] 寄件服務未設定，跳過自動寄送');
  const ym = `${year}-${String(month).padStart(2,'0')}`;
  const allUsers = await Users.all();
  const partners = allUsers.filter(u => u.role === 'partner' && u.status === 'active' && u.email);
  const snap = await require('firebase-admin').firestore()
    .collection('assignments').where('status','==','completed').get();
  const allCompleted = snap.docs.map(d => d.data());
  const p2 = n => String(n).padStart(2,'0');
  let sent = 0;
  for (const partner of partners) {
    const records = allCompleted.filter(a =>
      a.accepted_by === partner.id && (a.completed_at||'').startsWith(`${year}/${p2(month)}`)
    );
    if (!records.length) continue;
    const total = records.reduce((s,a) => s+(a.total_price||0), 0);
    const monthLabel = `${year} 年 ${month} 月`;
    const rows = records.map((a,i) => `
      <tr style="background:${i%2===0?'#f9f9f9':'#fff'}">
        <td style="padding:8px 12px;border:1px solid #e0e0e0">${a.company ? a.company+'：'+a.task_name : a.task_name}</td>
        <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center">${a.quantity}</td>
        <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:right">$${(a.unit_price||0).toLocaleString()}</td>
        <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:right;font-weight:700;color:#c87000">$${(a.total_price||0).toLocaleString()}</td>
        <td style="padding:8px 12px;border:1px solid #e0e0e0;color:#888;font-size:12px">${a.completed_at||'—'}</td>
      </tr>`).join('');
    const html = `<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8"></head><body style="font-family:Arial,sans-serif;background:#f5f7fa;padding:24px"><div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)"><div style="background:linear-gradient(135deg,#1a6fa0,#48B4E8);padding:28px 32px;color:#fff"><div style="font-size:22px;font-weight:700">💰 ${monthLabel}薪資通知</div><div style="font-size:14px;opacity:.85">希絆雲作所</div></div><div style="padding:28px 32px"><p>親愛的 <strong>${partner.real_name}</strong> 夥伴，您好：</p><table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0"><thead><tr style="background:#1a6fa0;color:#fff"><th style="padding:10px;text-align:left;border:1px solid #1a6fa0">任務</th><th style="padding:10px;border:1px solid #1a6fa0">數量</th><th style="padding:10px;border:1px solid #1a6fa0">單價</th><th style="padding:10px;border:1px solid #1a6fa0">小計</th><th style="padding:10px;border:1px solid #1a6fa0">完成時間</th></tr></thead><tbody>${rows}</tbody><tfoot><tr style="background:#fff8e8"><td colspan="3" style="padding:10px;border:1px solid #e0e0e0;text-align:right;font-weight:700">本月總計</td><td style="padding:10px;border:1px solid #e0e0e0;font-weight:700;color:#c87000">$${total.toLocaleString()}</td><td style="border:1px solid #e0e0e0"></td></tr></tfoot></table></div><div style="background:#f5f7fa;padding:16px;font-size:12px;color:#aaa;text-align:center">© 希絆雲作所 · 系統自動發送</div></div></body></html>`;
    try {
      await sendMail({ to: partner.email, subject: `【希絆雲作所】${monthLabel}薪資通知 — ${partner.real_name}`, html });
      sent++;
    } catch(e) { console.error(`[cron] 寄信失敗(${partner.real_name}):`, e.message); }
  }
  console.log(`[cron] 自動薪資通知完成，成功寄送 ${sent} 位`);
}

// 每月1號 08:00（台北時間）執行
cron.schedule('0 8 1 * *', () => {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  // 寄上個月資料
  const lastMonth = now.getMonth() === 0
    ? { year: now.getFullYear() - 1, month: 12 }
    : { year: now.getFullYear(), month: now.getMonth() };
  console.log(`[cron] 開始自動寄送 ${lastMonth.year}/${lastMonth.month} 薪資通知`);
  autoSendPayroll(lastMonth.year, lastMonth.month).catch(console.error);
}, { timezone: 'Asia/Taipei' });

// ── Gemini 圖片辨識 ──────────────────────────────────────────
// ── Google Drive helper ───────────────────────────────────────
function getDrive() {
  if (!process.env.GOOGLE_DRIVE_FOLDER_ID) return null;
  try {
    const { google } = require('googleapis');
    // 優先用 OAuth（個人帳號）
    if (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_REFRESH_TOKEN) {
      const oauth2 = new google.auth.OAuth2(
        process.env.GOOGLE_OAUTH_CLIENT_ID,
        process.env.GOOGLE_OAUTH_CLIENT_SECRET,
        'http://localhost'
      );
      oauth2.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
      return google.drive({ version: 'v3', auth: oauth2 });
    }
    // 備用：服務帳號
    if (process.env.GOOGLE_SERVICE_KEY) {
      const key = JSON.parse(process.env.GOOGLE_SERVICE_KEY);
      if (key.private_key) key.private_key = key.private_key.replace(/\\n/g, '\n');
      const auth = new google.auth.GoogleAuth({ credentials: key, scopes: ['https://www.googleapis.com/auth/drive'] });
      return google.drive({ version: 'v3', auth });
    }
    return null;
  } catch(e) { console.error('[Drive init]', e.message); return null; }
}

async function driveEnsureFolder(drive, name, parentId) {
  const res = await drive.files.list({
    q: `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (res.data.files.length) return res.data.files[0].id;
  const f = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id',
    supportsAllDrives: true,
  });
  return f.data.id;
}

// ── 資料庫備份（兩種類型：data=只結構化／full=含圖片）──────────
const IMAGE_COLLECTIONS = ['user_images', 'report_images']; // 圖片集合（含 base64）
const BACKUP_KEEP = { data: 30, full: 8 }; // 各類型保留份數

// 遞迴匯出一個集合；includeImages=false 時不下探子集合（圖片在子集合）
async function dumpCollection(colRef, counter, includeImages) {
  const snap = await colRef.get();
  const out = [];
  for (const doc of snap.docs) {
    counter.docs++;
    const entry = { id: doc.id, data: doc.data() };
    if (includeImages) {
      const subs = await doc.ref.listCollections();
      if (subs.length) {
        entry.sub = {};
        for (const s of subs) entry.sub[s.id] = await dumpCollection(s, counter, includeImages);
      }
    }
    out.push(entry);
  }
  return out;
}

// mode: 'data'（不含圖片，小而快）| 'full'（含圖片，可完整還原）
async function backupToDrive(mode = 'full') {
  const full = mode !== 'data';
  const drive  = getDrive();
  const rootId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!drive || !rootId) { console.log('[backup] Drive 未設定，略過'); return { ok: false, error: 'Drive 未設定' }; }

  const cols = await db.listCollections();
  const counter = { docs: 0 };
  const data = {};
  for (const col of cols) {
    if (!full && IMAGE_COLLECTIONS.includes(col.id)) continue; // data 模式跳過圖片集合
    data[col.id] = await dumpCollection(col, counter, full);
  }
  const docCount = counter.docs;
  const payload = {
    backup_meta: { backup_at: nowTW(), doc_count: docCount, type: full ? 'full' : 'data',
      collections: Object.keys(data), format: 'v2-full' },
    data,
  };
  const json = Buffer.from(JSON.stringify(payload), 'utf8');

  const dirId = await driveEnsureFolder(drive, '資料庫備份', rootId);
  const n = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const p = x => String(x).padStart(2, '0');
  const prefix = full ? 'hiban-full-' : 'hiban-data-';
  const fname = `${prefix}${n.getFullYear()}-${p(n.getMonth()+1)}-${p(n.getDate())}_${p(n.getHours())}${p(n.getMinutes())}.json`;
  const { Readable } = require('stream');
  await drive.files.create({
    requestBody: { name: fname, parents: [dirId] },
    media: { mimeType: 'application/json', body: Readable.from(json) },
    fields: 'id',
    supportsAllDrives: true,
  });

  // 依「同類型前綴」保留最近 N 份，清掉更舊的
  const keep = full ? BACKUP_KEEP.full : BACKUP_KEEP.data;
  const list = await drive.files.list({
    q: `'${dirId}' in parents and trashed=false and name contains '${prefix}'`,
    fields: 'files(id,name)', orderBy: 'name desc', pageSize: 1000,
    supportsAllDrives: true, includeItemsFromAllDrives: true,
  });
  const files = list.data.files || [];
  for (const f of files.slice(keep)) {
    try { await drive.files.delete({ fileId: f.id, supportsAllDrives: true }); } catch(e) { console.error('[backup] 清理舊檔失敗', e.message); }
  }
  const sizeMB = Math.round(json.length / 1048576 * 10) / 10;
  console.log(`[backup] 完成 ${fname}（${docCount} 筆，${sizeMB}MB，保留 ${Math.min(files.length, keep)} 份）`);
  return { ok: true, file: fname, type: full ? 'full' : 'data', doc_count: docCount, size_mb: sizeMB, kept: Math.min(files.length, keep) };
}

// 自動排程：週一～六 03:00 資料備份（不含圖片）；週日 04:00 完整備份（含圖片，已涵蓋 data）
cron.schedule('0 3 * * 1-6', () => {
  console.log('[cron] 資料備份（data，週一～六）');
  backupToDrive('data').catch(console.error);
}, { timezone: 'Asia/Taipei' });
cron.schedule('0 4 * * 0', () => {
  console.log('[cron] 完整備份（full，週日）');
  backupToDrive('full').catch(console.error);
}, { timezone: 'Asia/Taipei' });

// 浮水印：把 assets/watermark.png 疊到圖片上（縮放鋪滿），失敗則回傳原圖
let _watermarkPromise = null;
function loadWatermark() {
  if (!_watermarkPromise) {
    const Jimp = require('jimp');
    const path = require('path');
    _watermarkPromise = Jimp.read(path.join(__dirname, 'assets', 'watermark.png')).catch(e => {
      console.error('[watermark] 載入失敗', e.message); return null;
    });
  }
  return _watermarkPromise;
}

const WM_MAX_DIM = 1600; // 處理前先縮圖，避免大照片吃爆記憶體（Railway）
async function addWatermark(b64) {
  try {
    const Jimp = require('jimp');
    const wm = await loadWatermark();
    if (!wm) return Buffer.from(b64, 'base64');
    const img = await Jimp.read(Buffer.from(b64, 'base64'));
    // 過大的照片先縮到最長邊 WM_MAX_DIM（審核足夠，記憶體大幅下降）
    if (Math.max(img.bitmap.width, img.bitmap.height) > WM_MAX_DIM) {
      img.scaleToFit(WM_MAX_DIM, WM_MAX_DIM);
    }
    const overlay = wm.clone().resize(img.bitmap.width, img.bitmap.height);
    img.composite(overlay, 0, 0, { mode: Jimp.BLEND_SOURCE_OVER, opacitySource: 1, opacityDest: 1 });
    return await img.quality(85).getBufferAsync(Jimp.MIME_JPEG);
  } catch(e) {
    console.error('[watermark] 套用失敗，使用原圖', e.message);
    return Buffer.from(b64, 'base64');
  }
}

async function driveUploadImg(drive, name, b64, parentId, watermark = false) {
  const { Readable } = require('stream');
  const buf = watermark ? await addWatermark(b64) : Buffer.from(b64, 'base64');
  await drive.files.create({
    requestBody: { name, parents: [parentId] },
    media: { mimeType: 'image/jpeg', body: Readable.from(buf) },
    fields: 'id',
    supportsAllDrives: true,
  });
}

async function uploadUserToDrive(user, images) {
  const rootId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  const drive  = getDrive();
  if (!drive || !rootId) { console.log('[Drive] 未設定，略過'); return; }
  try {
    const staffDirId = await driveEnsureFolder(drive, '人員資料', rootId);
    const personId   = await driveEnsureFolder(drive, user.real_name, staffDirId);
    const bankLabel  = user.bank_type === 'post' ? '郵局存簿' : '銀行存摺';
    if (images.front) await driveUploadImg(drive, '身分證正面.jpg', images.front, personId, true);
    if (images.back)  await driveUploadImg(drive, '身分證反面.jpg', images.back,  personId, true);
    if (images.bank)  await driveUploadImg(drive, `${bankLabel}.jpg`, images.bank, personId, true);
    if (images.disability) await driveUploadImg(drive, '身心障礙手冊.jpg', images.disability, personId, true);
    // 記下 Drive 資料夾 ID，刪除人員時可直接刪除（避免靠姓名查找失敗）
    try { await Users.update(user.id, { drive_folder_id: personId }); } catch(e) { console.error('[Drive] 記錄資料夾ID失敗', e.message); }
    console.log(`[Drive] ${user.real_name} 資料上傳完成`);
  } catch(e) { console.error('[Drive upload]', e.message); }
}

// 共用 Gemini POST helper（不設 Content-Length，用 chunked encoding）
function geminiPost(apiKey, bodyStr) {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`);
    const options = {
      hostname: url.hostname, path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' }
    };
    const req2 = https.request(options, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        const d = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error('Gemini 回傳非 JSON：' + d.slice(0,200))); }
      });
    });
    req2.on('error', reject);
    req2.write(bodyStr);
    req2.end();
  });
}

app.post('/api/gemini/extract-id', async (req, res) => {
  try {
    const { image_base64, image_base64_back, mime_type } = req.body;
    if (!image_base64) return res.status(400).json({ error: '缺少圖片' });
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'GEMINI_API_KEY 未設定' });

    const prompt = `請判斷並提取圖片資料，只回傳 JSON 不要其他文字：
{"is_id_card":true/false(這是否為中華民國身分證？非身分證請填 false),"quality":"good/blurry/glare/dark/cropped(影像品質：清晰good/模糊blurry/反光glare/太暗dark/裁切不全cropped)","warning":"若有品質或非身分證問題，用一句中文說明，例如『影像模糊，請重拍』；正常則空字串","real_name":"姓名(從正面)","id_number":"身分證字號10碼英數(從正面)","birthday":"生日YYYY/MM/DD格式(從正面民國年轉換為西元)","gender":"性別男或女(從正面)","address":"完整戶籍地址(從反面)"}
看不清楚的欄位填空字串。`;

    const parts = [
      { text: prompt },
      { inline_data: { mime_type: mime_type || 'image/jpeg', data: image_base64 } }
    ];
    if (image_base64_back) {
      parts.push({ inline_data: { mime_type: mime_type || 'image/jpeg', data: image_base64_back } });
    }
    const body = JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.1 }
    });

    const result = await geminiPost(apiKey, body);
    if (result.error) return res.json({ ok: false, error: result.error.message || JSON.stringify(result.error) });
    const raw = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log('[Gemini ID raw]', raw.slice(0, 300));
    const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) return res.json({ ok: false, error: 'Gemini 未回傳 JSON：' + raw.slice(0,150) });
    const data = JSON.parse(raw.slice(start, end + 1));
    res.json({ ok: true, data });
  } catch(e) { console.error('[extract-id]', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/gemini/extract-bank', async (req, res) => {
  try {
    const { image_base64, mime_type } = req.body;
    if (!image_base64) return res.status(400).json({ error: '缺少圖片' });
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'GEMINI_API_KEY 未設定' });

    const prompt = `請從這張存摺或存簿封面圖片中提取資料。

首先判斷是「中華郵政（郵局）」還是「一般銀行」：
- 如果是中華郵政/郵局，請回傳 type=post：
{"type":"post","bank_holder":"戶名","post_branch":"郵局名稱(例:臺北松江路郵局)","post_office_code":"郵局局號(只有數字,例:0001557)","bank_account":"郵局帳號(只有數字,例:0966527)"}
- 如果是一般銀行，請回傳 type=bank：
{"type":"bank","bank_holder":"戶名","bank_name":"銀行名稱(例:台北富邦銀行)","bank_code":"銀行代號(3位數字,例:012)","bank_branch":"分行名稱(例:板橋分行)","bank_account":"帳號(只有數字)"}

只回傳 JSON，不要其他文字，看不清楚的欄位填空字串。`;

    const body = JSON.stringify({
      contents: [{ parts: [
        { text: prompt },
        { inline_data: { mime_type: mime_type || 'image/jpeg', data: image_base64 } }
      ]}],
      generationConfig: { temperature: 0.1 }
    });

    const result = await geminiPost(apiKey, body);
    if (result.error) return res.json({ ok: false, error: result.error.message || JSON.stringify(result.error) });
    const raw2 = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log('[Gemini Bank raw]', raw2.slice(0, 300));
    const s2 = raw2.indexOf('{'); const e2 = raw2.lastIndexOf('}');
    if (s2 === -1 || e2 === -1) return res.json({ ok: false, error: 'Gemini 未回傳 JSON：' + raw2.slice(0,150) });
    const data = JSON.parse(raw2.slice(s2, e2 + 1));
    res.json({ ok: true, data });
  } catch(e) { console.error('[extract-bank]', e); res.status(500).json({ error: e.message }); }
});

function httpsGetText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        return httpsGetText(r.headers.location).then(resolve, reject);
      }
      if (r.statusCode !== 200) return reject(new Error(`讀取失敗（HTTP ${r.statusCode}），請確認試算表已設為「知道連結的人皆可查看」`));
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

app.post('/api/sheet-fetch', requireRole('supervisor'), async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !/^https:\/\/docs\.google\.com\/spreadsheets\/d\//.test(url)) {
      return res.status(400).json({ error: '請輸入有效的 Google 試算表連結' });
    }
    const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!m) return res.status(400).json({ error: '無法解析試算表 ID' });
    const gidMatch = url.match(/[#&]gid=(\d+)/);
    const exportUrl = `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv` + (gidMatch ? `&gid=${gidMatch[1]}` : '');
    const text = await httpsGetText(exportUrl);
    if (text.startsWith('<')) return res.status(400).json({ error: '無法讀取，請確認試算表已設為「知道連結的人皆可查看」' });
    res.json({ ok: true, text: text.slice(0, 20000) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 上傳的 Excel（.xlsx，base64）→ 第一個工作表轉成 TSV 文字（供 AI 匯入解析）
app.post('/api/excel-to-text', requireRole('supervisor'), async (req, res) => {
  try {
    const { base64 } = req.body;
    if (!base64) return res.status(400).json({ error: '缺少檔案內容' });
    const ExcelJS = require('exceljs');
    const buf = Buffer.from(String(base64).replace(/^data:[^;]*;base64,/, ''), 'base64');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ error: '檔案中找不到工作表' });
    const cellText = v => {
      if (v == null) return '';
      if (typeof v === 'object') {
        if (v instanceof Date) { const p = n => String(n).padStart(2,'0'); return `${v.getFullYear()}/${p(v.getMonth()+1)}/${p(v.getDate())}`; }
        if (v.text != null) return String(v.text);
        if (v.result != null) return String(v.result);
        if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
        if (v.hyperlink) return String(v.hyperlink);
        return '';
      }
      return String(v);
    };
    const lines = [];
    ws.eachRow({ includeEmpty: false }, row => {
      const arr = Array.isArray(row.values) ? row.values.slice(1) : [];
      const vals = arr.map(c => cellText(c).trim());
      if (vals.some(x => x !== '')) lines.push(vals.join('\t'));
    });
    if (!lines.length) return res.status(400).json({ error: '工作表沒有資料' });
    res.json({ ok: true, text: lines.join('\n').slice(0, 20000) });
  } catch(e) {
    console.error('[excel-to-text]', e.message);
    res.status(500).json({ error: '解析失敗（請確認是 .xlsx 檔）：' + e.message });
  }
});

app.post('/api/gemini/extract-task', requireRole('supervisor'), async (req, res) => {
  try {
    const { text, tasks, companies, partners, customFields, mode } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: '請輸入要解析的文字' });
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'GEMINI_API_KEY 未設定' });

    const cfDesc = (customFields || []).map(f =>
      `- ${f.label}（${f.type}${f.options && f.options.length ? '，選項：' + f.options.join('/') : ''}${f.task_name ? '，僅用於任務「' + f.task_name + '」' : '，所有任務通用'}）`
    ).join('\n') || '（無）';

    const todayStr = nowTW().split(' ')[0]; // YYYY/MM/DD

    if (mode === 'free') {
      const freePrompt = `你是任務派案助手。請從以下文字中解析出「自由任務」資訊，並以 JSON 格式回傳，只回傳 JSON 不要其他文字。

今天日期：${todayStr}

可選任務名稱：${(tasks || []).join('、')}
可選公司名稱：${(companies || []).join('、')}

請回傳一個 JSON 物件（不是陣列），格式如下：
{
  "task_name": "從可選任務名稱中選最符合的，找不到則空字串",
  "company": "從可選公司名稱中選最符合的，找不到則空字串",
  "unit_price": "單價，數字字串，找不到則空字串",
  "total_qty": "總名額數量，數字字串。若原文說不限/無限/不限名額，則留空字串",
  "qty_unlimited": "布林值 true/false。原文若為不限名額則 true，否則 false",
  "deadline_days": "完成期限天數，數字字串。原文是天數直接用；是日期則換算成從今天起的剩餘天數（至少1）；找不到則空字串",
  "publish_end": "發布截止日，格式 YYYY/MM/DD。原文若為永久/長期/不限則留空字串；找不到也留空字串",
  "notes": "補充說明文字，找不到則空字串"
}

重要規則：
- 自由任務是「一個開放任務池」，不是多列名額，請只回傳「一個」JSON 物件。
- 自由任務為公開接案、不指定人，請忽略任何人名/指派對象欄位。
- publish_end 是「發布截止日」（過了就不能再接），deadline_days 是「接案後幾天內完成」，兩者不同，請勿混淆。
- 只回傳 JSON 物件，不要其他文字或說明。

文字內容：
"""
${text}
"""`;
      const body = JSON.stringify({ contents: [{ parts: [{ text: freePrompt }] }], generationConfig: { temperature: 0.1 } });
      const result = await geminiPost(apiKey, body);
      if (result.error) return res.json({ ok: false, error: result.error.message || JSON.stringify(result.error) });
      const raw = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      console.log('[Gemini extract-task free raw]', raw.slice(0, 300));
      const objIdx = raw.indexOf('{');
      if (objIdx === -1) return res.json({ ok: false, error: 'AI 未回傳 JSON：' + raw.slice(0,150) });
      let depth = 0, end = -1, inStr = false, esc = false;
      for (let i = objIdx; i < raw.length; i++) {
        const ch = raw[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end === -1) return res.json({ ok: false, error: 'AI 回傳的 JSON 不完整：' + raw.slice(0,150) });
      const data = JSON.parse(raw.slice(objIdx, end + 1));
      return res.json({ ok: true, data });
    }

    if (mode === 'grab') {
      const grabPrompt = `你是任務派案助手。請從以下文字中解析出「搶單任務」資訊，並以 JSON 格式回傳，只回傳 JSON 不要其他文字。

今天日期：${todayStr}

可選任務名稱：${(tasks || []).join('、')}
可選公司名稱：${(companies || []).join('、')}
夥伴姓名（僅供辨識，搶單為公開搶單，不指定人）：${(partners || []).join('、')}

自訂欄位定義（label 必須完全照抄）：
${cfDesc}

請回傳一個 JSON 物件（不是陣列），格式如下：
{
  "task_name": "從可選任務名稱中選最符合的，找不到則空字串",
  "company": "從可選公司名稱中選最符合的，找不到則空字串",
  "unit_price": "單價，數字字串，找不到則空字串",
  "notes": "整體備註文字，找不到則空字串",
  "slots": [
    {
      "work_date": "此列的執行日期，格式 YYYY/MM/DD。若原文有「執行日期」欄位請原樣填入該日期（不要換算成天數）；找不到則空字串",
      "deadline_days": "此列的完成期限天數，數字字串。僅當原文有「完成期限」欄位時：若是天數直接使用，若是日期請換算成從今天到該日期的剩餘天數（至少為1）；找不到則空字串",
      "custom_fields": [{"label":"欄位名稱","value":"解析出的值"}]
    }
  ]
}

重要規則：
- 文字內容通常是表格（含表頭與多列資料），請忽略表頭，為「每一列資料」各產生一個 slots 陣列元素（依原始順序，陣列長度 = 資料列數，也就是搶單總名額數）。
- task_name / company / unit_price / notes 這些欄位通常每列相同，取共同值或第一筆即可，不放入 slots。
- ⚠️「執行日期」與「完成期限」是兩個不同欄位：「執行日期」是某一天的日期，請放入 work_date 並保持 YYYY/MM/DD 日期格式，絕對不要換算成天數；「完成期限」才是天數（或換算成天數）。原文若只有「執行日期」就只填 work_date、deadline_days 留空。
- work_date 與 deadline_days 每一列可能不同，請務必逐列分別解析，放入該列對應的 slots 元素中。
- custom_fields：若欄位名稱出現在上方「自訂欄位定義」中，label 必須與定義完全一致。若出現定義以外的欄位（例如「評分」、「補充說明」），也請一併放入 custom_fields，label 直接使用該欄位在原文中的名稱即可。
- ⚠️ 搶單為公開搶單，不指定人。若表格中有「指派給／派給／負責人／夥伴／執行人」之類的人名欄位，請完全忽略，不要放入 custom_fields，也不要回傳。
- 只回傳 JSON 物件，不要其他文字或說明。

文字內容：
"""
${text}
"""`;

      const body = JSON.stringify({
        contents: [{ parts: [{ text: grabPrompt }] }],
        generationConfig: { temperature: 0.1 }
      });
      const result = await geminiPost(apiKey, body);
      if (result.error) return res.json({ ok: false, error: result.error.message || JSON.stringify(result.error) });
      const raw = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      console.log('[Gemini extract-task grab raw]', raw.slice(0, 300));
      const objIdx = raw.indexOf('{');
      if (objIdx === -1) return res.json({ ok: false, error: 'AI 未回傳 JSON：' + raw.slice(0,150) });
      let depth = 0, end = -1, inStr = false, esc = false;
      for (let i = objIdx; i < raw.length; i++) {
        const ch = raw[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end === -1) return res.json({ ok: false, error: 'AI 回傳的 JSON 不完整：' + raw.slice(0,150) });
      const data = JSON.parse(raw.slice(objIdx, end + 1));
      return res.json({ ok: true, data });
    }

    // 基礎資料匯入：從文字中整理 公司清單、任務名稱＋單價（任務與單價連結）
    if (mode === 'base-data') {
      const basePrompt = `你是資料整理助手。請從以下文字中整理出「公司名稱清單」與「任務名稱＋單價清單」，以 JSON 物件回傳，只回傳 JSON 不要其他文字。

現有公司：${(companies || []).join('、') || '（無）'}
現有任務：${(tasks || []).join('、') || '（無）'}

請回傳格式：
{
  "companies": ["公司名稱1", "公司名稱2"],
  "tasks": [{ "name": "任務名稱", "unit_price": "單價，數字字串，找不到則空字串" }]
}

重要規則：
- ⚠️ 只能輸出「文字內容中實際出現」的名稱。現有清單僅用於統一寫法（全半形、多餘空白差異時採用清單寫法），絕對不可把清單中有、但文字中沒出現的名稱加進結果。
- ⚠️ 任務名稱逐列「照原文抄錄」，每個不同的任務名稱都要各自列出，嚴禁合併、歸類或改寫成其他類似名稱（例如原文是「Mobile01回文」就輸出「Mobile01回文」，不可改成「口碑評論」）。
- 逐列掃描文字，收集出現過的所有「公司名稱」與「任務名稱」，各自去除重複（完全相同者才算重複）。
- 任務與單價要配對：同一列中任務名稱旁的單價就是該任務的單價；同一任務出現多個不同單價時，取出現次數最多者。
- 單價只填數字；找不到單價的任務 unit_price 填空字串。
- 「留言內容」「網址」「執行日期」「備註」等資料欄位內容不是任務或公司名稱，請忽略。
- 只回傳 JSON 物件，不要其他文字或說明。

文字內容：
"""
${text}
"""`;
      const body = JSON.stringify({ contents: [{ parts: [{ text: basePrompt }] }], generationConfig: { temperature: 0.1 } });
      const result = await geminiPost(apiKey, body);
      if (result.error) return res.json({ ok: false, error: result.error.message || JSON.stringify(result.error) });
      const raw = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      console.log('[Gemini extract-task base-data raw]', raw.slice(0, 300));
      const objIdx = raw.indexOf('{');
      if (objIdx === -1) return res.json({ ok: false, error: 'AI 未回傳 JSON：' + raw.slice(0,150) });
      let depth = 0, end = -1, inStr = false, esc = false;
      for (let i = objIdx; i < raw.length; i++) {
        const ch = raw[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end === -1) return res.json({ ok: false, error: 'AI 回傳的 JSON 不完整：' + raw.slice(0,150) });
      const data = JSON.parse(raw.slice(objIdx, end + 1));
      return res.json({
        ok: true,
        companies: Array.isArray(data.companies) ? data.companies : [],
        tasks: Array.isArray(data.tasks) ? data.tasks : [],
      });
    }

    // 自動分組：每列各自解析任務／公司，前端依(任務+公司)自動分組建立多個限量任務
    if (mode === 'grab-auto') {
      const multiPrompt = `你是任務派案助手。請從以下文字中解析出「限量任務資料列」，每一列資料各自解析，並以 JSON 物件回傳，只回傳 JSON 不要其他文字。

今天日期：${todayStr}

現有任務名稱（僅供正名參考）：${(tasks || []).join('、') || '（無）'}
現有公司名稱（僅供正名參考）：${(companies || []).join('、') || '（無）'}

自訂欄位定義（label 必須完全照抄）：
${cfDesc}

請回傳一個 JSON 物件（不是陣列），格式如下：
{
  "rows": [
    {
      "task_name": "此列的任務名稱，照原文填入；若與現有任務名稱相同或僅寫法差異，請用現有清單的寫法",
      "company": "此列的公司名稱，照原文填入；若與現有公司名稱相同或僅寫法差異，請用現有清單的寫法",
      "unit_price": "此列單價，數字字串，找不到則空字串",
      "work_date": "此列的執行日期，格式 YYYY/MM/DD，原文有就原樣填入（不要換算成天數），沒有則空字串",
      "deadline_days": "此列完成期限天數，數字字串。天數直接用；日期換算成從今天到該日的剩餘天數(至少1)；找不到則空字串",
      "notes": "僅當原文欄位名稱就是「備註」時才填入該欄的值，否則一律空字串",
      "custom_fields": [{"label":"欄位名稱","value":"解析出的值"}]
    }
  ]
}

重要規則：
- 文字通常是表格（含表頭與多列資料）：忽略表頭，為「每一列資料」各產生一個 rows 元素，依原始順序，不要自行合併或省略任何一列。
- task_name 與 company 每一列可能不同，請逐列各自解析，同列的值對應該列；名稱不在現有清單中也照原文填入，不要留空。
- ⚠️「執行日期」是某一天(放 work_date、保持日期格式)，「完成期限」才是天數(放 deadline_days)，勿混淆。
- custom_fields：欄位名稱出現在上方「自訂欄位定義」中則 label 必須完全一致；定義以外的欄位（例如「評分」、「網址」、「留言內容」）也請一併放入 custom_fields，label 直接用原文名稱。
- ⚠️ notes 只收欄位名稱為「備註」的內容；「留言內容」「內容」「說明」等其他文字欄位屬於該列資料，必須放在該列的 custom_fields，絕對不要抬升為 notes。
- ⚠️ 限量任務為公開認領，不指定人。「指派給／派給／負責人／夥伴／執行人」之類的人名欄位請完全忽略。
- 只回傳 JSON 物件，不要其他文字或說明。

文字內容：
"""
${text}
"""`;
      const body = JSON.stringify({ contents: [{ parts: [{ text: multiPrompt }] }], generationConfig: { temperature: 0.1 } });
      const result = await geminiPost(apiKey, body);
      if (result.error) return res.json({ ok: false, error: result.error.message || JSON.stringify(result.error) });
      const raw = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      console.log('[Gemini extract-task grab-auto raw]', raw.slice(0, 300));
      const objIdx = raw.indexOf('{');
      if (objIdx === -1) return res.json({ ok: false, error: 'AI 未回傳 JSON：' + raw.slice(0,150) });
      let depth = 0, end = -1, inStr = false, esc = false;
      for (let i = objIdx; i < raw.length; i++) {
        const ch = raw[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end === -1) return res.json({ ok: false, error: 'AI 回傳的 JSON 不完整：' + raw.slice(0,150) });
      const data = JSON.parse(raw.slice(objIdx, end + 1));
      return res.json({ ok: true, rows: Array.isArray(data.rows) ? data.rows : [] });
    }

    const prompt = `你是任務派案助手。請從以下文字中解析出派案資訊，並以 JSON 格式回傳，只回傳 JSON 不要其他文字。

今天日期：${todayStr}

可選任務名稱：${(tasks || []).join('、')}
可選公司名稱：${(companies || []).join('、')}
可選夥伴姓名：${(partners || []).join('、')}

自訂欄位定義（label 必須完全照抄）：
${cfDesc}

請回傳一個 JSON 陣列，陣列中每個物件代表「一筆派案」，格式如下：
[
  {
    "task_name": "從可選任務名稱中選最符合的，找不到則空字串",
    "company": "從可選公司名稱中選最符合的，找不到則空字串",
    "target_name": "從可選夥伴姓名中選最符合的，找不到則空字串",
    "qty": "數量，數字字串，找不到則空字串",
    "price": "單價，數字字串，找不到則空字串",
    "deadline_days": "完成期限天數，數字字串。若原文是天數（例如「3天內」）直接使用；若原文是日期（例如「2026/06/20」或「6/20」），請換算成從今天日期到該日期的剩餘天數（至少為1）；找不到則空字串",
    "notes": "補充說明文字，找不到則空字串",
    "custom_fields": [{"label":"欄位名稱","value":"解析出的值"}]
  }
]

重要規則：
- 若文字內容是表格（例如試算表，含表頭與多列資料），請忽略表頭，為「每一列資料」各產生一個物件，組成陣列（陣列長度 = 資料列數）。
- 若文字內容只是單一段敘述（非表格），陣列內只放一個物件即可。
- custom_fields：若欄位名稱出現在上方「自訂欄位定義」中，label 必須與定義完全一致（且符合所選任務）。若出現上方定義以外的欄位/欄位標題（例如「評分」），也請一併放入 custom_fields，label 直接使用該欄位在原文中的名稱即可，不需事先定義。
- ⚠️ 「指派給／派給／負責人／夥伴／執行人」之類的人名欄位，請只放入 target_name（對應到可選夥伴姓名），不要再重複放入 custom_fields。
- 只回傳 JSON 陣列，不要其他文字或說明。

文字內容：
"""
${text}
"""`;

    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1 }
    });

    const result = await geminiPost(apiKey, body);
    if (result.error) return res.json({ ok: false, error: result.error.message || JSON.stringify(result.error) });
    const raw = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log('[Gemini extract-task raw]', raw.slice(0, 300));
    // 找出第一個 [ 或 { 開始，計算括號平衡找出完整的 JSON（陣列或物件，避免AI多回傳內容導致解析失敗）
    const arrIdx = raw.indexOf('['); const objIdx = raw.indexOf('{');
    let start = -1, openCh, closeCh;
    if (arrIdx !== -1 && (objIdx === -1 || arrIdx < objIdx)) { start = arrIdx; openCh = '['; closeCh = ']'; }
    else if (objIdx !== -1) { start = objIdx; openCh = '{'; closeCh = '}'; }
    if (start === -1) return res.json({ ok: false, error: 'AI 未回傳 JSON：' + raw.slice(0,150) });
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === openCh) depth++;
      else if (ch === closeCh) { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) return res.json({ ok: false, error: 'AI 回傳的 JSON 不完整：' + raw.slice(0,150) });
    let data = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(data)) data = [data];
    res.json({ ok: true, data });
  } catch(e) { console.error('[extract-task]', e); res.status(500).json({ error: e.message }); }
});

// ── Firebase Client Config（給前端 onSnapshot 用）────────────
app.get('/api/firebase-config', requireAuth, (req, res) => {
  res.json({
    apiKey:            process.env.FIREBASE_WEB_API_KEY   || '',
    authDomain:        process.env.FIREBASE_AUTH_DOMAIN   || 'hiban-workspace-c6b5c.firebaseapp.com',
    projectId:         process.env.FIREBASE_PROJECT_ID    || 'hiban-workspace-c6b5c',
    storageBucket:     process.env.FIREBASE_STORAGE_BUCKET|| 'hiban-workspace-c6b5c.appspot.com',
    messagingSenderId: process.env.FIREBASE_SENDER_ID     || '',
    appId:             process.env.FIREBASE_APP_ID        || '',
  });
});

// 更改任務完成日期（只能延後）
app.put('/api/admin/assignments/:id/change-completed-at', requireRole('staff'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { new_date } = req.body; // "YYYY/MM/DD"
    if (!new_date) return res.status(400).json({ error: '缺少日期' });
    const a = await Assignments.byId(id);
    if (!a) return res.status(404).json({ error: '任務不存在' });
    if (a.status !== 'completed') return res.status(400).json({ error: '僅已完成任務可更改日期' });
    // 保留原始時間，只換日期部分
    const oldDate = (a.completed_at || '').split(' ')[0];
    const oldTime = (a.completed_at || '').split(' ')[1] || '00:00:00';
    if (new_date < oldDate) return res.status(400).json({ error: '新日期不能早於原完成日期' });
    const staffName = req.session.user.real_name || req.session.user.username;
    const patch = {
      completed_at: `${new_date} ${oldTime}`,
      completed_at_original: a.completed_at_original || a.completed_at,
      completed_at_changed_by: staffName,
      completed_at_changed_at: nowTW(),
    };
    await Assignments.update(id, patch);
    cacheClear('sup-'); // 更改完成日期 → 清派案人員儀表板快取（影響當月統計）
    await logTaskAction(req, '更改完成日期', `${a.task_name}${a.task_no ? ' #'+a.task_no : ''}：${oldDate} → ${new_date}`, { type: 'assignment', id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 資料管理 ──────────────────────────────────────────────────

// 資料健檢：重複註冊、孤兒資料、測試資料殘留
app.get('/api/admin/data-health', requireRole('staff'), async (req, res) => {
  try {
    const [users, assignments, wSnap, xSnap] = await Promise.all([
      Users.all(), Assignments.all(), db.collection('worklog_reports').get(), db.collection('xp_logs').get(),
    ]);
    const worklogs = wSnap.docs.map(d => d.data());
    const xpLogs = xSnap.docs.map(d => d.data());
    const userIds = new Set(users.map(u => u.id));
    const assignIds = new Set(assignments.map(a => a.id));

    // 1. 重複註冊（同身分證）
    const byIdno = {};
    users.forEach(u => { if (u.id_number) (byIdno[u.id_number] = byIdno[u.id_number] || []).push(u); });
    const duplicate_users = Object.entries(byIdno).filter(([, arr]) => arr.length > 1)
      .map(([idn, arr]) => ({
        id_number: idn.slice(0, 4) + '***',
        users: arr.map(u => ({ id: u.id, real_name: u.real_name, username: u.username, status: u.status, partner_no: u.partner_no || null })),
      }));

    // 2. 孤兒任務（accepted_by 指向不存在的帳號）
    const orphan_assignments = assignments
      .filter(a => a.accepted_by && !userIds.has(a.accepted_by))
      .map(a => ({ id: a.id, task_name: a.task_name, accepted_by: a.accepted_by }));

    // 3. 孤兒回報（assignment_id 不存在）
    const orphan_worklogs = worklogs
      .filter(w => w.assignment_id && !assignIds.has(w.assignment_id))
      .map(w => ({ id: w.id, assignment_id: w.assignment_id }));

    // 4. 孤兒成長紀錄（xp_logs 對應的任務已不存在；成長頁有、任務頁無）
    const orphan_xp_logs = xpLogs.filter(l => !assignments.some(a =>
      a.accepted_by === l.userId && (a.task_name || '') === (l.taskTitle || '') && (a.company || '') === (l.companyName || '')
    )).length;

    // 5. 測試資料殘留（test_seed）
    const test_seed_assignments = assignments.filter(a => a.test_seed).length;

    // 5. 啟用帳號缺必要欄位（姓名／身分證／銀行帳號）
    const incomplete_users = users
      .filter(u => u.role === 'partner' && u.status === 'active' && (!u.real_name || !u.id_number || !u.bank_account))
      .map(u => ({ id: u.id, real_name: u.real_name || '（無姓名）', username: u.username,
        missing: [!u.real_name && '姓名', !u.id_number && '身分證', !u.bank_account && '銀行帳號'].filter(Boolean) }));

    const issues = duplicate_users.length + orphan_assignments.length + orphan_worklogs.length + orphan_xp_logs + test_seed_assignments + incomplete_users.length;
    res.json({
      checked_at: nowTW(),
      counts: { users: users.length, assignments: assignments.length, worklogs: worklogs.length, xp_logs: xpLogs.length },
      issues_total: issues,
      duplicate_users, orphan_assignments, orphan_worklogs, orphan_xp_logs, test_seed_assignments, incomplete_users,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 概況統計
app.get('/api/admin/db-stats', requireRole('staff'), async (req, res) => {
  try {
    const [uSnap, aSnap, wSnap, gSnap, arSnap, awSnap] = await Promise.all([
      db.collection('users').get(),
      db.collection('assignments').get(),
      db.collection('worklog_reports').get(),
      db.collection('grab_tasks').get(),
      db.collection('archived_assignments').get(),
      db.collection('archived_worklog_reports').get(),
    ]);
    const assignments = aSnap.docs.map(d => d.data());
    const completed = assignments.filter(a => a.status === 'completed').length;
    const allDates = assignments.map(a => a.created_at).filter(Boolean).sort();
    const earliest = allDates[0] ? allDates[0].split('T')[0] : null;
    // 預估容量（KB）：各集合文件數 × 平均大小
    const estKB = Math.round(
      uSnap.size * 4 + aSnap.size * 5 + wSnap.size * 3 +
      gSnap.size * 4 + arSnap.size * 5 + awSnap.size * 3
    );
    res.json({
      users: uSnap.size,
      active_users: uSnap.docs.filter(d => d.data().status === 'active').length,
      inactive_users: uSnap.docs.filter(d => d.data().status === 'inactive').length,
      assignments: aSnap.size,
      completed,
      worklog_reports: wSnap.size,
      grab_tasks: gSnap.size,
      archived_assignments: arSnap.size,
      archived_worklog_reports: awSnap.size,
      earliest_date: earliest,
      estimated_kb: estKB,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 預覽封存/刪除筆數
app.get('/api/admin/data-preview', requireRole('staff'), async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 12;
    const action = req.query.action || 'archive'; // archive | delete
    const cutoff = (() => {
      const d = new Date(); d.setMonth(d.getMonth() - months);
      return d.toISOString().split('T')[0];
    })();
    const col = action === 'delete' ? 'archived_assignments' : 'assignments';
    const wCol = action === 'delete' ? 'archived_worklog_reports' : 'worklog_reports';
    const [aSnap, wSnap] = await Promise.all([
      db.collection(col).get(),
      db.collection(wCol).get(),
    ]);
    const aCount = aSnap.docs.filter(d => {
      const data = d.data();
      const dt = (action === 'archive' ? data.completed_at : data.archived_at) || data.created_at || '';
      return data.status === 'completed' && dateKey(dt) < cutoff;
    }).length;
    const wCount = wSnap.docs.filter(d => {
      const dt = d.data().archived_at || d.data().created_at || '';
      return dateKey(dt) < cutoff;
    }).length;
    res.json({ assignments: aCount, worklog_reports: wCount, cutoff });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 執行封存
app.post('/api/admin/data-archive', requireRole('staff'), async (req, res) => {
  try {
    const { retain_months } = req.body;
    const months = parseInt(retain_months) || 12;
    const cutoff = (() => {
      const d = new Date(); d.setMonth(d.getMonth() - months);
      return d.toISOString().split('T')[0];
    })();
    const aSnap = await db.collection('assignments').get();
    const toArchive = aSnap.docs.filter(d => {
      const data = d.data();
      const dt = data.completed_at || data.created_at || '';
      return data.status === 'completed' && dateKey(dt) < cutoff;
    });
    let aCount = 0, wCount = 0;
    for (const doc of toArchive) {
      const data = doc.data();
      const archiveData = { ...data, archived_at: nowTW() };
      await db.collection('archived_assignments').doc(doc.id).set(archiveData);
      await db.collection('assignments').doc(doc.id).delete();
      // 封存對應的 worklog_reports
      const wSnap = await db.collection('worklog_reports')
        .where('assignment_id', '==', data.id).get();
      for (const wDoc of wSnap.docs) {
        await db.collection('archived_worklog_reports').doc(wDoc.id)
          .set({ ...wDoc.data(), archived_at: nowTW() });
        await db.collection('worklog_reports').doc(wDoc.id).delete();
        wCount++;
      }
      aCount++;
    }
    res.json({ ok: true, archived_assignments: aCount, archived_worklog_reports: wCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 永久刪除（封存集合，5年以上才允許）
app.post('/api/admin/data-delete', requireRole('staff'), async (req, res) => {
  try {
    const { delete_before_months, confirm_text } = req.body;
    if (confirm_text !== 'DELETE') return res.status(400).json({ error: '確認文字錯誤' });
    const months = parseInt(delete_before_months) || 60;
    if (months < 60) return res.status(400).json({ error: '依法規不得刪除未滿 5 年的資料' });
    const cutoff = (() => {
      const d = new Date(); d.setMonth(d.getMonth() - months);
      return d.toISOString().split('T')[0];
    })();
    const [aSnap, wSnap] = await Promise.all([
      db.collection('archived_assignments').get(),
      db.collection('archived_worklog_reports').get(),
    ]);
    let aCount = 0, wCount = 0;
    for (const doc of aSnap.docs) {
      const dt = doc.data().archived_at || doc.data().completed_at || '';
      if (dateKey(dt) < cutoff) {
        await db.collection('archived_assignments').doc(doc.id).delete();
        aCount++;
      }
    }
    for (const doc of wSnap.docs) {
      const dt = doc.data().archived_at || doc.data().created_at || '';
      if (dateKey(dt) < cutoff) {
        await db.collection('archived_worklog_reports').doc(doc.id).delete();
        wCount++;
      }
    }
    res.json({ ok: true, deleted_assignments: aCount, deleted_worklog_reports: wCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 手動立即備份（type: 'data' 不含圖片 | 'full' 含圖片）
app.post('/api/admin/backup/run', requireRole('staff'), async (req, res) => {
  try {
    const mode = req.body && req.body.type === 'full' ? 'full' : 'data';
    res.json(await backupToDrive(mode));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 備份清單
app.get('/api/admin/backup/list', requireRole('staff'), async (req, res) => {
  try {
    const drive  = getDrive();
    const rootId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!drive || !rootId) return res.json({ configured: false, files: [] });
    const dirId = await driveEnsureFolder(drive, '資料庫備份', rootId);
    const list = await drive.files.list({
      q: `'${dirId}' in parents and trashed=false and name contains 'hiban-'`,
      fields: 'files(id,name,size,createdTime)', orderBy: 'name desc', pageSize: 80,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    res.json({ configured: true, files: (list.data.files || []).map(f => ({
      id: f.id, name: f.name, size: Number(f.size || 0), created: f.createdTime,
    })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 從備份還原（寫回 Firestore，覆蓋同 ID 文件；含子集合/圖片）
app.post('/api/admin/backup/restore', requireRole('staff'), async (req, res) => {
  try {
    const { file_id, confirm_text, collections } = req.body;
    if (confirm_text !== 'RESTORE') return res.status(400).json({ error: '確認文字錯誤（需輸入 RESTORE）' });
    if (!file_id) return res.status(400).json({ error: '請選擇要還原的備份' });
    const drive = getDrive();
    if (!drive) return res.status(503).json({ error: 'Drive 未設定' });

    // 下載備份 JSON
    const dl = await drive.files.get(
      { fileId: file_id, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );
    const payload = JSON.parse(Buffer.from(dl.data).toString('utf8'));
    if (!payload || !payload.data) return res.status(400).json({ error: '備份格式不正確（需 v2-full）' });

    const only = (Array.isArray(collections) && collections.length) ? new Set(collections) : null;
    const counter = { docs: 0 };
    let batch = db.batch(), n = 0;
    const flush = async (force) => { if (n >= 400 || (force && n > 0)) { await batch.commit(); batch = db.batch(); n = 0; } };
    const restoreCol = async (colRef, entries) => {
      for (const e of entries) {
        if (!e || e.id == null) continue;
        const ref = colRef.doc(String(e.id));
        batch.set(ref, e.data || {}); n++; counter.docs++;
        await flush(false);
        if (e.sub) for (const subName in e.sub) await restoreCol(ref.collection(subName), e.sub[subName]);
      }
    };
    for (const col in payload.data) {
      if (only && !only.has(col)) continue;
      await restoreCol(db.collection(col), payload.data[col]);
    }
    await flush(true);
    cacheClear(''); // 清所有快取
    res.json({ ok: true, restored_docs: counter.docs, backup_at: payload.backup_meta?.backup_at || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 個資即將/已到期清單
app.get('/api/admin/users/expiring-data', requireRole('staff'), async (req, res) => {
  try {
    const snap = await db.collection('users')
      .where('status', '==', 'inactive').get();
    const today = new Date().toISOString().split('T')[0];
    const warn = new Date(); warn.setMonth(warn.getMonth() + 3);
    const warnStr = warn.toISOString().split('T')[0];
    const list = snap.docs.map(d => d.data())
      .filter(u => u.left_at && u.data_retain_until)
      .map(u => ({
        id: u.id,
        real_name: u.real_name || '（未知）',
        username: u.username,
        left_at: u.left_at,
        data_retain_until: u.data_retain_until,
        data_anonymized: u.data_anonymized || false,
        expired: u.data_retain_until < today,
        expiring_soon: u.data_retain_until >= today && u.data_retain_until <= warnStr,
      }))
      .filter(u => u.expired || u.expiring_soon)
      .sort((a, b) => a.data_retain_until.localeCompare(b.data_retain_until));
    res.json(list);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 匿名化
app.put('/api/admin/users/:id/anonymize', requireRole('staff'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const u = await Users.byId(id);
    if (!u) return res.status(404).json({ error: '帳號不存在' });
    if (u.status !== 'inactive') return res.status(400).json({ error: '僅停用帳號可匿名化' });
    await Users.update(id, {
      real_name: '（已匿名）',
      id_number: '',
      phone: '',
      address: '',
      mailing_address: '',
      bank_account: '',
      bank_holder: '',
      bank_name: '',
      bank_branch: '',
      bank_code: '',
      data_anonymized: true,
    });
    // 刪除身分證 / 存簿圖片
    const imgSnap = await db.collection('users').doc(String(id))
      .collection('blobs').get();
    for (const d of imgSnap.docs) await d.ref.delete();
    cacheDel('users-list');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 自動封存設定讀寫
app.get('/api/admin/auto-archive-config', requireRole('staff'), async (req, res) => {
  try {
    const doc = await db.collection('settings').doc('auto_archive').get();
    res.json(doc.exists ? doc.data() : { enabled: false, day: 1, retain_months: 12, last_run: null, last_count: 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/auto-archive-config', requireRole('staff'), async (req, res) => {
  try {
    const { enabled, day, retain_months } = req.body;
    await db.collection('settings').doc('auto_archive').set(
      { enabled: !!enabled, day: parseInt(day)||1, retain_months: parseInt(retain_months)||12 },
      { merge: true }
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\nServer started: http://localhost:' + PORT);
  console.log('Firestore connected to project: hiban-workspace-c6b5c');
});
