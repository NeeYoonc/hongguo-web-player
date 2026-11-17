'use strict';

const SOURCE = 'hongguo';
const $ = (id) => document.getElementById(id);

const state = {
  category: '',
  query: '',
  page: 1,
  items: [],
  hasMore: false,
  loading: false,
  categories: [],
  drama: null,
  chapters: [],
  index: 0,
  plan: null,
  qualities: [],
  quality: 0,
  videoTime: 0,
  watched: {},
  favs: [],
  likes: [],
  renderLimit: 60,
};

/* ---------------- 基础工具 ---------------- */

const SESSION_KEY = 'hg:cookies';
function sessionCookies() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || '{}'); } catch (e) { return {}; }
}
async function bootstrapSession() {
  try {
    if (localStorage.getItem(SESSION_KEY)) return;
    const res = await api({ action: 'hgExportSession' });
    const cookies = (res && res.cookies) || {};
    if (Object.keys(cookies).length) saveSessionCookies(cookies);
  } catch (e) { /* 无旧会话，忽略 */ }
}
function saveSessionCookies(cookies) {
  try {
    if (cookies && Object.keys(cookies).length) localStorage.setItem(SESSION_KEY, JSON.stringify(cookies));
    else localStorage.removeItem(SESSION_KEY);
  } catch (e) { /* ignore */ }
}
async function api(payload) {
  const cookies = sessionCookies();
  if (Object.keys(cookies).length) payload = Object.assign({}, payload, { cookies: cookies });
  const res = await fetch('/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error('服务返回异常');
  }
  if (!data.ok) throw new Error(data.error || '请求失败');
  return data.data;
}

function proxyURL(url) {
  const m = /^http:\/\/127\.0\.0\.1:(\d+)(\/.*)$/.exec(url || '');
  return m ? `/rs/${m[1]}${m[2]}` : url;
}

// clog：把前端关键步骤与异常发回服务端日志（/clientlog），方便在 NAS 上排查。
// URL 带 ?debug=1 时同时在页面左下角显示最近 12 条，便于截图定位。
const SELFTEST = location.search.indexOf('selftest=1') >= 0;
// 自检自动播放需要静音（浏览器自动播放策略）；用户一旦有点击/按键，后续剧集恢复声音。
let userActivated = false;
let autoMuted = false;
['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
  window.addEventListener(ev, function () {
    userActivated = true;
    if (autoMuted) {
      autoMuted = false;
      const video = $('video');
      if (video) video.muted = false;
    }
  }, { capture: true, passive: true });
});
const DEBUG = location.search.indexOf('debug=1') >= 0 || SELFTEST;
const debugLines = [];
function debugPanel(msg) {
  if (!DEBUG) return;
  let box = document.getElementById('debug-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'debug-box';
    box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;max-width:70vw;max-height:38vh;overflow:auto;background:rgba(0,0,0,.82);color:#7fe3a1;font:11px/1.5 ui-monospace,Menlo,monospace;padding:8px 10px;border-radius:8px;white-space:pre-wrap;pointer-events:none';
    document.body.appendChild(box);
  }
  debugLines.push(new Date().toTimeString().slice(0, 8) + '  ' + msg);
  while (debugLines.length > 12) debugLines.shift();
  box.textContent = debugLines.join('\n');
}
function clog(msg) {
  const text = String(msg);
  try { console.log('[hg]', text); } catch (e) { /* ignore */ }
  debugPanel(text);
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/clientlog', JSON.stringify({ t: Date.now(), msg: text }));
    }
  } catch (e) { /* ignore */ }
}

function escapeHTML(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function coverURL(drama) {
  const cover = (drama && drama.cover) || '';
  const m = /\/novel-pic\/([0-9a-fA-F]+)~/.exec(cover);
  if (m) return `https://p3-novel.byteimg.com/novel-pic/${m[1]}~tplv-shrink:640:0.image`;
  return cover;
}

function avatarURL(url) {
  const u = String(url || '');
  const m = /\/novel-pic\/([0-9a-fA-F]+)~/.exec(u);
  if (m) return `https://p3-novel.byteimg.com/novel-pic/${m[1]}~tplv-shrink:200:0.image`;
  return u;
}

function fmtCount(value) {
  if (value == null) return '';
  const text = String(value).trim();
  if (/^[0-9.]+[万亿]$/.test(text)) return text;
  const n = Number(text);
  if (!isFinite(n) || n <= 0) return '';
  if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return String(Math.round(n));
}

/* ---------------- 账号 ---------------- */

let currentUser = '';

async function apiJSON(path, options) {
  const res = await fetch(path, Object.assign({
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
  }, options || {}));
  let data = {};
  try { data = await res.json(); } catch (e) { data = { ok: false, error: '响应异常' }; }
  if (!res.ok && !data.error) data.error = 'HTTP ' + res.status;
  return data;
}

function localList(key) {
  try {
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function renderUser() {
  const name = (officialUser && officialUser.name) || currentUser || '';
  const logged = !!name;
  $('side-avatar').textContent = logged ? name.slice(0, 1) : '游';
  $('side-user-name').textContent = logged ? (officialUser ? name + ' · 红果' : name) : '游客 · 未登录';
  $('btn-login').hidden = logged;
  $('btn-logout').hidden = !logged;
}

function officialLocalList(key) {
  try { return JSON.parse(localStorage.getItem(key) || '[]') || []; } catch (e) { return []; }
}
function saveOfficialLocalList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list.slice(0, 500))); } catch (e) { /* 忽略 */ }
}


const favIndex = new Set();
let favIndexReady = false;

async function ensureFavIndex(force) {
  if (!officialUser) return;
  if (favIndexReady && !force) return;
  try {
    const resp = await api({ action: 'hgUserFavorites', page: 1 });
    const items = ((resp && (resp.items ? resp : resp.data)) || {}).items || [];
    favIndex.clear();
    items.forEach((it) => favIndex.add(it.id));
    favIndexReady = true;
  } catch (e) { /* 忽略 */ }
}

function isFaved(id) {
  if (!id) return false;
  if (favIndex.has(id)) return true;
  if ((state.favs || []).some((d) => d.id === id)) return true;
  if (typeof officialFavList !== 'undefined' && officialFavList.some((d) => d.id === id)) return true;
  return false;
}


const likeIndex = new Set();
let likeIndexReady = false;

async function ensureLikeIndex(force) {
  if (!officialUser) return;
  if (likeIndexReady && !force) return;
  try {
    const resp = await api({ action: 'hgUserLikes' });
    const items = ((resp && (resp.items ? resp : resp.data)) || {}).items || [];
    likeIndex.clear();
    items.forEach((it) => likeIndex.add(it.id));
    likeIndexReady = true;
  } catch (e) { /* 忽略 */ }
}

function isLiked(id, vid) {
  if (id && (likeIndex.has(id) || (state.likes || []).some((d) => d.id === id))) return true;
  return Boolean(vid && likedVidSet().has(vid));
}

function likedVidSet() {
  try { return new Set(JSON.parse(localStorage.getItem('hg:liked-vids') || '[]')); } catch (e) { return new Set(); }
}
function setVidLiked(vid, on) {
  if (!vid) return;
  const set = likedVidSet();
  if (on) set.add(vid); else set.delete(vid);
  try { localStorage.setItem('hg:liked-vids', JSON.stringify(Array.from(set).slice(-500))); } catch (e) { /* 忽略 */ }
}

async function loadUserData() {
  if (currentUser) {
    const [favs, likes] = await Promise.all([apiJSON('/user/favs'), apiJSON('/user/likes')]);
    state.favs = favs.items || [];
    state.likes = likes.items || [];
    return;
  }
  if (officialUser) {
    state.favs = officialLocalList('hg:official-favs');
    state.likes = officialLocalList('hg:official-likes');
    return;
  }
  state.favs = localList('hg:favs');
  state.likes = localList('hg:likes');
}

async function initAuth() {
  try {
    const me = await apiJSON('/auth/me');
    if (me.ok && me.name) currentUser = me.name;
  } catch (e) { /* 忽略 */ }
  renderUser();
  await loadUserData();
  // 后台检查红果官方登录态（进程内 cookie），有则恢复侧栏显示。
  try {
    const me = await api({ action: 'hgLoginUserInfo' });
    const info = (me && (me.data || me)) || {};
    if (info.loggedIn) {
      saveOfficialUser({ name: info.name || '红果用户', avatar: info.avatar || '', uid: info.uid || info.id || '' });
    } else if (officialUser) {
      saveOfficialUser(null);
    }
  } catch (e) { /* 忽略 */ }
}


async function remoteSetFavorite(add) {
  const drama = state.drama;
  if (!drama) return false;
  const sid = String(drama.id || '').replace(/^hongguo:/, '');
  try {
    await api({ action: 'hgSetFavorite', session: sid, force: !!add });
    state.favs = (state.favs || []).filter((d) => d.id !== drama.id);
    if (add) state.favs.unshift(drama);
    if (add) favIndex.add(drama.id); else favIndex.delete(drama.id);
    if (typeof officialFavList !== 'undefined') {
      const at = officialFavList.findIndex((d) => d.id === drama.id);
      if (add && at < 0) officialFavList.unshift(drama);
      if (!add && at >= 0) officialFavList.splice(at, 1);
    }
    if (typeof officialRemoteFavs !== 'undefined' && officialRemoteFavs.length) officialRemoteFavs.length = 0;
    if (typeof officialFavList !== 'undefined' && officialFavList.length) officialFavList.length = 0;
    return true;
  } catch (e) {
    clog('favorite 远端失败: ' + ((e && e.message) || e));
    return false;
  }
}

async function toggleUserList(kind, drama, forceAdd) {
  if (!currentUser && officialUser) {
    // 已登录红果账号：点赞/收藏先记在本机（红果写入接口尚未接通）
    const list = kind === 'favs' ? state.favs : state.likes;
    const has = list.some((item) => item.id === drama.id);
    const add = forceAdd === undefined ? !has : forceAdd;
    const next = add
      ? [{ id: drama.id, title: drama.title || '', cover: drama.cover || '', episodes: drama.episodes || 0, source: SOURCE }, ...list.filter((item) => item.id !== drama.id)]
      : list.filter((item) => item.id !== drama.id);
    const savedKey = kind === 'favs' ? 'hg:official-favs' : 'hg:official-likes';
    const removedKey = kind === 'favs' ? 'hg:official-fav-removed' : 'hg:official-like-removed';
    if (kind === 'favs') state.favs = next; else state.likes = next;
    saveOfficialLocalList(savedKey, next);
    const removed = new Set(loadJSON(removedKey, []));
    if (!add) removed.add(drama.id); else removed.delete(drama.id);
    localStorage.setItem(removedKey, JSON.stringify([...removed]));
    if (state.view === 'list') loadList(kind === 'favs' ? 'fav' : 'likes');
    return add;
  }
  if (!currentUser) {
    openLogin('login');
    toast('登录后才能使用' + (kind === 'favs' ? '收藏' : '点赞'));
    return false;
  }
  const list = kind === 'favs' ? state.favs : state.likes;
  const has = list.some((item) => item.id === drama.id);
  const add = forceAdd === undefined ? !has : forceAdd;
  const res = await apiJSON('/user/' + kind, {
    method: 'POST',
    body: JSON.stringify({ action: add ? 'add' : 'remove', drama: drama }),
  });
  if (!res.ok) {
    toast(res.error || '操作失败');
    return has;
  }
  if (kind === 'favs') state.favs = res.items || [];
  else state.likes = res.items || [];
  return add;
}

/* ---------------- 登录弹层 ---------------- */

let loginMode = 'login';

function setLoginMode(mode) {
  loginMode = mode;
  $('tab-login').classList.toggle('active', mode === 'login');
  $('tab-register').classList.toggle('active', mode === 'register');
  $('login-title').textContent = '登录红果';
  $('login-submit').textContent = mode === 'login' ? '登录' : '注册并登录';
  $('login-local-error').hidden = true;
}

function openLogin(mode) {
  setLoginMode(mode || 'login');
  $('login-modal').hidden = false;
  setLoginTab('qr');
  setTimeout(() => { try { $('login-name').focus(); } catch (e) {} }, 30);
}

function closeLogin() {
  $('login-modal').hidden = true;
  $('login-error').hidden = true;
  $('login-local-error').hidden = true;
}

function showLoginError(message) {
  $('login-local-error').textContent = message;
  $('login-local-error').hidden = false;
}

async function submitLogin(event) {
  event.preventDefault();
  const name = $('login-name').value.trim();
  const password = $('login-pass').value;
  if (!name || !password) {
    showLoginError('请填写用户名和密码');
    return;
  }
  $('login-submit').disabled = true;
  try {
    const res = await apiJSON('/auth/' + (loginMode === 'login' ? 'login' : 'register'), {
      method: 'POST',
      body: JSON.stringify({ name: name, password: password }),
    });
    if (!res.ok) {
      showLoginError(res.error || '操作失败');
      return;
    }
    currentUser = res.name;
    renderUser();
    await loadUserData();
    closeLogin();
    $('login-pass').value = '';
    toast((loginMode === 'login' ? '欢迎回来，' : '注册成功，') + currentUser);
  } catch (e) {
    showLoginError('网络异常，请重试');
  } finally {
    $('login-submit').disabled = false;
  }
}

async function logout() {
  try { await apiJSON('/auth/logout', { method: 'POST', body: '{}' }); } catch (e) { /* 忽略 */ }
  saveSessionCookies(null);
  try { await api({ action: 'hgLoginLogout' }); } catch (e) { /* 忽略 */ }
  saveOfficialUser(null);
  currentUser = '';
  state.favs = [];
  state.likes = [];
  renderUser();
  toast('已退出登录');
}

/* ---------------- 观看历史 ---------------- */

