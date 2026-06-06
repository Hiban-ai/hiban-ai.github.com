const express = require('express');
const session = require('express-session');
const bcrypt  = require('bcryptjs');
const path    = require('path');
const { Users, ForgotReqs, Assignments, WorklogReports } = require('./db');

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
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
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
  try {
    const { role } = req.query;
    let users = await Users.all();
    users = users.filter(u => u.status === 'active');
    if (role) users = users.filter(u => u.role === role);
    // 督導只看自己負責的夥伴
    if (req.session.user?.role === 'supervisor' && role === 'partner') {
      users = users.filter(u => u.supervisor_id === req.session.user.id);
    }
    res.json(users.map(u => ({ id: u.id, username: u.username, real_name: u.real_name, nickname: u.nickname })));
  } catch(e) { res.status(500).json({ error: e.message }); }
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
    req.session.user = { id: user.id, username: user.username, real_name: user.real_name, nickname: user.nickname, role: user.role, is_admin: !!(user.is_admin || user.username === 'admin') };
    res.json({ ok: true, role: user.role, is_first_login: !!user.is_first_login });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get('/api/me', requireAuth, (req, res) => res.json({ ...req.session.user, is_admin: !!req.session.user.is_admin }));

app.get('/api/profile', requireAuth, async (req, res) => {
  try {
    const u = await Users.byId(req.session.user.id);
    if (!u) return res.status(404).json({ error: 'Not found' });
    const { id, username, real_name, role, status, id_number, birthday, phone, address,
            identity, bank_name, bank_branch, bank_account, bank_holder } = u;
    res.json({ id, username, real_name, role, status, id_number, birthday, phone, address,
               identity, bank_name, bank_branch, bank_account, bank_holder });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/profile', requireAuth, async (req, res) => {
  try {
    const role    = req.session.user.role;
    const allowed = ['phone','address'];
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
    if (!new_password || new_password.length < 4) return res.status(400).json({ error: 'Password too short' });
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
    const { email, nickname, identity, bank_name, bank_branch, bank_account, bank_holder } = req.body;
    if (!email) return res.status(400).json({ error: 'Missing email' });
    const base     = real_name.charCodeAt(0).toString(36);
    const username = await generateUsername('user_' + base);
    await Users.create({
      username, real_name, id_number, birthday, phone, address,
      email: email || null,
      nickname: nickname || null, identity: identity || null,
      bank_name: bank_name || null, bank_branch: bank_branch || null,
      bank_account: bank_account || null, bank_holder: bank_holder || null,
      role: 'partner', status: 'pending', is_first_login: true,
      password_hash: bcrypt.hashSync('0000', 10),
    });
    res.json({ ok: true, username });
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
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:id', requireRole('staff'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (id === req.session.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
    await ForgotReqs.resolveByUser(id);
    await Users.delete(id);
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

app.post('/api/assignments', requireRole('supervisor'), async (req, res) => {
  try {
    const { task_name, quantity, unit_price, notes, assign_type, target_partner_id, deadline_days } = req.body;
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
      task_name, quantity: qty, unit_price: price, total_price: qty * price,
      notes: notes || '',
      deadline_days: ddays,
      deadline_date,
      assigned_at,
      assign_type: assign_type || 'individual',
      target_partner_id: assign_type === 'individual' ? parseInt(target_partner_id) : null,
      supervisor_id: req.session.user.id,
      supervisor_name: req.session.user.real_name,
      status: 'pending', rejected_by: [], accepted_by: null, reject_reason: null,
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
  } catch(e) { res.status(500).json({ error: e.message }); }
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
        accepted_at:   a ? a.accepted_at   : null,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\nServer started: http://localhost:' + PORT);
  console.log('Firestore connected to project: hiban-workspace-c6b5c');
});
