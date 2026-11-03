#!/usr/bin/env node
/* =====================================================================
 * push.js — ad-monitor 企微定时推送（独立执行，不依赖任何人开电脑）
 *
 * 【口径从哪来】直接读线上看板 /api/snapshot（系统自己算好的那份），
 *   不在这里重算 AP、不重写渠道归因 —— 避免"两套口径打架"。
 *   AP 的唯一出口在主系统 lib/metrics.js#apOf：payUsers>0 ? recharge/payUsers : 0
 *
 * 【判据（与主系统 notify 一致）】
 *   在投(status=active) + AP>60 + 付费用户>0 + 有负责人
 *
 * 【打扰控制】
 *   ① 推送时段（默认：周一~周日 00:00-24:00，全天；可用 PUSH_DAYS/PUSH_START/PUSH_END 收窄）
 *   ② 内容没变就不推（.state/last.json 记上次指纹）
 *   ③ 方案 A（2026-10-29）：推送前查沙箱 /api/notify/pushed，今天沙箱已推过的计划不重推
 *      （查询失败按"没推过"处理，可用性优先）
 * 需要环境变量：APP_PASSWORD（过访问口令闸）、WECOM_WEBHOOK（群机器人）
 * ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

/* 【2026-10-26 重新首发】新站 + 平台分享码校验（不带 sharecode 的请求被平台 403 拦下） */
const BASE = (process.env.BASE_URL || 'https://ad-monitor-dashboard-87745.app.workbuddy.host').replace(/\/$/, '');
const SHARECODE = process.env.SHARECODE || 'Q26D2NW5HK';
const withShare = (u) => u + (u.includes('?') ? '&' : '?') + 'sharecode=' + encodeURIComponent(SHARECODE);
const AP_MIN = Number(process.env.AP_MIN || 60);
const DRY = process.env.DRY_RUN === '1';
const STATE_DIR = path.join(process.cwd(), '.state');
const STATE_FILE = path.join(STATE_DIR, 'last.json');

const PW = (process.env.APP_PASSWORD || '').trim();
const HOOK = (process.env.WECOM_WEBHOOK || '').trim();

/* 【公开仓库日志纪律（2026-11-03）】仓库公开后 Actions 运行日志任何人可见，
 * 所以本脚本所有 console 输出**只允许计数与状态**，禁止出现：
 * 计划名 / AP / 花费 / 负责人名 / 手机号 / userid / 完整消息内容 / 带 sharecode 的 URL。
 * DRY RUN 也一样 —— 要看明细就去企微群里看真消息，别靠日志。 */
function log(msg) { console.log('[' + new Date().toISOString() + '] ' + msg); }

/* ---- 推送时段：默认周一~周日 全天 ----
 * PUSH_DAYS="1-7"（1=周一 … 7=周日，可写 "1-5" 或 "1,3,5"）
 * PUSH_START / PUSH_END 为北京时间 HH[:MM]，END=24 表示当日 24:00（即含 23:59）
 * 例：想回到工作时段 → PUSH_DAYS=1-5 PUSH_START=9 PUSH_END=20:30 */
function hmToMin(s, dflt) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return dflt;
  if (t === '24') return 24 * 60;
  const m = /^(\d{1,2})(?::(\d{1,2}))?$/.exec(t);
  if (!m) return dflt;
  return Number(m[1]) * 60 + Number(m[2] || 0);
}
function daySet(spec) {
  const set = new Set();
  String(spec || '1-7').split(',').forEach(seg => {
    const p = seg.trim().split('-');
    const a = Number(p[0]);
    const b = p.length > 1 ? Number(p[1]) : a;
    if (!isFinite(a) || !isFinite(b)) return;
    for (let d = a; d <= b; d++) if (d >= 1 && d <= 7) set.add(d);
  });
  return set.size ? set : new Set([1, 2, 3, 4, 5, 6, 7]);
}
const PUSH_DAYS = daySet(process.env.PUSH_DAYS || '1-7');
const PUSH_START = hmToMin(process.env.PUSH_START, 0);
const PUSH_END = hmToMin(process.env.PUSH_END, 24 * 60);