function historyIDs() {
  try {
    const list = JSON.parse(localStorage.getItem('hg:history') || '[]');
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function rememberDrama(drama) {
  if (!drama || !drama.id) return;
  try {
    localStorage.setItem('hg:drama:' + drama.id, JSON.stringify(drama));
    const list = historyIDs().filter((id) => id !== drama.id);
    list.unshift(drama.id);
    localStorage.setItem('hg:history', JSON.stringify(list.slice(0, 60)));
  } catch (e) { /* ignore */ }
  if (currentUser) {
    apiJSON('/user/history', {
      method: 'POST',
      body: JSON.stringify({ action: 'set', drama: drama, index: state.index || 0, time: state.videoTime || 0 }),
    }).catch(() => {});
  }
}

async function loadHistory() {
  let items = [];
  if (currentUser) {
    try {
      const res = await apiJSON('/user/history');
      items = res.items || [];
    } catch (e) { items = []; }
  } else {
    items = historyIDs().map((id) => {
      try { return JSON.parse(localStorage.getItem('hg:drama:' + id) || 'null'); } catch (e) { return null; }
    }).filter(Boolean);
  }
  state.mode = 'history';
  state.items = items;
  state.hasMore = false;
  renderGrid();
  if (!items.length) toast(currentUser ? '还没有观看记录' : '还没有观看记录（登录后可跨设备同步）');
}

function showFavs() {
  if (!currentUser) {
    openLogin('login');
    toast('登录后才能查看收藏');
    return;
  }
  state.mode = 'favs';
  state.items = state.favs.slice();
  state.hasMore = false;
  renderGrid();
  if (!state.items.length) toast('还没有收藏，播放页点右侧 ☆ 收藏');
}

/* ---------------- 榜单 ---------------- */

async function loadRank(board) {
  state.mode = 'rank';
  state.rankBoard = board;
  $('grid').innerHTML = '<div class="empty">榜单加载中…</div>';
  $('more').hidden = true;
  $('reset-search').hidden = true;
  try {
    const data = await api({ action: 'rankings', board: board, page: 1 });
    state.items = (data.items || []).map((row) => Object.assign({}, row.drama, { _rank: row.rank, _metric: row.metric }));
    state.hasMore = false;
    renderGrid();
  } catch (e) {
    toast(e.message);
    $('grid').innerHTML = '';
  }
}

let toastTimer = 0;
function toast(message, ms = 2600) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function progressKey(id) { return 'hg:progress:' + id; }
function loadProgress(id) {
  try { return JSON.parse(localStorage.getItem(progressKey(id)) || 'null'); } catch (e) { return null; }
}
// 云端观看进度上报（红果账号历史）：read_history/update + read_progress/upload
const cloudProgress = { key: '', at: 0, pending: false };
function reportCloudProgress(force) {
  try {
    if (!officialUser || !state.drama || !state.chapters || !state.chapters.length) return;
    const ch = state.chapters[state.index];
    if (!ch) return;
    const vid = String(ch.videoUrl || '').replace('hongguo-cenc://', '');
    const sid = String(state.drama.id || '').replace('hongguo:', '');
    if (!/^\d{10,}$/.test(vid) || !/^\d{10,}$/.test(sid)) return;
    const now = Date.now();
    const key = state.drama.id + ':' + state.index;
    if (!force) {
      if (cloudProgress.pending) return;
      if (key === cloudProgress.key && now - cloudProgress.at < 20000) return;
    }
    if (!force && now - cloudProgress.at < 8000) return;
    const v = $('video');
    const posMs = Math.max(0, Math.round((v && v.currentTime ? v.currentTime : 0) * 1000));
    if (posMs < 1000) return;
    cloudProgress.key = key; cloudProgress.at = now; cloudProgress.pending = true;
    api({ action: 'hgReportProgress', query: sid, session: vid, index: state.index + 1,
      positionMs: posMs, cumulativeMs: posMs }).catch(() => {}).finally(() => { cloudProgress.pending = false; });
  } catch (e) { cloudProgress.pending = false; }
}

function saveProgress(id, index, time) {
  try {
    const ch = (state.chapters || [])[index] || null;
    const vid = ch ? String(ch.videoUrl || '').replace('hongguo-cenc://', '') : '';
    const prev = loadProgress(id) || {};
    const payload = { index, time, ts: Date.now() };
    if (vid) payload.vid = vid;
    if (ch && ch.title) payload.epTitle = ch.title;
    if (prev.duration) payload.duration = prev.duration;
    localStorage.setItem(progressKey(id), JSON.stringify(payload));
    state.watched[id] = index;
  } catch (e) { /* ignore */ }
}

// 本地观看进度（比红果接口更新时用于覆盖历史列表）
function localHistoryEntries() {
  const out = new Map();
  historyIDs().forEach((id) => {
    const p = loadProgress(id);
    if (!p || typeof p.index !== 'number') return;
    let drama = null;
    try { drama = JSON.parse(localStorage.getItem('hg:drama:' + id) || 'null'); } catch (e) { drama = null; }
    if (!drama || !drama.id) return;
    out.set(id, {
      id: drama.id,
      title: drama.title || '',
      cover: drama.cover || '',
      episodes: drama.episodes || 0,
      progressIndex: p.index,
      updatedAt: p.ts || 0,
      position: Math.round((Number(p.time) || 0) * 1000),
      vid: p.vid || '',
      local: true,
    });
  });
  return out;
}

/* ---------------- 分类 ---------------- */

async function loadCategories() {
  try {
    const data = await api({ action: 'categories', source: SOURCE });
    state.categories = data.items || [];
    renderChips();
  } catch (e) {
    /* 分类失败不影响浏览 */
  }
}

function renderChips() {
  const main = (state.categories || []).filter((item) => !String(item.id || '').startsWith('tag:'));
  $('chips').innerHTML = main.map((item) => {
    const active = !state.query && item.id === state.category ? ' active' : '';
    return `<button class="chip${active}" data-cat="${escapeHTML(item.id)}" data-row="genre">${escapeHTML(item.name)}</button>`;
  }).join('');
  renderFilterRows();
}

async function loadFilterRows() {
  if (state.filterRowsLoaded) return;
  state.filterRowsLoaded = true;
  try {
    const data = await api({ action: 'hgFilterRows' });
    state.filterRows = data.rows || [];
  } catch (e) {
    state.filterRows = [];
  }
  renderFilterRows();
}

function filterRowHTML(row) {
  const limit = 20;
  const expanded = !!state.filterExpanded[row.name];
  const list = expanded ? row.items : row.items.slice(0, limit);
  const more = row.items.length > limit
    ? `<button class="filter-more" data-row-more="${escapeHTML(row.name)}">${expanded ? '收起' : '更多'}</button>`
    : '';
  const allChip = `<button class="chip${!state.category ? ' active' : ''}" data-cat="" data-row="${escapeHTML(row.name)}">全部</button>`;
  const chips = allChip + list.map((item) => {
    const active = state.tagRow === row.name && item.id === state.category ? ' active' : '';
    return `<button class="chip${active}" data-cat="${escapeHTML(item.id)}" data-row="${escapeHTML(row.name)}">${escapeHTML(item.name)}</button>`;
  }).join('');
  return `<div class="filter-row"><span class="filter-label">${escapeHTML(row.name)}</span><div class="chips">${chips}${more}</div></div>`;
}

function renderFilterRows() {
  const box = $('filter-rows');
  if (!box) return;
  const rows = (state.filterRows || []).map(filterRowHTML);
  const sorts = [['', '全部'], ['new', '最新上架'], ['hot', '最高热度'], ['fav', '最高收藏']];
  rows.push(`<div class="filter-row"><span class="filter-label">推荐</span><div class="chips">${sorts.map(([v, n]) => `<button class="chip${state.sort === v ? ' active' : ''}" data-sort="${v}">${n}</button>`).join('')}</div></div>`);
  const sts = [['', '全部'], ['finished', '已完结'], ['ongoing', '连载中']];
  rows.push(`<div class="filter-row"><span class="filter-label">状态</span><div class="chips">${sts.map(([v, n]) => `<button class="chip${state.status === v ? ' active' : ''}" data-status="${v}">${n}</button>`).join('')}</div></div>`);
  box.innerHTML = rows.join('');
  renderFilterSummary();
}

function activeFilterNames() {
  const names = [];
  if (state.category) {
    const pools = [(state.categories || []), ...(state.filterRows || []).map((r) => r.items || [])];
    let found = null;
    pools.forEach((list) => { (list || []).forEach((it) => { if (!found && it && it.id === state.category) found = it; }); });
    if (found) names.push(found.name);
  }
  if (state.sort) names.push({ hot: '最高热度', fav: '最高收藏', new: '最新上架' }[state.sort] || '');
  if (state.status) names.push(state.status === 'finished' ? '已完结' : '连载中');
  return names.filter(Boolean);
}

function renderFilterSummary() {
  const el = $('filter-sum');
  const body = $('filter-body');
  const btn = $('filter-expand');
  if (body) body.hidden = !state.filterOpen;
  if (btn) btn.textContent = state.filterOpen ? '收起筛选 ▴' : '展开筛选 ▾';
  if (el) {
    const names = activeFilterNames();
    el.textContent = '筛选：' + (names.length ? names.join(' · ') : '全部');
  }
}

function fmtDurPad(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return '';
  const m = Math.floor(total / 60);
  const sec = Math.floor(total % 60);
  return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

function creatorCardHTML(c) {
  const role = c.subTitle || c.role || '';
  const av = avatarURL(c.avatar);
  const img = av ? '<img class="c-avatar" src="' + escapeHTML(av) + '" alt="" loading="lazy" onerror="this.style.visibility=\'hidden\'">' : '<span class="c-avatar"></span>';
  return '<div class="creator" data-idx="' + (c.__idx || 0) + '">' + img + '<div class="c-name">' + escapeHTML(c.nickname || '') + '</div>' + (role ? '<div class="c-role">' + escapeHTML(role) + '</div>' : '') + '<button class="c-follow" type="button" data-celebrity="' + escapeHTML(c.celebrityId || '') + '">+ 关注</button></div>';
}

function renderDetailCreators() {
  const box = $('dv-creators');
  if (!box) return;
  const actors = (state.drama && state.drama.celebrities) || [];
  const creators = (state.drama && state.drama.creators) || [];
  if (!actors.length && !creators.length) { box.innerHTML = ''; box.hidden = true; return; }
  box.hidden = false;
  let html = '';
  if (actors.length) html += '<div class="dv-crew"><div class="dv-crew-title">演员</div><div class="dv-crew-list">' + actors.map((c, i) => creatorCardHTML(Object.assign({}, c, { __idx: i }))).join('') + '</div></div>';
  if (creators.length) html += '<div class="dv-crew"><div class="dv-crew-title">主创</div><div class="dv-crew-list">' + creators.map(creatorCardHTML).join('') + '</div></div>';
  box.innerHTML = html;
}

function fmtDur(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return '';
  const m = Math.floor(total / 60);
  const sec = Math.floor(total % 60);
  return m + ':' + String(sec).padStart(2, '0');
}

function sortValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function visibleItems() {
  let items = state.items.slice();
  if (state.status === 'finished') items = items.filter((d) => d.releaseStatus === 'finished');
  else if (state.status === 'ongoing') items = items.filter((d) => d.releaseStatus !== 'finished');
  if (state.sort === 'hot') items.sort((a, b) => sortValue(b.heat) - sortValue(a.heat));
  else if (state.sort === 'fav') items.sort((a, b) => sortValue(b.views) - sortValue(a.views));
  return items;
}

/* ---------------- 列表 ---------------- */

Object.assign(state, { filterRows: [], filterRowsLoaded: false, filterExpanded: {}, tagRow: '', sort: '', status: '', filterOpen: false });

let catalogGen = 0;
async function loadCatalog({ reset = false } = {}) {
  // 切分类时允许打断进行中的请求（用代际号丢弃旧结果），加载更多则串行
  if (!reset && state.loading) return;
  const gen = ++catalogGen;
  state.mode = 'feed';
  state.loading = true;
  if (reset) {
    state.page = 1;
    state.items = [];
    state.renderLimit = 60;
    $('grid').innerHTML = '';
  }
  $('more').disabled = true;
  try {
    const data = await api({
      action: 'catalog',
      source: SOURCE,
      category: state.query ? '' : state.category,
      page: state.page,
      query: state.query,
    });
    if (gen !== catalogGen) return;
    const items = data.items || [];
    state.items = reset ? items : state.items.concat(items);
    state.hasMore = !!data.hasMore;
    if (data.warning) toast(data.warning);
    renderGrid();
    if (SELFTEST) runSelftest();
  } catch (e) {
    if (gen === catalogGen) toast(e.message);
  } finally {
    if (gen === catalogGen) {
      state.loading = false;
      $('more').disabled = false;
    }
  }
}

function renderGrid() {
  const all = visibleItems();
  const shown = all.slice(0, state.renderLimit);
  $('grid').innerHTML = shown.map((drama) => {
    const src = coverURL(drama);
    const cover = src
      ? `<img loading="lazy" src="${escapeHTML(src)}" alt="" onerror="this.remove()">`
      : '';
    const eps = drama.episodes ? `<span class="badge eps">共${escapeHTML(String(drama.episodes))}集</span>` : '';
    const heat = drama.heat ? `<span class="badge heat">🔥 ${escapeHTML(fmtCount(drama.heat))}</span>` : '';
    const vip = drama.vip ? '<span class="badge vip">VIP</span>' : '';
    const rank = drama._rank ? `<span class="badge rank">#${escapeHTML(drama._rank)}</span>` : '';
    const sub = [drama.category, drama._metric].filter(Boolean).map(escapeHTML).join(' · ');
    return `<div class="card" data-id="${escapeHTML(drama.id)}">
      <div class="cover-wrap">${cover}${rank}${heat}${eps}${vip}<div class="card-hover"><button class="card-act primary" data-act="play" type="button">▶ 播放</button><button class="card-act" data-act="home" type="button">主页</button></div></div>
      <h3>${escapeHTML(drama.title || '')}</h3>
      <div class="sub">${sub}</div>
    </div>`;
  }).join('');
  $('empty').hidden = state.items.length > 0;
  $('more').hidden = !(all.length > state.renderLimit || state.hasMore);
  $('reset-search').hidden = !state.query;
}

/* 卡片热度补全：catalog 数据源部分条目没有 heat，用详情接口批量补（小批量、播放中暂停，避免拖慢起播） */
const heatCache = new Map();
let heatLoading = false;
let heatToken = 0;
async function enrichHeat(shown) {
  if (heatLoading) return;
  if (!$('player').hidden) return;
  const ids = [];
  shown.forEach((d) => { if (!d.heat && !heatCache.has(d.id) && !d._heatTried) ids.push(d.id); });
  if (!ids.length) return;
  const token = heatToken;
  heatLoading = true;
  try {
    await new Promise((r) => setTimeout(r, 600));
    if (token !== heatToken || !$('player').hidden) return;
    const data = await api({ action: 'hgBatchHeat', ids: ids.slice(0, 16) });
    const map = (data && data.heat) || {};
    if (token !== heatToken) return;
    ids.forEach((id) => {
      const v = map[id];
      const item = state.items.find((d) => d.id === id);
      if (item) { if (v) item.heat = v; else item._heatTried = true; }
      if (v) heatCache.set(id, v);
    });
    ids.forEach((id) => {
      const v = map[id];
      if (!v) return;
      const card = $('grid').querySelector('.card[data-id="' + id.replace(/"/g, '\\"') + '"]');
      if (!card || card.querySelector('.badge.heat')) return;
      const wrap = card.querySelector('.cover-wrap');
      if (!wrap) return;
      const badge = document.createElement('span');
      badge.className = 'badge heat';
      badge.textContent = '🔥 ' + fmtCount(v);
      const eps = wrap.querySelector('.badge.eps');
      wrap.insertBefore(badge, eps || null);
    });
  } catch (e) { /* 热度补全失败不打扰用户 */ }
  finally { heatLoading = false; }
}

function findDrama(id) {
  return state.items.find((item) => item.id === id) || null;
}

/* ---------------- 详情 ---------------- */

let playerOrigin = null;

let detailOrigin = null;
let detailTab = 'eps';
let detailRelated = [];
let detailRelatedLoaded = false;

async function openDetail(drama, opts = {}) {
  if (!opts.play) exitFullscreenIfAny();
  if (opts.play) {
    suppressFeedAutoplayUntil = Date.now() + 4000;
    if (state.view !== 'recommend') playerOrigin = state.view;
    showView('recommend');
  }
  // 如果这部剧在推荐流里，同步 feed 游标，关闭/返回后滚轮才能接着切下一部
  const feedPos = feed.items.findIndex((it) => it && it.id === drama.id);
  if (feedPos >= 0) feed.index = feedPos;
  state.drama = drama;
  state.chapters = [];
  if (!opts.play) {
    if (state.view !== 'detail') detailOrigin = state.view;
    showView('detail');
    renderDetailLoading(drama);
  }
  try {
    const data = await api({ action: 'detail', source: SOURCE, drama });
    state.drama = Object.assign({}, drama, data.drama || {});
    state.chapters = data.chapters || [];
    clog('detail ok chapters=' + state.chapters.length);
    if (data.warning) toast(data.warning);
    if (!opts.play) renderDetailPage();
    if (opts.play && state.chapters.length) {
      const saved = loadProgress(state.drama.id);
      const startIndex = saved && saved.index < state.chapters.length ? saved.index : 0;
      await playEpisode(startIndex, { startTime: saved && saved.index === startIndex ? saved.time || 0 : 0 });
    }
  } catch (e) {
    clog('detail 失败: ' + e.message);
    toast(e.message);
    if (!opts.play) renderDetailError(e);
  }
}

function renderDetailLoading(drama) {
  detailRelatedLoaded = false;
  detailRelated = [];
  $('d-title').textContent = drama.title || '';
  const cover = coverURL(drama);
  if (cover) $('d-cover').src = cover; else $('d-cover').removeAttribute('src');
  $('dv-meta').textContent = '加载中…';
  $('dv-tags').innerHTML = '';
  $('d-desc').textContent = drama.description || '';
  $('dv-play').disabled = true;
  $('dv-play').textContent = '加载中…';
  $('dv-eps-n').textContent = '';
  $('d-chapters').innerHTML = '<div class="list-empty">加载中…</div>';
  $('dv-related').innerHTML = '';
}

function renderDetailError(e) {
  $('dv-meta').textContent = '';
  $('d-chapters').innerHTML = '<div class="list-empty">' + escapeHTML(e.message || '加载失败') + '</div>';
  $('dv-play').disabled = true;
  $('dv-play').textContent = '加载失败';
}

function renderDetailPage() {
  const drama = state.drama || {};
  $('d-title').textContent = drama.title || '';
  const cover = coverURL(drama);
  if (cover) $('d-cover').src = cover; else $('d-cover').removeAttribute('src');
  const meta = [];
  if (drama.heat) meta.push('🔥 红果热度值 <b>' + escapeHTML(fmtCount(drama.heat)) + '</b>');
  if (drama.followCount) meta.push('<b>' + escapeHTML(fmtCount(drama.followCount)) + '</b> 人追剧');
  if (drama.views) meta.push('<b>' + escapeHTML(fmtCount(drama.views)) + '</b> 次播放');
  if (drama.score) meta.push('评分 <b>' + escapeHTML(drama.score) + '</b>');
  $('dv-meta').innerHTML = meta.join(' · ');
  const tags = [];
  (drama.subTitles || []).forEach((t) => { if (t && tags.indexOf(t) < 0) tags.push(t); });
  if (drama.category) tags.push(drama.category);
  (drama.tags || []).forEach((t) => { if (t && tags.indexOf(t) < 0) tags.push(t); });
  if (drama.episodes && !tags.some((t) => /^全\d+集$/.test(t))) tags.push('全' + drama.episodes + '集');
  $('dv-tags').innerHTML = tags.map((t) => (/^全[0-9]+集$/.test(t) ? '<span>' + escapeHTML(t) + '</span>' : '<button type="button" class="meta-tag" data-tag="' + escapeHTML(t) + '">' + escapeHTML(t) + '</button>')).join('');
  renderDetailCreators();
  const rec = $('dv-record');
  if (rec) { rec.textContent = drama.recordNumber || ''; rec.hidden = !drama.recordNumber; }
  $('d-desc').textContent = drama.description || drama.intro || '暂无简介';
  const saved = loadProgress(drama.id);
  const startIndex = saved && saved.index < state.chapters.length ? saved.index : 0;
  const playBtn = $('dv-play');
  playBtn.textContent = saved ? '▶ 继续看第 ' + (startIndex + 1) + ' 集' : '▶ 播放第1集';
  playBtn.dataset.index = String(startIndex);
  playBtn.disabled = state.chapters.length === 0;
  const favOn = (state.favs || []).some((d) => d.id === drama.id);
  const likeOn = (state.likes || []).some((d) => d.id === drama.id);
  $('dv-fav').textContent = (favOn ? '★' : '☆') + ' 收藏';
  $('dv-like').textContent = (likeOn ? '♥' : '♡') + ' 点赞';
  $('dv-eps-n').textContent = state.chapters.length ? '全' + state.chapters.length + '集' : '';
  renderDetailEps(startIndex);
  detailTab = 'eps';
  switchDetailTab('eps');
  loadDetailRelated();
}

function renderDetailEps(startIndex) {
  const saved = loadProgress(state.drama.id);
  $('d-chapters').innerHTML = state.chapters.map((chapter, index) => {
    const cls = ['ep-num', 'ep-wide'];
    if (index === startIndex) cls.push('active');
    if (saved && index < saved.index) cls.push('watched');
    const dur = fmtDurPad(chapter.duration);
    return '<button type="button" class="' + cls.join(' ') + '" data-index="' + index + '"><span class="ep-idx">' + (index + 1) + '</span><span>第' + (index + 1) + '集</span>' + (dur ? '<i>' + dur + '</i>' : '') + '</button>';
  }).join('');
}

function switchDetailTab(name) {
  detailTab = name;
  document.querySelectorAll('.dv-tab').forEach((el) => el.classList.toggle('active', el.dataset.dvtab === name));
  $('dv-eps').hidden = name !== 'eps';
  $('dv-reviews').hidden = name !== 'reviews';
  $('dv-related').hidden = name !== 'related';
  if (name === 'related') loadDetailRelated();
}

function seriesIDOf(drama) { return drama ? String(drama.id || '').replace('hongguo:', '') : ''; }

async function loadDetailRelated() {
  if (detailRelatedLoaded || !state.drama) return;
  detailRelatedLoaded = true;
  const targetID = state.drama.id;
  try {
    const out = [];
    const seen = new Set([state.drama.id]);
    const albumID = state.drama.relatedAlbumId;
    if (albumID && /^\d+$/.test(String(albumID))) {
      try {
        const album = await api({ action: 'detail', drama: { id: 'hongguo:' + albumID, source: SOURCE } });
        const d = album && album.drama;
        if (d && d.id && !seen.has(d.id)) { seen.add(d.id); out.push(d); }
      } catch (e) { /* 同系列剧不可用时忽略 */ }
    }
    const data = await api({ action: 'catalog', source: SOURCE, category: '', page: 1 });
    const mine = new Set((state.drama.tags || []).concat(state.drama.category ? [state.drama.category] : []));
    const pool = (data.items || []).filter((d) => !seen.has(d.id));
    const same = pool.filter((d) => (d.tags || []).some((t) => mine.has(t)) || (d.category && d.category === state.drama.category));
    const rank = (d) => (Number(d.heat) || 0) * 1000 + (Number(d.score) || 0) * 10 + (Number(d.views) || 0) / 1000;
    same.sort((a, b) => rank(b) - rank(a));
    for (const d of same.length ? same : pool) {
      if (out.length >= 8) break;
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      out.push(d);
    }
    if (!state.drama || state.drama.id !== targetID) return;
    detailRelated = out.slice(0, 8);
    const rn = $('dv-related-n');
    if (rn) rn.textContent = detailRelated.length ? String(detailRelated.length) : '';
    $('dv-related').innerHTML = detailRelated.map((d) => {
      const src = coverURL(d);
      return '<div class="card" data-id="' + escapeHTML(d.id) + '">' +
        '<div class="cover-wrap">' + (src ? '<img loading="lazy" src="' + escapeHTML(src) + '" alt="">' : '') +
        (d.episodes ? '<span class="badge eps">共' + escapeHTML(String(d.episodes)) + '集</span>' : '') +
        '</div><h3>' + escapeHTML(d.title || '') + '</h3><div class="sub">' + escapeHTML(d.category || '') + '</div></div>';
    }).join('');
  } catch (e) { $('dv-related').innerHTML = '<div class="list-empty">暂无推荐</div>'; }
}

function closeDetailView() {
  detailRelatedLoaded = false;
  detailRelated = [];
  showView(detailOrigin || 'search');
  detailOrigin = null;
}

/* ---------------- 播放器 ---------------- */


/* ---------------- 播放内核（解密 / 转码适配） ---------------- */

const HEVC_MIME = 'video/mp4; codecs="hvc1.1.6.L93.B0"';
const MSE_CODECS = [
  'video/mp4; codecs="avc1.42C01F,mp4a.40.2"',
  'video/mp4; codecs="avc1.42E01F,mp4a.40.2"',
  'video/mp4; codecs="avc1.4D401F,mp4a.40.2"',
  'video/mp4; codecs="avc1.64001F,mp4a.40.2"',
];

function mseMime() {
  if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported) return MSE_CODECS[1];
  for (let i = 0; i < MSE_CODECS.length; i += 1) {
    if (MediaSource.isTypeSupported(MSE_CODECS[i])) return MSE_CODECS[i];
  }
  return MSE_CODECS[1];
}

function hevcSupported() {
  // 超分兜底：强制 H.264 转码路径（HEVC 硬件帧在部分显卡上无法被 WebGL 读取）
  if (window.__srForceMse) return false;
  try {
    const probe = document.createElement('video');
    const type = probe.canPlayType(HEVC_MIME);
    return type === 'probably' || type === 'maybe';
  } catch (e) {
    return false;
  }
}

function planStream(plan) {
  const m = /^http:\/\/127\.0\.0\.1:(\d+)(\/.*)$/.exec(plan.url || '');
  if (!m) return null;
  const chapter = state.chapters[state.index] || {};
  const cacheId = (chapter.id || '') + ':' + (plan.quality || 0);
  return { port: m[1], path: m[2], key: plan.decryptionKey || '', id: cacheId };
}

function streamQuery(stream) {
  return 'port=' + stream.port + '&path=' + encodeURIComponent(stream.path) +
    '&key=' + stream.key + '&id=' + encodeURIComponent(stream.id || '');
}

async function probeStream(stream) {
  const res = await fetch('/probe?' + streamQuery(stream));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || '探测失败');
  return data;
}

const playerState = { mode: '', token: 0, mse: null, stream: null };

// MseStream：把服务端实时转码出来的 H.264 fMP4 喂给 MediaSource。
// 拖动到未缓冲区间时，销毁并重建 MediaSource，从目标时间重新请求转码。
function MseStream(video, stream, handlers) {
  this.video = video;
  this.stream = stream;
  this.handlers = handlers || {};
  this.ms = null;
  this.sb = null;
  this.abort = null;
  this.queue = [];
  this.ended = false;
  this.gen = 0;
  this.pendingSeek = null;
  this.duration = 0;
  this.onSeeking = this.handleSeeking.bind(this);
  video.addEventListener('seeking', this.onSeeking);
}

MseStream.prototype.load = function (startTime, duration) {
  this.duration = duration || 0;
  this.startAt(startTime || 0);
};

MseStream.prototype.tcURL = function (start) {
  return '/tc?' + streamQuery(this.stream) + '&start=' + start.toFixed(3) + '&h=720';
};

MseStream.prototype.startAt = function (startTime) {
  const self = this;
  self.stop();
  const gen = ++self.gen;
  const ms = new MediaSource();
  self.ms = ms;
  ms.addEventListener('sourceopen', function () {
    clog('mse sourceopen gen=' + gen + '/' + self.gen);
    if (gen !== self.gen) return;
    if (self.duration > 0) { try { ms.duration = self.duration; } catch (e) { /* ignore */ } }
    let sb;
    try {
      sb = ms.addSourceBuffer(mseMime());
    } catch (e) {
      clog('mse addSourceBuffer 失败: ' + ((e && e.message) || e) + ' mime=' + mseMime());
      self.fail(e);
      return;
    }
    clog('mse addSourceBuffer ok ' + mseMime());
    sb.mode = 'segments';
    sb.timestampOffset = startTime;
    self.sb = sb;
    sb.addEventListener('updateend', function () {
      self.pump();
      self.applyPendingSeek();
    });
    self.pendingSeek = startTime;
    self.fetch(startTime, gen);
  });
  const url = URL.createObjectURL(ms);
  self.video.src = url;
  self.video.play().catch(function () { /* 忽略自动播放限制 */ });
};

MseStream.prototype.stop = function () {
  if (this.abort) { try { this.abort.abort(); } catch (e) { /* ignore */ } this.abort = null; }
  this.queue = [];
  this.sb = null;
  this.ms = null;
  const src = this.video.src;
  if (src && src.indexOf('blob:') === 0) { try { URL.revokeObjectURL(src); } catch (e) { /* ignore */ } }
  this.video.removeAttribute('src');
  try { this.video.load(); } catch (e) { /* ignore */ }
};

MseStream.prototype.destroy = function () {
  this.gen += 1;
  this.video.removeEventListener('seeking', this.onSeeking);
  this.stop();
};

MseStream.prototype.fail = function (err) {
  if (this.handlers.onError) this.handlers.onError(err);
};

MseStream.prototype.pump = function () {
  const sb = this.sb;
  if (!sb || sb.updating) return;
  if (this.queue.length) {
    const chunk = this.queue.shift();
    if (!this._firstAppend) { this._firstAppend = true; clog('mse 首个数据块 ' + chunk.byteLength + 'B'); }
    try {
      sb.appendBuffer(chunk);
    } catch (e) {
      this.fail(e);
    }
    return;
  }
  if (this.ended && this.ms && this.ms.readyState === 'open') {
    try { this.ms.endOfStream(); } catch (e) { /* ignore */ }
  }
};

MseStream.prototype.applyPendingSeek = function () {
  if (this.pendingSeek == null) return;
  const target = this.pendingSeek;
  const ranges = this.video.buffered;
  for (let i = 0; i < ranges.length; i += 1) {
    if (target >= ranges.start(i) - 0.5 && target <= ranges.end(i)) {
      this.pendingSeek = null;
      try { this.video.currentTime = target; } catch (e) { /* ignore */ }
      return;
    }
  }
};

MseStream.prototype.fetch = function (start, gen) {
  const self = this;
  const ctrl = new AbortController();
  self.abort = ctrl;
  fetch(self.tcURL(start), { signal: ctrl.signal }).then(function (res) {
    if (!res.ok || !res.body) throw new Error('转码请求失败 HTTP ' + res.status);
    const reader = res.body.getReader();
    function read() {
      return reader.read().then(function (result) {
        if (gen !== self.gen) return;
        if (result.done) {
          self.ended = true;
          self.pump();
          return;
        }
        self.queue.push(result.value);
        self.pump();
        return read();
      });
    }
    return read();
  }).catch(function (err) {
    if (err && err.name === 'AbortError') return;
    if (gen === self.gen) self.fail(err);
  });
};

MseStream.prototype.handleSeeking = function () {
  if (!this.sb) return;
  const video = this.video;
  const t = video.currentTime;
  if (!isFinite(t)) return;
  const ranges = video.buffered;
  for (let i = 0; i < ranges.length; i += 1) {
    if (t >= ranges.start(i) - 0.3 && t <= ranges.end(i) - 0.5) return;
  }
  this.startAt(t);
};

function teardownPlayer() {
  if (window.HGSuperRes) window.HGSuperRes.disable();
  const video = $('video');
  if (playerState.mse) { playerState.mse.destroy(); playerState.mse = null; }
  video.onloadedmetadata = null;
  video.pause();
  video.removeAttribute('src');
  try { video.load(); } catch (e) { /* ignore */ }
  playerState.mode = '';
  playerState.stream = null;
}

function pausePlaybackForNav(reason) {
  const video = $('video');
  if (!video) return;
  if (!video.paused) {
    try { video.pause(); } catch (e) { /* ignore */ }
    clog('切页暂停播放(' + (reason || 'nav') + ') t=' + video.currentTime.toFixed(1));
  }
}

function directState(tag) {
  const video = $('video');
  let buf = '';
  try {
    for (let i = 0; i < video.buffered.length; i += 1) {
      buf += video.buffered.start(i).toFixed(1) + '-' + video.buffered.end(i).toFixed(1) + ' ';
    }
  } catch (e) { /* ignore */ }
  clog('direct ' + tag + ': rs=' + video.readyState + ' ns=' + video.networkState +
    ' paused=' + video.paused + ' err=' + (video.error && video.error.code) +
    ' dur=' + video.duration + ' t=' + video.currentTime.toFixed(1) + ' buf=[' + buf + ']');
}

function playDirect(stream, startTime, token) {
  const video = $('video');
  clog('direct 模式 src=/dec?port=' + stream.port + ' start=' + startTime.toFixed(1));
  playerState.mode = 'direct';
  video.controls = false;
  if ((SELFTEST || !userActivated) && !userActivated) video.muted = true; // 自动起播先静音，用户交互后恢复声音
  autoMuted = !userActivated;
  video.onloadedmetadata = function () {
    clog('direct loadedmetadata dur=' + video.duration);
    dmLoad(token);
    if (startTime > 0 && isFinite(video.duration)) {
      video.currentTime = Math.min(startTime, Math.max(0, video.duration - 1));
    }
  };
  video.onloadeddata = function () { clog('direct loadeddata'); };
  video.oncanplay = function () { clog('direct canplay'); };
  video.onstalled = function () { clog('direct stalled'); };
  video.src = '/dec?' + streamQuery(stream) + '&v=' + token;
  applyPictureEnhance();
  video.play().then(function () {
    clog('direct play() resolved');
  }).catch(function (e) {
    clog('direct play() rejected: ' + ((e && e.name) || '') + ' ' + ((e && e.message) || e));
    if (!video.muted) {
      video.muted = true;
      autoMuted = true;
      video.play().then(function () {
        toast('已静音自动播放，点击画面开启声音');
      }).catch(function () {
        $('p-loading').hidden = true;
        toast('浏览器要求先点击画面才能播放');
      });
      return;
    }
    $('p-loading').hidden = true;
    toast('浏览器要求先点击画面才能播放');
  });
  setTimeout(function () { directState('3s'); }, 3000);
  setTimeout(function () { directState('8s'); }, 8000);
}

async function startMse(stream, startTime, token) {
  let duration = 0;
  clog('mse 模式 开始 probe');
  try {
    duration = (await probeStream(stream)).duration || 0;
    clog('mse probe ok duration=' + duration);
  } catch (e) {
    clog('mse probe 失败: ' + ((e && e.message) || e));
  }
  if (token !== playerState.token) return;
  const video = $('video');
  playerState.mode = 'mse';
  video.controls = false;
  if (SELFTEST && !userActivated) video.muted = true;
  playerState.mse = new MseStream(video, stream, {
    onError(err) {
      if (token !== playerState.token) return;
      $('p-loading').hidden = true;
      showPlayerError('转码播放失败：' + ((err && err.message) || err), true);
    },
  });
  playerState.mse.load(startTime, duration);
  dmLoad(token);
  applyPictureEnhance();
}

let playGeneration = 0;

async function playEpisode(index, opts = {}) {
  const { quality = (settingsState.quality || 0), keepTime = false, startTime = 0, fromFeed = false } = opts;
  const chapter = state.chapters[index];
  if (!chapter) return;
  if (!fromFeed) episodeMode = true; // 显式点播/选集/历史续播 = 集数模式
  // 任何显式点播都不应被推荐流的自动起播抢走
  suppressFeedAutoplayUntil = Date.now() + 4000;
  heatToken++; // 起播时取消排队中的热度补全，避免抢占解析带宽
  const generation = ++playGeneration;
  const previousTime = startTime > 0 ? startTime : (keepTime ? state.videoTime : 0);
  if (state.plan && state.plan.session) {
    api({ action: 'release', session: state.plan.session }).catch(() => {});
  }
  state.plan = null;
  state.index = index;
  state.videoTime = 0;
  epState.rangeUser = null;
  clog('playEpisode index=' + index + ' q=' + quality + ' start=' + previousTime.toFixed(1));
  if ($('view-detail')) $('view-detail').hidden = true;
  $('player').hidden = false;
  $('p-loading').hidden = false;
  $('p-ctrls').classList.remove('hide');
  $('p-error').hidden = true;
  $('p-title').textContent = state.drama.title || '';
  $('p-sub').textContent = chapter.title || `第 ${index + 1} 集`;
  updateFeedHint();
  renderPlayerMeta();
  rememberDrama(state.drama);
  renderPlayerChapters();
  $('p-loading').hidden = false;
  $('p-error').hidden = true;
  try {
    const plan = await api({
      action: 'resolve',
      source: SOURCE,
      drama: state.drama,
      chapter,
      index,
      quality,
    });
    if (generation !== playGeneration) {
      api({ action: 'release', session: plan.session }).catch(() => {});
      return;
    }
    consecutivePlayFails = 0;
    state.plan = plan;
    state.qualities = plan.qualities || [];
    state.quality = plan.quality || 0;
    clog('resolve ok q=' + plan.quality + ' url=' + String(plan.url).slice(0, 50) + ' keylen=' + String(plan.decryptionKey || '').length);
    await applyPlan(plan, previousTime);
  } catch (e) {
    if (generation !== playGeneration) return;
    clog('resolve 失败: ' + ((e && e.message) || e));
    $('p-loading').hidden = true;
    const msg = (e && e.message) || String(e);
    if (consecutivePlayFails < 1 && feed.items.length > 1) {
      consecutivePlayFails += 1;
      toast('该剧暂时不可用，换下一部');
      feed.index = (feed.index + 1) % feed.items.length;
      feedPlay(feed.index);
      return;
    }
    showPlayerError(msg, false);
  }
}


let consecutivePlayFails = 0;
let prefetchSeq = 0;
let lastPrefetchKey = '';
function schedulePrefetch() {
  if (settingsState.direct) return; // 直连模式不占用宿主机带宽做预缓冲
  const key = (state.drama && state.drama.id) + ':' + state.index;
  if (key === lastPrefetchKey) return;
  lastPrefetchKey = key;
  const my = ++prefetchSeq;
  setTimeout(async () => {
    if (my !== prefetchSeq) return;
    const drama = state.drama;
    const chapters = state.chapters || [];
    if (!drama || chapters.length < 2) return;
    const idx = state.index;
    const targets = [];
    for (let d = 1; d <= 10; d++) {
      if (idx + d < chapters.length) targets.push(idx + d);
      if (idx - d >= 0) targets.push(idx - d);
    }
    for (const i of targets) {
      if (my !== prefetchSeq) return;
      try {
        const plan = await api({ action: 'preload', drama: drama, chapter: chapters[i], index: i, quality: 0 });
        if (plan && plan.session) api({ action: 'release', session: plan.session }).catch(() => {});
        clog('prefetch ep ' + (i + 1) + ' bytes=' + ((plan && plan.prefetchedBytes) || 0));
      } catch (e) { /* 忽略 */ }
      await new Promise((r) => setTimeout(r, 250));
    }
  }, 1500);
}

async function applyPlan(plan, startTime) {
  try {
    const token = ++playerState.token;
    applyPictureEnhance();
    updateCommentCount();
    renderQuality();
    if (await tryDirectPlay(plan, startTime || 0)) {
      $('p-error').hidden = true;
      $('p-loading').hidden = false;
      schedulePrefetch();
      return;
    }
    teardownPlayer();
    state.videoTime = startTime || 0;
    $('p-error').hidden = true;
    $('p-loading').hidden = false;
    const stream = planStream(plan);
    if (!stream) {
      clog('applyPlan: 播放信息不完整 url=' + String(plan && plan.url).slice(0, 80));
      $('p-loading').hidden = true;
      showPlayerError('播放信息不完整，试试换一条线路。', true);
      return;
    }
    if (!stream.key) clog('applyPlan: 无解密密钥（明文流），走直通模式');
    playerState.stream = stream;
    const hevc = hevcSupported();
    clog('applyPlan: hevc=' + hevc + ' q=' + (plan.quality || 0) + ' stream=' + stream.port + stream.path.slice(0, 24));
    if (hevc) {
      playDirect(stream, startTime || 0, token);
      schedulePrefetch();
      return;
    }
    await startMse(stream, startTime || 0, token);
    schedulePrefetch();
  } catch (e) {
    clog('applyPlan 异常: ' + ((e && e.message) || e));
    $('p-loading').hidden = true;
    showPlayerError('播放初始化失败：' + ((e && e.message) || e), true);
  }
}

const commentCache = new Map();

async function loadComments(sid, vid) {
  const key = sid + ':' + vid;
  const hit = commentCache.get(key);
  if (hit && Date.now() - hit.ts < 600000) return hit.data;
  const resp = await fetch('/comments?sid=' + encodeURIComponent(sid) + '&vid=' + encodeURIComponent(vid));
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || '加载失败');
  commentCache.set(key, { data: data, ts: Date.now() });
  return data;
}

async function updateCommentCount() {
  if (!state.drama) return;
  const sid = String(state.drama.id || '').replace(/^hongguo:/, '');
  const chapter = (state.chapters || [])[state.index] || {};
  const vid = String(chapter.videoUrl || '').replace('hongguo-cenc://', '');
  const num = $('r-comment-num');
  if (!/^[0-9]+$/.test(vid)) { if (num) num.textContent = ''; return; }
  try {
    const data = await loadComments(sid, vid);
    if (num && String(state.chapters[state.index] && state.chapters[state.index].videoUrl || '').indexOf(vid) >= 0) {
      num.textContent = data.total ? fmtCount(data.total) : '0';
    }
  } catch (e) { if (num) num.textContent = ''; }
}

async function openTagBrowse(name) {
  const tag = String(name || '').trim();
  if (!tag) return;
  closePlayer();
  showView('search');
  try { await loadFilterRows(); } catch (e) {}
  let id = '';
  (state.filterRows || []).forEach((row) => {
    (row.items || []).forEach((it) => { if (!id && it.name === tag) id = it.id; });
  });
  if (!id) {
    chooseSearchTerm(tag);
    toast('没有同名筛选，已按关键词「' + tag + '」搜索');
    return;
  }
  state.query = '';
  state.category = id;
  const hitRow = (state.filterRows || []).find((row) => (row.items || []).some((it) => it.id === id));
  state.tagRow = hitRow ? hitRow.name : '';
  renderChips();
  renderFilterRows();
  renderFilterSummary();
  await loadCatalog({ reset: true });
}

function renderPlayerMeta() {
  const drama = state.drama || {};
  const chapter = state.chapters[state.index] || {};
  $('p-author').textContent = '@' + (drama.title || '红果短剧');
  const tags = (drama.tags && drama.tags.length ? drama.tags : [drama.category]).filter(Boolean).slice(0, 4);
  $('p-tags').innerHTML = tags.map((tag) => `<button type="button" class="meta-tag" data-tag="${escapeHTML(tag)}">${escapeHTML(tag)}</button>`).join('');
  $('p-ep').textContent = chapter.title || ('第 ' + (state.index + 1) + ' 集');
  $('p-desc').textContent = drama.description || '';
  $('p-meta').classList.remove('open');
  $('p-expand').textContent = '展开';
  $('p-expand').hidden = !drama.description || drama.description.length < 40;
  $('r-like-num').textContent = fmtCount(drama.heat) || '点赞';
  $('r-comment-num').textContent = '';
  updateCommentCount();
  const curVid = String(chapter.videoUrl || '').replace('hongguo-cenc://', '');
  $('r-like').classList.toggle('liked', isLiked(drama.id, curVid));
  ensureLikeIndex().then(() => {
    if (state.drama && state.drama.id === drama.id) $('r-like').classList.toggle('liked', isLiked(drama.id, curVid));
  });
  $('r-fav').classList.toggle('liked', isFaved(drama.id));
  ensureFavIndex().then(() => {
    if (state.drama && state.drama.id === drama.id) $('r-fav').classList.toggle('liked', isFaved(drama.id));
  });
  $('p-episodes').textContent = '选集·全 ' + state.chapters.length + ' 集';
  loadEpisodeSeries();
}

function applySpeed() {
  const video = $('video');
  const rate = Number($('p-speed').value) || 1;
  try { video.playbackRate = rate; } catch (e) { /* ignore */ }
}

function renderQuality() {
  const select = $('p-quality');
  const current = state.quality || state.plan && state.plan.quality || 0;
  const list = (state.qualities || []).slice().sort((a, b) => b - a);
  if (!list.length) {
    select.innerHTML = '<option>自动</option>';
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML = list.map((q) => {
    const label = q >= 1080 ? '1080P' : q + 'P';
    return `<option value="${q}"${q === current ? ' selected' : ''}>${label}</option>`;
  }).join('');
}

/* ---------------- 选集面板：区间分页 + 看过的红点 + 系列剧 ---------------- */
const EP_RANGE = 30;
const SEASON_SUFFIX = /第\s*([0-9零〇一二两三四五六七八九十百]+)\s*([季部])\s*$/;
const epState = { tab: 'ep', range: 0, rangeUser: null, series: [], seriesFor: '' };

function cnSeasonNum(label) {
  if (/^[0-9]+$/.test(label)) return parseInt(label, 10);
  const digits = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  let total = 0;
  let cur = 0;
  for (let i = 0; i < label.length; i += 1) {
    const ch = label[i];
    if (ch === '十') { total += (cur || 1) * 10; cur = 0; }
    else if (ch === '百') { total += (cur || 1) * 100; cur = 0; }
    else if (digits[ch] !== undefined) { cur = digits[ch]; }
    else { return 0; }
  }
  return total + cur;
}

function seasonBase(title) {
  const text = String(title || '');
  const m = text.match(SEASON_SUFFIX);
  if (!m) return null;
  const base = text.slice(0, m.index).replace(/[\s:：·\-—]+$/, '');
  if (!base) return null;
  return { base, num: cnSeasonNum(m[1]) };
}

function epWatchedIndex() {
  const drama = state.drama;
  if (!drama) return -1;
  let idx = -1;
  const rec = loadProgress(drama.id);
  if (rec && typeof rec.index === 'number') idx = rec.index;
  if (typeof officialHistory !== 'undefined' && officialHistory && officialHistory.get) {
    const it = officialHistory.get(drama.id);
    if (it && typeof it.progressIndex === 'number' && it.progressIndex > idx) idx = it.progressIndex;
  }
  return idx;
}

function renderEpTabs() {
  document.querySelectorAll('#ep-tabs .ep-tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.etab === epState.tab);
  });
  const seriesTab = document.querySelector('#ep-tabs [data-etab="series"]');
  if (seriesTab) seriesTab.hidden = epState.series.length < 2;
  $('ep-ranges').hidden = epState.tab !== 'ep';
  $('p-chapters').hidden = epState.tab !== 'ep';
  $('ep-series').hidden = epState.tab !== 'series';
  $('ep-count').textContent = epState.tab === 'ep'
    ? '全 ' + state.chapters.length + ' 集'
    : (epState.series.length ? '共 ' + epState.series.length + ' 季' : '');
}

function renderEpRanges() {
  const total = state.chapters.length;
  const ranges = Math.ceil(total / EP_RANGE);
  if (ranges <= 1) { $('ep-ranges').innerHTML = ''; epState.range = 0; return; }
  const active = Math.floor(state.index / EP_RANGE);
  if (epState.rangeUser === null || epState.rangeUser === undefined) {
    epState.range = active;
  } else {
    epState.range = Math.min(Math.max(0, epState.rangeUser), ranges - 1);
  }
  let html = '';
  for (let i = 0; i < ranges; i += 1) {
    const start = i * EP_RANGE + 1;
    const end = Math.min(total, (i + 1) * EP_RANGE);
    html += '<button type="button" class="ep-range' + (i === epState.range ? ' active' : '') + '" data-range="' + i + '">' + start + '-' + end + '</button>';
  }
  $('ep-ranges').innerHTML = html;
}

function renderEpGrid() {
  const total = state.chapters.length;
  const start = epState.range * EP_RANGE;
  const end = Math.min(total, start + EP_RANGE);
  const watched = epWatchedIndex();
  let html = '';
  for (let i = start; i < end; i += 1) {
    const cls = ['ep-num'];
    if (i === state.index) cls.push('active');
    if (i <= watched) cls.push('watched');
    const dur = fmtDur(state.chapters[i] && state.chapters[i].duration);
    html += '<button type="button" class="' + cls.join(' ') + '" data-index="' + i + '" title="' + (dur ? '第' + (i + 1) + '集 · ' + dur : '') + '">' + (i + 1) + (dur ? '<i>' + dur + '</i>' : '') + '</button>';
  }
  $('p-chapters').innerHTML = html;
}

function renderEpSeries() {
  $('ep-series').innerHTML = epState.series.map((it) => {
    const active = state.drama && it.id === state.drama.id ? ' active' : '';
    return '<button type="button" class="ep-season' + active + '" data-id="' + escapeHTML(it.id) + '">' + escapeHTML(it.title || it.id) + '</button>';
  }).join('');
}

async function loadEpisodeSeries() {
  const drama = state.drama;
  if (!drama) return;
  if (epState.seriesFor === drama.id) { renderEpTabs(); return; }
  epState.seriesFor = drama.id;
  epState.series = [];
  const info = seasonBase(drama.title);
  if (!info) { renderEpTabs(); return; }
  try {
    const data = await api({ action: 'catalog', source: SOURCE, query: info.base, page: 1 });
    const items = (data.items || []).filter((it) => String(it.title || '').indexOf(info.base) >= 0);
    const siblings = items
      .map((it) => ({ it, num: seasonBase(it.title) ? seasonBase(it.title).num : 0 }))
      .filter((x) => x.num > 0)
      .sort((a, b) => a.num - b.num)
      .map((x) => x.it);
    if (!siblings.some((it) => it.id === drama.id)) siblings.push(drama);
    epState.series = siblings;
  } catch (e) {
    epState.series = [];
  }
  renderEpTabs();
  renderEpSeries();
}

function renderPlayerChapters() {
  renderEpTabs();
  renderEpRanges();
  renderEpGrid();
  renderEpSeries();
}

function showPlayerError(message, canFallback) {
  $('p-error-text').textContent = message;
  $('p-fallback').hidden = !canFallback;
  $('p-error').hidden = false;
}

async function fallback() {
  if (!state.plan || !state.plan.session) return;
  $('p-error').hidden = true;
  $('p-loading').hidden = false;
  const keep = state.videoTime;
  try {
    const plan = await api({ action: 'fallback', session: state.plan.session });
    state.plan = plan;
    state.qualities = plan.qualities || state.qualities;
    state.quality = plan.quality || state.quality;
    applyPlan(plan, keep);
  } catch (e) {
    $('p-loading').hidden = true;
    showPlayerError(e.message, false);
  }
}

function closePlayer() {
  exitFullscreenIfAny();
  episodeMode = false;
  const origin = playerOrigin;
  playerOrigin = null;
  const restoreOrigin = () => {
    showView(origin && origin !== 'recommend' ? origin : 'search');
  };
  playGeneration += 1;
  dmItems = [];
  dmIndex = 0;
  dmClear();
  if (state.plan && state.plan.session) {
    api({ action: 'release', session: state.plan.session }).catch(() => {});
  }
  state.plan = null;
  teardownPlayer();
  $('p-error').hidden = true;
  $('p-loading').hidden = true;
  restoreOrigin();
}

function nextEpisode() {
  episodeMode = true;
  if (state.index + 1 < state.chapters.length) {
    playEpisode(state.index + 1, { quality: state.quality });
  } else {
    toast('已经是最后一集了');
  }
}

function prevEpisode() {
  episodeMode = true;
  if (state.index > 0) {
    playEpisode(state.index - 1, { quality: state.quality });
  } else {
    toast('已经是第一集了');
  }
}

/* ---------------- 弹幕 ---------------- */

const DM_KEY = 'hg:danmaku';
const dm = Object.assign({ on: true, opacity: 90, size: 18, speed: 100, area: 'full' }, (function () {
  try { return JSON.parse(localStorage.getItem(DM_KEY) || '{}') || {}; } catch (e) { return {}; }
})());

let dmItems = [];
let dmIndex = 0;
let dmLastTime = 0;
let dmLaneNext = [];
let dmLoadedToken = -1;

// 弹幕表情：竞品前端内置的 53 个 webp 表情（[笑哭] → e20.webp），
// 已从竞品资源里提取到 /assets/emoji/，这里把 [xx] 文本替换成内联图片。
let dmEmoji = [];
fetch('/assets/emoji/map.json').then(function (r) { return r.json(); }).then(function (map) {
  const entries = Object.keys(map || {}).map(function (tok) { return [tok, map[tok]]; });
  entries.sort(function (a, b) { return b[0].length - a[0].length; });
  dmEmoji = entries;
}).catch(function () { dmEmoji = []; });

function dmRichHTML(text) {
  let html = escapeHTML(text);
  if (!dmEmoji.length) return html;
  for (let i = 0; i < dmEmoji.length; i += 1) {
    const tok = dmEmoji[i][0];
    if (html.indexOf(tok) < 0) continue;
    const img = '<img class="dm-emoji" src="/assets/emoji/' + dmEmoji[i][1] + '" alt="' + tok + '" draggable="false">';
    html = html.split(tok).join(img);
  }
  return html;
}

function dmSave() {
  try { localStorage.setItem(DM_KEY, JSON.stringify(dm)); } catch (e) { /* ignore */ }
}

function dmApplyStyle() {
  const layer = $('p-danmaku');
  if (!layer) return;
  layer.style.opacity = String(dm.opacity / 100);
  layer.classList.toggle('off', !dm.on);
  layer.classList.remove('area-top', 'area-bottom');
  if (dm.area === 'top') layer.classList.add('area-top');
  if (dm.area === 'bottom') layer.classList.add('area-bottom');
}

function dmClear() {
  const layer = $('p-danmaku');
  if (layer) layer.innerHTML = '';
  dmLastTime = 0;
  dmLaneNext = [];
}

function dmReset(toMs) {
  dmClear();
  dmIndex = 0;
  while (dmIndex < dmItems.length && dmItems[dmIndex].timeMs < toMs) dmIndex += 1;
  dmLastTime = toMs / 1000;
}

const LOCAL_DM_PREFIX = 'hg:dm:';
const LOCAL_REVIEW_PREFIX = 'hg:review:';

function loadJSON(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
}
function currentVideoID() {
  const chapter = (state.chapters || [])[state.index] || null;
  return chapter ? String(chapter.videoUrl || '').replace('hongguo-cenc://', '') : '';
}
function localDanmaku(vid) { return vid ? loadJSON(LOCAL_DM_PREFIX + vid, []) : []; }
function pushLocalDanmaku(vid, text, timeMs) {
  if (!vid) return;
  const list = localDanmaku(vid);
  list.push({ text: text, timeMs: timeMs, t: Date.now() });
  saveJSON(LOCAL_DM_PREFIX + vid, list.slice(-200));
}

async function dmLoad(token, force) {
  dmItems = [];
  dmIndex = 0;
  dmClear();
  if (!dm.on && !force) { clog('danmaku 跳过: 弹幕开关关闭'); return; }
  const sid = seriesIDOf(state.drama);
  const vid = currentVideoID();
  if (!sid || !vid) { clog('danmaku 跳过: sid=' + sid + ' vid=' + vid); return; }
  dmLoadedToken = token;
  const video = $('video');
  const end = Math.max(60000, Math.ceil((isFinite(video.duration) && video.duration > 0 ? video.duration : 300) * 1000));
  try {
    const page = await api({ action: 'danmaku', query: sid, session: vid, startMs: 0, durationMs: end });
    if (token !== playerState.token) return;
    dmItems = (page.items || []).slice().sort(function (a, b) { return a.timeMs - b.timeMs; });
    const epTotal = Number(page.total) || dmItems.length;
    clog('danmaku 加载 ' + dmItems.length + ' 条');
    dmReset(Math.max(0, ($('video').currentTime || 0) * 1000));
  } catch (e) {
    clog('danmaku 失败: ' + ((e && e.message) || e));
  }
}

function dmSpawn(text) {
  const layer = $('p-danmaku');
  if (!layer) return;
  const stageW = layer.clientWidth || 800;
  const laneH = Math.max(20, Math.round(dm.size * 1.5));
  const laneCount = Math.max(3, Math.min(12, Math.floor((layer.clientHeight - 6) / laneH) || 3));
  const el = document.createElement('span');
  el.className = 'dm';
  el.innerHTML = dmRichHTML(text);
  el.style.fontSize = dm.size + 'px';
  layer.appendChild(el);
  const textW = el.offsetWidth || text.length * dm.size;
  const dist = stageW + textW;
  const travel = Math.max(2, 8 * (100 / Math.max(50, dm.speed)) * (dist / Math.max(1, stageW)));
  el.style.setProperty('--dm-dist', (-dist) + 'px');
  el.style.setProperty('--dm-dur', travel.toFixed(2) + 's');
  const now = performance.now();
  let lane = 0;
  let best = Infinity;
  for (let i = 0; i < laneCount; i += 1) {
    const t = dmLaneNext[i] || 0;
    if (t <= now) { lane = i; best = -1; break; }
    if (t < best) { best = t; lane = i; }
  }
  dmLaneNext[lane] = now + Math.max(350, travel * 1000 * (textW / dist) * 0.6);
  el.style.top = (lane * laneH + 4) + 'px';
  el.addEventListener('animationend', function () { el.remove(); });
}

function dmTick() {
  const layer = $('p-danmaku');
  const video = $('video');
  if (!layer || $('player').hidden) return;
  if (!dm.on) return;
  layer.classList.toggle('paused', video.paused);
  if (video.paused) { dmLastTime = video.currentTime; return; }
  const now = video.currentTime;
  if (now < dmLastTime - 1.5 || now > dmLastTime + 6) { dmReset(now * 1000); return; }
  while (dmIndex < dmItems.length && dmItems[dmIndex].timeMs <= now * 1000) {
    const item = dmItems[dmIndex];
    dmIndex += 1;
    if (item.timeMs >= dmLastTime * 1000 - 1500) dmSpawn(item.text);
  }
  dmLastTime = now;
}

function dmSyncSettings() {
  $('dm-on').checked = !!dm.on;
  $('dm-opacity').value = String(dm.opacity);
  $('dm-size').value = String(dm.size);
  $('dm-speed').value = String(dm.speed);
  $('dm-area').value = dm.area;
}

/* ---------------- 自定义播放控制条 ---------------- */

let seekDragging = false;
let volDragging = false;
let lastActivity = Date.now();

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function showControls(force) {
  const bar = $('p-ctrls');
  if (!bar) return;
  lastActivity = Date.now();
  $('player').classList.remove('ui-hidden');
  if (bar.classList.contains('hide')) {
    bar.classList.remove('hide');
    clog('ctrls show');
  }
  if (force) lastActivity = Date.now();
}

function hideControls() {
  const bar = $('p-ctrls');
  if (!bar) return;
  if (!bar.classList.contains('hide')) {
    bar.classList.add('hide');
    $('player').classList.add('ui-hidden');
    clog('ctrls hide');
  }
}

// 播放中 3 秒无操作自动隐藏控制条（鼠标悬停在控制条上时保持显示）
function startControlsWatcher() {
  setInterval(function () {
    if ($('player').hidden) return;
    const bar = $('p-ctrls');
    const video = $('video');
    if (!bar) return;
    const rail = document.querySelector('.player-rail');
    const meta = $('p-meta');
    if (bar.matches(':hover') || (rail && rail.matches(':hover')) || (meta && meta.matches(':hover'))) { lastActivity = Date.now(); return; }
    if (video.paused || seekDragging || volDragging) return;
    if (Date.now() - lastActivity > 3000) hideControls();
  }, 400);
}

function syncProgress() {
  const video = $('video');
  const seek = $('p-seek');
  if (!seek) return;
  const dur = isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  $('p-dur').textContent = dur ? fmtTime(dur) : '0:00';
  if (!seekDragging) {
    $('p-time').textContent = fmtTime(video.currentTime);
    if (dur) seek.value = String(Math.round((video.currentTime / dur) * 1000));
  }
  $('p-play').classList.toggle('playing', !video.paused);
  $('p-mute').classList.toggle('muted', video.muted || video.volume === 0);
  const vol = $('p-vol');
  if (vol && !volDragging) vol.value = String(Math.round(video.volume * 100));
  $('p-vol-label').textContent = Math.round(video.volume * 100) + '%';
}

function togglePlay() {
  const video = $('video');
  if (video.paused) video.play().catch(function () {});
  else video.pause();
  showControls(true);
  syncProgress();
}

function seekTo(t) {
  const video = $('video');
  if (!isFinite(video.duration) || video.duration <= 0) return;
  video.currentTime = Math.max(0, Math.min(t, video.duration - 0.3));
  syncProgress();
}

function toggleMute() {
  const video = $('video');
  video.muted = !video.muted;
  syncProgress();
  showControls(true);
}

function toggleFullscreen() {
  const player = $('player');
  if (document.fullscreenElement) {
    if (document.exitFullscreen) document.exitFullscreen().catch(function () {});
  } else if (player.requestFullscreen) {
    player.requestFullscreen().catch(function () {});
  } else {
    toast('当前浏览器不支持全屏');
  }
}

/* ---------------- 事件绑定 ---------------- */


/* ================= 视图路由与页面（复刻竞品布局） ================= */

const VIEW_TITLES = { recommend: '推荐', search: '找剧', rank: '排行榜', new: '新剧', history: '历史', fav: '收藏', likes: '点赞', reserve: '追更·预约', detail: '剧集详情', creator: '创作者主页' };

function showView(name) {
  if (name !== 'recommend') exitFullscreenIfAny();
  state.view = name;
  const isList = ['history', 'fav', 'likes'].indexOf(name) >= 0;
  ['recommend', 'search', 'rank', 'new', 'list', 'follow', 'detail', 'creator'].forEach((v) => {
    const el = $('view-' + v);
    if (el) el.hidden = !(v === name || (v === 'list' && isList) || (v === 'follow' && name === 'reserve'));
  });
  $('page-title').textContent = VIEW_TITLES[name] || '';
  $('tabs').hidden = name !== 'recommend';
  $('feed-hint').hidden = name !== 'recommend';
  $('search-form').hidden = name !== 'search';
  if (name !== 'search') closeSearchPop();
  document.querySelectorAll('.side-item[data-nav]').forEach((el) => el.classList.toggle('active', el.dataset.nav === name));
  if (name !== 'recommend') pausePlaybackForNav('view:' + name);
  if (name === 'recommend') ensureFeed();
  else if (name === 'search') ensureSearch();
  else if (name === 'rank') ensureRank();
  else if (name === 'new') ensureNew();
  else if (isList) loadList(name);
  else if (name === 'reserve') loadFollowView();
}


/* ---------- 创作者主页 ---------- */
const creatorState = { celebrity: null, origin: 'detail', drama: null, uid: '', profile: null, profileLoaded: false, works: [], cursor: '', hasMore: false, total: 0, loaded: false, loading: false };

function creatorUID(c) {
  const m = /[?&]uid=(\d+)/.exec(String((c && c.schema) || ''));
  if (m) return m[1];
  return String((c && c.uid) || '');
}

function openCreator(c, origin) {
  if (!c) return;
  creatorState.celebrity = c;
  creatorState.origin = origin || 'detail';
  creatorState.drama = state.drama || null;
  creatorState.uid = creatorUID(c);
  creatorState.profile = null;
  creatorState.profileLoaded = false;
  creatorState.works = [];
  creatorState.cursor = '';
  creatorState.hasMore = false;
  creatorState.total = 0;
  creatorState.loaded = false;
  creatorState.loading = false;
  showView('creator');
  renderCreator();
}

function renderCreator() {
  const c = creatorState.celebrity || {};
  const p = creatorState.profile || {};
  $('page-title').textContent = '创作者主页';
  const av = avatarURL(p.avatar || c.avatar);
  const img = $('cv-avatar');
  img.src = av || '';
  img.style.visibility = av ? 'visible' : 'hidden';
  $('cv-name').textContent = p.name || c.nickname || '';
  const roleText = p.role || c.subTitle || (c.role ? '饰 ' + c.role : '');
  $('cv-role').textContent = roleText || '演员';
  const verified = $('cv-verified');
  if (verified) verified.hidden = !p.verified;
  $('cv-bio').textContent = p.bio || c.intro || '';
  const stats = $('cv-stats');
  if (stats) {
    if (p.found) {
      stats.innerHTML = '<span><b>' + fmtCount(p.followCount || 0) + '</b> 关注</span><span><b>' + fmtCount(p.fansCount || 0) + '</b> 粉丝</span><span><b>' + fmtCount(p.likedCount || 0) + '</b> 获赞</span>';
      stats.hidden = false;
    } else {
      stats.hidden = true;
    }
  }
  const idBox = $('cv-id');
  if (idBox) {
    if (p.found && p.hongguoId) { idBox.textContent = '红果号 ' + p.hongguoId; idBox.hidden = false; } else { idBox.hidden = true; }
  }
  const tab = $('cv-tab');
  if (tab) tab.textContent = creatorState.loaded && creatorState.total ? '作品 ' + creatorState.total : '作品';
  renderCreatorWorks();
  if (creatorState.uid && !creatorState.profileLoaded) loadCreatorProfile();
  if (creatorState.uid && !creatorState.loaded && !creatorState.loading) loadCreatorWorks(false);
}

async function loadCreatorProfile() {
  const uid = creatorState.uid;
  if (!uid || creatorState.profileLoaded) return;
  creatorState.profileLoaded = true;
  try {
    const data = await api({ action: 'hgUserProfile', session: uid });
    if (data && data.found) creatorState.profile = data;
  } catch (err) {
    clog('creator profile error: ' + err.message);
  }
  renderCreator();
}

function renderCreatorWorks() {
  const works = $('cv-works');
  const empty = $('cv-empty');
  const more = $('cv-more-wrap');
  const list = creatorState.works;
  works.innerHTML = list.map(cardHTML).join('');
  works.hidden = !list.length;
  if (more) more.hidden = !creatorState.hasMore;
  if (!list.length) {
    empty.hidden = false;
    empty.textContent = creatorState.loading ? '正在加载作品…' : (creatorState.uid ? '这位创作者还没有公开作品' : '未找到该创作者的账号信息');
  } else {
    empty.hidden = true;
  }
  const tab = $('cv-tab');
  if (tab && creatorState.loaded) tab.textContent = '作品 ' + (creatorState.total || list.length);
}

async function loadCreatorWorks(append) {
  const uid = creatorState.uid;
  if (!uid || creatorState.loading) return;
  creatorState.loading = true;
  if (!append) creatorState.works = [];
  renderCreatorWorks();
  try {
    const data = await api({ action: 'hgCreatorWorks', session: uid, cursor: append ? creatorState.cursor : '' });
    const items = (data && data.items) || [];
    creatorState.works = append ? creatorState.works.concat(items) : items;
    creatorState.cursor = (data && data.cursor) || '';
    creatorState.hasMore = !!(data && data.hasMore);
    creatorState.total = Number((data && data.total) || creatorState.works.length) || creatorState.works.length;
    creatorState.loaded = true;
  } catch (err) {
    clog('creator works error: ' + err.message);
    toast('作品加载失败：' + err.message);
  } finally {
    creatorState.loading = false;
    renderCreatorWorks();
  }
}

function closeCreator() {
  const origin = creatorState.origin || 'detail';
  if (origin === 'detail' && state.drama) { showView('detail'); return; }
  showView(origin === 'recommend' ? 'recommend' : origin);
}

/* ---------- 推荐 feed（播放器即页面） ---------- */
// 从历史/收藏/搜索等外部入口点播时，避免 ensureFeed 自动起播推荐流的第一部剧把当前播放顶掉
let suppressFeedAutoplayUntil = 0;
const feed = { items: [], index: 0, category: '', page: 1, more: true, loading: false, loaded: false, busy: false, pending: 0 };
// 推荐页滚轮语义：feed=切下一部剧（默认），episode=切下一集（看过/点播过某一集之后）
let episodeMode = false;

async function ensureFeed() {
  if (!feed.loaded) await loadFeed(true);
}

async function loadFeed(reset, opts = {}) {
  if (feed.loading) return;
  feed.loading = true;
  try {
    const page = reset ? 1 : feed.page + 1;
    let data;
    if (feed.category) {
      data = await api({ action: 'recommendations', source: SOURCE, category: feed.category, page: page });
    } else {
      data = await api({ action: 'catalog', source: SOURCE, category: '', page: page });
    }
    const items = (data.items || []).filter((d) => d && d.id);
    if (reset) { feed.items = items; feed.index = 0; feed.page = 1; } else { feed.items = feed.items.concat(items); feed.page = page; }
    feed.more = !!data.hasMore;
    feed.loaded = true;
    updateFeedHint();
    if (reset && items.length && !opts.noPlay && Date.now() > suppressFeedAutoplayUntil) await feedPlay(0);
  } catch (e) {
    toast('加载失败：' + e.message);
  } finally {
    feed.loading = false;
  }
}

function isPlayerActive() {
  return !$('player').hidden && !!state.drama && (state.chapters || []).length > 0;
}

function updateFeedHint() {
  if (isPlayerActive()) {
    $('feed-hint').textContent = '第 ' + (state.index + 1) + ' / ' + state.chapters.length + ' 集 · 滚轮 / ↑↓ 切换集数';
    return;
  }
  if (!feed.items.length) { $('feed-hint').textContent = ''; return; }
  const total = feed.more ? feed.items.length + '+' : feed.items.length;
  $('feed-hint').textContent = (feed.index + 1) + ' / ' + total + ' · 滚轮 / ↑↓ 切换';
}

async function feedPlay(i) {
  if (feed.busy || !feed.items.length) return;
  feed.index = (i + feed.items.length) % feed.items.length;
  updateFeedHint();
  const drama = feed.items[feed.index];
  if (!drama) return;
  feed.busy = true;
  try {
    await openDetail(drama, { play: true });
    episodeMode = false; // 推荐流自动起播 = 浏览模式，滚轮切下一部剧
  } catch (e) {
    toast('打开失败：' + e.message);
  } finally {
    feed.busy = false;
  }
  if (feed.more && feed.index >= feed.items.length - 2) loadFeed(false);
  if (feed.pending) {
    const delta = feed.pending;
    feed.pending = 0;
    feedStep(delta);
  }
}

function feedStep(delta) {
  if (feed.busy) { feed.pending = delta; return; }
  feedPlay(feed.index + delta);
}

/* ---------- 找剧 ---------- */
const searchState = { loaded: false, expanded: false };

async function ensureSearch() {
  if (searchState.loaded) return;
  searchState.loaded = true;
  if (!state.categories.length) await loadCategories();
  renderChips();
  loadFilterRows();
  await loadCatalog({ reset: true });
}

/* ---------- 排行榜 ---------- */
const rankState = { loaded: false, board: 'hongguo-hot', items: [] };

async function ensureRank() {
  if (!rankState.loaded) {
    rankState.loaded = true;
    try {
      const data = await api({ action: 'rankingBoards' });
      const boards = data.items || [];
      $('boards').innerHTML = boards.map((b) => `<button class="board-item${b.id === rankState.board ? ' active' : ''}" data-board="${escapeHTML(b.id)}">${escapeHTML(b.name)}</button>`).join('');
    } catch (e) { toast(e.message); }
  }
  await loadRankRows(rankState.board);
}

async function loadRankRows(board) {
  rankState.board = board;
  document.querySelectorAll('.board-item').forEach((el) => el.classList.toggle('active', el.dataset.board === board));
  document.querySelectorAll('.rank-tab').forEach((el) => el.classList.toggle('active', el.dataset.board === board));
  $('rank-list').innerHTML = '<div class="list-empty">加载中…</div>';
  try {
    const data = await api({ action: 'rankings', board: board, page: 1 });
    rankState.items = data.items || [];
    renderRankRows();
  } catch (e) {
    $('rank-list').innerHTML = `<div class="list-empty">${escapeHTML(e.message)}</div>`;
  }
}

function renderRankRows() {
  if (!rankState.items.length) { $('rank-list').innerHTML = '<div class="list-empty">暂无数据</div>'; return; }
  $('rank-list').innerHTML = rankState.items.map((row, i) => {
    const d = row.drama || {};
    const rank = row.rank || i + 1;
    const top = rank <= 3 ? ' top' + rank : '';
    const src = coverURL(d);
    const cover = src ? `<img class="rank-cover" loading="lazy" src="${escapeHTML(src)}" alt="">` : '<div class="rank-cover"></div>';
    const tags = [d.category, d.episodes ? '全' + d.episodes + '集' : '', d.score ? d.score + '分' : ''].filter(Boolean).map((t) => `<span>${escapeHTML(String(t))}</span>`).join('');
    const metric = row.metric ? `<div class="rank-metrics">🔥 ${escapeHTML(String(row.metric))}</div>` : '';
    return `<div class="rank-row${top}" data-id="${escapeHTML(d.id || '')}">
      <div class="rank-no">${rank}</div>${cover}
      <div class="rank-info"><div class="rank-title">${escapeHTML(d.title || '')}</div>
      <div class="rank-tags">${tags}</div>
      <div class="rank-desc">${escapeHTML(d.description || '')}</div>${metric}</div>
      <div class="rank-actions"><button class="primary" data-act="play">播放</button><button data-act="detail">详情</button></div>
    </div>`;
  }).join('');
}

/* ---------- 新剧（真实接口：cell 7431550523368554558 / subscribe list tab_type=5） ---------- */
const newState = {
  loaded: false, tab: 'rec', gender: '2',
  items: [], cursor: '', hasMore: true, loading: false,
  calLoaded: false, calDates: [], calToday: '', calDate: '', calItems: [], calCursor: '', calHasMore: false, calLoading: false,
};

async function ensureNew() {
  if (newState.loaded) return;
  newState.loaded = true;
  await loadNewItems(true);
}

function genderParam() {
  if (newState.gender === 'male') return '1';
  if (newState.gender === 'female') return '0';
  return '2';
}

async function loadNewItems(reset) {
  if (newState.loading) return;
  newState.loading = true;
  if (reset) {
    newState.items = [];
    newState.cursor = '';
    newState.hasMore = true;
    $('new-grid').innerHTML = '<div class="list-empty">加载中…</div>';
    $('new-empty').hidden = true;
  }
  try {
    const data = await api({ action: 'hgNewSeries', session: genderParam(), cursor: reset ? '' : newState.cursor });
    newState.cursor = data.cursor || '';
    newState.hasMore = !!data.hasMore;
    newState.items = reset ? (data.items || []) : newState.items.concat(data.items || []);
    renderNewGrid();
  } catch (e) {
    if (reset) { $('new-grid').innerHTML = ''; $('new-empty').hidden = false; $('new-empty').textContent = e.message; }
  } finally {
    newState.loading = false;
  }
}

function newCardHTML(d) {
  const heat = fmtCount(d.heat || '');
  const tags = (d.tags || []).slice(0, 3).join(' · ');
  return `<div class="card new-card" data-id="${escapeHTML(d.id)}">
    <div class="cover-wrap"><img loading="lazy" src="${escapeHTML(coverURL(d))}" alt=""><span class="badge heat">${heat ? '🔥 ' + heat : ''}</span><span class="badge eps">共${d.episodes || 0}集</span></div>
    <h3>${escapeHTML(d.title || '')}</h3>
    <div class="sub">${escapeHTML(tags)}</div>
    <div class="new-score">${d.score ? escapeHTML(String(d.score)) + '分' : ''}</div>
  </div>`;
}

function calDateLabel(key) {
  if (!/^\d{8}$/.test(key)) return { week: '', day: key };
  const y = Number(key.slice(0, 4)), m = Number(key.slice(4, 6)), d = Number(key.slice(6, 8));
  const dt = new Date(y, m - 1, d);
  const week = key === newState.calToday ? '今天' : '周' + '日一二三四五六'[dt.getDay()];
  return { week, day: m + '/' + d };
}

async function ensureCalendar(reset) {
  if (newState.calLoading) return;
  newState.calLoading = true;
  if (reset) {
    newState.calItems = [];
    newState.calCursor = '';
    $('new-grid').innerHTML = '<div class="list-empty">加载中…</div>';
    $('new-empty').hidden = true;
  }
  try {
    const data = await api({ action: 'hgCalendar', query: newState.calDate || '', cursor: reset ? '' : newState.calCursor });
    if (data.dates && data.dates.length) newState.calDates = data.dates;
    if (data.today) newState.calToday = data.today;
    if (!newState.calDate) newState.calDate = data.date || data.today || (data.dates || [])[0] || '';
    newState.calCursor = data.cursor || '';
    newState.calHasMore = !!data.hasMore;
    newState.calItems = reset ? (data.items || []) : newState.calItems.concat(data.items || []);
    newState.calLoaded = true;
    renderNewGrid();
  } catch (e) {
    if (reset) { $('new-grid').innerHTML = ''; $('new-empty').hidden = false; $('new-empty').textContent = e.message; }
  } finally {
    newState.calLoading = false;
  }
}

function calRowHTML(it) {
  const kind = it.kind === 'comic' ? '漫剧' : it.kind === 'ai' ? 'AI剧' : '真人剧';
  const meta = [it.online ? '已上线' : (it.hint || '即将上线'), kind, it.episodes ? '共' + it.episodes + '集' : ''].filter(Boolean).join(' · ');
  const act = it.online
    ? '<button class="cal-sub" data-act="play">▶ 播放</button>'
    : '<button class="cal-sub" data-act="reserve">预约</button>';
  return `<div class="cal-row" data-id="${escapeHTML(it.id)}">
    <img class="cal-cover" loading="lazy" src="${escapeHTML(coverURL(it))}" alt="">
    <div class="cal-info"><div class="cal-title">${escapeHTML(it.title || '')}</div><div class="cal-meta">${escapeHTML(meta)}</div><div class="cal-intro">${escapeHTML(it.intro || '')}</div></div>
    ${act}
  </div>`;
}

function renderNewGrid() {
  const empty = $('new-empty');
  const dates = $('new-dates');
  if (newState.tab === 'cal') {
    $('new-filters').hidden = true;
    dates.hidden = false;
    if (!newState.calLoaded) {
      $('new-grid').innerHTML = '<div class="list-empty">加载中…</div>';
      empty.hidden = true;
      ensureCalendar(true);
      return;
    }
    dates.innerHTML = newState.calDates.map((key) => {
      const lb = calDateLabel(key);
      const past = key < newState.calToday ? ' past' : '';
      return `<button class="date-item${key === newState.calDate ? ' active' : ''}${past}" data-date="${key}"><span class="date-week">${lb.week}</span><span class="date-day">${lb.day}</span></button>`;
    }).join('');
    empty.hidden = newState.calItems.length > 0;
    empty.textContent = '这一天没有上新的剧';
    $('new-grid').classList.add('cal-list');
    $('new-grid').innerHTML = newState.calItems.map(calRowHTML).join('');
    return;
  }
  $('new-filters').hidden = false;
  dates.hidden = true;
  empty.hidden = newState.items.length > 0;
  empty.textContent = '暂无新剧';
  $('new-grid').classList.remove('cal-list');
  $('new-grid').innerHTML = newState.items.map(newCardHTML).join('');
  const more = $('new-more');
  if (more) more.hidden = !newState.hasMore;
}

/* ---------- 历史 / 收藏 / 点赞 / 预约 ---------- */
let listGen = 0;
const listFilter = { history: 'all', fav: 'all', likes: 'all' };
const officialFavList = [];
const officialLikeList = [];
const officialRemoteFavs = [];
const officialRemoteLikes = [];
const officialHistoryList = [];
const officialLikes = new Map();
let officialFolderList = null;

const LIST_CHIPS = {
  history: [
    { value: 'all', label: '全部' },
    { value: 'done', label: '已看完' },
    { value: 'undone', label: '未看完' },
  ],
  fav: [
    { value: 'all', label: '全部' },
    { value: 'real', label: '真人剧' },
    { value: 'comic', label: '漫剧' },
    { value: 'ai', label: 'AI剧' },
    { value: 'folder', label: '收藏夹' },
  ],
  likes: [
    { value: 'all', label: '全部' },
    { value: 'real', label: '真人剧' },
    { value: 'comic', label: '漫剧' },
    { value: 'ai', label: 'AI剧' },
  ],
};

function listChipsHTML(kind) {
  const chips = LIST_CHIPS[kind] || [];
  const active = listFilter[kind] || 'all';
  return `<div class="chips list-chips">${chips.map((c) => `<button class="chip${c.value === active ? ' active' : ''}" data-filter-kind="${kind}" data-filter-value="${c.value}">${c.label}</button>`).join('')}</div>`;
}

function historyIsDone(it) {
  const idx = Number(it.progressIndex) || 0;
  const total = Number(it.episodes) || 0;
  return total > 0 && idx + 1 >= total;
}

function historyRowHTML(it) {
  const idx = Number(it.progressIndex) || 0;
  const total = Number(it.episodes) || 0;
  const when = it.updatedAt ? timeAgo(it.updatedAt) : '';
  const cover = coverURL({ cover: it.cover || '' });
  const done = historyIsDone(it) ? '<span class="history-done">已看完</span>' : '';
  return `<div class="history-row" data-id="${escapeHTML(it.id)}">
    ${cover ? `<img class="history-cover" src="${escapeHTML(cover)}" alt="">` : '<div class="history-cover"></div>'}
    <div class="history-info"><div class="history-title">${escapeHTML(it.title || '')}</div>
    <div class="history-desc">${total ? `共 ${total} 集` : ''}${when ? ' · ' + when : ''}</div>
    <div class="history-progress">看到第 <b>${idx + 1}</b> 集${total ? ' / 共 ' + total + ' 集' : ''}${done}</div></div>
    <button class="history-continue" data-act="continue">继续播放</button></div>`;
}

function renderOfficialHistory(body, gen) {
  if (gen === undefined) gen = listGen;
  if (gen !== listGen) return;
  const filter = listFilter.history || 'all';
  const rows = officialHistoryList.filter((it) => {
    if (filter === 'done') return historyIsDone(it);
    if (filter === 'undone') return !historyIsDone(it);
    return true;
  });
  let html = listChipsHTML('history');
  if (!rows.length) {
    const empty = filter === 'done' ? '还没有看完的剧集' : filter === 'undone' ? '没有未看完的剧集' : '红果账号还没有观看记录';
    body.innerHTML = html + `<div class="list-empty">${empty}</div>`;
    return;
  }
  const shown = rows.slice(0, 120);
  html += shown.map(historyRowHTML).join('');
  if (rows.length > shown.length) html += `<div class="list-empty">仅显示最近 ${shown.length} 条（共 ${rows.length} 条）</div>`;
  body.innerHTML = html;
}

async function loadList(kind) {
  const gen = ++listGen;
  // 每次进入列表都重新拉取，保证点赞/收藏状态实时
  if (kind === 'fav') { officialRemoteFavs.length = 0; officialFavList.length = 0; }
  if (kind === 'likes') { officialRemoteLikes.length = 0; officialLikeList.length = 0; }
  if (kind === 'history') { officialHistoryList.length = 0; }
  const titles = { history: '历史', fav: '收藏', likes: '点赞', reserve: '预约' };
  $('list-title').textContent = titles[kind] || '';
  const body = $('list-body');
  if (kind === 'reserve') { body.innerHTML = '<div class="list-empty">暂无预约的剧集</div>'; return; }
  if (kind === 'history' && officialUser && officialUser.uid) {
    if (!officialHistoryList.length) {
      body.innerHTML = '<div class="list-empty">正在读取红果账号观看历史…</div>';
      try {
        const resp = await api({ action: 'hgUserHistory', page: 1 });
        const items = ((resp && (resp.items ? resp : resp.data)) || {}).items || [];
        const local = localHistoryEntries();
        const merged = items.map((it) => {
          const l = local.get(it.id);
          if (l && (l.updatedAt || 0) > (it.updatedAt || 0)) {
            it.progressIndex = l.progressIndex;
            it.updatedAt = l.updatedAt;
            it.position = l.position;
            if (l.vid) it.vid = l.vid;
            if (!it.title) it.title = l.title;
            if (!it.cover) it.cover = l.cover;
          }
          local.delete(it.id);
          return it;
        });
        local.forEach((l) => merged.push(l));
        merged.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
        officialHistoryList.length = 0;
        merged.forEach((it) => officialHistoryList.push(it));
      } catch (e) { /* ignore */ }
    }
    officialHistoryList.forEach((it) => officialHistory.set(it.id, it));
    renderOfficialHistory(body, gen);
    return;
  }
  if (kind === 'history') {
    const ids = historyIDs();
    if (!ids.length) { body.innerHTML = '<div class="list-empty">还没有观看记录</div>'; return; }
    const rows = ids.map((id) => {
      let drama = null;
      try { drama = JSON.parse(localStorage.getItem('hg:drama:' + id) || 'null'); } catch (e) { drama = null; }
      return drama ? { drama: drama, saved: loadProgress(id) } : null;
    }).filter(Boolean);
    body.innerHTML = rows.map((row) => {
      const drama = row.drama;
      const saved = row.saved;
      const src = coverURL(drama);
      const idx = saved ? saved.index : 0;
      const when = saved && saved.ts ? timeAgo(saved.ts) : '';
      const prog = saved
        ? `看到第 <b>${idx + 1}</b> 集 / 共 ${drama.episodes || '?'} 集 · ${fmtTime(saved.time || 0)}${when ? ' · ' + when : ''}`
        : '尚未开始';
      return `<div class="history-row" data-id="${escapeHTML(drama.id)}">
        ${src ? `<img class="history-cover" src="${escapeHTML(src)}" alt="">` : '<div class="history-cover"></div>'}
        <div class="history-info"><div class="history-title">${escapeHTML(drama.title || '')}</div>
        <div class="history-desc">${escapeHTML(drama.description || '暂无简介')}</div>
        <div class="history-progress">${prog}</div></div>
        <button class="history-continue" data-act="continue">继续播放</button></div>`;
    }).join('');
    return;
  }
  if (kind === 'fav' && officialUser && officialUser.uid) {
    await loadOfficialFavs(body, gen);
    return;
  }
  if (kind === 'likes' && officialUser && officialUser.uid) {
    await loadOfficialLikes(body, gen);
    return;
  }
  let items = [];
  try {
    if (currentUser) {
      const data = await apiJSON('/user/' + (kind === 'fav' ? 'favs' : 'likes'));
      items = data.items || [];
    } else {
      items = localList(kind === 'fav' ? 'hg:favs' : 'hg:likes');
    }
  } catch (e) { /* ignore */ }
  body.innerHTML = items.length
    ? `<div class="grid">${items.map(cardHTML).join('')}</div>`
    : `<div class="list-empty">还没有${titles[kind]}的剧集</div>`;
}

/* ---------- 红果账号数据（收藏 / 点赞） ---------- */
async function loadOfficialFavs(body, gen) {
  if (gen === undefined) gen = listGen;
  if (!officialRemoteFavs.length && !officialFavList.length) {
    if (gen !== listGen) return;
    body.innerHTML = '<div class="list-empty">正在读取红果账号收藏…</div>';
    try {
      const resp = await api({ action: 'hgUserFavorites', page: 1 });
      const items = ((resp && (resp.items ? resp : resp.data)) || {}).items || [];
      officialRemoteFavs.length = 0;
      items.forEach((it) => { officialRemoteFavs.push(it); officialDramas.set(it.id, it); });
    } catch (e) {
      if (gen === listGen) body.innerHTML = '<div class="list-empty">读取失败：' + escapeHTML(String((e && e.message) || e)) + '</div>';
      return;
    }
  }
  if (gen !== listGen) return;
  // 每次渲染都重新合并（本机收藏 + 移除标记），避免取消后仍显示
  const removed = new Set(loadJSON('hg:official-fav-removed', []));
  officialFavList.length = 0;
  officialRemoteFavs.forEach((it) => { if (!removed.has(it.id)) { officialFavList.push(it); officialDramas.set(it.id, it); } });
  loadJSON('hg:official-favs', []).forEach((it) => {
    if (!removed.has(it.id) && !officialFavList.some((x) => x.id === it.id)) { officialFavList.push(it); officialDramas.set(it.id, it); }
  });
  const filter = listFilter.fav || 'all';
  let html = listChipsHTML('fav');
  if (filter === 'folder') {
    html += await folderListHTML();
    if (gen === listGen) body.innerHTML = html;
    return;
  }
  const items = officialFavList.filter((it) => filter === 'all' || it.kind === filter);
  html += items.length
    ? `<div class="grid">${items.map(cardHTML).join('')}</div>`
    : `<div class="list-empty">${filter === 'all' ? '红果账号还没有收藏的剧集' : '没有该分类的收藏'}</div>`;
  if (gen === listGen) body.innerHTML = html;
}

async function folderListHTML() {
  if (officialFolderList === null) {
    try {
      const resp = await api({ action: 'hgUserFolders' });
      const data = (resp && (resp.folders ? resp : resp.data)) || {};
      officialFolderList = data.folders || [];
    } catch (e) { officialFolderList = []; }
  }
  if (!officialFolderList.length) return '<div class="list-empty">还没有创建收藏夹</div>';
  return officialFolderList.map((f) => `<div class="folder-row"><span class="folder-name">📁 ${escapeHTML(f.name || '')}</span><span class="folder-count">${escapeHTML(String(f.count || 0))} 部</span></div>`).join('');
}

async function loadOfficialLikes(body, gen) {
  if (gen === undefined) gen = listGen;
  if (!officialRemoteLikes.length && !officialLikeList.length) {
    if (gen !== listGen) return;
    body.innerHTML = '<div class="list-empty">正在读取红果账号点赞…</div>';
    try {
      const resp = await api({ action: 'hgUserLikes', page: 1 });
      const items = ((resp && (resp.items ? resp : resp.data)) || {}).items || [];
      officialRemoteLikes.length = 0;
      items.forEach((it) => { officialRemoteLikes.push(it); officialDramas.set(it.id, it); officialLikes.set(it.id, it); });
    } catch (e) {
      if (gen === listGen) body.innerHTML = '<div class="list-empty">读取失败：' + escapeHTML(String((e && e.message) || e)) + '</div>';
      return;
    }
  }
  if (gen !== listGen) return;
  const removed = new Set(loadJSON('hg:official-like-removed', []));
  officialLikeList.length = 0;
  officialRemoteLikes.forEach((it) => { if (!removed.has(it.id)) { officialLikeList.push(it); officialDramas.set(it.id, it); officialLikes.set(it.id, it); } });
  loadJSON('hg:official-likes', []).forEach((it) => {
    if (!removed.has(it.id) && !officialLikeList.some((x) => x.id === it.id)) { officialLikeList.push(it); officialDramas.set(it.id, it); officialLikes.set(it.id, it); }
  });
  const filter = listFilter.likes || 'all';
  const items = officialLikeList.filter((it) => filter === 'all' || it.kind === filter);
  let html = listChipsHTML('likes');
  html += items.length
    ? `<div class="grid">${items.map(cardHTML).join('')}</div>`
    : `<div class="list-empty">${filter === 'all' ? '红果账号还没有点赞的剧集' : '没有该分类的点赞'}</div>`;
  if (gen === listGen) body.innerHTML = html;
}

// playHistoryItem 直接播放条目记录的当前集（用 vid 走 App 取流，不用再查详情）。
async function playFromVid(item, opts = {}) {
  if (!item || !item.id) return;
  const drama = {
    id: item.id, source: SOURCE, title: item.title || '',
    episodes: Number(item.episodes) || 0, cover: item.cover || '',
    category: item.category || '', tags: item.tags || [],
  };
  officialDramas.set(drama.id, drama);
  suppressFeedAutoplayUntil = Date.now() + 4000;
  showView('recommend');
  $('p-loading').hidden = false;
  let chapters = [];
  try {
    const data = await api({ action: 'detail', source: SOURCE, drama });
    state.drama = Object.assign({}, drama, data.drama || {});
    chapters = data.chapters || [];
  } catch (e) {
    state.drama = drama;
  }
  state.chapters = chapters;
  const vid = item.vid ? String(item.vid) : '';
  let index = Math.max(0, Number(item.progressIndex) || 0);
  if (vid && chapters.length) {
    const found = chapters.findIndex((c) => String(c.videoUrl || '').indexOf(vid) >= 0 || String(c.id || '').indexOf(vid) >= 0);
    if (found >= 0) index = found;
  }
  if (!chapters.length) {
    const ep = (Number(item.progressIndex) || 0) + 1;
    state.chapters = [{ id: item.id + ':' + vid, source: SOURCE, title: '第 ' + ep + ' 集', videoUrl: 'hongguo-cenc://' + vid, currentEpisode: ep }];
    index = 0;
  } else {
    index = Math.min(index, chapters.length - 1);
  }
  feed.items = [state.drama]; feed.index = 0; feed.more = false;
  updateFeedHint();
  const startTime = item.position ? Math.max(0, Number(item.position) / 1000 - 2) : (opts.startTime || 0);
  await playEpisode(index, { startTime });
  // 播放开始后再悄悄把推荐流补回来（不自动起播），方便滚轮切换
  loadFeed(true, { noPlay: true }).then(() => {
    const at = feed.items.findIndex((d) => d.id === state.drama.id);
    if (at >= 0) { feed.index = at; updateFeedHint(); }
  }).catch(() => {});
}

function playHistoryItem(it) {
  return playFromVid(it);
}

function timeAgo(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' 小时前';
  return Math.round(h / 24) + ' 天前';
}

/* ---------- 追更 / 预约 ---------- */
const followState = { tab: 'follow', filter: '', follow: [], reserve: [] };

const FOLLOW_CHIPS = {
  follow: [{ value: 'all', label: '追更的剧' }, { value: 'updates', label: '更新提醒' }],
  reserve: [{ value: 'online', label: '已上线' }, { value: 'offline', label: '待上线' }],
};

function renderFollowChips() {
  const chips = FOLLOW_CHIPS[followState.tab] || [];
  const box = $('follow-filters');
  box.innerHTML = chips.map((c) => `<button class="chip${followState.filter === c.value ? ' active' : ''}" data-ffilter="${escapeHTML(c.value)}">${escapeHTML(c.label)}</button>`).join('');
}

async function loadFollowView(force) {
  const tab = followState.tab;
  if (!followState.filter) followState.filter = FOLLOW_CHIPS[tab][0].value;
  renderFollowChips();
  document.querySelectorAll('[data-ftab]').forEach((el) => el.classList.toggle('active', el.dataset.ftab === tab));
  const grid = $('follow-grid');
  const empty = $('follow-empty');
  if (tab === 'reserve') {
    if (!followState.reserve.length || force) {
      grid.innerHTML = '<div class="list-empty">正在读取预约…</div>';
      empty.hidden = true;
      try {
        const data = await api({ action: 'hgUserReservations', page: 1 });
        followState.reserve = (data.items || []).slice();
      } catch (e) {
        followState.reserve = [];
        grid.innerHTML = '<div class="list-empty">预约读取失败：' + escapeHTML(e.message || e) + '</div>';
        return;
      }
    }
    renderFollowGrid();
    return;
  }
  if (!followState.follow.length || force) {
    grid.innerHTML = '<div class="list-empty">正在读取追更…</div>';
    empty.hidden = true;
    try {
      const data = await api({ action: 'hgUserFollowUpdates' });
      followState.follow = (data.items || []).slice();
    } catch (e) {
      followState.follow = [];
      grid.innerHTML = '<div class="list-empty">追更读取失败：' + escapeHTML(e.message || e) + '</div>';
      return;
    }
  }
  renderFollowGrid();
}

function renderFollowGrid() {
  const grid = $('follow-grid');
  const empty = $('follow-empty');
  const tab = followState.tab;
  let items = tab === 'reserve' ? followState.reserve : followState.follow;
  if (tab === 'reserve') {
    const online = followState.filter === 'online';
    items = items.filter((it) => !!it.isOnline === online);
  } else if (followState.filter === 'updates') {
    items = items.filter((it) => (Number(it.updateCount) || 0) > 0);
  }
  if (!items.length) {
    grid.innerHTML = '';
    empty.hidden = false;
    empty.textContent = tab === 'reserve'
      ? (followState.filter === 'online' ? '暂无已上线的预约' : '暂无待上线的预约')
      : (followState.filter === 'updates' ? '暂无更新提醒' : '还没有追更的剧');
    return;
  }
  empty.hidden = true;
  grid.innerHTML = items.map((it) => followCardHTML(it, tab)).join('');
}

function followCardHTML(it, tab) {
  const src = coverURL(it);
  const cover = src ? `<img loading="lazy" src="${escapeHTML(src)}" alt="" onerror="this.remove()">` : '';
  let badge = '';
  if (tab === 'reserve') {
    badge = it.isOnline
      ? '<span class="follow-badge online">已上线</span>'
      : '<span class="follow-badge">待上线</span>';
  } else if (Number(it.updateCount) > 0) {
    badge = '<span class="follow-badge online">更新 ' + escapeHTML(String(it.updateCount)) + ' 集</span>';
  } else if (it.episodes) {
    badge = '<span class="card-badge">共' + escapeHTML(String(it.episodes)) + '集</span>';
  }
  const expect = tab === 'reserve' && !it.isOnline && it.expectText ? `<div class="follow-expect">${escapeHTML(it.expectText)}</div>` : '';
  return `<div class="card list-card" data-fid="${escapeHTML(it.id)}">
    <div class="cover-wrap">${cover}${badge}</div>
    <h3>${escapeHTML(it.title || '')}</h3>
    ${expect}
  </div>`;
}

function openFollowItem(id) {
  const tab = followState.tab;
  const it = (tab === 'reserve' ? followState.reserve : followState.follow).find((x) => x.id === id);
  if (!it) return;
  if (tab === 'reserve') {
    if (it.isOnline && it.vid) {
      playFromVid(it);
      return;
    }
    toast('该剧尚未上线，敬请期待');
    return;
  }
  openDetail(it, { play: false });
}

/* ---------- 通用卡片 ---------- */
function cardHTML(drama) {
  const src = coverURL(drama);
  const cover = src ? `<img loading="lazy" src="${escapeHTML(src)}" alt="" onerror="this.remove()">` : '';
  let eps = drama.episodes ? `<span class="card-badge">共${escapeHTML(String(drama.episodes))}集</span>` : '';
  if (drama.progressIndex && drama.episodes) {
    eps = `<span class="card-badge">第${escapeHTML(String(drama.progressIndex + 1))}集/共${escapeHTML(String(drama.episodes))}集</span>`;
  }
  const heat = drama.heat ? `<span class="badge">🔥 ${escapeHTML(fmtCount(drama.heat))}</span>` : '';
  const sub = [drama.category, drama.tags && drama.tags.length ? drama.tags[0] : ''].filter(Boolean).map(escapeHTML).join(' · ');
  return `<div class="card list-card" data-id="${escapeHTML(drama.id)}">
    <div class="cover-wrap">${cover}${heat}${eps}</div>
    <h3>${escapeHTML(drama.title || '')}</h3>
    <div class="sub">${sub}</div>
  </div>`;
}

/* ---------- 官方登录（扫码 / 短信） ---------- */
const officialDramas = new Map();
const officialHistory = new Map(); // 红果账号列表里解析出的剧集缓存
const official = { tab: 'qr', qrTimer: 0 };
let officialUser = null;
try { officialUser = JSON.parse(localStorage.getItem('hg:official') || 'null'); } catch (e) { officialUser = null; }
function saveOfficialUser(user) {
  officialUser = user || null;
  if (officialUser) localStorage.setItem('hg:official', JSON.stringify(officialUser));
  else localStorage.removeItem('hg:official');
  renderUser();
}

function setLoginTab(tab) {
  official.tab = tab;
  document.querySelectorAll('[data-login-tab]').forEach((el) => el.classList.toggle('active', el.dataset.loginTab === tab));
  $('pane-qr').hidden = tab !== 'qr';
  $('pane-sms').hidden = tab !== 'sms';
  if (tab === 'qr') startQRLogin();
}

function officialError(message) {
  const box = $('login-error');
  box.textContent = message;
  box.hidden = false;
}

let qrMode = 'web';

async function startQRLogin(mode) {
  if (mode) qrMode = mode;
  if (official.qrTimer) { clearInterval(official.qrTimer); official.qrTimer = 0; }
  const box = $('qr-box');
  box.classList.remove('ready');
  box.innerHTML = '<span class="qr-loading">二维码加载中…</span><i class="qr-logo"><img src="/assets/logo.png" alt=""></i>';
  try {
    const action = qrMode === 'fanqie' ? 'hgLoginFanqieQRStart' : 'hgLoginQRStart';
    const resp = await api({ action: action });
    const data = (resp && (resp.data || resp)) || {};
    const errCode = data.errorCode || data.error_code || 0;
    if (errCode) {
      box.innerHTML = '<span class="qr-loading">' + escapeHTML(data.description || '扫码登录暂未开放') + '</span><i class="qr-logo"><img src="/assets/logo.png" alt=""></i>';
      return;
    }
    const qr = data.qrcode || '';
    if (!qr) { box.innerHTML = '<span class="qr-loading">二维码数据异常</span><i class="qr-logo"><img src="/assets/logo.png" alt=""></i>'; return; }
    box.innerHTML = '<img alt="登录二维码" src="' + escapeHTML(qr) + '"><i class="qr-logo"><img src="/assets/logo.png" alt=""></i>';
    box.classList.add('ready');
    const tip = $('qr-tip');
    if (tip) tip.textContent = '用「红果短剧」App 的扫一扫扫描二维码，在手机上确认后即可登录';
    official.qrToken = data.token || '';
    startQRPoll(Number(data.expireTime) || 0);
  } catch (e) {
    $('qr-box').textContent = '加载失败';
    $('qr-tip').textContent = e.message;
  }
}

function startQRPoll(expireTime) {
  if (official.qrTimer) clearInterval(official.qrTimer);
  const token = official.qrToken;
  const deadline = expireTime ? expireTime * 1000 : Date.now() + 180000;
  official.qrTimer = setInterval(async () => {
    if (!official.qrToken || official.qrToken !== token) { clearInterval(official.qrTimer); official.qrTimer = 0; return; }
    if (Date.now() > deadline) {
      clearInterval(official.qrTimer); official.qrTimer = 0;
      toast('二维码已过期，请点击刷新二维码');
      return;
    }
    try {
      const action = qrMode === 'fanqie' ? 'hgLoginFanqieQRPoll' : 'hgLoginQRPoll';
      const resp = await api({ action: action, token: token });
      const data = (resp && (resp.data || resp)) || {};
      if (data.loggedIn) {
        clearInterval(official.qrTimer); official.qrTimer = 0;
        const name = data.name || '红果用户';
        saveSessionCookies(data.cookies || null);
        saveOfficialUser({ name: name, avatar: data.avatar || '', uid: data.uid || data.id || '' });
        $('login-modal').hidden = true;
        toast('已登录：' + name);
        return;
      }
      const status = String(data.status || '');
      if (/scan/i.test(status) && !/new/i.test(status)) $('qr-tip').textContent = '已扫码，请在手机上点击「确认登录」';
      else if (/new|init/i.test(status)) $('qr-tip').textContent = '请使用抖音 / 番茄小说 App 扫码，并在手机上确认';
    } catch (e) { /* 网络抖动继续轮询 */ }
  }, 2000);
}

function startCodeCountdown(btn, seconds) {
  let n = seconds || 60;
  btn.disabled = true;
  btn.textContent = n + 's 后重发';
  const timer = setInterval(() => {
    n -= 1;
    if (n <= 0) {
      clearInterval(timer);
      btn.disabled = false;
      btn.textContent = '发送验证码';
    } else {
      btn.textContent = n + 's 后重发';
    }
  }, 1000);
}

async function sendLoginCode() {
  const phone = ($('login-phone').value || '').trim();
  if (!/^1\d{10}$/.test(phone)) { officialError('请输入 11 位手机号'); return; }
  const btn = $('btn-send-code');
  btn.disabled = true;
  btn.textContent = '发送中…';
  try {
    const resp = await api({ action: 'hgLoginSendCode', phone: phone });
    const data = (resp && (resp.data || resp)) || {};
    const errCode = data.errorCode || data.error_code || 0;
    if (errCode) {
      let msg = data.description || ('发送失败 (错误码 ' + errCode + ')');
      if (errCode === 1105) msg = '红果要求先完成滑块安全验证，请稍后再试，或直接使用扫码登录';
      else if (errCode === 1205 || errCode === 1206) msg = '发送太频繁，请稍后再试';
      else if (errCode === 1001) msg = '该手机号已绑定到其他账号，请换一个号码，或先用该号码登录后再切换';
      else if (errCode === 1039) msg = '为保证账号安全，请使用手机验证码登录';
      officialError(msg);
      btn.disabled = false;
      btn.textContent = '发送验证码';
    } else {
      $('login-error').hidden = true;
      toast('验证码已发送，请查看短信');
      startCodeCountdown(btn, Number(data.retryTime || data.retry_time) || 60);
    }
  } catch (e) {
    officialError(e.message);
    btn.disabled = false;
    btn.textContent = '发送验证码';
  }
}

async function smsLogin() {
  const phone = ($('login-phone').value || '').trim();
  const code = ($('login-code').value || '').trim();
  if (!/^1\d{10}$/.test(phone)) { officialError('请输入 11 位手机号'); return; }
  if (!/^\d{4,6}$/.test(code)) { officialError('请输入验证码'); return; }
  const btn = $('btn-sms-login');
  btn.disabled = true;
  btn.textContent = '登录中…';
  try {
    const resp = await api({ action: 'hgLoginSMS', phone: phone, code: code });
    const data = (resp && (resp.data || resp)) || {};
    const errCode = data.errorCode || data.error_code || 0;
    if (errCode) {
      const known = {
        1105: '红果要求完成滑块安全验证，请改用扫码登录',
        1102: '验证码错误，请重新输入',
        1202: '验证码错误，请重新输入',
        1203: '验证码已过期或错误次数过多，请重新获取',
        1204: '手机号无效或已被限制，请检查号码',
        1205: '操作太频繁，请稍后再试',
        1206: '发送太频繁，请稍后再试',
        1045: '需要上行短信验证：请按手机短信提示发送短信后，再点一次登录',
        1039: '为保证账号安全，请使用手机验证码登录',
        3052: '请求参数错误，请重试',
      };
      officialError(known[errCode] || data.description || ('登录失败 (错误码 ' + errCode + ')'));
      return;
    }
    // 登录成功后拉取账号信息（红果 App 会话）
    const me = await api({ action: 'hgLoginUserInfo' });
    const info = (me && (me.data || me)) || {};
    const name = info.name || '红果用户';
    saveOfficialUser({ name: name, avatar: info.avatar || '', uid: info.id || info.uid || '' });
    $('login-modal').hidden = true;
    toast('已登录：' + name);
  } catch (e) {
    officialError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '登录';
  }
}

function bindFollowEvents() {
  $('follow-tabs').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-ftab]');
    if (!btn || btn.dataset.ftab === followState.tab) return;
    followState.tab = btn.dataset.ftab;
    followState.filter = FOLLOW_CHIPS[followState.tab][0].value;
    loadFollowView();
  });
  $('follow-filters').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-ffilter]');
    if (!chip) return;
    followState.filter = chip.dataset.ffilter;
    renderFollowChips();
    renderFollowGrid();
  });
  $('follow-grid').addEventListener('click', (event) => {
    const card = event.target.closest('.card[data-fid]');
    if (!card) return;
    openFollowItem(card.dataset.fid);
  });
}


