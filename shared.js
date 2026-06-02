// ══════════════════════════════════════════
// shared.js — 希絆雲作所 共用前端模組
// ══════════════════════════════════════════

const API = {
  async call(method, url, body) {
    const opt = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
    if (body) opt.body = JSON.stringify(body);
    const res = await fetch(url, opt);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '操作失敗');
    return data;
  },
  get:    (url)       => API.call('GET',    url),
  post:   (url, body) => API.call('POST',   url, body),
  put:    (url, body) => API.call('PUT',    url, body),
  delete: (url)       => API.call('DELETE', url),
};

// 確認登入狀態，未登入導回首頁（傳入允許的角色）
async function requireAuth(allowedRoles) {
  try {
    const me = await API.get('/api/me');
    if (allowedRoles && !allowedRoles.includes(me.role)) {
      alert('權限不足，返回登入頁');
      location.href = '/index.html';
      return null;
    }
    return me;
  } catch {
    location.href = '/index.html';
    return null;
  }
}

// 登出
async function signOut() {
  await API.post('/api/logout').catch(() => {});
  location.href = '/index.html';
}

// 顯示 toast 通知
function showToast(msg, type = 'info') {
  let el = document.getElementById('_toast');
  if (!el) {
    el = document.createElement('div');
    el.id = '_toast';
    el.style.cssText = `
      position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%);
      padding:.7rem 1.4rem;border-radius:24px;font-size:.88rem;font-weight:600;
      z-index:9999;pointer-events:none;transition:opacity .3s;opacity:0;
      font-family:'Noto Sans TC',sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.15);
      white-space:nowrap;
    `;
    document.body.appendChild(el);
  }
  const colors = { info: '#48B4E8', success: '#2EAA7A', error: '#E05555', warn: '#F07840' };
  el.style.background = colors[type] || colors.info;
  el.style.color = '#fff';
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.opacity = '0'; }, 2800);
}