function inPushWindow(now) {
  const bj = new Date(now.getTime() + 8 * 3600e3);        // UTC → 北京
  const dow = bj.getUTCDay() === 0 ? 7 : bj.getUTCDay();  // 1=周一 … 7=周日
  if (!PUSH_DAYS.has(dow)) return false;
  const min = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  return min >= PUSH_START && min < PUSH_END;
}
function windowText() {
  const days = [...PUSH_DAYS].sort().join(',');
  const fmt = m => (m >= 24 * 60 ? '24:00' : String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'));
  return '星期' + days + ' ' + fmt(PUSH_START) + '-' + fmt(PUSH_END);
}

async function login() {
  const r = await fetch(withShare(BASE + '/__login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'pw=' + encodeURIComponent(PW),
    redirect: 'manual',
  });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  /* 【2026-10-29 硬化】只认闸自己的 Cookie（adm_access）—— 2026-10-29 实测线上
   * 「口令不对」页也回 200 + 平台层 Set-Cookie，只判"有 Cookie"会把口令错当成
   * 登录成功，然后 snapshot 拿回口令页 HTML 在 JSON.parse 处才炸（报错误导人）。
   * 另：404 = 实例没启用口令闸（本机开发形态）⇒ 直接走，方便对本地实例联调。 */
  if (r.status === 404) { log('实例未启用口令闸（本机开发形态），跳过登录'); return ''; }
  if (!sc.some(x => /(?:^|;)\s*adm_access=/.test(String(x)))) {
    throw new Error('口令闸登录失败（status ' + r.status + '）：口令不对，检查 APP_PASSWORD');
  }
  return sc.map(x => String(x).split(';')[0]).join('; ');
}

async function snapshot(cookie) {
  const r = await fetch(withShare(BASE + '/api/snapshot'), { headers: cookie ? { Cookie: cookie } : {} });
  if (r.status !== 200) throw new Error('/api/snapshot 返回 ' + r.status);
  const j = await r.json();
  return (j && j.data) ? j.data : j;      /* 该端点裸返回，两种都兼容 */
}

/* 【方案 A（2026-10-29）：兜底去重】推送前先问沙箱"今天哪些计划已经推过了"
 * （GET /api/notify/pushed，口令闸内只读），把沙箱已推过的计划滤掉 ——
 * 消除"同一条计划群里看到两种格式两条消息"（沙箱事件推送 + 本定时任务各发各的）。
 * "今天"按北京时间 0 点裁剪（条目带原始 ts，沙箱不猜时区）。
 * 查询失败（端点不在/网络抖动）按"沙箱没推过"处理 —— 可用性优先于去重，宁可多推不漏推。 */
async function pushedNames(cookie) {
  try {
    const r = await fetch(withShare(BASE + '/api/notify/pushed'), { headers: cookie ? { Cookie: cookie } : {} });
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const items = (j && j.items) || [];
    const bjDay = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const dayStart = Date.parse(bjDay + 'T00:00:00Z') - 8 * 3600e3;   // 北京当天 0 点（UTC ms）
    const set = new Set();
    items.forEach(x => { if (Number(x.ts) >= dayStart && x.name) set.add(String(x.name)); });
    log('沙箱已推清单：今天 ' + set.size + ' 个');
    return set;
  } catch (e) {
    log('已推清单查询失败（' + (e && e.message) + '），按"沙箱没推过"处理');
    return null;
  }
}

/* 【沙箱某天推过哪些（2026-11-03）】补报前先查沙箱台账（GET /api/notify/ledger，
 * 全量 pushLog，按 campaignId 记、带 day），把 ids 映射回计划名 ——
 * 避免"沙箱白天推过、兜底凌晨又补一遍"的重复打扰。
 * 台账查询失败按"没推过"处理：宁可多推，不漏推。 */
async function sandboxPushedNames(cookie, dayWanted, idToName) {
  try {
    const r = await fetch(withShare(BASE + '/api/notify/ledger'), { headers: cookie ? { Cookie: cookie } : {} });
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const pl = (j && j.pushLog) || {};
    const set = new Set();
    Object.keys(pl).forEach(id => {
      const rec = pl[id];
      if (rec && rec.day === dayWanted && idToName[id]) set.add(String(idToName[id]));
    });
    log('沙箱 ' + dayWanted + ' 已推 ' + set.size + ' 个');
    return set;
  } catch (e) {
    log('沙箱台账查询失败（' + (e && e.message) + '），按"没推过"处理');
    return null;
  }
}

/* 判据与主系统一致：AP 唯一出口 apOf，payUsers=0 不推 */
const apOf = c => (c && Number(c.payUsers) > 0) ? Number(c.recharge || 0) / Number(c.payUsers) : 0;

function pickTargets(snap) {
  return (snap.campaigns || [])
    .filter(c => c.status === 'active')
    .filter(c => Number(c.payUsers) > 0)
    .map(c => ({ c, ap: apOf(c) }))
    .filter(x => x.ap > AP_MIN)
    .filter(x => x.c.ownerName)                 /* 有负责人才推 */
    .sort((a, b) => b.ap - a.ap);
}

/* 【昨日补报的口径（2026-11-03）】用 historyDaily 里**昨天那一行**重算合格名单。
 * 为什么不用当天的 pickTargets：跨天后当天 payUsers 归零，深夜达标永远查不到。
 * recharge/payUsers 是日累计，昨天最后一行的值就是昨天的最终口径 ——
 * 只要昨天任意时刻达到过 AP>60 且最终仍 >60，这里都能兜住。
 * 历史行挂在计划对象上（老版本挂在顶层 historyDaily），两处都兼容。 */
function pickTargetsFromHistory(snap, yday) {
  const top = (snap && snap.historyDaily) || {};
  return ((snap && snap.campaigns) || [])
    .map(c => {
      let rows = c.historyDaily || top[c.id] || [];
      if (!Array.isArray(rows)) rows = Object.values(rows);
      const r = rows.find(x => x && x.date === yday);
      if (!r) return null;
      const ap = (Number(r.payUsers) > 0) ? Number(r.recharge || 0) / Number(r.payUsers) : 0;
      if (!(ap > AP_MIN)) return null;
      if (!c.ownerName) return null;            /* 与 pickTargets 同款：有负责人才推 */
      return { c: { name: c.name, ownerName: c.ownerName, spend: r.spend || 0 }, ap };
    })
    .filter(Boolean)
    .sort((a, b) => b.ap - a.ap);
}

function buildMessage(targets, title) {
  const byOwner = {};
  targets.forEach(x => {
    const o = x.c.ownerName;
    (byOwner[o] = byOwner[o] || []).push(x);
  });
  const lines = [];
  lines.push('## ' + (title || ('投放监控 · 重点计划 ' + targets.length + ' 个（AP>' + AP_MIN + '）')));
  lines.push('');
  Object.keys(byOwner).forEach(owner => {
    lines.push('**' + owner + '**（' + byOwner[owner].length + ' 个）');
    byOwner[owner].forEach(x => {
      const n = String(x.c.name || '');
      lines.push('> ' + (n.length > 34 ? n.slice(0, 34) + '…' : n) + ' · AP ' + x.ap.toFixed(0)
        + ' · 花费 ¥' + Math.round(Number(x.c.spend || 0)));
    });
    lines.push('');
  });
  lines.push('<font color="comment">' + new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + '（北京时间）</font>');
  return lines.join('\n');
}

/* 【真 @（2026-11-03）】兜底消息也要 @ 到人 —— 之前负责人只是加粗文字，群里
 * 没有提醒。沙箱有未脱敏名单端点（GET /api/notify/mentions，口令闸内）。
 * 查询失败不挡主流程：digest 照发，只是这条不带 @。 */
async function mentionItems(cookie) {
  try {
    const r = await fetch(withShare(BASE + '/api/notify/mentions'), { headers: cookie ? { Cookie: cookie } : {} });
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return (j && j.items) || [];
  } catch (e) {
    log('@ 名单查询失败（' + (e && e.message) + '），本条不带 @');
    return null;
  }
}

/* @ 的载体是**单独一条 text 消息**：markdown 的 <@userid> 只认成员账号，
 * 而名单里配的多是手机号 —— text 的 mentioned_mobile_list 认手机号、
 * mentioned_list 认 userid，按服务端给的 mobile 标记分流，两种都稳。 */
async function pushMention(owners, items) {
  if (!Array.isArray(items) || !items.length) return { skipped: 'no-items' };
  const byName = {};
  items.forEach(x => { byName[String(x.name || '').trim()] = x; });
  const mobiles = [], users = [], names = [];
  const seen = new Set();
  (owners || []).forEach(o => {
    const key = String(o || '').trim();
    const m = byName[key];
    if (!m || !m.id || seen.has(key)) return;
    seen.add(key);
    (m.mobile ? mobiles : users).push(m.id);
    names.push('@' + key);
  });
  if (!names.length) return { skipped: 'no-config' };
  const content = names.join(' ') + ' 以上重点计划请关注（AP>' + AP_MIN + '）';
  if (DRY) {
    /* 脱敏：不打印 content（含计划名/AP/负责人），只打印计数与载体分布 */
    console.log('--- DRY RUN，@ 消息：拟 @ ' + names.length + ' 人'
      + '（mobiles=' + mobiles.length + '，users=' + users.length + '），明细已脱敏 ---');
    return { ok: true, dry: true };
  }
  const text = { content };
  if (mobiles.length) text.mentioned_mobile_list = mobiles;
  if (users.length) text.mentioned_list = users;
  const r = await fetch(HOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text }),
  });
  const j = await r.json().catch(() => ({}));
  const ok = j && (j.errcode === 0 || j.errcode === undefined);
  return { ok, detail: j };
}