function bindPlayerSwipe() {
  const stage = $('stage') || document.querySelector('.stage');
  if (!stage) return;
  let sx = 0, sy = 0, st = 0, moved = false, ignore = false;
  stage.addEventListener('touchstart', (e) => {
    ignore = !state.drama || $('player').hidden || state.view !== 'recommend';
    if (ignore) return;
    if (e.target.closest('#comment-drawer') || e.target.closest('.player-ctrls') || e.target.closest('#dm-panel') || e.target.closest('#ep-panel')) { ignore = true; return; }
    const t = e.touches[0]; sx = t.clientX; sy = t.clientY; st = Date.now(); moved = false;
  }, { passive: true });
  stage.addEventListener('touchmove', () => { moved = true; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (ignore || !state.drama || $('player').hidden || state.view !== 'recommend' || !moved) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 45) {
      if (dy < 0) {
        if (episodeMode) nextEpisode(); else feedStep(1);
      } else {
        if (episodeMode) prevEpisode(); else feedStep(-1);
      }
    }
  }, { passive: true });
}


function exitFullscreenIfAny() {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    try {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } catch (e) { /* 忽略 */ }
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) { /* 忽略 */ }
  }
}

async function toggleFullview() {
  const player = $('player');
  try {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) { /* 忽略 */ }
    }
    else {
      if (player.requestFullscreen) await player.requestFullscreen();
      else if (player.webkitRequestFullscreen) player.webkitRequestFullscreen();
      const v = $('video');
      const landscape = v && v.videoWidth > 0 && v.videoWidth >= v.videoHeight;
      if (landscape && screen.orientation && screen.orientation.lock) {
        try { await screen.orientation.lock('landscape'); } catch (e) { /* 忽略 */ }
      }
    }
  } catch (e) { toast('当前浏览器不支持全屏'); }
}

