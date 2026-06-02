// db.js — 使用 lowdb（JSON 檔案資料庫，純 JS，無需編譯）
const low     = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const bcrypt  = require('bcryptjs');
const path    = require('path');

const adapter = new FileSync(path.join(__dirname, 'hiban_db.json'));
const db      = low(adapter);

// 預設資料結構
db.defaults({ users: [], forgot_requests: [], _nextId: { users: 1, forgot: 1 } }).write();

// ── 工具函式 ──────────────────────────────────────────────────
function nextId(table) {
  const id = db.get(`_nextId.${table}`).value();
  db.set(`_nextId.${table}`, id + 1).write();
  return id;
}

function now() {
  return new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
}

// ── Users ─────────────────────────────────────────────────────
const Users = {
  all:    ()     => db.get('users').value(),
  byId:   (id)   => db.get('users').find({ id }).value(),
  byName: (username) => db.get('users').find({ username }).value(),

  create(data) {
    const user = { id: nextId('users'), created_at: now(), ...data };
    db.get('users').push(user).write();
    return user;
  },

  update(id, patch) {
    db.get('users').find({ id }).assign(patch).write();
    return this.byId(id);
  },

  delete(id) {
    db.get('users').remove({ id }).write();
  },
};

// ── ForgotRequests ────────────────────────────────────────────
const ForgotReqs = {
  pending:     ()      => db.get('forgot_requests').filter({ status: 'pending' }).value(),
  byUser:      (uid)   => db.get('forgot_requests').find({ user_id: uid, status: 'pending' }).value(),
  create(uid)          { db.get('forgot_requests').push({ id: nextId('forgot'), user_id: uid, status: 'pending', created_at: now() }).write(); },
  resolveByUser(uid)   { db.get('forgot_requests').find({ user_id: uid, status: 'pending' }).assign({ status: 'done' }).write(); },
};

// ── 種子帳號 ──────────────────────────────────────────────────
function seed() {
  if (Users.all().length > 0) return; // 已有資料就跳過

  const defaultPw = bcrypt.hashSync('0000', 10);
  const adminPw = bcrypt.hashSync('1234', 10);
  const seeds = [
    { username: 'admin',        real_name: '系統管理員', nickname: null,       role: 'staff',      status: 'active',   is_first_login: false, password_hash: adminPw },
    { username: 'staff01',      real_name: '張管理',  nickname: null,        role: 'staff',      status: 'active',   is_first_login: false, password_hash: defaultPw },
    { username: 'supervisor01', real_name: '陳督導',  nickname: null,        role: 'supervisor', status: 'active',   is_first_login: false, password_hash: defaultPw },
    { username: 'partner01',    real_name: '陳小花',  nickname: '月影旅者',  role: 'partner',    status: 'active',   is_first_login: true,  password_hash: defaultPw },
    { username: 'partner02',    real_name: '林大明',  nickname: '靜默劍士',  role: 'partner',    status: 'active',   is_first_login: false, password_hash: defaultPw },
  ];
  seeds.forEach(s => Users.create(s));
  console.log('✅ 已建立預設帳號');
}

seed();

module.exports = { Users, ForgotReqs };
