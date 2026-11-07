/**
 * Marketplace SMART auto-post (separate from `mppost go`, which is untouched).
 *
 *  • Posts every active product to every saved group once a day, at a RANDOM time
 *    inside a window (default 09:00–12:30, bot timezone — `.setvar TIME_ZONE=…`).
 *  • Keeps a ledger of every (product × group) pair: posted / failed / why.
 *  • Failures are classified. Permanent ones (kicked, locked, forbidden) are NOT
 *    retried and are reported with group name + JID + reason. Temporary ones
 *    (connection closed, timeouts, rate limit) are retried later — only for the
 *    pairs that are still missing — with a hard limit on attempts.
 *  • Persisted + restart-safe (same idea as lib/scheduler.js): a crash or restart
 *    mid-run resumes with the remaining pairs instead of starting over.
 */
'use strict';

const fs = require('fs-extra');
const path = require('path');
const mp = require('./marketplace');

const PROJECT_ROOT = process.env.CODEX_PROJECT_ROOT || path.join(__dirname, '..');
const FILE = path.join(PROJECT_ROOT, 'database', 'marketplace_smart.json');

const DEFAULT_WINDOW = { from: '09:00', to: '12:30' };
const CATCHUP_GRACE_MIN = 60;            // bot was offline at the planned time: still post if back within this after the window ends
const RETRY_DELAYS_MIN = [10, 25, 45];   // wait before retry pass 1, 2, 3  (±20% jitter)
const RETRY_DEADLINE_H = 6;              // never retry later than this after the run started
const TICK_MS = 30 * 1000;
const HISTORY_MAX = 14;
const CHRONIC_DAYS = 3;                  // group failed this many days in a row → suggest removing it

// ── tiny persistence (atomic write + corrupt backup) ────────────────────────
function load() {
  let raw;
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch { return fresh(); }
  try { return Object.assign(fresh(), JSON.parse(raw)); } catch (e) {
    try { fs.copyFileSync(FILE, `${FILE}.corrupt-${Date.now()}`); } catch {}
    console.log('marketplaceSmart: state unreadable, backup kept:', e.message);
    return fresh();
  }
}
function fresh() {
  return { enabled: false, window: { ...DEFAULT_WINDOW }, reportTo: null, plan: null, lastRunDate: null,
    run: null, history: [], groupHealth: {}, outbox: [] };
}
function save(st) {
  fs.ensureDirSync(path.dirname(FILE));
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
  fs.renameSync(tmp, FILE);
}