const settingsState = Object.assign({ quality: 0, sr: false, sharpen: 'mid', autoNext: true, direct: false },
  (() => { try { return JSON.parse(localStorage.getItem('hg:settings') || '{}'); } catch (e) { return {}; } })());

function saveSettings() {
  try { localStorage.setItem('hg:settings', JSON.stringify(settingsState)); } catch (e) { /* 忽略 */ }
}

// —— GPU 超分（WebGL2，实现在 sr.js）：重建放大 + CAS 锐化，全程 GPU ——
function ensureSrCanvas(show) {
  const box = document.querySelector('.player-video');
  if (!box) return null;
  let canvas = document.getElementById('p-sr');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'p-sr';
    const video = document.getElementById('video');
    if (video && video.parentNode === box) video.insertAdjacentElement('afterend', canvas);
    else box.appendChild(canvas);
  }
  canvas.style.display = show ? 'block' : 'none';
  return canvas;
}

function srSharpness() {
  if (settingsState.sharpen === 'strong') return 1.0;
  if (settingsState.sharpen === 'light') return 0.4;
  return 0.7;
}

function disablePictureEnhance() {
  if (window.HGSuperRes) window.HGSuperRes.disable();
  const canvas = document.getElementById('p-sr');
  if (canvas) canvas.style.display = 'none';
  const v = document.getElementById('video');
  if (v) { v.style.opacity = ''; v.style.filter = ''; }
}

