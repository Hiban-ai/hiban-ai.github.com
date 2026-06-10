// db.js — Firebase Firestore 版本
// 日期字串轉 timestamp，支援 'YYYY/MM/DD hh:mm:ss' 與 'YYYY/M/D...' 格式
function byDate(a, b) {
  const parse = s => s ? new Date((s||'').replace(/\//g,'-').replace(' ','T')).getTime() : 0;
  return parse(a) - parse(b);
}
const admin  = require('firebase-admin');
const bcrypt = require('bcryptjs');

// ── 初始化 Firebase ──────────────────────────────────────────
let serviceAccount;
if (process.env.FIREBASE_KEY) {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
  if (serviceAccount.private_key)
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
} else {
  serviceAccount = require('./firebase-key.json');
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── Firestore 流量統計（讀/寫/刪計數，每日台灣時間 00:00 重置）──
const fs = require('fs');
const path = require('path');
const STATS_FILE = path.join(__dirname, 'traffic_stats.json');
function todayTW() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}
let trafficStats = { date: todayTW(), reads: 0, writes: 0, deletes: 0, history: [] };
try {
  const saved = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  if (saved && saved.date === todayTW()) trafficStats = saved;
} catch (e) {}
function saveStats() {
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(trafficStats)); } catch (e) {}
}
function checkRollover() {
  const t = todayTW();
  if (trafficStats.date !== t) {
    trafficStats = { date: t, reads: 0, writes: 0, deletes: 0, history: [] };
  }
}
function getTrafficStats() {
  checkRollover();
  return trafficStats;
}
function snapshotTraffic() {
  checkRollover();
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const time = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  trafficStats.history.push({ time, reads: trafficStats.reads, writes: trafficStats.writes, deletes: trafficStats.deletes });
  if (trafficStats.history.length > 96) trafficStats.history.shift();
  saveStats();
}
setInterval(() => { snapshotTraffic(); }, 30 * 60 * 1000);
snapshotTraffic();

// 修補 Firestore 原型方法，攔截讀/寫/刪以計數
const QueryProto = Object.getPrototypeOf(db.collection('_meta'));
const DocRefProto = Object.getPrototypeOf(db.collection('_meta').doc('x'));
const _queryGet = QueryProto.get;
QueryProto.get = async function (...args) {
  const snap = await _queryGet.apply(this, args);
  checkRollover();
  trafficStats.reads += (snap.size || (snap.exists ? 1 : 0)) || 1;
  saveStats();
  return snap;
};
const _docGet = DocRefProto.get;
DocRefProto.get = async function (...args) {
  const snap = await _docGet.apply(this, args);
  checkRollover();
  trafficStats.reads += 1;
  saveStats();
  return snap;
};
['set', 'update'].forEach(m => {
  const orig = DocRefProto[m];
  DocRefProto[m] = async function (...args) {
    checkRollover();
    trafficStats.writes += 1;
    saveStats();
    return orig.apply(this, args);
  };
});
const _docDelete = DocRefProto.delete;
DocRefProto.delete = async function (...args) {
  checkRollover();
  trafficStats.deletes += 1;
  saveStats();
  return _docDelete.apply(this, args);
};

function now() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ── 自動遞增 ID ───────────────────────────────────────────────
async function nextId(table) {
  const ref = db.collection('_meta').doc('counters');
  return db.runTransaction(async t => {
    const doc  = await t.get(ref);
    const data = doc.exists ? doc.data() : {};
    const next = (data[table] || 0) + 1;
    t.set(ref, { ...data, [table]: next }, { merge: true });
    return next;
  });
}

