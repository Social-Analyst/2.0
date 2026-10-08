// === UTIL ===
const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const igLink = u => `<a class="text-sky-400 hover:underline" href="https://instagram.com/${encodeURIComponent(u)}" target="_blank" rel="noopener noreferrer">@${esc(u)}</a>`;
const GRACE = 3 * 864e5, CELEB = 1e5, DAILY_CAP = 25, IG_APP_ID = '936619743392459';
let cancel = false;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.remove('hidden'); setTimeout(() => t.classList.add('hidden'), 4500); }

// === DATA LAYER (IndexedDB) ===
let db;
const STORES = { tracked_accounts: 'username', whitelist: 'username', app_settings: 'key' };
function initializeLocalDatabase() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('follower_analyzer', 1);
    r.onupgradeneeded = () => { for (const [s, k] of Object.entries(STORES)) r.result.createObjectStore(s, { keyPath: k }); };
    r.onsuccess = () => { db = r.result; res(); };
    r.onerror = () => rej(r.error);
  });
}
const tx = (s, m, f) => new Promise((res, rej) => { const t = db.transaction(s, m), q = f(t.objectStore(s)); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); });
const dbPut = (s, v) => tx(s, 'readwrite', o => o.put(v));
const dbGet = (s, k) => tx(s, 'readonly', o => o.get(k));
const dbAll = s => tx(s, 'readonly', o => o.getAll());
const dbDel = (s, k) => tx(s, 'readwrite', o => o.delete(k));
const getSetting = async (k, d) => { const r = await dbGet('app_settings', k); return r ? r.value : d; };
const setSetting = (k, v) => dbPut('app_settings', { key: k, value: v });

// === TERMS OF SERVICE ===
const TOS = `
<p><b>1. Experimental software.</b> This application is an AI-generated experimental test. It is provided "AS IS", without warranty of any kind.</p>
<p><b>2. Unofficial access.</b> It is not affiliated with Instagram or Meta. It uses unofficial endpoints and automation that may violate Instagram's Terms of Use.</p>
<p><b>3. Zero liability.</b> The authors, contributors, and the AI that generated this code accept no liability for data loss, unsent or deleted chat messages (irreversible), unfollowed accounts, rate limits, account restrictions, suspensions, or permanent bans.</p>
<p><b>4. Assumption of risk.</b> You use this software entirely at your own risk and are solely responsible for every action it performs on your account.</p>
<p><b>5. Local data.</b> All data and session cookies stay on your device. Session cookies grant access to your account; you are responsible for protecting them.</p>`;
function renderTermsOfServiceModal() {
  return new Promise(res => {
    const r = $('#tos-root');
    r.innerHTML = `<div class="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div class="bg-zinc-900 border border-zinc-700 rounded-2xl max-w-2xl w-full max-h-[90vh] flex flex-col">
        <h2 class="text-lg font-semibold p-6 pb-3">TERMS OF SERVICE &amp; LIABILITY DISCLAIMER</h2>
        <div class="overflow-y-auto px-6 text-sm space-y-3 text-zinc-300">${TOS}</div>
        <div class="p-6 border-t border-zinc-800 mt-3 space-y-4">
          <label class="flex gap-3 items-start text-sm"><input id="tos-check" type="checkbox" class="mt-1">
            <span>I have read, understood, and accept all terms of service and assume full responsibility for my account actions.</span></label>
          <button id="tos-accept" class="btn w-full" disabled>Accept &amp; Proceed to Login</button>
        </div></div></div>`;
    const c = $('#tos-check'), b = $('#tos-accept');
    c.onchange = () => { b.disabled = !c.checked; };
    b.onclick = async () => { if (!c.checked) return; await setSetting('tos_accepted', true); r.innerHTML = ''; res(); };
  });
}