async function push(content) {
  /* 脱敏：DRY 只报长度，不落消息内容（公开仓库日志可见） */
  if (DRY) { console.log('--- DRY RUN，消息 ' + content.length + ' 字符（明细已脱敏）---'); return { ok: true, dry: true }; }
  const r = await fetch(HOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
  });
  const j = await r.json().catch(() => ({}));
  const ok = j && (j.errcode === 0 || j.errcode === undefined);
  return { ok, detail: j };
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function writeState(s) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { /* 无缓存也不影响推送 */ }
}

(async () => {
  if (!PW) { console.error('缺少 APP_PASSWORD'); process.exit(2); }
  if (!HOOK && !DRY) { console.error('缺少 WECOM_WEBHOOK'); process.exit(2); }

  log('推送时段：' + windowText());
  if (!inPushWindow(new Date())) { log('不在推送时段（' + windowText() + '），跳过'); return; }

  const cookie = await login();
  log('已过口令闸');
  /* 【先唤醒、等一轮同步、再读数（2026-11-02）】沙箱是"访问唤醒"型：这次请求把实例
   * 唤醒后，第一次读到的往往是**上次落盘的旧快照**（同步轮次还没跑完）—— 周末延迟
   * 2.5 小时就是这么来的。所以这里读两次：第一次唤醒 + 顺手触发同步，等 SYNC_WAIT_MS
   * （默认 20 秒，沙箱同步间隔 5 秒，够跑完一轮），再读第二次，取同步时间更新的那份。
   * 两次读的间隙实例保持存活（本次连接还没断），同步在后台继续跑。 */
  const s1 = await snapshot(cookie);
  log('第一次快照：' + (s1.campaigns || []).length + ' 个计划 · 同步时间 '
    + (((s1.sync || {}).lastSyncTs) ? new Date(s1.sync.lastSyncTs).toISOString() : '未知'));
  await new Promise(r => setTimeout(r, Number(process.env.SYNC_WAIT_MS || 20000)));
  const s2 = await snapshot(cookie);
  const ts1 = Number((s1.sync || {}).lastSyncTs) || 0;
  const ts2 = Number((s2.sync || {}).lastSyncTs) || 0;
  const snap = ts2 >= ts1 ? s2 : s1;
  log((ts2 >= ts1 ? '第二次' : '第一次（第二次反而旧，罕见）') + '快照：' + (snap.campaigns || []).length
    + ' 个计划 · 同步时间 ' + (Math.max(ts1, ts2) ? new Date(Math.max(ts1, ts2)).toISOString() : '未知'));

  let targets = pickTargets(snap);
  log('命中判据：' + targets.length + ' 个');

  const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(day + 'T00:00:00Z') - 86400e3).toISOString().slice(0, 10);
  const st = readState();

  /* 【昨日补报（2026-11-03 用户报：昨晚达标的计划企微没 @）】深夜达标的计划
   * 两个通道都会整体漏掉：沙箱睡着（没人开看板就不跑推送），而 Actions 下一轮
   * 跑到时已过 0 点 —— 当天 payUsers 归零、AP 算不出，判据永远不再命中。
   * 补法：state.compensatedFor 记"补到哪天了"；**每天第一跑必对昨天补一次账**
   * （不能用 st.day!==day 判断 —— 旧版代码跨天也会把 day 滚到今天，那样
   * 第一天上线时昨天的漏网之鱼就永远补不上，2026-11-03 的 360屏保 就是活例）。
   * 口径：快照 historyDaily 里**昨天那一行**重算合格名单（recharge/payUsers 是
   * 日累计，深夜最后一笔也算在内），减去「沙箱台账昨天推过的」和「本兜底昨天
   * 推过的」⇒ 剩下的补一条（带 @）。一天最多补一次；查询失败宁可多推。 */
  if (st.compensatedFor !== yesterday) {
    /* 沙箱昨天已推的也要排除（台账全量 pushLog 里 day===昨天的条目），
     * 否则白天沙箱推过、凌晨兜底又补一遍，群里刷屏。 */
    const idToName = {};
    ((snap && snap.campaigns) || []).forEach(c => { if (c && c.id) idToName[c.id] = String(c.name || ''); });
    const pushedYday = new Set((st.pushed && st.pushed[yesterday]) || []);
    const sb = await sandboxPushedNames(cookie, yesterday, idToName);
    if (sb) sb.forEach(n => pushedYday.add(n));
    const yd = pickTargetsFromHistory(snap, yesterday);
    const missed = yd.filter(x => !pushedYday.has(String(x.c.name || '')));
    if (missed.length) {
      log('昨日补报：' + yesterday + ' 合格 ' + yd.length + ' 个，其中没推过 ' + missed.length + ' 个');
      const content = buildMessage(missed,
        '投放监控 · 昨日补报 ' + missed.length + ' 个（' + yesterday + ' 数据，AP>' + AP_MIN + '）');
      const r = await push(content);
      if (!r.ok) { console.error('补报推送失败：' + JSON.stringify(r.detail)); process.exit(1); }
      const mr = await pushMention(missed.map(x => x.c.ownerName), await mentionItems(cookie));
      log('补报已推（' + missed.length + ' 个，@=' + (mr.ok ? '已发' : JSON.stringify(mr).slice(0, 120)) + '）');
      st.pushed = st.pushed || {};
      st.pushed[yesterday] = (st.pushed[yesterday] || []).concat(missed.map(x => x.c.name));
    }
    st.compensatedFor = yesterday;
    writeState(st);   /* 标记/记录立刻落盘：后面就算提前 return，补报也不能重复发 */
  }

  if (!targets.length) { log('没有 AP>' + AP_MIN + ' 的重点计划，不推送'); return; }

  /* 【方案 A】滤掉沙箱今天已推过的计划；全被滤掉 = 沙箱通道正常工作，兜底不打扰。 */
  const pushed = await pushedNames(cookie);
  if (pushed) {
    const before = targets.length;
    targets = targets.filter(x => !pushed.has(String(x.c.name || '')));
    log('沙箱今天已推 ' + (before - targets.length) + ' 个，兜底剩 ' + targets.length + ' 个');
    if (!targets.length) { log('重点计划沙箱通道已全部推过，兜底通道不打扰'); return; }
  }

  /* 【跨天不再重播（2026-11-02 用户报：每天 0 点把昨天的数据重新播一遍）】
   * 老判据 st.day === day && st.key === key：跨天 state.day 变了 ⇒ 同样内容被当成
   * "今天首次"全量重发 —— 而 0 点刚过时沙箱读到的还是昨天的数据（访问唤醒 + 平台
   * 日切时间差），于是每天 0 点把昨天的数播一遍。现在指纹**跨天比较**：内容（计划名+AP）
   * 和上次推送完全一样就不发，管它是今天还是昨天推的；AP 真变了才推。 */
  const key = targets.map(x => x.c.name + ':' + x.ap.toFixed(0)).join('|');
  if (st.key === key) {
    log('内容与上次推送完全相同（上次 ' + (st.day || '?') + '，今天 ' + day + '）—— 不重复打扰，跨天也不重播');
    writeState(Object.assign({}, st, { day, key, ts: Date.now() }));
    return;
  }

  const content = buildMessage(targets);
  const r = await push(content);
  if (!r.ok) { console.error('推送失败：' + JSON.stringify(r.detail)); process.exit(1); }
  /* 【真 @】digest 发出后补一条 text @；名单查不到就只发 digest，不挡主流程。 */
  const mr = await pushMention(targets.map(x => x.c.ownerName), await mentionItems(cookie));
  log('已推送（' + targets.length + ' 个计划，@=' + (mr.ok ? '已发' : '未发') + '）');
  /* 记录今天实际推过的计划名（供跨天补报比对），只留最近 3 天，state 不无限膨胀 */
  const pushedKeep = {};
  Object.keys(st.pushed || {}).sort().slice(-2).forEach(d => { pushedKeep[d] = st.pushed[d]; });
  pushedKeep[day] = ((st.pushed || {})[day] || []).concat(targets.map(x => x.c.name));
  writeState(Object.assign({}, st, { day, key, ts: Date.now(), pushed: pushedKeep }));
})().catch(e => { console.error('失败：' + (e && e.message)); process.exit(1); });
