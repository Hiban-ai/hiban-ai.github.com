// 重建測試資料：清除舊帳號（保留 admin），建立新的督導、夥伴，隨機指派督導
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

async function createUser(data) {
  const snap = await db.collection('users').where('username','==',data.username).limit(1).get();
  if (!snap.empty) { console.log(`  ⏭  ${data.username} 已存在`); return snap.docs[0].data(); }
  const id   = await nextId();
  const user = { id, created_at: now(), ...data };
  await db.collection('users').doc(String(id)).set(user);
  console.log(`  ➕ ${data.username} (${data.role}) — ${data.real_name}`);
  return user;
}

async function main() {
  const defaultPw = bcrypt.hashSync('0000', 10);
  const adminPw   = bcrypt.hashSync('1234', 10);

  // 1. 清除除 admin 以外的所有帳號
  console.log('\n🗑️  清除舊資料...');
  const snap = await db.collection('users').get();
  const batch = db.batch();
  snap.docs.forEach(d => { if (d.data().username !== 'admin') batch.delete(d.ref); });
  await batch.commit();

  // 重設計數器
  const adminSnap = await db.collection('users').where('username','==','admin').limit(1).get();
  const adminId   = adminSnap.empty ? 1 : adminSnap.docs[0].data().id;
  await db.collection('_meta').doc('counters').set({ users: adminId }, { merge: true });

  // 2. 建立管理人員
  console.log('\n👤 建立管理人員...');
  await createUser({ username:'staff01', real_name:'張管理', nickname:null, role:'staff', status:'active', is_first_login:false, password_hash:defaultPw, id_number:'Z100000001', birthday:'1985-03-10', phone:'0912000001', email:'staff01@hiban.com', address:'台北市信義區基隆路一段' });

  // 3. 建立督導人員
  console.log('\n📖 建立督導人員...');
  const sv1 = await createUser({ username:'sv_001001', real_name:'吳建國', nickname:null, role:'supervisor', status:'active', is_first_login:false, password_hash:defaultPw, id_number:'H890123456', birthday:'1980-04-12', phone:'0912345001', email:'wu@hiban.com', address:'台北市大安區敦化南路一段200號' });
  const sv2 = await createUser({ username:'sv_002002', real_name:'蔡淑芬', nickname:null, role:'supervisor', status:'active', is_first_login:false, password_hash:defaultPw, id_number:'I901234567', birthday:'1978-08-20', phone:'0912345002', email:'tsai@hiban.com', address:'新北市中和區景平路500號' });

  // 4. 建立工作夥伴（隨機分配督導）
  console.log('\n⚔️  建立工作夥伴...');
  const supervisors = [sv1, sv2];
  const partners = [
    { username:'partner01', real_name:'陳小花', nickname:'月影旅者',  id_number:'A234567890', birthday:'1998-05-20', phone:'0911000001', email:'flower@gmail.com',  address:'台北市中山區民生東路三段10號', bank_name:'台灣銀行',  bank_account:'001234567890', identity:'' },
    { username:'partner02', real_name:'林大明', nickname:'靜默劍士',  id_number:'B345678901', birthday:'1995-11-08', phone:'0911000002', email:'forest@gmail.com',  address:'新北市板橋區文化路一段50號',  bank_name:'合作金庫',  bank_account:'006234567890', identity:'' },
    { username:'partner03', real_name:'王小明', nickname:'流星飛俠',  id_number:'C456789012', birthday:'1993-03-22', phone:'0911000003', email:'wang@gmail.com',    address:'台中市西屯區台灣大道三段300號', bank_name:'第一銀行',  bank_account:'007234567890', identity:'' },
    { username:'partner04', real_name:'李美玲', nickname:'紫羅蘭',    id_number:'D567890123', birthday:'1996-07-14', phone:'0911000004', email:'lee@gmail.com',     address:'高雄市前鎮區中山二路50號',  bank_name:'國泰世華',  bank_account:'013234567890', identity:'二度就業婦女' },
    { username:'partner05', real_name:'張志豪', nickname:'暗影獵手',  id_number:'E678901234', birthday:'1990-09-05', phone:'0911000005', email:'chang@gmail.com',   address:'桃園市桃園區中正路150號',   bank_name:'玉山銀行',  bank_account:'808234567890', identity:'身心障礙者' },
    { username:'partner06', real_name:'陳雅婷', nickname:'白雪精靈',  id_number:'F789012345', birthday:'2000-01-18', phone:'0911000006', email:'chen@gmail.com',    address:'台南市東區東門路一段80號',  bank_name:'彰化銀行',  bank_account:'009234567890', identity:'' },
    { username:'partner07', real_name:'劉建宏', nickname:'鐵甲武士',  id_number:'G890123456', birthday:'1988-12-30', phone:'0911000007', email:'liu@gmail.com',     address:'基隆市仁愛區愛一路30號',    bank_name:'台灣銀行',  bank_account:'001987654321', identity:'中高齡者（45歲以上）' },
    { username:'partner08', real_name:'林怡君', nickname:'月光使者',  id_number:'H901234567', birthday:'1994-06-25', phone:'0911000008', email:'lin@gmail.com',     address:'新竹市東區光復路二段100號', bank_name:'合作金庫',  bank_account:'006987654321', identity:'' },
  ];

  const createdPartners = [];
  for (let i = 0; i < partners.length; i++) {
    const sv = supervisors[i % supervisors.length]; // 輪流分配
    const p  = await createUser({
      ...partners[i],
      role: 'partner', status: 'active', is_first_login: false,
      password_hash: defaultPw,
      supervisor_id: sv.id,
    });
    createdPartners.push(p);
    console.log(`     → 分配督導：${sv.real_name}`);
  }

  // 5. 加一個待審核夥伴
  await createUser({ username:'partner_new01', real_name:'黃志偉', nickname:'新星', id_number:'I012345678', birthday:'2001-08-15', phone:'0911000009', email:'huang@gmail.com', address:'台北市松山區八德路三段20號', bank_name:'台灣銀行', bank_account:'001111111111', identity:'', role:'partner', status:'pending', is_first_login:true, password_hash:defaultPw });

  console.log('\n✅ 完成！');
  console.log(`   管理人員：1 人`);
  console.log(`   督導人員：2 人（吳建國 / 蔡淑芬）`);
  console.log(`   工作夥伴：${createdPartners.length} 人（已啟用，已分配督導）`);
  console.log(`   待審核：1 人（黃志偉）`);
  process.exit(0);
}
main().catch(e => { console.error('❌', e.message); process.exit(1); });