function applyPictureEnhance() {
  const v = document.getElementById('video');
  if (!v) return;
  v.style.filter = ''; // 旧的 SVG 卷积滤镜走 CPU，已废弃
  if (!settingsState.sr) {
    window.__srForceMse = false;
    window.__srMseTried = false;
    disablePictureEnhance();
    return;
  }
  const canvas = ensureSrCanvas(true);
  if (!canvas || !window.HGSuperRes) return;
  clog('sr 开启 sharp=' + srSharpness());
  const ok = window.HGSuperRes.enable(v, canvas, {
    sharp: srSharpness(),
    onReady: function () {
      try { clog('sr 生效 ' + JSON.stringify(window.HGSuperRes.status())); } catch (e) { /* 忽略 */ }
    },
    onFail: function (reason) {
      try {
        const st = window.HGSuperRes ? window.HGSuperRes.status() : {};
        clog('sr 失败: ' + reason + ' ' + JSON.stringify(st));
      } catch (e) { /* 忽略 */ }
      // 第一次失败：自动切 H.264 转码路径重试（HEVC 硬件帧无法读回时，H.264 通常可以）
      if (!window.__srMseTried && state.chapters && state.chapters[state.index]) {
        window.__srMseTried = true;
        window.__srForceMse = true;
        disablePictureEnhance();
        const at = ($('video') && $('video').currentTime) || 0;
        clog('sr 回退：切 H.264 转码重试，at=' + at.toFixed(1));
        toast('HEVC 帧无法读取，已切 H.264 转码重试超分…', 2600);
        playEpisode(state.index, { startTime: at, quality: state.quality, keepTime: true });
        return;
      }
      // 第二次仍失败：彻底关闭
      settingsState.sr = false;
      saveSettings();
      const box = document.getElementById('st-sr');
      if (box) box.checked = false;
      disablePictureEnhance();
      toast('GPU 超分已自动关闭：' + reason);
    },
  });
  if (!ok) {
    disablePictureEnhance();
    if (!window.__srWarned) {
      window.__srWarned = true;
      const msg = (window.HGSuperRes && window.HGSuperRes.status().error) || '当前浏览器或显卡不支持 WebGL2';
      toast('GPU 超分不可用：' + msg);
    }
  }
}