// === INSTAGRAM TRANSPORT ===
async function igRequest(path, { method = 'GET', body } = {}) {
  const s = await getSetting('session');
  if (!s) throw new Error('Not logged in');
  const url = 'https://www.instagram.com' + path;
  const headers = { 'X-IG-App-ID': IG_APP_ID, 'X-CSRFToken': s.csrftoken, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' };
  let r;
  if (window.native) r = await window.native.request({ path, method, body, csrftoken: s.csrftoken });
  else if (window.Capacitor?.isNativePlatform?.()) {
    const o = await Capacitor.Plugins.CapacitorHttp.request({ url, method, headers: { ...headers, Cookie: s.cookie }, data: body });
    r = { status: o.status, json: o.data };
  } else throw new Error('Instagram requests need the desktop or Android build. Browsers block cross-site cookies.');
  if (r.status === 429) throw Object.assign(new Error('429 rate limited'), { rate: true });
  if (r.status >= 400) throw new Error('HTTP ' + r.status);
  return r.json;
}

// === SESSION LOGIN ===
async function captureWebViewSession() {
  if (!await getSetting('tos_accepted', false)) throw new Error('Terms not accepted');
  let s;
  if (window.native) s = await window.native.login();                         // Electron: embedded BrowserWindow
  else if (window.Capacitor?.Plugins?.CookieBridge) s = await Capacitor.Plugins.CookieBridge.login(); // Android: native WebView plugin
  else return toast('Login needs the desktop or Android build. Browsers cannot read Instagram cookies.');
  await setSetting('session', s);
  toast('Logged in'); show('nonfollowers');
}

// === ANALYTICS ENGINE ===
async function fetchList(kind, userId) {
  const out = []; let maxId = '';
  do {
    if (cancel) break;
    const j = await igRequest(`/api/v1/friendships/${userId}/${kind}/?count=100${maxId ? '&max_id=' + maxId : ''}`);
    out.push(...j.users.map(u => ({ username: u.username, id: u.pk || u.id, full_name: u.full_name, has_default_pic: /44884218_345710/.test(u.profile_pic_url || '') })));
    maxId = j.next_max_id || '';
    await sleep(rand(1500, 3500));
  } while (maxId);
  return out;
}
async function runProfileScan() {
  const s = await getSetting('session'); if (!s) return toast('Log in first');
  cancel = false; toast('Scanning…');
  const fers = await fetchList('followers', s.userId), fing = await fetchList('following', s.userId);
  await applyScan(fers, fing);
}
async function applyScan(fers, fing, pending = []) {
  const fSet = new Set(fers.map(u => u.username)), gSet = new Set(fing.map(u => u.username)), pSet = new Set(pending.map(u => u.username)), now = Date.now();
  const old = Object.fromEntries((await dbAll('tracked_accounts')).map(a => [a.username, a]));
  for (const u of [...fing, ...fers.filter(u => !gSet.has(u.username)), ...pending.filter(u => !gSet.has(u.username))]) {
    const status = gSet.has(u.username) ? (fSet.has(u.username) ? 'mutual' : 'non_follower') : pSet.has(u.username) ? 'non_follower' : 'follower';
    const o = old[u.username] || {};
    await dbPut('tracked_accounts', { ...o, ...u, url: 'https://instagram.com/' + u.username, pending: pSet.has(u.username), status, timestamp: now,
      detected_at: status === 'non_follower' ? (o.status === 'non_follower' ? o.detected_at : now) : null });
  }
  for (const a of Object.values(old)) if (!fSet.has(a.username) && !gSet.has(a.username) && !pSet.has(a.username)) await dbDel('tracked_accounts', a.username);
  await setSetting('last_scan', now); toast('Scan complete'); show('nonfollowers');
}
const whitelistSet = async () => new Set((await dbAll('whitelist')).filter(w => w.type !== 'chat' && w.whitelisted).map(w => w.username));
async function evaluateThreeDayGracePeriod() {
  const wl = await whitelistSet(), due = [], soon = [];
  for (const a of (await dbAll('tracked_accounts')).filter(a => a.status === 'non_follower')) {
    if (wl.has(a.username) || a.is_celebrity) continue;
    const left = GRACE - (Date.now() - a.detected_at);
    (left <= 0 ? due : soon).push({ ...a, msLeft: left });
  }
  return { due, soon };
}
async function ensureProfile(a) {
  if (a.profile_at) return a;
  const j = await igRequest('/api/v1/users/web_profile_info/?username=' + encodeURIComponent(a.username));
  const u = j.data.user;
  Object.assign(a, { followers_count: u.edge_followed_by.count, following_count: u.edge_follow.count, posts: u.edge_owner_to_timeline_media.count,
    bio: u.biography, has_default_pic: a.has_default_pic || !u.profile_pic_url, profile_at: Date.now(), is_celebrity: u.edge_followed_by.count >= CELEB });
  await dbPut('tracked_accounts', a); return a;
}
async function guardPause() {
  const p = await getSetting('pause_until', 0);
  if (Date.now() < p) throw new Error('Paused until ' + new Date(p).toLocaleString());
}
async function pauseOn429(e) { if (e.rate) await setSetting('pause_until', Date.now() + rand(6, 12) * 36e5); }
async function runAutoUnfollow() {
  if (!await getSetting('enableAutoUnfollow', false)) return;
  try { await guardPause(); } catch { return; }
  const day = new Date().toDateString(); let q = await getSetting('unfollow_quota', { day, n: 0 }); if (q.day !== day) q = { day, n: 0 };
  const { due } = await evaluateThreeDayGracePeriod();
  for (const a0 of due) {
    if (q.n >= DAILY_CAP || cancel) break;
    try {
      const a = await ensureProfile(a0); if (a.is_celebrity) continue;       // celebrity check before every action
      await igRequest(`/api/v1/friendships/destroy/${a.id}/`, { method: 'POST', body: 'user_id=' + a.id });
      a.status = 'unfollowed'; await dbPut('tracked_accounts', a);
      q.n++; await setSetting('unfollow_quota', q);
      await sleep(rand(30e3, 90e3));                                          // drip-feed
    } catch (e) { await pauseOn429(e); toast(e.message); break; }
  }
}
async function sendDailySummaryNotification() {
  if (Date.now() - await getSetting('last_summary', 0) < 864e5) return;
  const { due, soon } = await evaluateThreeDayGracePeriod();
  const n = (await getSetting('unfollow_quota', { n: 0 })).n;
  const body = `${n} unfollowed today · ${due.length} past grace period · ${soon.length} approaching expiry`;
  if (Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission === 'granted') new Notification('Daily summary', { body });
  await setSetting('last_summary', Date.now());
}

// === CELEBRITY DETECTION ===
async function detectCelebrityProfiles() {
  cancel = false;
  const list = (await dbAll('tracked_accounts')).filter(a => a.status !== 'follower' && !a.profile_at);
  for (const [i, a] of list.entries()) {
    if (cancel) break;
    try { await ensureProfile(a); toast(`Checked ${i + 1}/${list.length}`); await sleep(rand(2000, 4000)); }
    catch (e) { await pauseOn429(e); toast(e.message); break; }
  }
  show('whitelist');
}

// === BOT / FRAUD SCORING ===
function calculateBotFraudScore(p) {
  let s = 0;
  if (p.following / Math.max(p.followers_count, 1) > 10) s += 40;
  if (p.posts === 0) s += 30; else if (p.posts <= 3) s += 15;
  if (/\d{4,}$/.test(p.username)) s += 15;
  if (p.has_default_pic) s += 15;
  if (!p.bio) s += 5;
  return s;
}
const renderBotStatusIndicator = a => a.score >= 70 ? `<span class="badge" style="background:#7f1d1d">🤖 Likely bot · ${a.score}</span>` : '';
async function runSpamAudit() {
  cancel = false;
  const list = (await dbAll('tracked_accounts')).filter(a => a.status !== 'non_follower' && a.status !== 'unfollowed' && a.status !== 'follower' || a.status === 'follower');
  for (const [i, a] of list.entries()) {
    if (cancel) break;
    try { await ensureProfile(a); a.following_count = a.following_count; a.score = calculateBotFraudScore({ ...a, following: a.following_count }); await dbPut('tracked_accounts', a);
      toast(`Audited ${i + 1}/${list.length}`); await sleep(rand(2000, 4000)); }
    catch (e) { await pauseOn429(e); toast(e.message); break; }
  }
  show('spam');
}

// === CHAT MAINTENANCE ===
async function throttleChatMutations(fn) {
  await guardPause();
  await sleep(rand(3000, 7000));                                              // 3–7 s between mutations
  try { return await fn(); } catch (e) { await pauseOn429(e); throw e; }      // 429 → 6–12 h pause
}
async function unsendMessageByMessage(threadId, onCount) {
  const me = String((await getSetting('session')).userId); let cursor = '', n = 0;
  do {
    const th = (await igRequest(`/api/v1/direct_v2/threads/${threadId}/?limit=20${cursor ? '&cursor=' + cursor : ''}`)).thread;
    for (const it of th.items) {
      if (cancel) return n;
      if (String(it.user_id) !== me) continue;
      await throttleChatMutations(() => igRequest(`/api/v1/direct_v2/threads/${threadId}/items/${it.item_id}/delete/`, { method: 'POST', body: '' }));
      onCount(++n);
    }
    cursor = th.has_older ? th.oldest_cursor : '';
  } while (cursor);
  return n;
}

// === EXPORT IMPORT (works in any browser, no login) ===
const uniq = a => [...new Map(a.map(u => [u.username, u])).values()];
function igNames(data) {
  const arr = Array.isArray(data) ? data : Object.values(data || {}).find(Array.isArray) || [];
  return arr.map(e => { const s = e.string_list_data?.[0] || {}; return s.value || e.title || (s.href || '').split('/').filter(Boolean).pop(); })
    .filter(Boolean).map(n => ({ username: String(n) }));
}
async function importExport(files) {
  const fers = [], fing = [], pend = [];
  for (const f of files) {
    const n = f.name.toLowerCase(); let j;
    try { j = JSON.parse(await f.text()); } catch { continue; }
    if (n.startsWith('followers')) fers.push(...igNames(j));
    else if (n.startsWith('following')) fing.push(...igNames(j));
    else if (n.includes('pending_follow_requests') || n.includes('follow_requests_sent')) pend.push(...igNames(j));
  }
  if (!fers.length || !fing.length) return toast('Select followers_1.json and following.json (JSON format)');
  await applyScan(uniq(fers), uniq(fing), uniq(pend));
}
const releaseUrl = () => { const r = location.pathname.split('/')[1]; return location.hostname.endsWith('.github.io') && r ? `https://github.com/${location.hostname.split('.')[0]}/${r}/releases/latest` : ''; };

// === UI ===
const canAct = () => !!(window.native || window.Capacitor?.isNativePlatform?.());
const toggle = (id, on, dis) => `<label class="switch"><input id="${id}" type="checkbox" ${on ? 'checked' : ''} ${dis ? 'disabled' : ''}><span></span></label>`;
const people = (arr, extra = () => '') => arr.length ? arr.map(a => `<div class="row"><div>${igLink(a.username)} ${extra(a)}</div></div>`).join('') : '<p class="text-zinc-400 p-4">Nothing here yet. Run a scan from Non-followers.</p>';
const views = {
  async importer() {
    const rel = releaseUrl();
    return `<h1 class="text-2xl font-semibold mb-2">Import your Instagram data</h1>
      <p class="text-zinc-400 mb-4 max-w-prose">No login needed. Files never leave this device.</p>
      <ol class="list-decimal ml-5 space-y-1 text-sm text-zinc-300 mb-4 max-w-prose">
        <li>In Instagram, open Accounts Center → Your information and permissions → Download your information (menu names can vary).</li>
        <li>Choose your Instagram profile, select <b>Followers and following</b>, date range <b>All time</b>, format <b>JSON</b>.</li>
        <li>Download the ZIP when Instagram emails you, then unzip it. The files are in <code>connections/followers_and_following</code>.</li>
        <li>Select <code>followers_1.json</code> (and any other followers files), <code>following.json</code>, and optionally <code>pending_follow_requests.json</code>.</li>
      </ol>
      <input id="ex-files" type="file" accept=".json,application/json" multiple class="block mb-3 text-sm">
      <button id="do-import" class="btn">Import and analyze</button>
      <p class="text-xs text-zinc-500 mt-4 max-w-prose">Import a fresh export every few days. Each account's 3-day grace timer starts at the first import where it shows as a non-follower and carries over to later imports.</p>
      ${rel ? `<p class="mt-6 text-sm"><a class="text-sky-400 hover:underline" href="${rel}" target="_blank" rel="noopener noreferrer">Desktop and Android apps (latest release)</a></p>` : ''}`;
  },
  async login() {
    const s = await getSetting('session');
    return `<h1 class="text-2xl font-semibold mb-2">Login</h1>
      <p class="text-zinc-400 mb-4 max-w-prose">Sign in through Instagram's own login page in a secure window. Your session stays on this device.</p>
      <button id="do-login" class="btn">${s ? 'Log in again' : 'Log in with Instagram'}</button>
      <p class="text-xs text-zinc-500 mt-4 max-w-prose">Available in the desktop and Android builds. A browser tab cannot read Instagram cookies.</p>`;
  },
  async nonfollowers() {
    const on = await getSetting('enableAutoUnfollow', false), wl = await whitelistSet();
    const { due, soon } = await evaluateThreeDayGracePeriod();
    const all = (await dbAll('tracked_accounts')).filter(a => a.status === 'non_follower');
    const state = a => wl.has(a.username) ? '<span class="badge">Whitelisted</span>' : a.is_celebrity ? '<span class="badge gold">Celebrity Account</span>'
      : Date.now() - a.detected_at >= GRACE ? '<span class="badge" style="background:#7f1d1d">Past grace period</span>' : `<span class="badge">${Math.ceil((GRACE - (Date.now() - a.detected_at)) / 864e5)}d left</span>`;
    return `<div class="flex justify-between items-center mb-4"><h1 class="text-2xl font-semibold">Non-followers <span class="text-zinc-500 text-base">${all.length}</span></h1><button id="do-scan" class="btn">Scan now</button></div>
      <div class="bg-zinc-900 border border-zinc-800 rounded-xl p-4 mb-4"><div class="flex justify-between items-center"><b>Auto-unfollow</b>${toggle('enableAutoUnfollow', on, !canAct())}</div>
      <p class="text-sm text-zinc-400 mt-2">This feature allows the app to automatically unfollow accounts that do not follow you back, or cancel pending follow requests that remain unanswered. To protect your account, actions are safely delayed and calculated using a 3-day grace period. You can completely exclude close friends, family, or specific accounts by adding them to your Whitelist.</p>
      ${canAct() ? '' : '<p class="text-xs text-amber-400 mt-2">Auto-unfollow runs only in the desktop build. Here, open each account link to unfollow manually once it is past the grace period.</p>'}<p class="text-xs text-zinc-500 mt-2">${due.length} past grace period · ${soon.length} still in grace period</p></div>
      <div class="bg-zinc-900 border border-zinc-800 rounded-xl">${people(all, state)}</div>`;
  },
  async followers() {
    return `<h1 class="text-2xl font-semibold mb-4">Followers</h1><div class="bg-zinc-900 border border-zinc-800 rounded-xl">${people((await dbAll('tracked_accounts')).filter(a => a.status === 'mutual' || a.status === 'follower'), a => a.status === 'mutual' ? '<span class="badge">Mutual</span>' : '')}</div>`;
  },
  async whitelist() {
    const wl = await whitelistSet(), q = ($('#wl-q')?.value || '').toLowerCase();
    const list = (await dbAll('tracked_accounts')).filter(a => (a.status === 'mutual' || a.status === 'non_follower') && a.username.toLowerCase().includes(q));
    return `<div class="flex justify-between items-center mb-4"><h1 class="text-2xl font-semibold">Whitelist</h1><button id="do-celeb" class="btn alt">Detect celebrities</button></div>
      <input id="wl-q" value="${esc(q)}" placeholder="Search accounts you follow" class="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 mb-4">
      <div class="bg-zinc-900 border border-zinc-800 rounded-xl">${list.map(a => `<div class="row"><div>${igLink(a.username)} ${a.is_celebrity ? '<span class="badge gold">Celebrity Account</span>' : ''}</div>
        ${a.is_celebrity ? '<span class="text-xs text-zinc-500">Always excluded</span>' : `<label class="switch"><input type="checkbox" data-wl="${esc(a.username)}" ${wl.has(a.username) ? 'checked' : ''}><span></span></label>`}</div>`).join('') || '<p class="text-zinc-400 p-4">No accounts yet. Run a scan first.</p>'}</div>`;
  },
  async spam() {
    const flagged = (await dbAll('tracked_accounts')).filter(a => a.score >= 70);
    return `<div class="flex justify-between items-center mb-4"><h1 class="text-2xl font-semibold">Spam audit</h1><button id="do-spam" class="btn">Audit accounts</button></div>
      <p class="text-sm text-zinc-400 mb-4">Flags are for your manual review. Nothing is removed automatically.</p>
      <div class="bg-zinc-900 border border-zinc-800 rounded-xl">${people(flagged, renderBotStatusIndicator)}</div>`;
  },
  async chat() {
    return `<h1 class="text-2xl font-semibold mb-2">Chat cleaner</h1><p class="text-sm text-zinc-400 mb-4 max-w-prose">Unsends only your own messages, one at a time, every 3–7 seconds. Unsending cannot be undone. Exempted threads are skipped.</p>
      <button id="do-threads" class="btn mb-4">Load conversations</button><div id="threads" class="bg-zinc-900 border border-zinc-800 rounded-xl hidden"></div>`;
  }
};
async function show(name) {
  document.querySelectorAll('.nav[data-panel]').forEach(b => b.classList.toggle('active', b.dataset.panel === name));
  $('#view').innerHTML = await views[name](); bind(name);
}
async function task(fn) { try { await fn(); } catch (e) { toast(e.message); } }
function bind(name) {
  if (name === 'importer') $('#do-import').onclick = () => task(() => importExport([...$('#ex-files').files]));
  if (name === 'login') $('#do-login').onclick = () => task(captureWebViewSession);
  if (name === 'nonfollowers') {
    $('#do-scan').onclick = () => task(runProfileScan);
    $('#enableAutoUnfollow').onchange = async e => { await setSetting('enableAutoUnfollow', e.target.checked); if (e.target.checked) task(runAutoUnfollow); };
  }
  if (name === 'whitelist') {
    $('#do-celeb').onclick = () => task(detectCelebrityProfiles);
    $('#wl-q').oninput = () => show('whitelist').then(() => { const i = $('#wl-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); });
    document.querySelectorAll('[data-wl]').forEach(c => c.onchange = () => dbPut('whitelist', { username: c.dataset.wl, type: 'account', whitelisted: c.checked }));
  }
  if (name === 'spam') $('#do-spam').onclick = () => task(runSpamAudit);
  if (name === 'chat') $('#do-threads').onclick = () => task(async () => {
    const j = await igRequest('/api/v1/direct_v2/inbox/?limit=20');
    const ex = new Set((await dbAll('whitelist')).filter(w => w.type === 'chat' && w.whitelisted).map(w => w.username));
    const box = $('#threads'); box.classList.remove('hidden');
    box.innerHTML = j.inbox.threads.map(t => `<div class="row"><span>${esc(t.thread_title || t.users.map(u => u.username).join(', '))}</span>
      <span class="flex items-center gap-3 text-xs">Exempt <label class="switch"><input type="checkbox" data-chat="${esc(t.thread_id)}" ${ex.has('chat:' + t.thread_id) ? 'checked' : ''}><span></span></label>
      <button class="btn alt" data-unsend="${esc(t.thread_id)}">Unsend mine</button><span id="c-${esc(t.thread_id)}"></span></span></div>`).join('');
    box.querySelectorAll('[data-chat]').forEach(c => c.onchange = () => dbPut('whitelist', { username: 'chat:' + c.dataset.chat, type: 'chat', whitelisted: c.checked }));
    box.querySelectorAll('[data-unsend]').forEach(b => b.onclick = () => task(async () => {
      const id = b.dataset.unsend;
      if ((await dbGet('whitelist', 'chat:' + id))?.whitelisted) return toast('Thread is exempt');
      if (!confirm('Unsend all your messages in this conversation? This cannot be undone.')) return;
      cancel = false; const n = await unsendMessageByMessage(id, k => { $('#c-' + id).textContent = k + ' unsent'; }); toast(`Unsent ${n} messages`);
    }));
  });
}

// === BOOT ===
(async () => {
  await initializeLocalDatabase();
  if (!await getSetting('tos_accepted', false)) await renderTermsOfServiceModal();
  $('#app').classList.remove('hidden');
  document.querySelectorAll('.nav[data-panel]').forEach(b => b.onclick = () => show(b.dataset.panel));
  $('#stop').onclick = () => { cancel = true; toast('Stopping after the current step'); };
  show((await getSetting('session')) || (await dbAll('tracked_accounts')).length ? 'nonfollowers' : (window.native ? 'login' : 'importer'));
  const tick = () => { runAutoUnfollow(); sendDailySummaryNotification().catch(() => {}); };
  setTimeout(tick, 5000); setInterval(tick, 30 * 60 * 1000);
})();