// ── time helpers (local time = bot timezone, since lib/timezone.js sets process.env.TZ) ──
function parseClock(s) {
  const m = String(s || '').trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = +m[1]; const min = +(m[2] || 0); const ap = m[3];
  if (ap) { if (h < 1 || h > 12) return null; if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; }
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
const fmtClock = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
function parseWindow(text) {
  const parts = String(text || '').toLowerCase().trim().split(/\s*(?:-|–|—|to)\s*/).filter(Boolean);
  if (parts.length !== 2) return null;
  const a = parseClock(parts[0]); const b = parseClock(parts[1]);
  if (a === null || b === null || b <= a) return null;
  return { from: fmtClock(a), to: fmtClock(b) };
}
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function atMin(day, mins) { return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(mins / 60), mins % 60, 0, 0); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function fmtTime(ts) {
  return new Date(ts).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function fmtHM(ts) { return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }

/** Random moment inside the window. Never in the past; rolls to tomorrow if today's window is (almost) over. */
function pickPlan(now, win, skipToday = false) {
  const start = parseClock(win.from); const end = parseClock(win.to);
  const rnd = (lo, hi) => Math.floor(lo + Math.random() * (hi - lo));
  if (!skipToday) {
    const lo0 = atMin(now, start).getTime(); const hi = atMin(now, end).getTime();
    const lo = Math.max(lo0, now.getTime() + 60 * 1000);
    if (lo < hi - 30 * 1000) return { date: dayKey(now), at: rnd(lo, hi) };
  }
  const t = addDays(now, 1);
  return { date: dayKey(t), at: rnd(atMin(t, start).getTime(), atMin(t, end).getTime()) };
}

// ── failure classification ──────────────────────────────────────────────────
function shortMsg(e) { return String(e?.message || e || 'unknown').replace(/\s+/g, ' ').slice(0, 120); }
/** → { category, retryable, scope: 'send'|'group'|'item', reason } */
function classify(e) {
  const msg = String(e?.message || e || ''); const low = msg.toLowerCase();
  const code = e?.output?.statusCode;
  if (mp.isConnError(e)) return { category: 'connection', retryable: true, scope: 'send', reason: 'Connection dropped / timed out' };
  if (/rate-overlimit|too many|429/.test(low) || code === 429) return { category: 'rate-limit', retryable: true, scope: 'send', reason: 'WhatsApp rate limit (sending too fast)' };
  if (/enoent/.test(low)) return { category: 'media-missing', retryable: false, scope: 'item', reason: 'Media file is missing on disk' };
  if (/forbidden|not-authorized|not authorized/.test(low) || code === 403 || code === 401)
    return { category: 'forbidden', retryable: false, scope: 'group', reason: 'WhatsApp refused the send — bot was removed, group is admin-only, or the account is restricted there' };
  if (/item-not-found|not found|invalid jid|gone/.test(low) || code === 404)
    return { category: 'not-found', retryable: false, scope: 'group', reason: 'Group not found (deleted, or the bot is not in it)' };
  return { category: 'unknown', retryable: true, scope: 'send', reason: `Unexpected error: ${shortMsg(e)}` };
}

// ── engine state ────────────────────────────────────────────────────────────
let sock = null; let botRef = null; let ticker = null; let active = false; let cancelFlag = false;

function liveSock() { if (botRef?.sock) sock = botRef.sock; return sock; }   // newest socket (bot swaps it on reconnect)
function isOpen() { const s = liveSock(); return !!s && mp.wsOpen(s); }
function norm(j) { return String(j || '').replace(/:[0-9]+@/, '@'); }
function ownJid() { return norm(liveSock()?.user?.id); }

function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => tick().catch((e) => console.log('marketplaceSmart tick:', e.message)), TICK_MS);
  if (ticker.unref) ticker.unref();
  const t = setTimeout(() => tick().catch(() => {}), 5000); if (t.unref) t.unref();
}
function attach(s) {          // from commands / album listener
  if (s) sock = s;
  startTicker();
}
function attachBot(bot) {     // from lib/scheduler.js init() — runs on every (re)connect
  botRef = bot;
  if (bot?.sock) sock = bot.sock;
  startTicker();
}

async function notify(st, text) {
  const to = st.reportTo || ownJid();
  const chunks = [];
  for (let i = 0; i < text.length; i += 3500) chunks.push(text.slice(i, i + 3500));
  for (const c of chunks) {
    try {
      if (!isOpen() || !to) throw new Error('not connected');
      await liveSock().sendMessage(to, { text: c });
    } catch (e) {
      console.log('marketplaceSmart: report queued (', e.message, ')');
      st.outbox = (st.outbox || []).concat(c).slice(-8);
      save(st);
    }
  }
}
async function flushOutbox(st) {
  if (!st.outbox?.length || !isOpen()) return;
  const to = st.reportTo || ownJid(); if (!to) return;
  const pending = st.outbox.slice(); st.outbox = []; save(st);
  for (const t of pending) {
    try { await liveSock().sendMessage(to, { text: t }); }
    catch { st.outbox.push(t); }
  }
  save(st);
}

const sleepC = async (ms) => { const end = Date.now() + ms; while (Date.now() < end && !cancelFlag) await mp.sleep(Math.min(1000, end - Date.now())); };
const pairKey = (item, g) => `${item}|${g}`;