function openSettings() {
  settingsState.autoNext = $('p-auto') ? $('p-auto').checked : settingsState.autoNext;
  const q = document.getElementById('st-quality');
  const sr = document.getElementById('st-sr');
  const sh = document.getElementById('st-sharpen');
  const au = document.getElementById('st-auto');
  if (q) q.value = String(settingsState.quality || 0);
  if (sr) sr.checked = !!settingsState.sr;
  if (sh) sh.value = settingsState.sharpen || 'mid';
  if (au) au.checked = !!settingsState.autoNext;
  const di = document.getElementById('st-direct');
  if (di) di.checked = !!settingsState.direct;
  const modal = document.getElementById('settings-modal');
  if (modal) modal.hidden = false;
}

function closeSettings() {
  const modal = document.getElementById('settings-modal');
  if (modal) modal.hidden = true;
}

function bindSettings() {
  const modal = document.getElementById('settings-modal');
  if (!modal) return;
  document.getElementById('st-close').addEventListener('click', closeSettings);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeSettings(); });
  document.getElementById('st-quality').addEventListener('change', (e) => { settingsState.quality = Number(e.target.value) || 0; saveSettings(); });
  document.getElementById('st-sr').addEventListener('change', (e) => { settingsState.sr = e.target.checked; saveSettings(); applyPictureEnhance(); });
  document.getElementById('st-sharpen').addEventListener('change', (e) => { settingsState.sharpen = e.target.value; saveSettings(); applyPictureEnhance(); });
  document.getElementById('st-auto').addEventListener('change', (e) => { settingsState.autoNext = e.target.checked; saveSettings(); if ($('p-auto')) $('p-auto').checked = e.target.checked; });
  const directEl = document.getElementById('st-direct');
  if (directEl) directEl.addEventListener('change', (e) => { settingsState.direct = e.target.checked; saveSettings(); toast(e.target.checked ? '直连播放已开启（下一集生效）' : '已切回宿主机中转'); });
  if ($('p-auto')) {
    $('p-auto').addEventListener('change', (e) => { settingsState.autoNext = e.target.checked; saveSettings(); });
  }
  applyPictureEnhance();
}

function bindPictureInPictureHooks() {
  const v = document.getElementById('video');
  if (!v || v.__srPipBound) return;
  v.__srPipBound = true;
  // 浏览器画中画窗口渲染的是原始 <video>，超分画布不会跟着走；
  // 进入画中画时暂停超分，退出后恢复，避免「两个画面、一个锐一个不锐」。
  v.addEventListener('enterpictureinpicture', function () {
    if (settingsState.sr) {
      window.__srPipPaused = true;
      disablePictureEnhance();
      toast('画中画模式已暂停 GPU 超分', 2200);
    }
  });
  v.addEventListener('leavepictureinpicture', function () {
    if (window.__srPipPaused) {
      window.__srPipPaused = false;
      applyPictureEnhance();
    }
  });
}

