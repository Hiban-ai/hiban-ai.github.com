// 一次性修復腳本：將 admin 的 role 改為 staff
const admin  = require('firebase-admin');
const bcrypt = require('bcryptjs');
const serviceAccount = require('./firebase-key.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function fix() {
  const snap = await db.collection('users').where('username','==','admin').limit(1).get();
  if (snap.empty) {
    // 建立 admin
    const counterRef = db.collection('_meta').doc('counters');
    const next = await db.runTransaction(async t => {
      const doc  = await t.get(counterRef);
      const data = doc.exists ? doc.data() : {};
      const n    = (data.users || 0) + 1;
      t.set(counterRef, { ...data, users: n }, { merge: true });
      return n;
    });
    await db.collection('users').doc(String(next)).set({
      id: next, username:'admin', real_name:'系統管理員', nickname:null,
      role:'staff', status:'active', is_first_login:false,
      password_hash: bcrypt.hashSync('1234',10),
      created_at: new Date().toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})
    });
    console.log('✅ admin 帳號已建立，role: staff');
  } else {
    const doc  = snap.docs[0];
    const data = doc.data();
    console.log('目前 admin role:', data.role);
    if (data.role !== 'staff') {
      await doc.ref.update({ role: 'staff' });
      console.log('✅ admin role 已修正為 staff');
    } else {
      console.log('✅ admin role 已正確，無需修改');
    }
  }
  process.exit(0);
}

fix().catch(e => { console.error('❌ 錯誤:', e.message); process.exit(1); });
