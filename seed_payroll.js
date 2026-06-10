// 塞薪資測試資料：為多位夥伴建立 4/5/6 月已完成任務
const admin = require('firebase-admin');
let sa;
try { sa = require('./firebase-key.json'); } catch(e) { sa = JSON.parse(process.env.FIREBASE_KEY); }
if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g,'\n');
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

// 夥伴資料 [id, name, supervisor_id]
const partners = [
  [7,  '陳小花', 4],
  [8,  '林大明', 4],
  [10, '李美玲', 6],
  [11, '張志豪', 6],
  [12, '陳雅婷', 6],
];

// 任務樣板 [task_name, unit_price, quantity]
const tasks = [
  ['口碑任務',      300, 3],
  ['SEO文案撰寫',   500, 2],
  ['廣告圖設計',    800, 1],
  ['社群貼文撰寫',  400, 2],
  ['影片腳本撰寫',  600, 1],
];

// 日期清單 [year, month, day, hour, min, sec]
const dates = {
  4: [[4,5,9,30,0],[4,12,14,20,0],[4,20,10,0,0],[4,28,16,45,0]],
  5: [[5,3,9,0,0],[5,10,11,30,0],[5,18,15,0,0],[5,25,10,15,0]],
  6: [[6,2,9,0,0],[6,5,14,0,0]],
};

function fmt(y,mo,d,h,mi,s){
  const p=n=>String(n).padStart(2,'0');
  return `${y}/${p(mo)}/${p(d)} ${p(h)}:${p(mi)}:${p(s)}`;
}
function fmtDay(y,mo,d){
  const p=n=>String(n).padStart(2,'0');
  return `${y}/${p(mo)}/${p(d)}`;
}

async function run() {
  const metaRef = db.collection('_meta').doc('counters');
  const metaDoc = await metaRef.get();
  let counter = metaDoc.exists ? (metaDoc.data().assignments || 0) : 0;

  const batch_size = 400; // Firestore batch limit
  let ops = [];

  for (const [pid, pname, svId] of partners) {
    for (const [month, dayList] of Object.entries(dates)) {
      for (let i = 0; i < dayList.length; i++) {
        const [mo, d, h, mi, s] = dayList[i];
        const task = tasks[(pid + i) % tasks.length];
        const [task_name, unit_price, quantity] = task;
        const total_price = unit_price * quantity;
        counter++;
        const id = counter;
        const completed_at = fmt(2026, mo, d, h, mi, s);
        const accepted_at  = fmt(2026, mo, d, h-1 < 0 ? 0 : h-1, mi, s);
        const assigned_at  = fmt(2026, mo, d > 1 ? d-1 : 1, 10, 0, 0);
        const deadline_date = fmtDay(2026, mo, d+2 > 28 ? 28 : d+2);

        const doc = {
          id, task_name, unit_price, quantity, total_price,
          status: 'completed',
          assign_type: 'individual',
          target_partner_id: pid,
          accepted_by: pid,
          supervisor_id: svId,
          supervisor_name: svId === 4 ? '吳建國' : svId === 5 ? '蔡淑芬' : '林志明',
          partner_name: pname,
          assigned_at, accepted_at, completed_at, deadline_date,
          notes: '',
          created_at: assigned_at,
        };
        ops.push({ id: String(id), data: doc });
      }
    }
  }

  // 更新 counter
  await metaRef.set({ assignments: counter }, { merge: true });

  // 寫入 Firestore
  let batch = db.batch();
  let count = 0;
  for (const op of ops) {
    batch.set(db.collection('assignments').doc(op.id), op.data);
    count++;
    if (count % 400 === 0) { await batch.commit(); batch = db.batch(); }
  }
  await batch.commit();

  console.log(`✅ 已塞入 ${ops.length} 筆資料（counter now ${counter}）`);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