// ── the loop ────────────────────────────────────────────────────────────────
async function tick() {
  if (active || !isOpen()) return;
  const st = load();
  await flushOutbox(st);
  if (mp.runState.by) return;                       // a manual post is running; try again next tick
  const now = Date.now();

  // crashed / restarted mid-run → resume with what's still missing
  if (st.run && st.run.status === 'running') {
    st.run.crashes = (st.run.crashes || 0) + 1;
    if (st.run.crashes > 3) {                                   // same failure over and over — stop, don't loop forever
      st.run.status = 'done'; st.run.finishedAt = now; st.run.note = 'stopped after repeated interruptions'; save(st);
      await notify(st, '⚠️ *Smart post stopped* — it was interrupted several times in a row. Check the bot logs, then run *mpsmart now*.');
      return;
    }
    st.run.status = 'waiting-retry'; st.run.nextRetryAt = now + 2 * 60 * 1000; st.run.note = 'resumed after restart';
    save(st);
    return;
  }
  if (st.run && st.run.status === 'waiting-retry') {
    if (now >= st.run.nextRetryAt) await guarded(() => runPass(st, 'retry'));
    return;
  }
  if (!st.enabled) return;

  const nowD = new Date(); const today = dayKey(nowD);
  if (!st.plan || st.plan.date < today || (st.plan.date === today && st.lastRunDate === today)) {
    st.plan = pickPlan(nowD, st.window, st.lastRunDate === today);
    save(st);
  }
  if (st.plan.date === today && now >= st.plan.at && st.lastRunDate !== today) {
    const endToday = atMin(nowD, parseClock(st.window.to)).getTime();
    if (now > endToday + CATCHUP_GRACE_MIN * 60 * 1000) {            // bot was offline too long — skip today
      st.lastRunDate = today;
      st.history.unshift({ date: today, trigger: 'schedule', status: 'missed', note: 'bot was offline during the window' });
      st.history = st.history.slice(0, HISTORY_MAX);
      st.plan = pickPlan(nowD, st.window, true); save(st);
      await notify(st, `⚠️ *Smart post missed today* — the bot was offline during the posting window.\nNext run: ${fmtTime(st.plan.at)}`);
      return;
    }
    await guarded(() => startRun(st, 'schedule'));
  }
}

async function guarded(fn) {
  if (active) return false;
  active = true; cancelFlag = false; mp.runState.by = 'smart';
  try { await fn(); } catch (e) { console.log('marketplaceSmart run error:', e.stack || e.message); }
  finally { active = false; mp.runState.by = null; }
  return true;
}

async function startRun(st, trigger) {
  const now = new Date(); const today = dayKey(now);
  const listings = await mp.loadListings();
  const items = Object.values(listings).filter((i) => i.status === 'active').slice(0, mp.MAX_ITEMS_PER_RUN).map((i) => i.id);
  const groups = await mp.loadGroups();
  st.lastRunDate = today;
  st.plan = pickPlan(now, st.window, true);
  if (!items.length || !groups.length) {
    st.history.unshift({ date: today, trigger, status: 'skipped', note: !items.length ? 'no active products' : 'no groups saved' });
    st.history = st.history.slice(0, HISTORY_MAX); save(st);
    await notify(st, `ℹ️ *Smart post skipped* — ${!items.length ? 'no active products' : 'no groups saved'}.\nNext run: ${fmtTime(st.plan.at)}`);
    return;
  }
  st.run = { id: mp.generateId ? mp.generateId() : String(Date.now()), date: today, trigger, startedAt: Date.now(), status: 'running',
    items, groups, names: {}, done: {}, failed: {}, deadGroups: {}, pass: 0, retries: 0, nextRetryAt: null, note: '' };
  save(st);
  await notify(st, `🧠 *Smart post starting* (${trigger})\n${items.length} product(s) → ${groups.length} group(s)\n_Takes a while — delays between sends keep the account safe._`);
  await runPass(st, 'initial');
}

function pendingPairs(run) {
  const out = [];
  for (const it of run.items) for (const g of run.groups) {
    const k = pairKey(it, g);
    if (run.done[k] || run.deadGroups[g]) continue;
    const f = run.failed[k];
    if (f && !f.retryable) continue;
    out.push(k);
  }
  return out;
}

function botIsAdmin(meta) {
  const me = liveSock(); const ids = new Set([norm(me?.user?.id), norm(me?.user?.lid)].filter(Boolean));
  return (meta?.participants || []).some((p) =>
    (ids.has(norm(p.id)) || ids.has(norm(p.lid)) || ids.has(norm(p.phoneNumber))) && (p.admin === 'admin' || p.admin === 'superadmin'));
}

