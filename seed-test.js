// 建立測試帳號
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
  if (!snap.empty) { console.log(`  ⏭  ${data.username} 已存在`); return; }
  const id   = await nextId();
  await db.collection('users').doc(String(id)).set({ id, created_at: now(), ...data });
  console.log(`  ➕ ${data.username} (${data.role}) — ${data.real_name}`);
}

const defaultPw = bcrypt.hashSync('0000', 10);

const testUsers = [
  // ── 工作夥伴 ──────────────────────────────────────────────
  {
    username:'partner03', real_name:'王小明', nickname:'流星飛俠',
    role:'partner', status:'active', is_first_login:false,
    id_number:'B234567890', birthday:'1995-03-22', phone:'0923456789',
    email:'wang.ming@gmail.com', address:'台北市信義區忠孝東路五段100號',
    identity:'', bank_name:'台灣銀行', bank_account:'123456789012',
    password_hash: defaultPw,
  },
  {
    username:'partner04', real_name:'李美玲', nickname:'紫羅蘭',
    role:'partner', status:'active', is_first_login:false,
    id_number:'C345678901', birthday:'1998-07-14', phone:'0934567890',
    email:'li.meiling@gmail.com', address:'新北市板橋區文化路一段200號',
    identity:'二度就業婦女', bank_name:'合作金庫', bank_account:'234567890123',
    password_hash: defaultPw,
  },
  {
    username:'partner05', real_name:'張志豪', nickname:'暗影獵手',
    role:'partner', status:'active', is_first_login:false,
    id_number:'D456789012', birthday:'1992-11-05', phone:'0945678901',
    email:'chang.hao@gmail.com', address:'台中市西屯區台灣大道三段300號',
    identity:'身心障礙者', bank_name:'第一銀行', bank_account:'345678901234',
    password_hash: defaultPw,
  },
  {
    username:'partner06', real_name:'陳雅婷', nickname:'白雪精靈',
    role:'partner', status:'pending', is_first_login:true,
    id_number:'E567890123', birthday:'2000-05-18', phone:'0956789012',
    email:'chen.yating@gmail.com', address:'高雄市前鎮區中山二路50號',
    identity:'', bank_name:'國泰世華', bank_account:'456789012345',
    password_hash: defaultPw,
  },
  {
    username:'partner07', real_name:'劉建宏', nickname:'鐵甲武士',
    role:'partner', status:'pending', is_first_login:true,
    id_number:'F678901234', birthday:'1989-09-30', phone:'0967890123',
    email:'liu.jianhong@gmail.com', address:'桃園市桃園區中正路150號',
    identity:'中高齡者（45歲以上）', bank_name:'玉山銀行', bank_account:'567890123456',
    password_hash: defaultPw,
  },
  {
    username:'partner08', real_name:'林怡君', nickname:'月光使者',
    role:'partner', status:'inactive', is_first_login:false,
    id_number:'G789012345', birthday:'1994-01-25', phone:'0978901234',
    email:'lin.yijun@gmail.com', address:'台南市東區東門路一段80號',
    identity:'單親家庭', bank_name:'彰化銀行', bank_account:'678901234567',
    password_hash: defaultPw,
  },

  // ── 督導人員 ──────────────────────────────────────────────
  {
    username:'sv_001001', real_name:'吳建國', nickname:null,
    role:'supervisor', status:'active', is_first_login:false,
    id_number:'H890123456', birthday:'1980-04-12', phone:'0912345001',
    email:'wu.jianguo@hiban.com', address:'台北市大安區敦化南路一段200號',
    identity:'', password_hash: defaultPw,
  },
  {
    username:'sv_002002', real_name:'蔡淑芬', nickname:null,
    role:'supervisor', status:'active', is_first_login:false,
    id_number:'I901234567', birthday:'1978-08-20', phone:'0912345002',
    email:'tsai.shufen@hiban.com', address:'新北市中和區景平路500號',
    identity:'', password_hash: defaultPw,
  },

  // ── 工作人員 ──────────────────────────────────────────────
  {
    username:'st_001001', real_name:'黃志明', nickname:null,
    role:'staff', status:'active', is_first_login:false,
    id_number:'J012345678', birthday:'1985-12-03', phone:'0912345003',
    email:'huang.zhiming@hiban.com', address:'台北市中山區民生東路三段100號',
    identity:'', password_hash: defaultPw,
  },
  {
    username:'st_002002', real_name:'許雅雯', nickname:null,
    role:'staff', status:'active', is_first_login:false,
    id_number:'K123456789', birthday:'1990-06-15', phone:'0912345004',
    email:'hsu.yawen@hiban.com', address:'台中市北區三民路三段80號',
    identity:'', password_hash: defaultPw,
  },
];

async function main() {
  console.log('\n🔧 建立測試帳號...');
  for (const u of testUsers) await createUser(u);
  console.log(`\n✅ 完成！共處理 ${testUsers.length} 筆\n`);
  process.exit(0);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
