const express = require('express');
const session = require('express-session');
const bcrypt  = require('bcryptjs');
const path    = require('path');
const { Users, ForgotReqs } = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));
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
    req.session.user = { id: user.id, username: user.username, real_name: user.real_name, nickname: user.nickname, role: user.role };
    res.json({ ok: true, role: user.role, is_first_login: !!user.is_first_login });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get('/api/me', requireAuth, (req, res) => res.json(req.session.user));

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
    const allowed = role === 'partner' ? ['phone','address'] : ['phone'];
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
    if (await ForgotReqs.byUser(user.id)) return res.json({ ok: true, msg: '申請已送出，請等待工作人員處理' });
    await ForgotReqs.create(user.id);
    res.json({ ok: true, msg: '申請已送出！工作人員將盡快重設密碼' });
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
    const { role, real_name, id_number, birthday, phone } = req.body;
    if (!['supervisor','staff'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (!real_name || !id_number || !birthday || !phone) return res.status(400).json({ error: 'Missing required fields' });
    const prefix   = role === 'supervisor' ? 'sv' : 'st';
    const username = await generateUsername(prefix);
    const user     = await Users.create({
      username, real_name, id_number, birthday, phone,
      role, status: 'active', is_first_login: true,
      password_hash: bcrypt.hashSync('0000', 10),
    });
    res.json({ ok: true, username: user.username });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/users/:id/approve', requireRole('staff'), async (req, res) => {
  try {
    await Users.update(parseInt(req.params.id), { status: 'active' });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\nServer started: http://localhost:' + PORT);
  console.log('Firestore connected to project: hiban-workspace-c6b5c');
});
