// reseed3: 10夥伴、3督導(管2/1/3人)、3管理人員(含admin)
const admin  = require('firebase-admin');
const bcrypt = require('bcryptjs');
const key    = require('./firebase-key.json');
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

const now = () => new Date().toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false});
const pw0 = bcrypt.hashSync('0000', 10);
const pw1 = bcrypt.hashSync('1234', 10);

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

async function upsert(data) {
  const snap = await db.collection('users').where('username','==',data.username).limit(1).get();
  if (!snap.empty) {
    await snap.docs[0].ref.update(data);
    console.log(`  ✏️  更新 ${data.username} — ${data.real_name}`);
    return snap.docs[0].data().id;
  }
  const id   = await nextId();
  await db.collection('users').doc(String(id)).set({ id, created_at: now(), ...data });
  console.log(`  ➕ 建立 ${data.username} — ${data.real_name}`);
  return id;
}

async function clearNonAdmin() {
  const snap = await db.collection('users').get();
  const batch = db.batch();
  let cnt = 0;
  snap.docs.forEach(d => { if (d.data().username !== 'admin') { batch.delete(d.ref); cnt++; } });
  await batch.commit();
  console.log(`  🗑️  清除 ${cnt} 筆舊資料`);
  // 重設計數器
  const adminSnap = await db.collection('users').where('username','==','admin').limit(1).get();
  const adminId   = adminSnap.empty ? 1 : adminSnap.docs[0].data().id;
  await db.collection('_meta').doc('counters').set({ users: adminId }, { merge: true });
}

