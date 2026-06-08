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

// ── 公告已讀追蹤 ──────────────────────────────────────────────
function getReadIds(userId) {
  try { return JSON.parse(localStorage.getItem(`ann_read_${userId}`) || '[]'); } catch { return []; }
}
function markRead(userId, id) {
  const ids = getReadIds(userId);
  if (!ids.includes(String(id))) { ids.push(String(id)); localStorage.setItem(`ann_read_${userId}`, JSON.stringify(ids)); }
}
function markAllRead(userId, ids) {
  localStorage.setItem(`ann_read_${userId}`, JSON.stringify(ids.map(String)));
}

// ── 公告詳細視窗（所有角色共用）─────────────────────────────
function showAnnDetail(ann, userId) {
  // 標記已讀
  if (userId) markRead(userId, ann.id);

  const targetLabel = { all:'全部角色', partner:'工作夥伴', supervisor:'督導人員', staff:'管理人員' }[ann.target||'all'] || '全部角色';
  const expiryHtml  = ann.expires_at
    ? `<span style="background:#F0F8FE;color:#7A9AAF;padding:.18rem .55rem;border-radius:8px">到期：${ann.expires_at}</span>`
    : `<span style="background:#F0EBF8;color:#9B6FD4;padding:.18rem .55rem;border-radius:8px">🔒 永久公告</span>`;
  const attUrl  = `/api/announcements/${ann.id}/attachment`;
  const isImage = ann.attachment_mime && ann.attachment_mime.startsWith('image/');
  const attHtml = ann.attachment_name ? `
    <div style="margin-top:1rem;padding-top:.9rem;border-top:1px solid #C8E8F6">
      <div style="font-size:.75rem;color:#7A9AAF;margin-bottom:.6rem">📎 附件</div>
      ${isImage ? `
        <div style="margin-bottom:.7rem;border-radius:10px;overflow:hidden;border:1.5px solid #C8E8F6;max-width:100%;line-height:0">
          <img src="${attUrl}" alt="${ann.attachment_name}"
               style="max-width:100%;max-height:320px;object-fit:contain;display:block;background:#f5fafd">
        </div>` : `
        <div style="display:flex;align-items:center;gap:.6rem;padding:.6rem .8rem;background:#f5fafd;border:1.5px solid #C8E8F6;border-radius:10px;margin-bottom:.6rem">
          <span style="font-size:1.5rem">📄</span>
          <span style="font-size:.82rem;color:#3D5A70;word-break:break-all">${ann.attachment_name}</span>
        </div>`}
      <a href="${attUrl}" download="${ann.attachment_name}"
         style="display:inline-flex;align-items:center;gap:.4rem;padding:.38rem 1rem;background:#1A8AC0;border-radius:20px;font-size:.82rem;font-weight:700;color:#fff;text-decoration:none">
        ⬇ 下載附件
      </a>
    </div>` : '';

  // 建立或取得 modal
  let modal = document.getElementById('_ann_detail_modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = '_ann_detail_modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9998;display:flex;align-items:center;justify-content:center;padding:1rem;overflow-y:auto';
    modal.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px;width:min(600px,96vw);max-height:88vh;overflow-y:auto;padding:1.6rem;box-shadow:0 16px 48px rgba(13,74,114,.22);position:relative">
      <button onclick="document.getElementById('_ann_detail_modal').style.display='none'"
              style="position:absolute;top:1rem;right:1rem;background:none;border:none;font-size:1.25rem;cursor:pointer;color:#7A9AAF;line-height:1">✕</button>
      <div style="font-family:'Noto Serif TC',serif;font-weight:700;font-size:1.1rem;line-height:1.5;padding-right:2rem;margin-bottom:.75rem">${ann.title}</div>
      <div style="display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:.6rem;font-size:.73rem">
        ${ann.is_pinned ? '<span style="background:#1A8AC0;color:#fff;padding:.18rem .5rem;border-radius:8px">📌 置頂</span>' : ''}
        <span style="background:#EBF7FD;color:#1A8AC0;padding:.18rem .55rem;border-radius:8px">${targetLabel}</span>
        ${expiryHtml}
      </div>
      <div style="font-size:.75rem;color:#7A9AAF;margin-bottom:.9rem">
        發布：${ann.created_by || '—'} &nbsp;·&nbsp; ${(ann.created_at||'').slice(0,16)}
      </div>
      <div style="font-size:.92rem;color:#3D5A70;line-height:1.85;white-space:pre-wrap;border-top:1px solid #C8E8F6;padding-top:.9rem">${ann.content}</div>
      ${attHtml}
    </div>`;
  modal.style.display = 'flex';
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
