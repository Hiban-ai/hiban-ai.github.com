// taskId.js — 任務代號（外層隨機碼）／任務編號（內層流水號）產生模組
// 技術棧：Node.js + Firebase Firestore，�in配合既有 Transaction 機制
// 匯出：產生任務代號()、新增任務(代號)

const crypto = require('crypto');
const admin = require('firebase-admin');
const { db } = require('./db'); // 沿用已初始化的 Firestore 實例

// 字元集：剛好 62 種（0-9 A-Z a-z）
const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const CODE_LEN = 6;   // 代號長度
const MAX_RETRY = 5;  // 撞號重試上限

// 以密碼學等級亂數產生 6 碼代號（不可用 Math.random）
function randomCode() {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += CHARSET[crypto.randomInt(CHARSET.length)];
  return s;
}

/**
 * 一、產生任務代號（外層，隨機碼）
 *  - 隨機 6 碼；以「代號當 document ID」+ Transaction 確保唯一（非先查再寫）
 *  - 撞號則重新產生並重試，最多 5 次；仍失敗丟出明確錯誤
 *  - 建立父文件，含 childCount(初始0)、建立時間(serverTimestamp)
 * @param {string} codeCollection 代號集合名稱（如 '自由任務代號'、'限量任務代號'）
 * @returns {Promise<string>} 不重複的 6 碼代號
 */
async function 產生任務代號(codeCollection = 'taskCodes') {
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const code = randomCode();
    const ref = db.collection(codeCollection).doc(code);
    try {
      await db.runTransaction(async t => {
        const snap = await t.get(ref);
        if (snap.exists) throw new Error('CODE_COLLISION'); // 已存在 → 撞號
        t.set(ref, { childCount: 0, 建立時間: admin.firestore.FieldValue.serverTimestamp() });
      });
      return code; // 成功取得不重複代號
    } catch (e) {
      if (e.message === 'CODE_COLLISION') continue; // 撞號 → 換一個重試
      throw e; // 其他錯誤直接拋出
    }
  }
  throw new Error(`產生任務代號失敗：連續 ${MAX_RETRY} 次撞號（${codeCollection}）`);
}

/**
 * 二、新增任務（內層，流水號）
 *  - 在指定代號底下，用 Transaction 遞增父文件 childCount，產生 3 碼編號（001…999）
 *  - 每個代號底下各自獨立計數，避免並發超發或重號
 *  - taskItems 文件 ID 用「完整編號」：{代號}-{編號}（如 aB3xKp-001）
 *  - 必存欄位：任務代號、任務編號、完整編號、序、狀態(預設"未認領")、建立時間
 * @param {string} 代號 6 碼任務代號
 * @param {object} [opts] { codeCollection, itemCollection, extra }
 * @returns {Promise<{完整編號:string,任務代號:string,任務編號:string,序:number}>}
 */
async function 新增任務(代號, opts = {}) {
  const codeCollection = opts.codeCollection || 'taskCodes';
  const itemCollection = opts.itemCollection || 'taskItems';
  const extra = opts.extra || {};
  const parentRef = db.collection(codeCollection).doc(代號);
  return db.runTransaction(async t => {
    const snap = await t.get(parentRef);
    if (!snap.exists) throw new Error(`任務代號不存在：${代號}`);
    const 序 = (snap.data().childCount || 0) + 1;
    if (序 > 999) throw new Error(`代號 ${代號} 的任務編號已達上限 999，請改用新代號`);
    const 任務編號 = String(序).padStart(3, '0');
    const 完整編號 = `${代號}-${任務編號}`;
    const itemRef = db.collection(itemCollection).doc(完整編號);
    t.update(parentRef, { childCount: 序 });
    t.set(itemRef, {
      任務代號: 代號,
      任務編號,
      完整編號,
      序,
      狀態: '未認領',
      建立時間: admin.firestore.FieldValue.serverTimestamp(),
      ...extra, // 整合用的額外欄位（夥伴、任務名稱…）
    });
    return { 完整編號, 任務代號: 代號, 任務編號, 序 };
  });
}

/**
 * 三、批次新增任務（一次產生多筆編號，供限量任務「挑選模式」預先建卡）
 *  - 單一 Transaction 內把父文件 childCount 一次推進 N，產生 N 筆 代號-編號 項目
 *  - 避免逐筆呼叫造成 N 次 round-trip，且維持編號連續、無重號
 * @param {string} 代號 6 碼任務代號
 * @param {object[]} extras 每筆要附加的欄位（長度 = 要產生的數量）；可給空物件
 * @param {object} [opts] { codeCollection, itemCollection }
 * @returns {Promise<Array<{完整編號:string,任務代號:string,任務編號:string,序:number}>>}
 */
async function 新增任務批次(代號, extras = [], opts = {}) {
  const codeCollection = opts.codeCollection || 'taskCodes';
  const itemCollection = opts.itemCollection || 'taskItems';
  if (!Array.isArray(extras) || extras.length === 0) return [];
  const parentRef = db.collection(codeCollection).doc(代號);
  return db.runTransaction(async t => {
    const snap = await t.get(parentRef);
    if (!snap.exists) throw new Error(`任務代號不存在：${代號}`);
    let 序 = snap.data().childCount || 0;
    const out = [];
    for (const extra of extras) {
      序 += 1;
      if (序 > 999) throw new Error(`代號 ${代號} 的任務編號已達上限 999，請改用新代號`);
      const 任務編號 = String(序).padStart(3, '0');
      const 完整編號 = `${代號}-${任務編號}`;
      t.set(db.collection(itemCollection).doc(完整編號), {
        任務代號: 代號, 任務編號, 完整編號, 序,
        狀態: '未認領',
        建立時間: admin.firestore.FieldValue.serverTimestamp(),
        ...(extra || {}),
      });
      out.push({ 完整編號, 任務代號: 代號, 任務編號, 序 });
    }
    t.update(parentRef, { childCount: 序 });
    return out;
  });
}

module.exports = { 產生任務代號, 新增任務, 新增任務批次 };

/* ── 呼叫範例 ───────────────────────────────────────────────
const { 產生任務代號, 新增任務 } = require('./taskId');

(async () => {
  // ① 自由任務發布：產生一個不重複代號（存於「自由任務代號」集合）
  const code = await 產生任務代號('自由任務代號');
  // ② 夥伴接案：在該代號下取一個任務編號（完整編號如 aB3xKp-001）
  const r = await 新增任務(code, {
    codeCollection: '自由任務代號',
    itemCollection: '自由任務項目',
    extra: { 任務名稱: '開箱文撰寫', 夥伴: 'partner01' },
  });
  console.log(r.完整編號); // 例：aB3xKp-001
})();
─────────────────────────────────────────────────────────── */