function bindViewEvents() {
  const fullview = $('p-fullview');
  if (fullview) fullview.addEventListener('click', toggleFullview);
  const menuBtn = $('btn-menu');
  const backdrop = $('nav-backdrop');
  if (menuBtn) menuBtn.addEventListener('click', () => {
    const app = document.querySelector('.app');
    const sb = document.querySelector('.sidebar');
    const opened = app.classList.toggle('nav-open');
    if (backdrop) backdrop.hidden = !opened;
    if (sb) sb.style.cssText = opened
      ? 'display:flex;flex-direction:column;position:fixed;left:0;top:0;bottom:0;width:236px;z-index:60;transform:none;'
      : '';
  });
  if (backdrop) backdrop.addEventListener('click', () => {
    document.querySelector('.app').classList.remove('nav-open');
    const sb2 = document.querySelector('.sidebar'); if (sb2) sb2.style.cssText = '';
    backdrop.hidden = true;
  });
  const sideNav = document.querySelector('.side-nav');
  if (sideNav) sideNav.addEventListener('click', (e) => {
    if (e.target.closest('.side-item')) { document.querySelector('.app').classList.remove('nav-open'); const sb3 = document.querySelector('.sidebar'); if (sb3) sb3.style.cssText = ''; const bd = $('nav-backdrop'); if (bd) bd.hidden = true; }
  });
  const sideToggle = $('btn-side-toggle');
  if (sideToggle) sideToggle.addEventListener('click', toggleSidebar);
  applySidebar();
  bindScrollLoad();
  const stage = $('view-recommend');
  let wheelLock = 0;
  stage.addEventListener('wheel', (event) => {
    if ($('view-recommend').hidden) return;
    const cdrawer = $('comment-drawer');
    if (cdrawer && !cdrawer.hidden && cdrawer.contains(event.target)) return;
    const now = Date.now();
    if (now - wheelLock < 700) return;
    if (Math.abs(event.deltaY) < 8) return;
    wheelLock = now;
    // 推荐页滚轮：浏览模式(feed)=切下一部剧；集数模式(episode)=切下一集。
    if (state.drama && !$('player').hidden && episodeMode) {
      if (feed.busy || !(state.chapters || []).length) return; // 正在加载本剧详情/起播，忽略滚轮
      if (event.deltaY > 0) nextEpisode(); else prevEpisode();
      return;
    }
    feedStep(event.deltaY > 0 ? 1 : -1);
  }, { passive: true });

  $('boards').addEventListener('click', (event) => {
    const item = event.target.closest('[data-board]');
    if (item) loadRankRows(item.dataset.board);
  });
  $('rank-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-board]');
    if (tab) loadRankRows(tab.dataset.board);
  });
  $('rank-list').addEventListener('click', async (event) => {
    const row = event.target.closest('.rank-row');
    if (!row) return;
    const item = rankState.items.find((r) => (r.drama || {}).id === row.dataset.id);
    if (!item) return;
    const drama = item.drama;
    const act = event.target.closest('[data-act]');
    if (act && act.dataset.act === 'detail') { showView('search'); openDetail(drama); return; }
    showView('recommend');

    feed.items = [drama]; feed.index = 0; feed.more = false;
    updateFeedHint();
    await openDetail(drama, { play: true });
  });

  $('new-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-newtab]');
    if (!tab) return;
    newState.tab = tab.dataset.newtab;
    document.querySelectorAll('.new-tab').forEach((el) => el.classList.toggle('active', el === tab));
    if (newState.tab === 'cal' && !newState.calLoaded) ensureCalendar(true);
    else renderNewGrid();
  });
  $('new-filters').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-gender]');
    if (!chip) return;
    newState.gender = chip.dataset.gender;
    document.querySelectorAll('#new-filters .chip').forEach((el) => el.classList.toggle('active', el === chip));
    loadNewItems(true);
  });
  $('new-grid').addEventListener('click', (event) => {
    const sub = event.target.closest('.cal-sub');
    if (sub) {
      const row = sub.closest('.cal-row');
      const item = row && newState.calItems.find((it) => it.id === row.dataset.id);
      if (item && item.online) { openDetail(item, { play: true }); }
      else { toast('预约功能开发中，请到红果 App 内预约'); }
      return;
    }
    const row = event.target.closest('.cal-row');
    if (row) {
      const item = newState.calItems.find((it) => it.id === row.dataset.id);
      if (item) openDetail(item, { play: !!item.online });
      return;
    }
    const card = event.target.closest('.card');
    if (!card) return;
    const drama = newState.items.find((d) => d.id === card.dataset.id);
    if (drama) openDetail(drama);
  });
  $('new-dates').addEventListener('click', (event) => {
    const item = event.target.closest('[data-date]');
    if (!item || item.dataset.date === newState.calDate) return;
    newState.calDate = item.dataset.date;
    ensureCalendar(true);
  });

  $('list-body').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip[data-filter-kind]');
    if (chip) {
      const kind = chip.dataset.filterKind;
      listFilter[kind] = chip.dataset.filterValue;
      const body = $('list-body');
      if (kind === 'history') renderOfficialHistory(body);
      else if (kind === 'fav') loadOfficialFavs(body);
      else if (kind === 'likes') loadOfficialLikes(body);
      return;
    }
    const row = event.target.closest('[data-id]');
    if (!row) return;
    const id = row.dataset.id;
    const like = officialLikes.get(id);
    if (like && like.vid) { playHistoryItem(like); return; }
    const hist = officialHistory.get(id);
    if (hist && hist.vid) { playHistoryItem(hist); return; }
    let drama = null;
    try { drama = JSON.parse(localStorage.getItem('hg:drama:' + id) || 'null'); } catch (e) { drama = null; }
    if (!drama) drama = officialDramas.get(id) || null;
    if (!drama) return;
    const saved = loadProgress(drama.id);
    showView('recommend');
    feed.items = [drama]; feed.index = 0; feed.more = false;
    updateFeedHint();
    openDetail(drama, { play: true, startTime: saved ? saved.time : 0 });
  });

  document.querySelectorAll('[data-login-tab]').forEach((el) => {
    el.addEventListener('click', () => setLoginTab(el.dataset.loginTab));
  });
  $('qr-refresh').addEventListener('click', () => startQRLogin());
  const fanqieBtn = $('qr-fanqie');
  if (fanqieBtn) fanqieBtn.addEventListener('click', () => { qrMode = 'fanqie'; $('qr-tip').textContent = '用抖音 / 番茄小说 App 扫码（竞品同款番茄码）'; startQRLogin('fanqie'); });
  $('btn-send-code').addEventListener('click', sendLoginCode);
  $('btn-sms-login').addEventListener('click', smsLogin);
  $('btn-local-toggle').addEventListener('click', () => {
    const form = $('login-form');
    form.hidden = !form.hidden;
    $('btn-local-toggle').textContent = form.hidden ? '使用本机账号' : '收起本机账号';
  });
  const filterToggle = () => {
    const btn = $('filter-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => { searchState.expanded = !searchState.expanded; renderTagFilters(); });
  };
  document.addEventListener('click', (event) => {
    if (event.target && event.target.id === 'filter-toggle') filterToggle();
  });
}

/* ---------- 侧栏收起 / 滚动加载更多 ---------- */
const sidebarState = { collapsed: localStorage.getItem('hg:sidebar') === '1' };

function applySidebar() {
  document.querySelector('.app').classList.toggle('collapsed', sidebarState.collapsed);
  const btn = $('btn-side-toggle');
  if (btn) btn.textContent = sidebarState.collapsed ? '»' : '«';
}

function toggleSidebar() {
  sidebarState.collapsed = !sidebarState.collapsed;
  localStorage.setItem('hg:sidebar', sidebarState.collapsed ? '1' : '0');
  applySidebar();
}

// 视图内部滚动容器（找剧/新剧/历史等）滚动到底部时自动加载下一页。
function maybeLoadMore() {
  const vs = $('view-search');
  if (!vs || vs.hidden) return;
  if (state.loading || !state.hasMore) return;
  if (vs.scrollHeight - vs.scrollTop - vs.clientHeight > 600) return;
  if (state.renderLimit < visibleItems().length) {
    state.renderLimit += 60;
    renderGrid();
    return;
  }
  state.page += 1;
  loadCatalog();
}

function maybeLoadNewMore() {
  const vn = $('view-new');
  if (!vn || vn.hidden) return;
  if (newState.tab !== 'rec' || newState.loading || !newState.hasMore) return;
  if (vn.scrollHeight - vn.scrollTop - vn.clientHeight > 500) return;
  loadNewItems(false);
}

function bindScrollLoad() {
  document.addEventListener('scroll', (event) => {
    const el = event.target;
    if (!el || !el.id) return;
    if (el.id === 'view-search') maybeLoadMore();
    else if (el.id === 'view-new') maybeLoadNewMore();
  }, true);
  const vn = $('view-new');
  if (vn) vn.addEventListener('scroll', maybeLoadNewMore, { passive: true });
  const vs = $('view-search');
  if (vs) vs.addEventListener('scroll', maybeLoadMore, { passive: true });
  // 兜底：视图可见时定时检查（覆盖键盘/触摸/布局异常等收不到 scroll 的情况）
  setInterval(() => {
    if ($('view-search') && !$('view-search').hidden) maybeLoadMore();
    if ($('view-new') && !$('view-new').hidden) maybeLoadNewMore();
  }, 900);
  // 兜底：底部按钮进入视口也触发
  if (window.IntersectionObserver) {
    const more = $('more');
    if (more) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => { if (entry.isIntersecting) maybeLoadMore(); });
      }, { rootMargin: '600px' });
      io.observe(more);
    }
  }
}

/* ---------------- 搜索候选 / 搜索历史 ---------------- */
const SEARCH_HISTORY_KEY = 'hg:searchHistory';
let searchHistory = [];
try {
  const raw = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]');
  if (Array.isArray(raw)) searchHistory = raw.filter((x) => typeof x === 'string').slice(0, 10);
} catch (e) { searchHistory = []; }
let searchPopItems = [];
let searchPopIndex = -1;
let searchPopKind = '';
let suggestTimer = 0;
let suggestSeq = 0;

function saveSearchHistory() {
  try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(searchHistory.slice(0, 10))); } catch (e) { /* ignore */ }
}

function pushSearchHistory(term) {
  const q = String(term || '').trim();
  if (!q) return;
  searchHistory = [q].concat(searchHistory.filter((x) => x !== q)).slice(0, 10);
  saveSearchHistory();
}

function closeSearchPop() {
  const pop = $('search-pop');
  if (pop) { pop.hidden = true; pop.innerHTML = ''; }
  searchPopItems = [];
  searchPopIndex = -1;
  searchPopKind = '';
}

function searchHighlight(text) {
  const q = ($('search-input').value || '').trim();
  if (!q) return escapeHTML(text);
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return escapeHTML(text);
  return escapeHTML(text.slice(0, idx)) + '<em>' + escapeHTML(text.slice(idx, idx + q.length)) + '</em>' + escapeHTML(text.slice(idx + q.length));
}

function searchItemHTML(text, index, icon, highlight) {
  return '<button type="button" class="sp-item" data-sp-index="' + index + '">' +
    '<span class="sp-ico">' + icon + '</span>' +
    '<span class="sp-text">' + (highlight ? searchHighlight(text) : escapeHTML(text)) + '</span>' +
    '</button>';
}

function renderSearchPop(kind, items) {
  const pop = $('search-pop');
  if (!pop) return;
  searchPopKind = kind;
  searchPopItems = (items || []).slice();
  searchPopIndex = -1;
  if (kind === 'history' && !searchPopItems.length) {
    pop.hidden = true;
    pop.innerHTML = '';
    return;
  }
  let html = '';
  if (kind === 'history') {
    html += '<div class="sp-head"><span>搜索历史</span><button type="button" class="sp-clear" data-sp-clear="1">清空</button></div>';
    searchPopItems.forEach((t, i) => { html += searchItemHTML(t, i, '🕘', false); });
  } else {
    html += '<div class="sp-head"><span>猜你想搜</span></div>';
    if (!searchPopItems.length) html += '<div class="sp-empty">没有找到相关搜索</div>';
    searchPopItems.forEach((t, i) => { html += searchItemHTML(t, i, '🔍', true); });
  }
  pop.innerHTML = html;
  pop.hidden = false;
}

function fetchSearchSuggest(query) {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(() => {
    const seq = ++suggestSeq;
    api({ action: 'suggestions', query }).then((data) => {
      if (seq !== suggestSeq) return;
      if (($('search-input').value || '').trim() !== query) return;
      const items = (data && data.items) || [];
      renderSearchPop('suggest', items.slice(0, 12));
    }).catch(() => {
      if (seq === suggestSeq) renderSearchPop('suggest', []);
    });
  }, 180);
}

function refreshSearchPop() {
  const q = ($('search-input').value || '').trim();
  if (!q) renderSearchPop('history', searchHistory);
  else fetchSearchSuggest(q);
}

function chooseSearchTerm(term) {
  const q = String(term || '').trim();
  if (!q) return;
  pushSearchHistory(q);
  $('search-input').value = q;
  closeSearchPop();
  state.query = q;
  loadCatalog({ reset: true });
}

function moveSearchPop(delta) {
  const pop = $('search-pop');
  if (!pop) return;
  const items = pop.querySelectorAll('.sp-item');
  if (!items.length) return;
  searchPopIndex = (searchPopIndex + delta + items.length) % items.length;
  items.forEach((el, i) => el.classList.toggle('active', i === searchPopIndex));
  const active = items[searchPopIndex];
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
}

function bindSearchPop() {
  const input = $('search-input');
  const pop = $('search-pop');
  if (!input || !pop) return;
  input.addEventListener('focus', () => { refreshSearchPop(); });
  input.addEventListener('input', () => {
    const q = (input.value || '').trim();
    if (!q) renderSearchPop('history', searchHistory);
    else fetchSearchSuggest(q);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeSearchPop(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!pop.hidden && searchPopItems.length) {
        event.preventDefault();
        moveSearchPop(event.key === 'ArrowDown' ? 1 : -1);
      }
    } else if (event.key === 'Enter') {
      if (!pop.hidden && searchPopIndex >= 0 && searchPopItems[searchPopIndex]) {
        event.preventDefault();
        chooseSearchTerm(searchPopItems[searchPopIndex]);
      }
    }
  });
  pop.addEventListener('mousedown', (event) => { event.preventDefault(); });
  pop.addEventListener('click', (event) => {
    if (event.target.closest('[data-sp-clear]')) {
      searchHistory = [];
      saveSearchHistory();
      closeSearchPop();
      return;
    }
    const item = event.target.closest('.sp-item');
    if (!item) return;
    const term = searchPopItems[Number(item.dataset.spIndex)];
    if (term) chooseSearchTerm(term);
  });
  document.addEventListener('click', (event) => {
    if (pop.hidden) return;
    if (event.target.closest('#search-form')) return;
    closeSearchPop();
  });
}

