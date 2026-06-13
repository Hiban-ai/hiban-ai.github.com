const express    = require('express');
const session    = require('express-session');
const bcrypt     = require('bcryptjs');
const path       = require('path');
const cron       = require('node-cron');
const https = require('https');
const { Users, ForgotReqs, Assignments, WorklogReports, UserImages, Announcements, GrabTasks, GrabRecords, Reports, ReportImages, db: firestoreDb, getTrafficStats, LEVELS, LEVEL_THRESHOLDS, calculateLevel, xpToNextLevel, levelInfo, getLevelsWithThresholds, BADGES, XPConfig, XPLogs, grantTaskXP } = require('./db');

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

const app = express();
app.use(express.json({ limit: '20mb' }));
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
  let filtered = users.filter(u => u.status === 'active');
  if (role) filtered = filtered.filter(u => u.role === role);
  if (req.session.user?.role === 'supervisor' && role === 'partner') {
    filtered = filtered.filter(u => u.supervisor_id === req.session.user.id);
  }
  res.json(filtered.map(u => ({ id: u.id, username: u.username, real_name: u.real_name, nickname: u.nickname, login_dates: u.login_dates || [] })));
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
    const user = await Users.byName(username);
    if (!user) return res.status(401).json({ error: 'Account not found' });
    if (user.status === 'pending')  return res.status(403).json({ error: 'Account pending approval' });
    if (user.status === 'inactive') return res.status(403).json({ error: 'Account disabled' });
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
app.get('/api/announcements', requireAuth, async (req, res) => {
  try {
    const role = req.session.user.role;
    const now  = new Date();
    let list = cacheGet('announcements');
    if (!list) { list = await Announcements.all(); cacheSet('announcements', list, 3 * 60 * 1000); }
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
    // 任務名稱與督導設定的任務類型一致
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

app.get('/api/profile', requireAuth, async (req, res) => {
  try {
    const u = await Users.byId(req.session.user.id);
    if (!u) return res.status(404).json({ error: 'Not found' });
    const { id, username, real_name, role, status, id_number, birthday, phone, address, email,
            identity, bank_name, bank_branch, bank_account, bank_holder } = u;
    res.json({ id, username, real_name, role, status, id_number, birthday, phone, address, email,
               identity, bank_name, bank_branch, bank_account, bank_holder });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/profile', requireAuth, async (req, res) => {
  try {
    const role    = req.session.user.role;
    const allowed = ['phone','address','email'];
    const patch   = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) patch[f] = req.body[f]; });
    await Users.update(req.session.user.id, patch);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/profile/bank', requireAuth, async (req, res) => {
  try {
    if (req.session.user.role !== 'partner') return res.status(403).json({ error: 'Forbidden' });
    const { bank_name, bank_branch, bank_account, bank_holder } = req.body;
    await Users.update(req.session.user.id, { bank_name, bank_branch, bank_account, bank_holder });
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
    const { email, gender, nickname, identity, bank_type, bank_name, bank_branch, bank_account, bank_holder, post_office_code,
            id_front_b64, id_back_b64, bank_b64 } = req.body;
    if (!email) return res.status(400).json({ error: 'Missing email' });
    const base     = real_name.charCodeAt(0).toString(36);
    const username = await generateUsername('user_' + base);
    const newUser = await Users.create({
      username, real_name, id_number, birthday, phone, address,
      email: email || null, gender: gender || null,
      nickname: nickname || null, identity: identity || null,
      bank_type: bank_type || null,
      bank_name: bank_name || null, bank_branch: bank_branch || null,
      bank_account: bank_account || null, bank_holder: bank_holder || null,
      post_office_code: post_office_code || null,
      role: 'partner', status: 'pending', is_first_login: true,
      password_hash: bcrypt.hashSync('0000', 10),
    });

    // 儲存圖片（背景，不阻塞）
    console.log(`[UserImages] front=${id_front_b64?.length||0} back=${id_back_b64?.length||0} bank=${bank_b64?.length||0}`);
    if (id_front_b64 || id_back_b64 || bank_b64) {
      UserImages.save(newUser.id, { front: id_front_b64||'', back: id_back_b64||'', bank: bank_b64||'' })
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
    const { role, real_name, id_number, birthday, phone, email, address, identity, is_admin } = req.body;
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
      identity: identity || null,
      is_admin: role === 'staff' && !!is_admin,
      role, status: 'active', is_first_login: true,
      password_hash: bcrypt.hashSync('0000', 10),
    });
    res.json({ ok: true, username: user.username });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/users/:id/approve', requireRole('staff'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const user = await Users.byId(id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    // 工作夥伴核准時必須指定督導
    if (user.role === 'partner') {
      const { supervisor_id } = req.body;
      if (!supervisor_id) return res.status(400).json({ error: '請選擇負責督導人員' });
      const sv = await Users.byId(parseInt(supervisor_id));
      if (!sv || sv.role !== 'supervisor') return res.status(400).json({ error: '無效的督導人員' });
      await Users.update(id, { status: 'active', supervisor_id: parseInt(supervisor_id) });
    } else {
      await Users.update(id, { status: 'active' });
    }
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
              if (sv) svLine = `<p>您的負責督導人員為 <strong>${sv.real_name}</strong>，如有任何問題歡迎與督導聯繫。</p>`;
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
    if (!supervisor_id) return res.status(400).json({ error: '請選擇督導人員' });
    const sv = await Users.byId(parseInt(supervisor_id));
    if (!sv || sv.role !== 'supervisor') return res.status(400).json({ error: '無效的督導人員' });
    await Users.update(id, { supervisor_id: parseInt(supervisor_id) });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/users/:id/deactivate', requireRole('staff'), async (req, res) => {
  try {
    await Users.update(parseInt(req.params.id), { status: 'inactive' });
    cacheDel('users-list');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:id', requireRole('staff'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (id === req.session.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });

    // 刪 Drive 人員資料夾
    const user = await Users.byId(id);
    if (user && user.real_name) {
      const drive  = getDrive();
      const rootId = process.env.GOOGLE_DRIVE_FOLDER_ID;
      if (drive && rootId) {
        try {
          // 找 人員資料 資料夾
          const staffDirRes = await drive.files.list({
            q: `name='人員資料' and '${rootId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
            fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true,
          });
          const staffDirId = staffDirRes.data.files[0]?.id;
          if (staffDirId) {
            // 找該人的子資料夾
            const personRes = await drive.files.list({
              q: `name='${user.real_name}' and '${staffDirId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
              fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true,
            });
            const personFolderId = personRes.data.files[0]?.id;
            if (personFolderId) {
              await drive.files.delete({ fileId: personFolderId, supportsAllDrives: true });
              console.log(`[Drive] 已刪除 ${user.real_name} 的人員資料夾`);
            }
          }
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
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: '請輸入任務名稱' });
    await ttCol().doc(req.params.id).update({ name: name.trim() });
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
    const { label, type, options } = req.body;
    if (!label || !label.trim()) return res.status(400).json({ error: '請輸入欄位名稱' });
    const validTypes = ['text','number','date','select'];
    const t = validTypes.includes(type) ? type : 'text';
    const snap = await cfCol().get();
    const ref = cfCol().doc();
    const data = { label: label.trim(), type: t, sort: snap.size };
    if (t === 'select') data.options = Array.isArray(options) ? options.map(o=>String(o).trim()).filter(Boolean) : [];
    await ref.set(data);
    res.json({ ok: true, id: ref.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/custom-field-defs/:id', requireRole('supervisor'), async (req, res) => {
  try {
    const { label, type, options, sort } = req.body;
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
const DEFAULT_FIELD_ORDER = ['target','company','task','qty','price','total','deadline','notes','custom'];

app.get('/api/field-order', async (req, res) => {
  try {
    const doc = await firestoreDb.collection('settings').doc('fieldOrder').get();
    const order = doc.exists && Array.isArray(doc.data().order) ? doc.data().order : DEFAULT_FIELD_ORDER;
    const merged = [...order, ...DEFAULT_FIELD_ORDER.filter(k => !order.includes(k))];
    res.json({ order: merged });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/field-order', requireRole('supervisor'), async (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order) || !DEFAULT_FIELD_ORDER.every(k => order.includes(k)))
      return res.status(400).json({ error: '欄位順序資料不正確' });
    await firestoreDb.collection('settings').doc('fieldOrder').set({ order });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/assignments', requireRole('supervisor'), async (req, res) => {
  try {
    const { task_name, company, quantity, unit_price, notes, assign_type, target_partner_id, deadline_days, custom_fields } = req.body;
    if (!task_name || !quantity || !unit_price) return res.status(400).json({ error: '缺少必填欄位' });
    if (assign_type === 'individual' && !target_partner_id) return res.status(400).json({ error: '請選擇指派對象' });
    const qty = parseInt(quantity), price = parseInt(unit_price);
    const ddays = (parseInt(deadline_days) >= 1) ? parseInt(deadline_days) : 7;
    const assigned_at = nowTW();
    const dlBase = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    dlBase.setDate(dlBase.getDate() + ddays);
    const p = n => String(n).padStart(2,'0');
    const deadline_date = `${dlBase.getFullYear()}/${p(dlBase.getMonth()+1)}/${p(dlBase.getDate())}`;
    const item = await Assignments.create({
      task_name, company: company || '', quantity: qty, unit_price: price, total_price: qty * price,
      notes: notes || '',
      deadline_days: ddays,
      deadline_date,
      assigned_at,
      assign_type: assign_type || 'individual',
      target_partner_id: assign_type === 'individual' ? parseInt(target_partner_id) : null,
      supervisor_id: req.session.user.id,
      supervisor_name: req.session.user.real_name,
      status: 'pending', rejected_by: [], accepted_by: null, reject_reason: null,
      custom_fields: Array.isArray(custom_fields) ? custom_fields : [],
    });
    res.json({ ok: true, id: item.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/assignments/:id/accept', requireRole('partner'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const a  = await Assignments.byId(id);
    if (!a || a.status !== 'pending') return res.status(400).json({ error: '任務已不可接受' });
    await Assignments.update(id, { status: 'accepted', accepted_by: req.session.user.id, accepted_at: nowTW() });
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
      return res.status(400).json({ error: '請選擇督導人員' });
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

// 督導收到的問題
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

// 督導建立搶單任務
app.post('/api/grab-tasks', requireRole('supervisor'), async (req, res) => {
  try {
    const { task_name, company, unit_price, total_slots, deadline, notes, deadline_days, custom_fields } = req.body;
    if (!task_name || !unit_price || !total_slots || !deadline)
      return res.status(400).json({ error: '缺少必填欄位' });
    const slots = parseInt(total_slots);
    const price = parseInt(unit_price);
    const ddays = parseInt(deadline_days) || null;
    if (slots < 1) return res.status(400).json({ error: '總名額至少 1' });
    const item = await GrabTasks.create({
      task_name, company: company || '',
      unit_price: price, total_price_each: price,
      total_slots: slots,
      deadline,
      deadline_days: ddays,
      notes: notes || '',
      supervisor_id: req.session.user.id,
      supervisor_name: req.session.user.real_name,
      custom_fields: Array.isArray(custom_fields) ? custom_fields : [],
    });
    cacheDel('grab-tasks-open');
    res.json({ ok: true, id: item.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 督導取得自己的搶單任務列表
app.get('/api/grab-tasks/supervisor', requireRole('supervisor'), async (req, res) => {
  try {
    const list = await GrabTasks.forSupervisor(req.session.user.id);
    res.json(list);
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
    const list = await Assignments.all();
    const enriched = await Promise.all(list.map(async a => {
      let partner_name = null;
      if (a.accepted_by) {
        const u = await Users.byId(a.accepted_by);
        partner_name = u ? u.real_name : null;
      } else if (a.target_partner_id) {
        const u = await Users.byId(a.target_partner_id);
        partner_name = u ? u.real_name : null;
      }
      return { ...a, partner_name };
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
    list = list.filter(t => t.deadline >= now.slice(0,16));
    // 附上該夥伴是否已搶
    const result = await Promise.all(list.map(async t => {
      const recSnap = await firestoreDb.collection('grab_tasks').doc(String(t.id))
        .collection('grabbed_by').doc(String(partnerId)).get();
      return { ...t, my_grab_no: recSnap.exists ? recSnap.data().grab_no : null };
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 取得某搶單任務的搶單紀錄
app.get('/api/grab-tasks/:id/records', requireRole('supervisor','staff'), async (req, res) => {
  try {
    const records = await GrabRecords.forTask(parseInt(req.params.id));
    res.json(records);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 督導關閉搶單
app.put('/api/grab-tasks/:id/close', requireRole('supervisor'), async (req, res) => {
  try {
    const task = await GrabTasks.byId(parseInt(req.params.id));
    if (!task) return res.status(404).json({ error: '任務不存在' });
    if (task.supervisor_id !== req.session.user.id) return res.status(403).json({ error: '無權限' });
    await GrabTasks.update(parseInt(req.params.id), { status: 'closed' });
    cacheDel('grab-tasks-open');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 夥伴搶單（Firestore Transaction 防超搶）
app.post('/api/grab-tasks/:id/grab', requireRole('partner'), async (req, res) => {
  const taskId    = parseInt(req.params.id);
  const partnerId = req.session.user.id;
  const partnerName = req.session.user.real_name;
  try {
    const taskRef    = firestoreDb.collection('grab_tasks').doc(String(taskId));
    const alreadyRef = taskRef.collection('grabbed_by').doc(String(partnerId));
    const counterRef = firestoreDb.collection('_meta').doc('counters');

    const result = await firestoreDb.runTransaction(async t => {
      const [taskDoc, alreadyDoc, counterDoc] = await Promise.all([
        t.get(taskRef), t.get(alreadyRef), t.get(counterRef)
      ]);
      if (!taskDoc.exists) throw new Error('搶單任務不存在');
      const task = taskDoc.data();
      if (task.status !== 'open') throw new Error('搶單已關閉');
      const nowStr = nowTW().slice(0,16); // YYYY/MM/DD HH:MM
      if (task.deadline <= nowStr) throw new Error('搶單時間已截止');
      if (task.grabbed_count >= task.total_slots) throw new Error('名額已滿');
      if (alreadyDoc.exists) throw new Error('您已搶過此單');

      const counters   = counterDoc.exists ? counterDoc.data() : {};
      const nextRecId  = (counters['grab_records'] || 0) + 1;
      const nextGrabNo = (counters[`grab_no_${taskId}`] || 0) + 1;
      const grabNoStr  = String(nextGrabNo).padStart(3, '0');
      const ts = nowTW();

      t.update(taskRef, { grabbed_count: task.grabbed_count + 1 });
      t.set(counterRef, { ...counters, grab_records: nextRecId, [`grab_no_${taskId}`]: nextGrabNo }, { merge: true });
      t.set(alreadyRef, { partner_id: partnerId, grab_no: grabNoStr, grabbed_at: ts });
      t.set(firestoreDb.collection('grab_records').doc(String(nextRecId)), {
        id: nextRecId, grab_task_id: taskId,
        grab_no: grabNoStr, partner_id: partnerId, partner_name: partnerName,
        grabbed_at: ts, status: 'active', created_at: ts,
      });

      return { recId: nextRecId, grabNo: grabNoStr, task };
    });

    // Transaction 外建立 assignment（自動接受）
    const assignment = await Assignments.create({
      task_name:       result.task.task_name,
      company:         result.task.company || '',
      quantity:        1,
      unit_price:      result.task.unit_price,
      total_price:     result.task.unit_price,
      notes:           result.task.notes || '',
      deadline_days:   result.task.deadline_days || null,
      deadline_date:   result.task.deadline.slice(0,10),
      assigned_at:     nowTW(),
      assign_type:     'grab',
      target_partner_id: partnerId,
      accepted_by:     partnerId,
      accepted_at:     nowTW(),
      supervisor_id:   result.task.supervisor_id,
      supervisor_name: result.task.supervisor_name,
      grab_task_id:    taskId,
      grab_no:         result.grabNo,
      status:          'accepted',
      rejected_by: [], reject_reason: null,
    });
    // 更新 grab_record 存 assignment_id
    await firestoreDb.collection('grab_records').doc(String(result.recId)).update({ assignment_id: assignment.id });

    res.json({ ok: true, grab_no: result.grabNo, assignment_id: assignment.id });
  } catch(e) {
    const userErr = ['搶單任務不存在','搶單已關閉','搶單時間已截止','名額已滿','您已搶過此單'];
    if (userErr.some(m => e.message.includes(m)))
      return res.status(400).json({ error: e.message });
    console.error('[grab]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 任務回報 ──────────────────────────────────────────────────
app.post('/api/reports', requireRole('partner'), async (req, res) => {
  try {
    const { assignment_id, url, notes, images, completed_qty } = req.body;
    if (!assignment_id) return res.status(400).json({ error: 'Missing assignment_id' });
    const a = await Assignments.byId(parseInt(assignment_id));
    if (!a || a.accepted_by !== req.session.user.id) return res.status(403).json({ error: 'Forbidden' });
    const report = await WorklogReports.create({
      assignment_id: parseInt(assignment_id),
      supervisor_id: a.supervisor_id || null,
      partner_id: req.session.user.id,
      partner_name: req.session.user.real_name,
      task_name: a.task_name,
      task_no: a.task_no || null,
      company: a.company || '',
      task_quantity: a.quantity,
      completed_qty: parseInt(completed_qty) || 0,
      url: url || '',
      notes: notes || '',
      images: images || [],
      status: 'pending',
    });
    // 標記 assignment 為審核中，避免重複送出
    await Assignments.update(parseInt(assignment_id), { review_status: 'reviewing' });
    res.json({ ok: true, id: report.id });
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
      };
    }));
    res.json(enriched);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/reports/:id/approve', requireRole('supervisor'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await WorklogReports.update(id, { status: 'approved' });
    // 取回 report 找到 assignment_id，把 assignment 改成 completed
    const snap = await require('./db').WorklogReports;
    const rSnap = await require('firebase-admin').firestore()
      .collection('worklog_reports').where('id','==',id).limit(1).get();
    if (!rSnap.empty) {
      const r   = rSnap.docs[0].data();
      await Assignments.update(r.assignment_id, {
        status: 'completed', completed_at: nowTW(), review_status: 'approved'
      });
      const a = await Assignments.byId(r.assignment_id);
      if (a && a.accepted_by) {
        await grantTaskXP(a.accepted_by, a.task_name, a.company).catch(e => console.error('[grantTaskXP]', e.message));
      }

      // 督導核可後，背景上傳附件圖片至雲端
      if (r.images && r.images.length) {
        const drive  = getDrive();
        const rootId = process.env.GOOGLE_DRIVE_FOLDER_ID;
        if (drive && rootId) {
          (async () => {
            try {
              const worklogDirId = await driveEnsureFolder(drive, '回報附件', rootId);
              const taskDirId    = await driveEnsureFolder(drive, r.task_name || `任務${r.assignment_id}`, worklogDirId);
              const partnerDirId = await driveEnsureFolder(drive, r.partner_name || '未知', taskDirId);
              const completedAt = nowTW().replace(/[/: ]/g, '-');
              const timeDirId    = await driveEnsureFolder(drive, completedAt, partnerDirId);
              const { Readable } = require('stream');
              const driveIds = [];
              const qtyLabel = (r.completed_qty != null) ? `${r.completed_qty}件` : '';
              for (let i = 0; i < r.images.length; i++) {
                const img  = r.images[i];
                const b64  = img.data ? img.data.replace(/^data:[^;]+;base64,/, '') : img;
                const mime = img.mime || 'image/jpeg';
                const ext  = mime.split('/')[1] || 'jpg';
                const fname = `${qtyLabel}_${i+1}.${ext}`;
                const buf   = Buffer.from(b64, 'base64');
                const created = await drive.files.create({
                  requestBody: { name: fname, parents: [timeDirId] },
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
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/reports/:id/reject', requireRole('supervisor'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: '請填寫退回原因' });
    await WorklogReports.update(id, { status: 'rejected' });
    const rSnap = await require('firebase-admin').firestore()
      .collection('worklog_reports').where('id','==',id).limit(1).get();
    if (!rSnap.empty) {
      const r   = rSnap.docs[0].data();
      const a   = await Assignments.byId(r.assignment_id);
      const ts = nowTW(); // YYYY/MM/DD hh:mm:ss
      const [date, time] = ts.split(' ');
      const comments = [...(a.supervisor_comments || []), { date, time, text: reason }];
      // 退回後清除 review_status，讓夥伴可重新送出
      await Assignments.update(r.assignment_id, { supervisor_comments: comments, review_status: null });
    }
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
    summary.getRow(1).fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF1A6FA0' } };
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
        { header: '督導名稱', key: 'sv',        width: 14 },
      ];
      ws.getRow(1).font = { bold: true, size: 14, color:{ argb:'FFFFFFFF' } };
      ws.getRow(1).fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF1A6FA0' } };
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
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="salary.xlsx"; filename*=UTF-8''${encodeURIComponent(fileLabel)}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
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
      <p style="margin:0;font-size:13px;color:#888">如有疑問請聯繫您的督導人員。感謝您的辛勤付出！</p>
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
      <p style="margin:0;font-size:13px;color:#888">如有疑問請聯繫您的督導人員。感謝您的辛勤付出！</p>
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

async function driveUploadImg(drive, name, b64, parentId) {
  const { Readable } = require('stream');
  const buf = Buffer.from(b64, 'base64');
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
    if (images.front) await driveUploadImg(drive, '身分證正面.jpg', images.front, personId);
    if (images.back)  await driveUploadImg(drive, '身分證反面.jpg', images.back,  personId);
    if (images.bank)  await driveUploadImg(drive, `${bankLabel}.jpg`, images.bank, personId);
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
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
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

    const prompt = `這是一張中華民國身分證的正面和反面圖片。請提取以下資料，以 JSON 格式回傳，只回傳 JSON 不要其他文字：
{"real_name":"姓名(從正面)","id_number":"身分證字號10碼英數(從正面)","birthday":"生日YYYY/MM/DD格式(從正面民國年轉換為西元)","gender":"性別男或女(從正面)","address":"完整戶籍地址(從反面)"}
如果某欄位看不清楚請填空字串。`;

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\nServer started: http://localhost:' + PORT);
  console.log('Firestore connected to project: hiban-workspace-c6b5c');
});