async function runPass(st, kind) {
  const run = st.run; run.status = 'running'; run.pass += 1; save(st);
  if (kind === 'retry') {
    await notify(st, `🔁 *Smart post — retry ${run.retries}/${RETRY_DELAYS_MIN.length}*\n${pendingPairs(run).length} post(s) still missing.`);
  }

  // one request tells us which groups the bot is still in
  const names = await mp.groupNames(liveSock(), true);
  for (const g of run.groups) run.names[g] = (names && names[g]) || mp.knownName(g) || run.names[g] || g;
  const dead = (g, category, reason) => { run.deadGroups[g] = { category, reason }; };
  const groupsWithWork = new Set(pendingPairs(run).map((k) => k.split('|')[1]));
  for (const g of groupsWithWork) {
    if (names && !names[g]) { dead(g, 'left', 'Bot is no longer in this group (removed or left)'); continue; }
    try {
      const meta = await require('./groupMetaCache').get(liveSock(), g);
      if (meta?.announce && !botIsAdmin(meta)) dead(g, 'locked', 'Group is locked (admins only) and the bot is not an admin');
    } catch { /* can't tell — let the send decide */ }
  }
  save(st);

  const listings = await mp.loadListings();
  let streak = 0; let aborted = false;
  let remaining = pendingPairs(run).length;

  for (let n = 0; n < run.items.length && !cancelFlag && !aborted; n++) {
    const id = run.items[n];
    const gs = run.groups.filter((g) => !run.deadGroups[g] && !run.done[pairKey(id, g)] && !(run.failed[pairKey(id, g)] && !run.failed[pairKey(id, g)].retryable));
    if (!gs.length) continue;
    const item = listings[id];
    if (!item || item.status !== 'active') {                                 // removed meanwhile
      for (const g of gs) run.failed[pairKey(id, g)] = { category: 'item-removed', retryable: false, reason: 'Product was removed/deactivated', attempts: 0, at: Date.now() };
      save(st); continue;
    }
    const caption = mp.buildPostCaption(item);
    const files = await mp.resolveItemMedia(item);
    if (!files.length && !caption) {
      for (const g of gs) run.failed[pairKey(id, g)] = { category: 'media-missing', retryable: false, reason: 'No media or caption to post', attempts: 0, at: Date.now() };
      save(st); continue;
    }
    let anyOk = false;
    for (const g of gs) {
      if (cancelFlag || aborted) break;
      if (run.deadGroups[g]) continue;                                       // died earlier in this very item loop
      const k = pairKey(id, g);
      try {
        const ids = await mp.sendPostRetry(liveSock, g, files, caption, () => cancelFlag);
        await mp.recordSent(id, ids);
        run.done[k] = { at: Date.now() }; delete run.failed[k]; anyOk = true; streak = 0;
      } catch (e) {
        const c = classify(e);
        run.failed[k] = { category: c.category, retryable: c.retryable, reason: c.reason, error: shortMsg(e), attempts: ((run.failed[k] || {}).attempts || 0) + 1, at: Date.now() };
        console.log(`marketplaceSmart ${id}→${g}: ${c.category}: ${shortMsg(e)}`);
        if (!c.retryable && c.scope === 'group') dead(g, c.category, c.reason);
        else if (c.retryable) { streak += 1; if (streak >= mp.MAX_CONSECUTIVE_FAILS) aborted = true; }
      }
      save(st);
      remaining -= 1;
      if (remaining > 0 && !cancelFlag && !aborted) await sleepC(mp.randomBetween(mp.GROUP_DELAY));
    }
    if (anyOk) await mp.markItemPosted(id);
    if (!cancelFlag && !aborted && n < run.items.length - 1) await sleepC(mp.randomBetween(mp.ITEM_DELAY));
  }
  await finishPass(st, { aborted });
}

function stats(run) {
  const total = run.items.length * run.groups.length;
  const sent = Object.keys(run.done).length;
  const retryable = pendingPairs(run).length;
  return { total, sent, retryable, permanent: total - sent - retryable };
}

