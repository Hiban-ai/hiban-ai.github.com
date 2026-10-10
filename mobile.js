// mobile.js — 三個角色手機版共用的小工具、路由、公告、個人資料（需先載入 shared.js）
// ── 小工具 ──────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
// 先跳脫再把網址轉成連結
function linkify(s) {
  return esc(s).replace(/https?:\/\/[^\s<>"']+/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
}
const money = n => '$' + (Number(n) || 0).toLocaleString();
function twNow() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' })); }
const pad = n => String(n).padStart(2, '0');
function ymd(d) { return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`; }
function fmtDay(s) {
  if (!s) return '—';
  const [y, m, d] = s.replace(/-/g, '/').split(' ')[0].split('/');
  return `${y}/${pad(m)}/${pad(d)}`;
}
// 'YYYY/MM/DD...' 或 'YYYY/M/D...' 是否落在指定年月
function inMonth(s, y, m) { s = s || ''; return s.startsWith(`${y}/${pad(m)}/`) || s.startsWith(`${y}/${m}/`); }
// 卡片右上角金額：時薪任務在回報前還沒有總額，改顯示時薪
function priceHtml(a) {
  return a.assign_type === 'hourly' && !a.total_price
    ? `<div class="price" style="font-size:1rem">時薪 ${money(a.hourly_wage)}</div>`
    : `<div class="price">${money(a.total_price)}</div>`;
}
function taskLabel(a) { return a.company ? `${a.company}：${a.task_name}` : (a.task_name || ''); }
function taskCode(a) { return a.full_code || a.task_no || ''; }
function attachmentsHtml(atts) {
  if (!atts || !atts.length) return '';
  return `<div>${atts.map(a => `<a class="att" href="/api/task-attachment/${encodeURIComponent(a.drive_id)}" target="_blank" rel="noopener">📎 ${esc(a.name || '附件')}</a>`).join('')}</div>`;
}
function customFieldsHtml(fields) {
  fields = (fields || []).filter(f => f.value !== '' && f.value != null);
  if (!fields.length) return '';
  return `<div style="font-size:.92rem;margin:.3rem 0">${fields.map(f => `<div><span class="muted">${esc(f.label)}：</span>${linkify(f.value)}</div>`).join('')}</div>`;
}
function setBadge(id, n) { const el = $(id); if (!el) return; el.textContent = n; el.style.display = n ? 'inline-flex' : 'none'; }
function closeSheet(id) { $(id).classList.remove('open'); }
function openSheet(id) { $(id).classList.add('open'); const f = $(id).querySelector('input,textarea,select,button.x'); if (f) setTimeout(() => f.focus(), 50); }

// 壓縮圖片（最寬 maxW，JPEG）
function compressImage(file, maxW, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = e => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}
function fileToB64(f) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); }); }

// ── 頁面切換（用網址 #，手機返回鍵可回上一頁）─────────────────────
// 頁面提供 PAGES（第一個是預設頁）、NAV_OF（子頁對應到哪個底部按鈕）、onShowPage(name)
const NAV_TABS = () => Array.from(document.querySelectorAll('.nav button[id^="nav-"]')).map(b => b.id.slice(4));
function go(name) { if (location.hash !== '#' + name) location.hash = name; else showPage(name); }
function showPage(name) {
  if (!PAGES.includes(name)) name = PAGES[0];
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
  NAV_TABS().forEach(n => {
    const b = $('nav-' + n);
    if ((NAV_OF[name] || name) === n) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
  if (typeof onShowPage === 'function') onShowPage(name);
}
window.addEventListener('hashchange', () => showPage(location.hash.slice(1)));

// 切到電腦版並記住選擇（登入頁會照這個導向）
function switchToDesktop(page) {
  try { localStorage.setItem('hiban_view', 'desktop'); } catch (e) {}
  location.href = page;
}

function monthOptions(sel) {
  if (sel.options.length) return;
  const now = twNow();
  for (let i = 0; i < 24; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const o = document.createElement('option');
    o.value = `${d.getFullYear()}-${d.getMonth() + 1}`;
    o.textContent = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
    sel.appendChild(o);
  }
}

function scheduleMidnightLogout() {
  const now = twNow(), mid = new Date(now); mid.setHours(23, 59, 59, 999);
  setTimeout(() => signOut(), mid - now + 1000);
}

// ── 📢 公告（頁面可定義 onAnnChange() 更新自己的角標）────────────
function annChanged() { if (typeof onAnnChange === 'function') onAnnChange(); }
let annList = [], annTab = 'general';
async function loadAnnouncements() {
  try { annList = await API.get('/api/announcements'); } catch (e) { annList = []; }
  renderAnnList(); renderHomeNotices(); annChanged();
}
function visibleAnns() { const today = new Date().toISOString().slice(0, 10); return annList.filter(a => !a.expires_at || a.expires_at >= today); }
function isUnread(a) { return !getReadIds(meId).includes(String(a.id)); }
function setAnnTab(t) {
  annTab = t;
  ['general', 'task'].forEach(x => $('ann-tab-' + x).setAttribute('aria-selected', x === t));
  renderAnnList();
}
function annRow(a) {
  return `<button class="ann" onclick="openAnn('${esc(String(a.id))}')">
    <div class="row">${isUnread(a) ? '<span class="dot" aria-label="未讀"></span>' : ''}${a.is_pinned ? '📌' : ''}<b style="flex:1;min-width:0">${esc(a.title)}</b></div>
    <div class="muted">${esc((a.created_at || '').slice(0, 16))}・${esc(a.created_by || '—')}</div>
  </button>`;
}
function renderAnnList() {
  const vis = visibleAnns();
  const groups = { general: vis.filter(a => a.category !== 'task'), task: vis.filter(a => a.category === 'task') };
  ['general', 'task'].forEach(t => { const n = groups[t].filter(isUnread).length; $('ann-n-' + t).textContent = n ? `(${n})` : ''; });
  const list = groups[annTab].slice().sort((a, b) => ((b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0)) || (b.created_at || '').localeCompare(a.created_at || ''));
  $('ann-list').innerHTML = list.length ? list.map(annRow).join('') : `<div class="card empty">${annTab === 'task' ? '目前沒有任務通知' : '目前沒有公告'}</div>`;
}
function renderHomeNotices() {
  const unread = visibleAnns().filter(isUnread).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  if (!$('home-notices')) return;
  $('home-notices').innerHTML = unread.length
    ? `<div class="section">🔔 新公告 <span class="count">${unread.length}</span></div>${unread.slice(0, 2).map(annRow).join('')}${unread.length > 2 ? `<a href="#notices" class="muted" style="display:block;text-align:center;padding:.5rem">還有 ${unread.length - 2} 則 ›</a>` : ''}`
    : '';
}
function openAnn(id) {
  const a = annList.find(x => String(x.id) === id);
  if (!a) return;
  showAnnDetail(a, meId);
  renderAnnList(); renderHomeNotices(); annChanged();
}
function markAllAnnsRead() {
  markAllRead(meId, visibleAnns().map(a => a.id));
  renderAnnList(); renderHomeNotices(); annChanged();
  showToast('公告已全部標為已讀', 'success');
}

// ── 🧑 個人資料 ────────────────────────────────────────────────
let prof = {};
const maskId = s => s && s.length > 4 ? s.slice(0, 2) + '*'.repeat(s.length - 5) + s.slice(-3) : (s || '');
function fillProfile() {
  const set = (id, v) => { const el = $(id); if (el) el.value = v || ''; };
  set('prof-name', prof.real_name); set('prof-idno', maskId(prof.id_number));
  set('prof-birthday', prof.birthday); set('prof-phone', prof.phone);
  set('prof-address', prof.address); set('prof-email', prof.email);
  set('prof-bank-code', prof.bank_code); set('prof-bank-name', prof.bank_name); set('prof-bank-account', prof.bank_account);
}
function toggleProfEdit(on) {
  ['prof-phone', 'prof-address'].forEach(i => { $(i).disabled = !on; });
  $('prof-edit-btn').style.display = on ? 'none' : ''; $('prof-save-row').style.display = on ? 'flex' : 'none';
  if (on) $('prof-phone').focus(); else fillProfile();
}
async function saveProfile() {
  try {
    await API.put('/api/profile', { phone: $('prof-phone').value.trim(), address: $('prof-address').value.trim() });
    prof.phone = $('prof-phone').value.trim(); prof.address = $('prof-address').value.trim();
    toggleProfEdit(false); showToast('個人資料已儲存', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}
function toggleBankEdit(on) {
  ['prof-bank-code', 'prof-bank-name', 'prof-bank-account'].forEach(i => { $(i).disabled = !on; });
  $('bank-edit-btn').style.display = on ? 'none' : ''; $('bank-save-row').style.display = on ? 'flex' : 'none';
  if (on) $('prof-bank-code').focus(); else fillProfile();
}
async function saveBank() {
  const body = { bank_code: $('prof-bank-code').value.trim(), bank_name: $('prof-bank-name').value.trim(), bank_account: $('prof-bank-account').value.trim() };
  try { await API.put('/api/profile/bank', body); Object.assign(prof, body); toggleBankEdit(false); showToast('銀行資料已儲存', 'success'); }
  catch (e) { showToast(e.message, 'error'); }
}
async function changePassword() {
  const err = $('pw-err'); err.style.display = 'none';
  const cur = $('pw-current').value, nw = $('pw-new').value, cf = $('pw-confirm').value;
  const fail = m => { err.textContent = m; err.style.display = 'block'; };
  if (nw.length < 6 || nw.length > 12) return fail('新密碼要 6～12 碼');
  if (nw !== cf) return fail('兩次輸入的新密碼不一樣');
  try {
    await API.post('/api/change-password', { current_password: cur, new_password: nw });
    ['pw-current', 'pw-new', 'pw-confirm'].forEach(i => { $(i).value = ''; });
    showToast('密碼已更新', 'success');
  } catch (e) { fail(e.status === 401 ? '目前密碼不正確' : e.message); }
}