// ── Users ─────────────────────────────────────────────────────
const Users = {
  async all() {
    const snap = await db.collection('users').get();
    return snap.docs.map(d => d.data());
  },
  async byId(id) {
    const snap = await db.collection('users').where('id','==',id).limit(1).get();
    return snap.empty ? null : snap.docs[0].data();
  },
  async byName(username) {
    const snap = await db.collection('users').where('username','==',username).limit(1).get();
    return snap.empty ? null : snap.docs[0].data();
  },
  async create(data) {
    const id   = await nextId('users');
    const user = { id, created_at: now(), ...data };
    await db.collection('users').doc(String(id)).set(user);
    return user;
  },
  async update(id, patch) {
    await db.collection('users').doc(String(id)).update(patch);
    return this.byId(id);
  },
  async delete(id) {
    await db.collection('users').doc(String(id)).delete();
  },
};

// ── ForgotRequests ────────────────────────────────────────────
const ForgotReqs = {
  async pending() {
    const snap = await db.collection('forgot_requests').where('status','==','pending').get();
    return snap.docs.map(d => d.data());
  },
  async byUser(uid) {
    const snap = await db.collection('forgot_requests')
      .where('user_id','==',uid).where('status','==','pending').limit(1).get();
    return snap.empty ? null : snap.docs[0].data();
  },
  async create(uid) {
    const id = await nextId('forgot');
    await db.collection('forgot_requests').doc(String(id)).set({
      id, user_id: uid, status: 'pending', created_at: now()
    });
  },
  async resolveByUser(uid) {
    const snap = await db.collection('forgot_requests')
      .where('user_id','==',uid).where('status','==','pending').get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.update(d.ref, { status: 'done' }));
    await batch.commit();
  },
};

// ── 種子帳號 ──────────────────────────────────────────────────
async function seed() {
  const snap = await db.collection('users').limit(1).get();
  if (!snap.empty) {
    // 補建 admin（若不存在）
    const adminSnap = await db.collection('users').where('username','==','admin').limit(1).get();
    if (adminSnap.empty) {
      await Users.create({
        username:'admin', real_name:'系統管理員', nickname:null,
        role:'staff', status:'active', is_first_login:false,
        password_hash: bcrypt.hashSync('1234', 10),
      });
      console.log('✅ Firebase: Admin 帳號已補建');
    }
    return;
  }

  const defaultPw = bcrypt.hashSync('0000', 10);
  const adminPw   = bcrypt.hashSync('1234', 10);
  const seeds = [
    { username:'admin',        real_name:'系統管理員', nickname:null,         role:'staff',      status:'active', is_first_login:false, password_hash:adminPw   },
    { username:'staff01',      real_name:'張管理',     nickname:null,         role:'staff',      status:'active', is_first_login:false, password_hash:defaultPw },
    { username:'supervisor01', real_name:'陳督導',     nickname:null,         role:'supervisor', status:'active', is_first_login:false, password_hash:defaultPw },
    { username:'partner01',    real_name:'陳小花',     nickname:'月影旅者',   role:'partner',    status:'active', is_first_login:true,  password_hash:defaultPw },
    { username:'partner02',    real_name:'林大明',     nickname:'靜默劍士',   role:'partner',    status:'active', is_first_login:false, password_hash:defaultPw },
  ];
  for (const s of seeds) await Users.create(s);
  console.log('✅ Firebase: 預設帳號已建立');
}

seed().catch(console.error);

// ── Assignments ───────────────────────────────────────────────
const Assignments = {
  async byId(id) {
    const snap = await db.collection('assignments').where('id','==',id).limit(1).get();
    return snap.empty ? null : snap.docs[0].data();
  },
  async create(data) {
    const id   = await nextId('assignments');
    const item = { id, created_at: now(), ...data };
    await db.collection('assignments').doc(String(id)).set(item);
    return item;
  },
  async update(id, patch) {
    await db.collection('assignments').doc(String(id)).update(patch);
  },
  // 夥伴待回覆
  async pendingForPartner(partnerId) {
    const snap = await db.collection('assignments').where('status','==','pending').get();
    return snap.docs.map(d => d.data()).filter(a =>
      a.assign_type === 'individual'
        ? a.target_partner_id === partnerId
        : !(a.rejected_by || []).includes(partnerId)
    ).sort((a,b) => byDate(b.created_at, a.created_at));
  },
  // 夥伴已接案
  async activeForPartner(partnerId) {
    const snap = await db.collection('assignments')
      .where('accepted_by','==',partnerId).where('status','==','accepted').get();
    return snap.docs.map(d => d.data()).sort((a,b) => byDate(b.created_at, a.created_at));
  },
  // 夥伴已完成
  async completedForPartner(partnerId) {
    const snap = await db.collection('assignments')
      .where('accepted_by','==',partnerId).where('status','==','completed').get();
    return snap.docs.map(d => d.data()).sort((a,b) => byDate(b.completed_at, a.completed_at));
  },
  // 督導派案紀錄
  async forSupervisor(supervisorId) {
    const snap = await db.collection('assignments').where('supervisor_id','==',supervisorId).get();
    return snap.docs.map(d => d.data()).sort((a,b) => byDate(b.created_at, a.created_at));
  },
};

