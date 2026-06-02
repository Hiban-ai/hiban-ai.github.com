// 重新補建所有預設帳號（已存在的不重複建立）
const admin  = require('firebase-admin');
const bcrypt = require('bcryptjs');
const key    = require('./firebase-key.json');

admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

const now = () => new Date().toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false});

async function nextId() {
  const ref = db.collection('_meta').doc('counters');
  return db.runTransaction(async t => {
    const doc  = await t.get(ref);
    const data = doc.exists ? doc.data() : {};
    const n    = (data.users || 0) + 1;
    t.set(ref, { ...data, users: n }, { merge: true });
    return n;
  });
}

async function ensureUser(data) {
  const snap = await db.collection('users').where('username','==',data.username).limit(1).get();
  if (!snap.empty) {
    // 若 role 不對，修正它
    const doc = snap.docs[0];
    if (doc.data().role !== data.role) {
      await doc.ref.update({ role: data.role, status: 'active' });
      console.log(`  ✏️  修正 ${data.username} role → ${data.role}`);
    } else {
      console.log(`  ✅ ${data.username} 已存在`);
    }
    return;
  }
  const id   = await nextId();
  const user = { id, created_at: now(), ...data };
  await db.collection('users').doc(String(id)).set(user);
  console.log(`  ➕ 建立 ${data.username} (${data.role})`);
}

async function main() {
  const defaultPw = bcrypt.hashSync('0000', 10);
  const adminPw   = bcrypt.hashSync('1234', 10);

  const seeds = [
    { username:'admin',        real_name:'系統管理員', nickname:null,        role:'staff',      status:'active', is_first_login:false, password_hash:adminPw   },
    { username:'staff01',      real_name:'張管理',     nickname:null,        role:'staff',      status:'active', is_first_login:false, password_hash:defaultPw },
    { username:'supervisor01', real_name:'陳督導',     nickname:null,        role:'supervisor', status:'active', is_first_login:false, password_hash:defaultPw },
    { username:'partner01',    real_name:'陳小花',     nickname:'月影旅者',  role:'partner',    status:'active', is_first_login:true,  password_hash:defaultPw },
    { username:'partner02',    real_name:'林大明',     nickname:'靜默劍士',  role:'partner',    status:'active', is_first_login:false, password_hash:defaultPw },
  ];

  console.log('\n🔧 補建預設帳號...');
  for (const s of seeds) await ensureUser(s);
  console.log('\n✅ 完成！\n');
  process.exit(0);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