function groupLines(st, run, final) {
  const lines = [];
  for (const g of run.groups) {
    const ok = run.items.filter((it) => run.done[pairKey(it, g)]).length;
    if (ok === run.items.length) continue;
    const fails = run.items.map((it) => run.failed[pairKey(it, g)]).filter(Boolean);
    const dead = run.deadGroups[g];
    const reasons = {};
    for (const f of fails) reasons[f.reason] = (reasons[f.reason] || 0) + 1;
    const top = dead?.reason || Object.entries(reasons).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Not attempted yet';
    const retry = dead ? 'no retry' : (final ? 'gave up' : 'will retry');
    const nm = run.names[g] && run.names[g] !== g ? run.names[g] : (st.groupHealth[g]?.name || 'Name unavailable');
    let line = `• *${nm}*\n  \`${g}\`\n  ${top}\n  ${ok}/${run.items.length} posted · ${retry}`;
    const h = st.groupHealth[g];
    if (final && h && h.fails >= CHRONIC_DAYS) line += `\n  ⚠️ failed ${h.fails} days in a row — consider *mpgremove ${g}*`;
    lines.push(line);
  }
  return lines;
}

async function finishPass(st, { aborted }) {
  const run = st.run; const now = Date.now();
  const s = stats(run);
  let text; let final = false;

  if (cancelFlag) {
    run.status = 'cancelled'; final = true;
    text = `⏹️ *Smart post cancelled* — ${s.sent}/${s.total} posted.`;
  } else if (s.retryable > 0 && run.retries < RETRY_DELAYS_MIN.length && now < run.startedAt + RETRY_DEADLINE_H * 3600 * 1000) {
    const base = RETRY_DELAYS_MIN[run.retries] * 60 * 1000;
    run.retries += 1; run.status = 'waiting-retry';
    run.nextRetryAt = now + Math.round(base * (0.8 + Math.random() * 0.4));
    text = `${aborted ? '⚠️ *Connection trouble* — paused early.\n' : ''}📊 *Smart post — ${s.sent}/${s.total} posted so far*\n` +
      `⏳ Retry ${run.retries}/${RETRY_DELAYS_MIN.length} at *${fmtHM(run.nextRetryAt)}* — ${s.retryable} post(s) still missing (only those will be retried).`;
  } else {
    run.status = 'done'; final = true;
    text = `✅ *Smart post finished — ${s.sent}/${s.total} posted*` + (s.retryable ? `\n⚠️ ${s.retryable} post(s) still failing after ${run.retries} retries.` : '');
  }

  if (final) {
    run.finishedAt = now;
    // day-streak tracking per group (once per run)
    for (const g of run.groups) {
      const ok = run.items.some((it) => run.done[pairKey(it, g)]);
      const h = st.groupHealth[g] || { fails: 0 };
      if (ok) { h.fails = 0; h.lastOkAt = now; } else { h.fails += 1; h.lastReason = (run.deadGroups[g]?.reason) || 'failed'; }
      h.name = run.names[g] || h.name; st.groupHealth[g] = h;
    }
    st.history.unshift({ date: run.date, trigger: run.trigger, status: run.status, items: run.items.length, groups: run.groups.length,
      sent: s.sent, failed: s.total - s.sent, retries: run.retries, startedAt: run.startedAt, finishedAt: now });
    st.history = st.history.slice(0, HISTORY_MAX);
    if (st.enabled && st.plan) text += `\n🗓️ Next run: ${fmtTime(st.plan.at)}`;
  }

  const gl = groupLines(st, run, final);
  if (gl.length) text += `\n\n*Groups with problems (${gl.length}):*\n${gl.join('\n')}`;
  save(st);
  await notify(st, text);
}