// ── WorklogReports ────────────────────────────────────────────
const WorklogReports = {
  async create(data) {
    const id   = await nextId('reports');
    const item = { id, created_at: now(), ...data };
    await db.collection('worklog_reports').doc(String(id)).set(item);
    return item;
  },
  async forAssignment(assignmentId) {
    const snap = await db.collection('worklog_reports')
      .where('assignment_id','==',assignmentId).get();
    return snap.docs.map(d => d.data()).sort((a,b) => (a.created_at||'').localeCompare(b.created_at||''));
  },
  async pendingForSupervisor(supervisorId) {
    // 取得所有此督導的夥伴 assignment 的回報
    const assignSnap = await db.collection('assignments')
      .where('supervisor_id','==',supervisorId).get();
    const assignIds = assignSnap.docs.map(d => d.data().id);
    if (!assignIds.length) return [];
    const snap = await db.collection('worklog_reports').get();
    return snap.docs.map(d => d.data())
      .filter(r => assignIds.includes(r.assignment_id) && r.status === 'pending')
      .sort((a,b) => byDate(b.created_at, a.created_at));
  },
  async approvedForSupervisor(supervisorId) {
    const assignSnap = await db.collection('assignments')
      .where('supervisor_id','==',supervisorId).get();
    const assignIds = assignSnap.docs.map(d => d.data().id);
    if (!assignIds.length) return [];
    const snap = await db.collection('worklog_reports').get();
    return snap.docs.map(d => d.data())
      .filter(r => assignIds.includes(r.assignment_id) && r.status === 'approved')
      .sort((a,b) => byDate(b.created_at, a.created_at));
  },
  async update(id, patch) {
    await db.collection('worklog_reports').doc(String(id)).update(patch);
  },
};

// ── UserImages（申請圖片，壓縮 base64 分開存）─────────────────
const UserImages = {
  async save(userId, { front, back, bank }) {
    await db.collection('user_images').doc(String(userId)).set({
      user_id: userId, front: front||'', back: back||'', bank: bank||'',
      saved_at: now()
    });
  },
  async get(userId) {
    const doc = await db.collection('user_images').doc(String(userId)).get();
    return doc.exists ? doc.data() : null;
  },
  async delete(userId) {
    await db.collection('user_images').doc(String(userId)).delete();
  }
};