async function main() {
  console.log('\n🗑️  清除舊資料...');
  await clearNonAdmin();

  // ── 管理人員 (3人含admin) ────────────────────────────────────
  console.log('\n🧹 管理人員...');
  await upsert({ username:'staff01', real_name:'張管理', role:'staff', status:'active', is_first_login:false, password_hash:pw0, id_number:'Z100000001', birthday:'1985-03-10', phone:'0912000001', email:'staff01@hiban.com', address:'台北市信義區基隆路一段10號', nickname:null });
  await upsert({ username:'staff02', real_name:'王文豪', role:'staff', status:'active', is_first_login:false, password_hash:pw0, id_number:'Z200000002', birthday:'1982-07-22', phone:'0912000002', email:'staff02@hiban.com', address:'台北市大安區和平東路二段50號', nickname:null });

  // ── 督導人員 (3人) ────────────────────────────────────────────
  console.log('\n📖 督導人員...');
  const sv1id = await upsert({ username:'sv_001001', real_name:'吳建國', role:'supervisor', status:'active', is_first_login:false, password_hash:pw0, id_number:'H890123456', birthday:'1980-04-12', phone:'0912345001', email:'wu@hiban.com', address:'台北市大安區敦化南路一段200號', nickname:null });
  const sv2id = await upsert({ username:'sv_002002', real_name:'蔡淑芬', role:'supervisor', status:'active', is_first_login:false, password_hash:pw0, id_number:'I901234567', birthday:'1978-08-20', phone:'0912345002', email:'tsai@hiban.com', address:'新北市中和區景平路500號', nickname:null });
  const sv3id = await upsert({ username:'sv_003003', real_name:'林志明', role:'supervisor', status:'active', is_first_login:false, password_hash:pw0, id_number:'J012345678', birthday:'1983-11-05', phone:'0912345003', email:'lin@hiban.com', address:'台中市西屯區台灣大道四段200號', nickname:null });

  console.log(`   吳建國(id:${sv1id}) / 蔡淑芬(id:${sv2id}) / 林志明(id:${sv3id})`);

  // ── 工作夥伴 (10人) ──────────────────────────────────────────
  // 督導分配：吳建國管2人、蔡淑芬管1人、林志明管3人 → 6人已核可
  // 剩4人待審核
  console.log('\n⚔️  工作夥伴...');

  const partners = [
    // ── 吳建國負責 2人 ──
    { username:'partner01', real_name:'陳小花', nickname:'月影旅者', id_number:'A234567890', birthday:'1998-05-20', phone:'0911000001', email:'flower@gmail.com',  address:'台北市中山區民生東路三段10號',   bank_name:'台灣銀行', bank_account:'001234567890', identity:'',            status:'active',  supervisor_id: sv1id },
    { username:'partner02', real_name:'林大明', nickname:'靜默劍士', id_number:'B345678901', birthday:'1995-11-08', phone:'0911000002', email:'forest@gmail.com',  address:'新北市板橋區文化路一段50號',    bank_name:'合作金庫', bank_account:'006234567890', identity:'',            status:'active',  supervisor_id: sv1id },
    // ── 蔡淑芬負責 1人 ──
    { username:'partner03', real_name:'王小明', nickname:'流星飛俠', id_number:'C456789012', birthday:'1993-03-22', phone:'0911000003', email:'wang@gmail.com',    address:'台中市西屯區台灣大道三段300號', bank_name:'第一銀行', bank_account:'007234567890', identity:'',            status:'active',  supervisor_id: sv2id },
    // ── 林志明負責 3人 ──
    { username:'partner04', real_name:'李美玲', nickname:'紫羅蘭',   id_number:'D567890123', birthday:'1996-07-14', phone:'0911000004', email:'lee@gmail.com',     address:'高雄市前鎮區中山二路50號',     bank_name:'國泰世華', bank_account:'013234567890', identity:'二度就業婦女', status:'active',  supervisor_id: sv3id },
    { username:'partner05', real_name:'張志豪', nickname:'暗影獵手', id_number:'E678901234', birthday:'1990-09-05', phone:'0911000005', email:'chang@gmail.com',   address:'桃園市桃園區中正路150號',      bank_name:'玉山銀行', bank_account:'808234567890', identity:'身心障礙者',  status:'active',  supervisor_id: sv3id },
    { username:'partner06', real_name:'陳雅婷', nickname:'白雪精靈', id_number:'F789012345', birthday:'2000-01-18', phone:'0911000006', email:'chen@gmail.com',    address:'台南市東區東門路一段80號',     bank_name:'彰化銀行', bank_account:'009234567890', identity:'',            status:'active',  supervisor_id: sv3id },
    // ── 待核可 4人（未分配督導） ──
    { username:'partner07', real_name:'劉建宏', nickname:'鐵甲武士', id_number:'G890123456', birthday:'1988-12-30', phone:'0911000007', email:'liu@gmail.com',     address:'基隆市仁愛區愛一路30號',       bank_name:'台灣銀行', bank_account:'001987654321', identity:'中高齡者（45歲以上）', status:'pending', supervisor_id: null },
    { username:'partner08', real_name:'林怡君', nickname:'月光使者', id_number:'H901234567', birthday:'1994-06-25', phone:'0911000008', email:'lin@gmail.com',     address:'新竹市東區光復路二段100號',    bank_name:'合作金庫', bank_account:'006987654321', identity:'',            status:'pending', supervisor_id: null },
    { username:'partner09', real_name:'黃志偉', nickname:'極速之星', id_number:'I012345679', birthday:'2001-08-15', phone:'0911000009', email:'huang@gmail.com',   address:'台北市松山區八德路三段20號',   bank_name:'台灣銀行', bank_account:'001111111111', identity:'',            status:'pending', supervisor_id: null },
    { username:'partner10', real_name:'吳宜蓉', nickname:'晨曦戰士', id_number:'J123456780', birthday:'1997-04-03', phone:'0911000010', email:'wu_r@gmail.com',    address:'新北市三重區重新路五段100號',  bank_name:'第一銀行', bank_account:'007222222222', identity:'單親家庭',     status:'pending', supervisor_id: null },
  ];

  for (const p of partners) {
    await upsert({ ...p, role:'partner', is_first_login: p.status==='active' ? false : true, password_hash: pw0 });
  }

  const approved = partners.filter(p => p.status === 'active').length;
  const pending  = partners.filter(p => p.status === 'pending').length;

  console.log('\n✅ 完成！');
  console.log(`   管理人員：3人（admin / staff01 / staff02）`);
  console.log(`   督導人員：3人`);
  console.log(`   工作夥伴：10人（已核可 ${approved} 人、待核可 ${pending} 人）`);
  console.log(`   督導分配：吳建國(2) / 蔡淑芬(1) / 林志明(3)`);
  process.exit(0);
}
main().catch(e => { console.error('❌', e.message); process.exit(1); });