// ── public API (used by .mpsmart) ───────────────────────────────────────────
function enable(window, reportTo) {
  const st = load();
  st.enabled = true; st.window = window || st.window || { ...DEFAULT_WINDOW };
  if (reportTo) st.reportTo = reportTo;
  st.plan = pickPlan(new Date(), st.window, st.lastRunDate === dayKey(new Date()));
  save(st);
  return st;
}
function disable() {
  const st = load(); st.enabled = false; st.plan = null; save(st); return st;
}
function cancel() {
  const st = load();
  if (active) { cancelFlag = true; return 'Stopping the current smart run…'; }
  if (st.run && st.run.status === 'waiting-retry') {
    st.run.status = 'cancelled'; st.run.finishedAt = Date.now(); save(st); return 'Pending retries cancelled.';
  }
  return 'Nothing to cancel.';
}
async function runNow(reportTo) {
  if (active || mp.runState.by) return { ok: false, msg: `Busy — ${mp.runState.by || 'smart'} post in progress.` };
  const st = load();
  if (st.run && st.run.status === 'waiting-retry') return { ok: false, msg: 'A run is waiting to retry. Use *mpsmart retry* or *mpsmart cancel*.' };
  if (!isOpen()) return { ok: false, msg: 'Bot is not connected right now.' };
  if (reportTo) st.reportTo = reportTo;
  save(st);
  guarded(() => startRun(load(), 'manual')).catch(() => {});
  return { ok: true, msg: 'Smart run started — progress and failures will be DM’d to you.' };
}
async function retryNow() {
  const st = load();
  if (active || mp.runState.by) return { ok: false, msg: 'A post is already running.' };
  if (!st.run || st.run.status !== 'waiting-retry') return { ok: false, msg: 'Nothing is waiting to retry.' };
  if (!isOpen()) return { ok: false, msg: 'Bot is not connected right now.' };
  st.run.nextRetryAt = Date.now(); save(st);
  guarded(() => runPass(load(), 'retry')).catch(() => {});
  return { ok: true, msg: 'Retrying the missing posts now.' };
}

function status() {
  const st = load();
  const L = [];
  L.push(`*Smart post:* ${st.enabled ? '🟢 ON' : '⚪ OFF'}`);
  L.push(`Window: ${st.window.from}–${st.window.to} (random time, bot timezone)`);
  if (st.enabled && st.plan) L.push(`Next run: *${fmtTime(st.plan.at)}*`);
  const run = st.run;
  if (active) L.push('Now: 🏃 posting…');
  else if (run && run.status === 'waiting-retry') L.push(`Now: ⏳ retry ${run.retries}/${RETRY_DELAYS_MIN.length} at ${fmtHM(run.nextRetryAt)} — ${pendingPairs(run).length} post(s) missing`);
  if (run && ['done', 'cancelled', 'running', 'waiting-retry'].includes(run.status)) {
    const s = stats(run);
    L.push(`Last run (${run.date}, ${run.trigger}): ${s.sent}/${s.total} posted · ${run.status}`);
  }
  const chronic = Object.entries(st.groupHealth).filter(([, h]) => h.fails >= CHRONIC_DAYS);
  if (chronic.length) {
    L.push(`\n⚠️ *Failing ${CHRONIC_DAYS}+ days in a row:*`);
    for (const [g, h] of chronic) L.push(`• ${h.name || g}\n  \`${g}\` — ${h.lastReason || 'failed'}`);
  }
  return L.join('\n');
}
function lastReport() {
  const st = load(); const run = st.run;
  if (!run) return '_No smart run yet._';
  const s = stats(run);
  let t = `*Last smart run — ${run.date}* (${run.trigger}, ${run.status})\n${s.sent}/${s.total} posted · ${run.retries} retries\n`;
  const posted = run.items.map((it) => `#${it}: ${run.groups.filter((g) => run.done[pairKey(it, g)]).length}/${run.groups.length} groups`);
  t += `\n*Products*\n${posted.join('\n')}`;
  const gl = groupLines(st, run, run.status !== 'waiting-retry');
  t += gl.length ? `\n\n*Groups with problems*\n${gl.join('\n')}` : '\n\n✅ No problem groups.';
  return t;
}

module.exports = {
  attach, attachBot, tick, enable, disable, cancel, runNow, retryNow, status, lastReport, parseWindow, fmtTime, isActive: () => active,
  // exposed for tests
  _t: { classify, pickPlan, parseClock, RETRY_DELAYS_MIN, load, save, FILE, pendingPairs },
};