// ── Announcements（公告）─────────────────────────────────────
const Announcements = {
  async all() {
    const snap = await db.collection('announcements').orderBy('created_at','desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async byId(id) {
    const doc = await db.collection('announcements').doc(String(id)).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
  },
  async create(data) {
    const ref = await db.collection('announcements').add({ ...data, created_at: now() });
    return ref.id;
  },
  async update(id, data) {
    await db.collection('announcements').doc(String(id)).update({ ...data, updated_at: now() });
  },
  async delete(id) {
    await db.collection('announcements').doc(String(id)).delete();
  }
};

// ── GrabTasks ─────────────────────────────────────────────────
const GrabTasks = {
  async byId(id) {
    const snap = await db.collection('grab_tasks').where('id','==',id).limit(1).get();
    return snap.empty ? null : snap.docs[0].data();
  },
  async create(data) {
    const id   = await nextId('grab_tasks');
    const item = { id, created_at: now(), grabbed_count: 0, status: 'open', ...data };
    await db.collection('grab_tasks').doc(String(id)).set(item);
    return item;
  },
  async update(id, patch) {
    await db.collection('grab_tasks').doc(String(id)).update(patch);
  },
  async openList() {
    const snap = await db.collection('grab_tasks').where('status','==','open').get();
    return snap.docs.map(d => d.data()).sort((a,b) => byDate(b.created_at, a.created_at));
  },
  async forSupervisor(supervisorId) {
    const snap = await db.collection('grab_tasks').where('supervisor_id','==',supervisorId).get();
    return snap.docs.map(d => d.data()).sort((a,b) => byDate(b.created_at, a.created_at));
  },
  async all() {
    const snap = await db.collection('grab_tasks').get();
    return snap.docs.map(d => d.data()).sort((a,b) => byDate(b.created_at, a.created_at));
  },
};

// ── GrabRecords ───────────────────────────────────────────────
const GrabRecords = {
  async forTask(grabTaskId) {
    const snap = await db.collection('grab_records').where('grab_task_id','==',grabTaskId).get();
    return snap.docs.map(d => d.data()).sort((a,b) => a.grab_no.localeCompare(b.grab_no));
  },
  async forPartner(partnerId) {
    const snap = await db.collection('grab_records').where('partner_id','==',partnerId).get();
    return snap.docs.map(d => d.data()).sort((a,b) => byDate(b.grabbed_at, a.grabbed_at));
  },
};

// ── Reports ───────────────────────────────────────────────────
const Reports = {
  async byId(id) {
    const snap = await db.collection('reports').where('id','==',id).limit(1).get();
    return snap.empty ? null : snap.docs[0].data();
  },
  async create(data) {
    const id   = await nextId('reports');
    const item = { id, created_at: now(), updated_at: now(),
                   replies: [], unread_handler: true, unread_reporter: false,
                   status: 'pending', ...data };
    await db.collection('reports').doc(String(id)).set(item);
    return item;
  },
  async update(id, patch) {
    await db.collection('reports').doc(String(id)).update({ ...patch, updated_at: now() });
  },
  async forReporter(reporterId) {
    const snap = await db.collection('reports').where('reporter_id','==',reporterId).get();
    return snap.docs.map(d=>d.data()).sort((a,b)=>byDate(b.created_at,a.created_at));
  },
  async forSupervisor(supervisorId) {
    const snap = await db.collection('reports')
      .where('report_type','==','supervisor')
      .where('supervisor_id','==',supervisorId).get();
    return snap.docs.map(d=>d.data()).sort((a,b)=>byDate(b.created_at,a.created_at));
  },
  async forAdmin() {
    const snap = await db.collection('reports').where('report_type','==','admin').get();
    return snap.docs.map(d=>d.data()).sort((a,b)=>byDate(b.created_at,a.created_at));
  },
};

// ── ReportImages ──────────────────────────────────────────────
const ReportImages = {
  async save(reportId, index, data, mime) {
    await db.collection('report_images').doc(`${reportId}_${index}`).set(
      { report_id: reportId, index, data, mime, saved_at: now() }
    );
  },
  async get(reportId, index) {
    const doc = await db.collection('report_images').doc(`${reportId}_${index}`).get();
    return doc.exists ? doc.data() : null;
  },
  async listForReport(reportId) {
    const snap = await db.collection('report_images').where('report_id','==',reportId).get();
    return snap.docs.map(d=>d.data()).sort((a,b)=>a.index-b.index);
  },
  async deleteAll(reportId) {
    const snap = await db.collection('report_images').where('report_id','==',reportId).get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  },
};

module.exports = { Users, ForgotReqs, Assignments, WorklogReports, UserImages, Announcements, GrabTasks, GrabRecords, Reports, ReportImages, db, getTrafficStats };
