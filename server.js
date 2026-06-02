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

app.get('/api/users-list', (req, res) => {
  const { role } = req.query;
  let users = Users.all().filter(u => u.status === 'active');
  if (role) users = users.filter(u => u.role === role);
  res.json(users.map(u => ({ id: u.id, username: u.username, real_name: u.real_name, nickname: u.nickname })));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

  const user = Users.byName(username);
  if (!user) return res.status(401).json({ error: 'Account not found' });
  if (user.status === 'pending') return res.status(403).json({ error: 'Account pending approval' });
  if (user.status === 'inactive') return res.status(403).json({ error: 'Account disabled' });
  if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Wrong password' });

  req.session.user = { id: user.id, username: user.username, real_name: user.real_name, nickname: user.nickname, role: user.role };
  res.json({ ok: true, role: user.role, is_first_login: !!user.is_first_login });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get('/api/me', requireAuth, (req, res) => res.json(req.session.user));

app.get('/api/profile', requireAuth, (req, res) => {
  const u = Users.byId(req.session.user.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const { id, username, real_name, role, status, id_number, birthday, phone, address,
          identity, bank_name, bank_branch, bank_account, bank_holder } = u;
  res.json({ id, username, real_name, role, status, id_number, birthday, phone, address,
             identity, bank_name, bank_branch, bank_account, bank_holder });
});

app.put('/api/profile', requireAuth, (req, res) => {
  const role = req.session.user.role;
  const allowed = role === 'partner' ? ['phone','address'] : ['phone'];
  const patch = {};
  allowed.forEach(f => { if (req.body[f] !== undefined) patch[f] = req.body[f]; });
  Users.update(req.session.user.id, patch);
  res.json({ ok: true });
});

app.put('/api/profile/bank', requireAuth, (req, res) => {
  if (req.session.user.role !== 'partner') return res.status(403).json({ error: 'Forbidden' });
  const { bank_name, bank_branch, bank_account, bank_holder } = req.body;
  Users.update(req.session.user.id, { bank_name, bank_branch, bank_account, bank_holder });
  res.json({ ok: true });
});

app.post('/api/admin/users/create', requireRole('staff'), (req, res) => {
  const { role, real_name, id_number, birthday, phone } = req.body;
  if (!['supervisor','staff'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (!real_name || !id_number || !birthday || !phone)
    return res.status(400).json({ error: 'Missing required fields' });
  const prefix = role === 'supervisor' ? 'sv' : 'st';
  let username = prefix + '_' + Math.floor(100000 + Math.random() * 900000);
  while (Users.byName(username)) username = prefix + '_' + Math.floor(100000 + Math.random() * 900000);
  const user = Users.create({
    username, real_name, id_number, birthday, phone,
    role, status: 'active', is_first_login: true,
    password_hash: bcrypt.hashSync('0000', 10),
  });
  res.json({ ok: true, username: user.username });
});

app.post('/api/change-password', requireAuth, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!new_password || new_password.length < 4) return res.status(400).json({ error: 'Password too short' });
  const user = Users.byId(req.session.user.id);
  if (!bcrypt.compareSync(current_password, user.password_hash)) return res.status(401).json({ error: 'Wrong current password' });
  Users.update(user.id, { password_hash: bcrypt.hashSync(new_password, 10), is_first_login: false });
  res.json({ ok: true });
});

app.post('/api/forgot-password', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Missing username' });
  const user = Users.byName(username);
  if (!user || user.status !== 'active') return res.status(404).json({ error: 'Account not found' });
  if (ForgotReqs.byUser(user.id)) return res.json({ ok: true, msg: 'Already submitted' });
  ForgotReqs.create(user.id);
  res.json({ ok: true, msg: 'Request submitted' });
});

function generateUsername(real_name) {
  const base = real_name.charCodeAt(0).toString(36);
  let username = 'user_' + base + Math.floor(100000 + Math.random() * 900000);
  while (Users.byName(username)) {
    username = 'user_' + base + Math.floor(100000 + Math.random() * 900000);
  }
  return username;
}

app.post('/api/register', (req, res) => {
  const { real_name, id_number, birthday, phone, address } = req.body;
  if (!real_name)  return res.status(400).json({ error: 'Missing real_name' });
  if (!id_number)  return res.status(400).json({ error: 'Missing id_number' });
  if (!birthday)   return res.status(400).json({ error: 'Missing birthday' });
  if (!phone)      return res.status(400).json({ error: 'Missing phone' });
  if (!address)    return res.status(400).json({ error: 'Missing address' });

  const { nickname, identity, bank_name, bank_branch, bank_account, bank_holder } = req.body;
  const username = generateUsername(real_name);
  Users.create({
    username, real_name, id_number, birthday, phone, address,
    nickname: nickname || null,
    identity: identity || null,
    bank_name: bank_name || null,
    bank_branch: bank_branch || null,
    bank_account: bank_account || null,
    bank_holder: bank_holder || null,
    role: 'partner',
    status: 'pending',
    is_first_login: true,
    password_hash: bcrypt.hashSync('0000', 10),
  });
  res.json({ ok: true, username });
});

app.get('/api/admin/users', requireRole('staff'), (req, res) => {
  res.json(Users.all().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')));
});

app.put('/api/admin/users/:id/approve', requireRole('staff'), (req, res) => {
  Users.update(parseInt(req.params.id), { status: 'active' });
  res.json({ ok: true });
});

app.put('/api/admin/users/:id/deactivate', requireRole('staff'), (req, res) => {
  Users.update(parseInt(req.params.id), { status: 'inactive' });
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireRole('staff'), (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.session.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  ForgotReqs.resolveByUser(id);
  Users.delete(id);
  res.json({ ok: true });
});

app.put('/api/admin/users/:id/reset-password', requireRole('staff'), (req, res) => {
  const id = parseInt(req.params.id);
  Users.update(id, { password_hash: bcrypt.hashSync('0000', 10), is_first_login: true });
  ForgotReqs.resolveByUser(id);
  res.json({ ok: true });
});

app.get('/api/admin/forgot-requests', requireRole('staff'), (req, res) => {
  const rows = ForgotReqs.pending().map(r => {
    const user = Users.byId(r.user_id);
    return { ...r, username: user ? user.username : '?', real_name: user ? user.real_name : '?' };
  });
  res.json(rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\nServer started: http://localhost:' + PORT);
  console.log('Default accounts (password: 0000)');
  console.log('  admin(1234) / staff01 / supervisor01 / partner01 (first login) / partner02');
});