function bindEvents() {
  $('search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const term = $('search-input').value.trim();
    pushSearchHistory(term);
    closeSearchPop();
    state.query = term;
    loadCatalog({ reset: true });
  });

  $('reset-search').addEventListener('click', () => {
    state.query = '';
    $('search-input').value = '';
    loadCatalog({ reset: true });
    renderChips();
  });

  $('filter-rows').addEventListener('click', (event) => {
    const more = event.target.closest('[data-row-more]');
    if (more) {
      const name = more.dataset.rowMore;
      state.filterExpanded[name] = !state.filterExpanded[name];
      renderFilterRows();
      return;
    }
    const sortChip = event.target.closest('[data-sort]');
    if (sortChip) {
      state.sort = sortChip.dataset.sort || '';
      renderFilterRows();
      renderGrid();
      return;
    }
    const statusChip = event.target.closest('[data-status]');
    if (statusChip) {
      state.status = statusChip.dataset.status || '';
      renderFilterRows();
      renderGrid();
      return;
    }
    const chip = event.target.closest('.chip');
    if (!chip || !chip.hasAttribute('data-cat')) return;
    state.query = '';
    $('search-input').value = '';
    state.category = chip.dataset.cat || '';
    state.tagRow = chip.dataset.row || '';
    renderChips();
    loadCatalog({ reset: true });
  });

  $('filter-expand').addEventListener('click', () => {
    state.filterOpen = !state.filterOpen;
    renderFilterSummary();
  });

  $('chips').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    state.query = '';
    $('search-input').value = '';
    state.category = chip.dataset.cat || '';
    state.tagRow = 'genre';
    renderChips();
    loadCatalog({ reset: true });
  });

  $('grid').addEventListener('click', (event) => {
    const card = event.target.closest('.card');
    clog('点击卡片: ' + (card ? card.dataset.id : '非卡片区域'));
    if (!card) return;
    const drama = findDrama(card.dataset.id);
    clog('卡片匹配: ' + (drama ? drama.title : '未找到'));
    if (!drama) return;
    const act = event.target.closest('.card-act');
    if (act && act.dataset.act === 'home') {
      openDetail(drama);
      return;
    }
    openDetail(drama, { play: true });
  });

  const newMoreBtn = $('new-more-btn');
  if (newMoreBtn) newMoreBtn.addEventListener('click', () => loadNewItems(false));

  $('more').addEventListener('click', () => {
    const total = visibleItems().length;
    if (state.renderLimit < total) {
      state.renderLimit += 60;
      renderGrid();
      return;
    }
    state.page += 1;
    loadCatalog();
  });

  $('dv-back').addEventListener('click', () => closeDetailView());

  $('cv-back').addEventListener('click', () => closeCreator());
  $('cv-follow').addEventListener('click', () => toast('关注功能开发中，敬请期待'));
  $('cv-works').addEventListener('click', (event) => {
    const card = event.target.closest('.card');
    if (!card) return;
    const work = creatorState.works.find((it) => it.id === card.dataset.id);
    if (work) { openDetail(work, { play: false }); return; }
    if (creatorState.drama) openDetail(creatorState.drama, { play: false });
  });
  const cvMore = $('cv-more');
  if (cvMore) cvMore.addEventListener('click', () => loadCreatorWorks(true));

  const creatorsBox = $('dv-creators');
  if (creatorsBox) creatorsBox.addEventListener('click', (event) => {
    const card = event.target.closest('.creator');
    if (card && !event.target.closest('.c-follow')) {
      const list = (state.drama && state.drama.celebrities) || [];
      const c = list[Number(card.dataset.idx) || 0];
      if (c) { openCreator(c, 'detail'); return; }
    }
    const btn = event.target.closest('.c-follow');
    if (!btn) return;
    if (btn.classList.contains('on')) { btn.classList.remove('on'); btn.textContent = '+ 关注'; }
    else { btn.classList.add('on'); btn.textContent = '已关注'; toast('已关注 ' + (btn.closest('.creator').querySelector('.c-name').textContent || '')); }
  });

  $('d-chapters').addEventListener('click', (event) => {
    const button = event.target.closest('.ep-num');
    if (!button) return;
    const index = Number(button.dataset.index);
    const saved = state.drama ? loadProgress(state.drama.id) : null;
    const startTime = saved && saved.index === index ? saved.time || 0 : 0;
    if (state.view !== 'recommend') playerOrigin = 'detail';
    showView('recommend');
    playEpisode(index, { startTime });
  });

  $('dv-play').addEventListener('click', (event) => {
    const index = Number(event.currentTarget.dataset.index || 0);
    clog('点击开始播放 index=' + index + ' chapters=' + state.chapters.length);
    const saved = state.drama ? loadProgress(state.drama.id) : null;
    const startTime = saved && saved.index === index ? saved.time || 0 : 0;
    if (state.view !== 'recommend') playerOrigin = 'detail';
    showView('recommend');
    playEpisode(index, { startTime });
  });

  $('dv-fav').addEventListener('click', async () => {
    if (!state.drama) return;
    const on = isFaved(state.drama.id);
    const ok = await remoteSetFavorite(!on);
    const nowOn = isFaved(state.drama.id);
    $('dv-fav').textContent = (nowOn ? '★' : '☆') + ' 收藏';
    toast(!ok ? '收藏失败（已存本机）' : (nowOn ? '已收藏' : '已取消收藏'));
  });

  $('dv-like').addEventListener('click', () => {
    if (!state.drama) return;
    toggleUserList('like', state.drama);
    setTimeout(() => { const on = (state.likes || []).some((d) => d.id === state.drama.id); $('dv-like').textContent = (on ? '♥' : '♡') + ' 点赞'; }, 60);
  });

  $('dv-follow').addEventListener('click', () => toast('追更功能开发中，请到红果 App 内追更'));
  $('dv-download').addEventListener('click', () => toast('下载功能开发中，请到红果 App 内下载'));

  $('dv-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-dvtab]');
    if (tab) switchDetailTab(tab.dataset.dvtab);
  });

  $('dv-related').addEventListener('click', (event) => {
    const card = event.target.closest('.card');
    if (!card) return;
    const drama = detailRelated.find((d) => d.id === card.dataset.id);
    if (drama) openDetail(drama);
  });

  $('p-back').addEventListener('click', () => { closePlayer(); });
  $('p-close').addEventListener('click', closePlayer);
  $('p-prev').addEventListener('click', prevEpisode);
  $('p-next').addEventListener('click', nextEpisode);
  $('p-fallback').addEventListener('click', fallback);
  $('p-dm').addEventListener('click', function () {
    const panel = $('dm-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { $('ep-panel').hidden = true; dmSyncSettings(); }
  });
  $('dm-on').addEventListener('change', function (e) {
    dm.on = e.target.checked;
    dmSave();
    document.addEventListener('visibilitychange', function () {
  if (document.hidden) pausePlaybackForNav('hidden');
});

bindPictureInPictureHooks();
dmApplyStyle();
    if (dm.on) dmLoad(playerState.token);
    else { dmItems = []; dmIndex = 0; dmClear(); }
  });
  $('dm-opacity').addEventListener('input', function (e) { dm.opacity = Number(e.target.value); dmSave(); dmApplyStyle(); });
  $('dm-size').addEventListener('input', function (e) { dm.size = Number(e.target.value); dmSave(); });
  $('dm-speed').addEventListener('input', function (e) { dm.speed = Number(e.target.value); dmSave(); });
  $('dm-area').addEventListener('change', function (e) { dm.area = e.target.value; dmSave(); dmApplyStyle(); });
  setInterval(dmTick, 200);
  $('p-play').addEventListener('click', togglePlay);
  $('p-mute').addEventListener('click', toggleMute);
  $('p-full').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', function () { showControls(true); });
  document.addEventListener('webkitfullscreenchange', function () { showControls(true); });
  $('p-ctrls').addEventListener('pointerdown', function () { showControls(true); });
  $('player').addEventListener('pointermove', function (e) { if (!e.pointerType || e.pointerType === 'mouse') showControls(false); });
  $('player').addEventListener('click', function () { if (state.view === 'recommend' && !$('player').hidden) showControls(false); });
  startControlsWatcher();
  $('player').addEventListener('pointerdown', function (e) { if (!e.pointerType || e.pointerType === 'mouse') showControls(true); });

  const seek = $('p-seek');
  seek.addEventListener('pointerdown', function () { seekDragging = true; });
  seek.addEventListener('input', function () {
    const video = $('video');
    if (!isFinite(video.duration) || video.duration <= 0) return;
    $('p-time').textContent = fmtTime((Number(seek.value) / 1000) * video.duration);
  });
  seek.addEventListener('change', function () {
    const video = $('video');
    seekDragging = false;
    if (!isFinite(video.duration) || video.duration <= 0) return;
    seekTo((Number(seek.value) / 1000) * video.duration);
  });
  window.addEventListener('pointerup', function () { seekDragging = false; volDragging = false; });

  const vol = $('p-vol');
  vol.addEventListener('pointerdown', function () { volDragging = true; });
  vol.addEventListener('input', function () {
    const video = $('video');
    const pct = Number(vol.value);
    video.volume = pct / 100;
    if (pct > 0 && video.muted) video.muted = false;
    $('p-vol-label').textContent = pct + '%';
    $('p-mute').classList.toggle('muted', pct === 0);
    showControls(true);
  });
  vol.addEventListener('change', function () { volDragging = false; });

  $('p-quality').addEventListener('change', (event) => {
    const quality = Number(event.target.value) || 0;
    playEpisode(state.index, { quality, keepTime: true });
  });

  /* ---- 新版界面：选集面板 / 倍速 / 简介展开 / 右侧互动 / 顶部 tab / 侧栏 ---- */

  $('p-episodes').addEventListener('click', () => {
    const panel = $('ep-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      $('dm-panel').hidden = true;
      epState.tab = 'ep';
      epState.rangeUser = null;
      renderPlayerChapters();
    }
  });
  $('ep-close').addEventListener('click', () => { $('ep-panel').hidden = true; });

  const savedSpeed = localStorage.getItem('hg:speed');
  if (savedSpeed) $('p-speed').value = savedSpeed;
  $('p-speed').addEventListener('change', () => {
    localStorage.setItem('hg:speed', $('p-speed').value);
    applySpeed();
    showControls(true);
  });

  $('p-expand').addEventListener('click', () => {
    const meta = $('p-meta');
    meta.classList.toggle('open');
    $('p-expand').textContent = meta.classList.contains('open') ? '收起' : '展开';
  });

  function ensureCommentDrawer() {
    let box = document.getElementById('comment-drawer');
    if (box) return box;
    box = document.createElement('div');
    box.id = 'comment-drawer';
    box.className = 'comment-drawer';
    box.hidden = true;
    box.innerHTML = '<div class="cm-head"><b id="cm-title">评论</b><button type="button" class="cm-close" id="cm-close">关闭</button></div><div class="cm-list" id="cm-list"></div>';
    document.querySelector('#player .player-video').appendChild(box);
    box.querySelector('#cm-close').addEventListener('click', () => { box.hidden = true; });
    return box;
  }

  async function openCommentsDrawer() {
    if (!state.drama) return;
    const box = ensureCommentDrawer();
    box.hidden = false;
    const list = box.querySelector('#cm-list');
    list.innerHTML = '<div class="list-empty">加载中…</div>';
    const sid = String(state.drama.id || '').replace(/^hongguo:/, '');
    const chapter = (state.chapters || [])[state.index] || {};
    const vid = String(chapter.videoUrl || '').replace('hongguo-cenc://', '');
    if (!sid || !vid || !/^[0-9]+$/.test(vid)) { list.innerHTML = '<div class="list-empty">该集暂无评论</div>'; return; }
    try {
      const data = await loadComments(sid, vid);
      box.querySelector('#cm-title').textContent = '评论 · ' + fmtCount(data.total || 0);
      const items = data.items || [];
      if (!items.length) { list.innerHTML = '<div class="list-empty">该集暂无评论</div>'; return; }
      list.innerHTML = items.map(function (it) {
        const t = it.time ? timeAgo(it.time * 1000) : '';
        const avatar = it.avatar ? '<img class="cm-avatar" src="' + it.avatar.replace(/"/g, '') + '" alt="" loading="lazy">' : '<span class="cm-avatar"></span>';
        const digg = it.digg ? '♥ ' + fmtCount(it.digg) : '';
        return '<div class="cm-item cm-review">' + avatar +
          '<div class="cm-main"><div class="cm-user">' + escapeHTML(it.user || '') +
          (t ? '<span class="cm-sub">' + escapeHTML(t) + '</span>' : '') + '</div>' +
          '<div class="cm-text">' + dmRichHTML(String(it.text || '').replace(/[\uFFFC\u200B]/g, '')) + '</div>' +
          (digg ? '<div class="cm-meta">' + digg + '</div>' : '') + '</div></div>';
      }).join('');
    } catch (err) {
      list.innerHTML = '<div class="list-empty">评论加载失败</div>';
      clog('comments load failed: ' + err.message);
    }
  }

  const tagHandler = (event) => {
    const el = event.target.closest('[data-tag]');
    if (el) openTagBrowse(el.getAttribute('data-tag'));
  };
  $('p-tags').addEventListener('click', tagHandler);
  const dvTags = $('dv-tags');
  if (dvTags) dvTags.addEventListener('click', tagHandler);

  $('p-author').addEventListener('click', () => {
    if (!state.drama) return;
    pausePlaybackForNav('open-detail');
    openDetail(state.drama);
  });

  $('r-like').addEventListener('click', async () => {
    if (!state.drama) return;
    const chapter = (state.chapters || [])[state.index] || null;
    const videoID = chapter && String(chapter.videoUrl || '').replace('hongguo-cenc://', '');
    const liked = $('r-like').classList.contains('liked');
    if (videoID && /^\d+$/.test(videoID)) {
      try {
        const res = await api({ action: 'hgDigg', session: videoID, force: !liked });
        if (res && res.ok) {
          $('r-like').classList.toggle('liked', !liked);
          setVidLiked(videoID, !liked);
          if (!liked && state.drama) likeIndex.add(state.drama.id);
          toast(liked ? '已取消点赞' : '已点赞');
          return;
        }
        toast((res && res.message) || '点赞失败');
        return;
      } catch (err) { /* 回退到本地记录 */ }
    }
    const added = await toggleUserList('likes', state.drama);
    setVidLiked(videoID, added);
    $('r-like').classList.toggle('liked', added);
    toast(added ? '已点赞' : '已取消点赞');
  });
  $('r-fav').addEventListener('click', async () => {
    if (!state.drama) return;
    const on = isFaved(state.drama.id);
    const ok = await remoteSetFavorite(!on);
    const nowOn = isFaved(state.drama.id);
    $('r-fav').classList.toggle('liked', nowOn);
    toast(!ok ? '收藏失败（已存本机）' : (nowOn ? '已收藏' : '已取消收藏'));
  });
  $('r-comment').addEventListener('click', openCommentsDrawer);
  [['r-share', '分享链接功能暂未开放'], ['r-download', '下载功能请在红果 App 内使用'],
   ['r-dislike', '已记录不感兴趣（本机）']].forEach(([id, message]) => {
    $(id).addEventListener('click', () => toast(message));
  });

  /* ---- 账号：登录/注册/退出 ---- */
  $('btn-login').addEventListener('click', () => openLogin('login'));
  $('btn-logout').addEventListener('click', () => logout());
  $('tab-login').addEventListener('click', () => setLoginMode('login'));
  $('tab-register').addEventListener('click', () => setLoginMode('register'));
  $('login-form').addEventListener('submit', submitLogin);
  document.querySelectorAll('#login-modal [data-close]').forEach((btn) => {
    btn.addEventListener('click', closeLogin);
  });
  $('login-modal').addEventListener('click', (event) => {
    if (event.target === $('login-modal')) closeLogin();
  });

  // 弹幕发送已移除：只显示服务端拉取到的弹幕
  $('tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    if (tab.dataset.nav === 'follow') {
      document.querySelectorAll('#tabs .tab').forEach((el) => el.classList.toggle('active', el === tab));
      (async () => {
        try {
          const res = await api({ action: 'hgUserFollowUpdates', session: '', count: 30 });
          const list = (res && res.items) || [];
          if (!list.length) { toast('还没有追更的剧，去红果 App 追更后这里会自动连播'); return; }
          feed.items = list.filter((it) => it && it.id);
          feed.index = 0;
          feed.category = '';
          feed.loaded = true;
          showView('recommend');
          feedPlay(Math.floor(Math.random() * Math.min(3, feed.items.length)));
        } catch (e) { toast('读取追更失败：' + e.message); }
      })();
      return;
    }
    document.querySelectorAll('#tabs .tab').forEach((el) => el.classList.toggle('active', el === tab));
    feed.category = tab.dataset.cat || '';
    feed.loaded = false;
    feed.page = 1;
    feed.items = [];
    feed.index = 0;
    suppressFeedAutoplayUntil = Date.now() + 4000;
    showView('recommend');
    (async () => {
      for (let i = 0; i < 40 && feed.loading; i++) await new Promise((r) => setTimeout(r, 100));
      await loadFeed(true, { noPlay: true });
      if (!feed.items.length) {
        await new Promise((r) => setTimeout(r, 600));
        await loadFeed(true, { noPlay: true });
      }
      if (feed.items.length) {
        const pool = Math.min(feed.items.length, feed.category ? 10 : 20);
        feedPlay(Math.floor(Math.random() * pool));
      } else toast('这个分类暂时没有内容');
    })();
  });

  document.querySelector('.sidebar').addEventListener('click', (event) => {
    const item = event.target.closest('[data-nav]');
    if (!item) return;
    const nav = item.dataset.nav;
    if (nav === 'feedback') { toast('反馈：可在项目仓库提交 issue'); return; }
    if (nav === 'settings') { openSettings(); return; }
    showView(nav);
  });

  $('p-chapters').addEventListener('click', (event) => {
    const button = event.target.closest('.ep-num');
    if (!button) return;
    $('ep-panel').hidden = true;
    playEpisode(Number(button.dataset.index), { quality: state.quality });
  });

  $('ep-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.ep-tab');
    if (!tab || tab.hidden) return;
    epState.tab = tab.dataset.etab;
    renderPlayerChapters();
  });

  $('ep-ranges').addEventListener('click', (event) => {
    const btn = event.target.closest('.ep-range');
    if (!btn) return;
    epState.rangeUser = Number(btn.dataset.range);
    epState.range = epState.rangeUser;
    epState.tab = 'ep';
    renderEpTabs();
    renderEpRanges();
    renderEpGrid();
  });

  $('ep-series').addEventListener('click', (event) => {
    const btn = event.target.closest('.ep-season');
    if (!btn) return;
    const target = epState.series.find((it) => it.id === btn.dataset.id);
    if (!target) return;
    $('ep-panel').hidden = true;
    openDetail(target, { play: true });
  });

  const video = $('video');
  let progressAt = 0;
  video.addEventListener('timeupdate', () => {
    state.videoTime = video.currentTime;
    syncProgress();
    if (!state.drama) return;
    const now = Date.now();
    if (now - progressAt > 3000) {
      progressAt = now;
      saveProgress(state.drama.id, state.index, video.currentTime);
      reportCloudProgress(false);
    }
  });
  video.addEventListener('ended', () => {
    if (!state.drama) return;
    saveProgress(state.drama.id, state.index + 1, 0);
    reportCloudProgress(true);
    if ($('p-auto').checked) nextEpisode();
  });
  video.addEventListener('playing', () => {
    clog('video playing t=' + video.currentTime.toFixed(1) + ' rs=' + video.readyState);
    $('p-loading').hidden = true;
    $('p-error').hidden = true;
    syncProgress();
    schedulePrefetch();
  });
  video.addEventListener('loadedmetadata', () => { applySpeed(); syncProgress(); });
  video.addEventListener('seeking', function () {
    if (!dmItems.length) return;
    dmReset(video.currentTime * 1000);
  });
  video.addEventListener('durationchange', syncProgress);
  video.addEventListener('pause', () => { showControls(true); syncProgress(); reportCloudProgress(true); });
  video.addEventListener('play', () => { syncProgress(); });
  video.addEventListener('volumechange', syncProgress);
  video.addEventListener('click', togglePlay);
  video.addEventListener('error', () => {
  if (video.dataset.direct === '1' && video.dataset.fallback) {
    clog('direct: 直连失败，回落宿主机中转');
    video.dataset.direct = '';
    const fallback = video.dataset.fallback;
    video.dataset.fallback = '';
    try { video.setMediaKeys(null); } catch (e) { /* 忽略 */ }
    video.src = fallback;
    return;
  }
    clog('video error code=' + (video.error && video.error.code) + ' msg=' + (video.error && video.error.message));
    if (!video.getAttribute('src')) return;
    if (playerState.mode === 'direct' && playerState.stream) {
      // HEVC 探测误报或浏览器实际解不了 HEVC：自动改走服务端转码。
      playerState.mode = '';
      toast('浏览器不支持该视频格式，已切换到转码模式');
      startMse(playerState.stream, state.videoTime, playerState.token);
      return;
    }
    $('p-loading').hidden = true;
    showPlayerError('播放失败：可能是该清晰度线路异常，试试切换清晰度或换一条线路。', true);
  });

  let stallTimer = 0;
  video.addEventListener('waiting', () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      if (video.readyState < 3 && !video.paused) {
        showPlayerError('线路响应较慢，可以点“换一条线路”重试。', true);
      }
    }, 15000);
  });
  video.addEventListener('playing', () => clearTimeout(stallTimer));
  video.addEventListener('timeupdate', () => clearTimeout(stallTimer));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const dmDrawer = $('comment-drawer');
      if (dmDrawer && !dmDrawer.hidden) { dmDrawer.hidden = true; return; }
      if (!$('player').hidden) closePlayer();
      else if ($('view-detail') && !$('view-detail').hidden) $('view-detail').hidden = true;
    }
    if (!$('player').hidden) {
      const drawerEl = $('comment-drawer');
      if (drawerEl && !drawerEl.hidden && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        drawerEl.scrollBy(0, event.key === 'ArrowDown' ? 90 : -90);
        event.preventDefault();
        return;
      }
      if (event.key === ' ') { event.preventDefault(); togglePlay(); }
      if (event.key === 'ArrowRight') seekTo($('video').currentTime + 5);
      if (event.key === 'ArrowLeft') seekTo($('video').currentTime - 5);
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (episodeMode && !feed.busy && (state.chapters || []).length) prevEpisode();
        else feedStep(-1);
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (episodeMode && !feed.busy && (state.chapters || []).length) nextEpisode();
        else feedStep(1);
      }
      if (event.key === 'f' || event.key === 'F') toggleFullscreen();
    }
  });

  let scrollLock = false;
  window.addEventListener('scroll', () => {
    if (scrollLock || !state.hasMore || state.loading) return;
    if (window.innerHeight + window.scrollY < document.body.offsetHeight - 600) return;
    scrollLock = true;
    state.page += 1;
    loadCatalog().finally(() => setTimeout(() => { scrollLock = false; }, 400));
  });
}

/* ---------------- 自检（?selftest=1，自动播第一部剧，便于远程排查） ---------------- */

let selftestRan = false;
async function runSelftest() {
  if (selftestRan || !state.items.length) return;
  selftestRan = true;
  clog('selftest: 自动打开 ' + state.items[0].id);
  try {
    await openDetail(state.items[0]);
    clog('selftest: detail 完成 chapters=' + state.chapters.length);
    if (state.chapters.length) {
      await playEpisode(0, { startTime: 0 });
      clog('selftest: playEpisode 返回');
    }
  } catch (e) {
    clog('selftest 异常: ' + ((e && e.message) || e));
  }
}

/* ---------------- 直连播放（浏览器端 WASM 解密） ---------------- */

let ffWorker = null;
let ffSeq = 0;
const ffPending = new Map();

function ensureFFWorker() {
  if (ffWorker) return ffWorker;
  ffWorker = new Worker('/assets/ffmpeg/decrypt-worker.js');
  ffWorker.onmessage = (event) => {
    const msg = event.data || {};
    const wait = ffPending.get(msg.id);
    if (!wait) return;
    ffPending.delete(msg.id);
    if (msg.ok) wait.resolve(new Blob([msg.data], { type: 'video/mp4' }));
    else wait.reject(new Error(msg.error || '解密失败'));
  };
  ffWorker.onerror = (event) => {
    const err = new Error('解密线程错误: ' + ((event && event.message) || ''));
    ffPending.forEach((w) => w.reject(err));
    ffPending.clear();
    try { ffWorker.terminate(); } catch (e) { /* 忽略 */ }
    ffWorker = null;
  };
  return ffWorker;
}

function wasmDecrypt(url, key) {
  return new Promise((resolve, reject) => {
    const worker = ensureFFWorker();
    const id = ++ffSeq;
    ffPending.set(id, { resolve, reject });
    worker.postMessage({ id, url, key });
  });
}

const directCache = new Map();
function rememberDirect(key, url) {
  if (!key) return;
  const old = directCache.get(key);
  if (old) { try { URL.revokeObjectURL(old); } catch (e) {} }
  directCache.set(key, url);
  while (directCache.size > 3) {
    const first = directCache.keys().next().value;
    try { URL.revokeObjectURL(directCache.get(first)); } catch (e) {}
    directCache.delete(first);
  }
}

let directPrefetchSeq = 0;
async function scheduleDirectPrefetch() {
  if (!settingsState.direct) return;
  const seq = ++directPrefetchSeq;
  setTimeout(async () => {
    if (seq !== directPrefetchSeq || !settingsState.direct) return;
    const idx = state.index + 1;
    const chapter = (state.chapters || [])[idx];
    if (!chapter || !state.drama) return;
    const key = chapter.videoUrl;
    if (directCache.has(key)) return;
    try {
      const plan = await api({ action: 'resolve', drama: state.drama, chapter: chapter, index: idx, quality: 0 });
      if (seq !== directPrefetchSeq || !plan || !plan.originUrl || !plan.decryptionKey) return;
      if (plan.session) api({ action: 'release', session: plan.session }).catch(() => {});
      const blob = await wasmDecrypt(plan.originUrl, plan.decryptionKey);
      if (seq !== directPrefetchSeq) return;
      rememberDirect(key, URL.createObjectURL(blob));
      clog('direct: 预解密下一集 ' + Math.round(blob.size / 1024) + 'KB');
    } catch (e) { /* 预解密失败不影响播放 */ }
  }, 4000);
}

function startDirectVideo(video, url) {
  video.src = url;
  // ★ 直连（浏览器本地解密）路径必须自己加载弹幕：
  //   旧实现只在服务器 /dec 路径的 loadedmetadata 里调 dmLoad，直连播放永远没有弹幕。
  (function loadDanmakuOnce() {
    let done = false;
    const fire = function () {
      if (done) return;
      done = true;
      try { dmLoad(playerState.token); } catch (e) { /* 忽略 */ }
    };
    if (video.readyState >= 1) fire();
    else video.addEventListener('loadedmetadata', function once() {
      video.removeEventListener('loadedmetadata', once);
      fire();
    });
  })();
  applyPictureEnhance();
  video.play().then(function () {
    clog('direct: play() resolved');
  }).catch(function (e) {
    clog('direct: play() rejected ' + ((e && e.name) || '') + ' ' + ((e && e.message) || e));
    if (!video.muted) {
      video.muted = true;
      autoMuted = true;
      video.play().then(function () { toast('已静音自动播放，点击画面开启声音'); }).catch(function () {
        $('p-loading').hidden = true;
        toast('浏览器要求先点击画面才能播放');
      });
    }
  });
}

function revokeDirectBlob(video) {
  if (video && video.dataset.directBlob) {
    try { URL.revokeObjectURL(video.dataset.directBlob); } catch (e) { /* 忽略 */ }
    delete video.dataset.directBlob;
  }
}

async function tryDirectPlay(plan, startTime) {
  if (!settingsState.direct) return false;
  if (!plan || !plan.originUrl || !plan.decryptionKey) return false;
  const video = document.querySelector('#player video');
  if (!video || !window.Worker) return false;
  const chapter = (state.chapters || [])[state.index] || {};
  const cacheKey = chapter.videoUrl || plan.originUrl;
  const cached = directCache.get(cacheKey);
  if (cached) {
    video.dataset.direct = '1';
    video.dataset.directBlob = cached;
    video.dataset.fallback = plan.url;
    video.pause();
    startDirectVideo(video, cached);
    scheduleDirectPrefetch();
    clog('direct: 命中本地解密缓存');
    return true;
  }
  try {
    toast('直连解密中…', 2200);
    const t0 = Date.now();
    const blob = await wasmDecrypt(plan.originUrl, plan.decryptionKey);
    clog('direct: wasm 解密完成 ' + Math.round(blob.size / 1024) + 'KB / ' + (Date.now() - t0) + 'ms');
    revokeDirectBlob(video);
    const blobUrl = URL.createObjectURL(blob);
    video.dataset.direct = '1';
    video.dataset.directBlob = blobUrl;
    video.dataset.fallback = plan.url;
    video.dataset.directPlan = JSON.stringify({ url: plan.url, key: plan.decryptionKey });
    rememberDirect(cacheKey, blobUrl);
    video.pause();
    startDirectVideo(video, blobUrl);
    scheduleDirectPrefetch();
    if (startTime > 0) video.addEventListener('loadedmetadata', function once() {
      video.removeEventListener('loadedmetadata', once);
      try { video.currentTime = startTime; } catch (e) { /* 忽略 */ }
    });
    return true;
  } catch (e) {
    clog('direct: 失败 ' + ((e && e.name) ? e.name + ': ' : '') + ((e && e.message) || e));
    return false;
  }
}

/* ---------------- 启动 ---------------- */

window.addEventListener('unhandledrejection', (event) => {
  const msg = (event.reason && event.reason.message) || String(event.reason);
  clog('unhandledrejection: ' + msg);
  toast('脚本错误：' + msg, 6000);
});
window.addEventListener('error', (event) => {
  clog('window error: ' + (event.message || '') + ' @' + (event.filename || '') + ':' + (event.lineno || 0));
});

if (window.HGSuperRes) {
  window.addEventListener('resize', function () { if (settingsState.sr) window.HGSuperRes.layout(); });
  document.addEventListener('fullscreenchange', function () { if (settingsState.sr) window.HGSuperRes.layout(); });
}
applyPictureEnhance();
dmApplyStyle();
clog('页面加载 v8 ' + location.href);
bindEvents();
bindPlayerSwipe();
bindSettings();
bindSearchPop();
bindViewEvents();
bindFollowEvents();
bootstrapSession().finally(() => { initAuth(); });
showView('recommend');
window.__hg = { get state() { return state; }, get feed() { return feed; }, get rankState() { return rankState; }, get newState() { return newState; }, feedStep: feedStep, showView: showView, dmRichHTML: dmRichHTML, dmSpawn: dmSpawn, openDetail: openDetail, playEpisode: playEpisode, hideControls: hideControls, showControls: showControls, renderPlayerChapters: renderPlayerChapters, searchHistory: function () { return searchHistory.slice(); }, nextEpisode: nextEpisode, prevEpisode: prevEpisode, playHistoryItem: playHistoryItem, updateCommentCount: updateCommentCount, reportCloudProgress: reportCloudProgress, setOfficialUser: function (v) { officialUser = v; }, likeIndex: likeIndex, favIndex: favIndex, ensureLikeIndex: ensureLikeIndex, isLiked: isLiked };
