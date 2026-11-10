#!/usr/bin/env node
/* =====================================================================
 * paytrack-broadcast.js — 付费用户流失播报（独立群，2026-11-09 新增）
 *
 * 【分工】判定与台账全在主系统（lib/paytrack.js#broadcastFeed/Ack，唯一出口），
 *   本脚本只是哑终端：到点 → 拉 feed → 逐条发企微 → 发一条 ack 一条。
 * 【2026-11-10 用户口径】播报内容 = 一条「太始 · 付费跟踪数据速览」（区间对比/状态/
 *   充值 Top10/需跟进），带红点的流失明细消息不再下发；速览发成功后仍 ack 候选人，
 *   保证「同一节点不重复提示」的台账语义。
 *   规则（用户 11-09 拍板）：>5000 当天未登录 / >1000 满1天 / >200 满2天 触发
 *   第一次；离线满 7 天第二次；自然月最多 2 次；回归重置；kf 数据停更 >6h 熔断。
 *
 * 【触发】仓库 cron + 本机 dispatch 外部触发，这里自己判断北京时间：
 *   10:30 与 17:30 两个宽窗口（[10:30,13:00) / [17:30,21:00)，抵消 GitHub cron 限流延迟），
 *   窗口内第一跑发送；state 记当天已发时段，之后的重跑直接跳过（一天一次）。
 *
 * 【防重】两层：
 *   ① 本地 state（.state/paytrack.json）记"今天哪个时段发过"；
 *   ② 服务端台账（发送成功才 ack）——同一条消息就算 Actions 重跑也不会重发。
 *
 * 【部分失败】逐条发：发成功一条立刻 ack 一条（服务端台账落账）→
 *   下一轮 feed 自然少掉已发的人，失败的重试也不重复打扰。
 *
 * 需要环境变量：
 *   APP_PASSWORD       口令（与 push.js 同一个）
 *   KF_SYNC_KEY        主系统同步密钥（feed/ack 端点鉴权，deploy/.env 里同值）
 *   WECOM_WEBHOOK_PAY  【另一个群】的机器人 webhook（与 push.js 的 WECOM_WEBHOOK 不同）
 *   DRY_RUN=1          只打印计数不发群（日志脱敏纪律与 push.js 相同）
 * ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = (process.env.BASE_URL || 'https://ad-monitor-dashboard-87745.app.workbuddy.host').replace(/\/$/, '');
const SHARECODE = process.env.SHARECODE || 'Q26D2NW5HK';
const withShare = (u) => u + (u.includes('?') ? '&' : '?') + 'sharecode=' + encodeURIComponent(SHARECODE);
const PW = (process.env.APP_PASSWORD || '').trim();
const KEY = (process.env.KF_SYNC_KEY || '').trim();
const HOOK = (process.env.WECOM_WEBHOOK_PAY || process.env.WECOM_WEBHOOK || '').trim();
const DRY = process.env.DRY_RUN === '1';
const STATE_DIR = path.join(process.cwd(), '.state');
const STATE_FILE = path.join(STATE_DIR, 'paytrack.json');

/* 发送时段（北京时间）：label → [起,止) 分钟。
 * ⚠️ 2026-11-09 实测：GitHub 免费版 schedule 被限流，每 5 分钟的 cron 实际 30~50 分钟才跑一次
 *   （当天 10:31 → 11:18 → 12:18 → 13:24 → 14:28 → 15:52 → 16:52 → 17:44 → 18:31 → 19:25）。
 *   原来 5 分钟窗口直接把 17:30 那轮错过了 ⇒ 窗口放宽到 2.5 小时，
 *   靠 state 的「当天该时段已发」标记保证一天只发一次（晚发总比不发好）。 */
const SLOTS = [
  { label: '1030', start: 10 * 60 + 30, end: 13 * 60 },
  { label: '1730', start: 17 * 60 + 30, end: 21 * 60 },
];

function log(msg) { console.log('[' + new Date().toISOString() + '] ' + msg); }

function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; } }
function writeState(s) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { /* 无缓存不挡发送 */ }
}

function bjNow() { return new Date(Date.now() + 8 * 3600e3); }
function bjDay() { return bjNow().toISOString().slice(0, 10); }
function currentSlot() {
  const bj = bjNow();
  const min = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  return SLOTS.find(s => min >= s.start && min < s.end) || null;
}

async function login() {
  const r = await fetch(withShare(BASE + '/__login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'pw=' + encodeURIComponent(PW),
    redirect: 'manual',
  });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (r.status === 404) return '';
  if (!sc.some(x => /(?:^|;)\s*adm_access=/.test(String(x)))) {
    throw new Error('口令闸登录失败（status ' + r.status + '）');
  }
  return sc.map(x => String(x).split(';')[0]).join('; ');
}

async function feed(cookie) {
  const r = await fetch(withShare(BASE + '/api/paytrack/broadcast-feed'), {
    headers: Object.assign({ 'x-sync-key': KEY }, cookie ? { Cookie: cookie } : {}),
  });
  if (r.status !== 200) throw new Error('broadcast-feed 返回 ' + r.status);
  return r.json();
}

async function ack(cookie, sends) {
  const r = await fetch(withShare(BASE + '/api/paytrack/broadcast-ack'), {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', 'x-sync-key': KEY }, cookie ? { Cookie: cookie } : {}),
    body: JSON.stringify({ sends }),
  });
  if (r.status !== 200) throw new Error('broadcast-ack 返回 ' + r.status);
  return r.json();
}

async function sendMarkdown(content) {
  if (DRY) { log('DRY RUN，消息 ' + content.length + ' 字符（明细已脱敏）'); return { ok: true }; }
  const r = await fetch(HOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: !!(j && (j.errcode === 0 || j.errcode === undefined)), detail: j };
}

(async () => {
  if (!PW) { console.error('缺少 APP_PASSWORD'); process.exit(2); }
  if (!KEY) { console.error('缺少 KF_SYNC_KEY'); process.exit(2); }
  if (!HOOK && !DRY) { console.error('缺少 WECOM_WEBHOOK_PAY'); process.exit(2); }

  const slot = (process.env.FORCE_SLOT && SLOTS.find(s => s.label === process.env.FORCE_SLOT)) || currentSlot();
  if (!slot) { log('不在播报时段（10:30-13:00 / 17:30-21:00 北京时间），跳过'); return; }
  if (process.env.FORCE_SLOT) log('FORCE_SLOT=' + slot.label + '（测试旁路，忽略时段窗口）');

  const day = bjDay();
  const st = readState();
  if (st.day === day && st.sent && st.sent[slot.label]) {
    log('今天 ' + slot.label + ' 时段已发过，跳过'); return;
  }

  const cookie = await login();
  const f = await feed(cookie);
  if (f.stale) {
    /* 数据熔断：不发、不记"已发"——下一轮（5 分钟后）同步恢复还能补上 */
    log('数据熔断（' + f.why + '），本轮不播');
    return;
  }

  /* 与服务端台账对账：feed.sendsPerMessage 与 messages 一一对应，
   * 发一条 ack 一组 —— 部分失败下轮 feed 只剩没发出去的人。
   * 【2026-11-10 最终口径】messages 只有一条「数据速览」；它对应的组是本次候选人，
   *   发成功就 ack（台账记"已播报过"，同一节点不再提示）。 */
  log('候选 ' + ((f.sends || []).length) + ' 人 · 消息 ' + ((f.messages || []).length) + ' 条 · 名单 ' + (f.population || 0) + ' · 无登录数据 ' + (f.nodata || 0));
  const msgs = f.messages || [];
  const groups = f.sendsPerMessage || [];
  if (!msgs.length) {
    writeState(Object.assign({}, st, { day, sent: Object.assign({}, st.sent, { [slot.label]: Date.now() }) }));
    log('本时段无消息，记已处理'); return;
  }
  if (DRY) { log('DRY RUN 结束（不发群、不 ack、不写状态）'); return; }
  for (let i = 0; i < msgs.length; i++) {
    const r = await sendMarkdown(msgs[i]);
    if (!r.ok) {
      console.error('第 ' + (i + 1) + ' 条发送失败：' + JSON.stringify(r.detail || {}).slice(0, 200));
      process.exit(1);   /* 不记已发；已成功的组已 ack，下轮重试只补这条 */
    }
    if (groups[i] && groups[i].length) await ack(cookie, groups[i]);
    log('第 ' + (i + 1) + '/' + msgs.length + ' 条已发' + ((groups[i] || []).length ? '并登记 ' + groups[i].length + ' 人' : '（无候选人，不登记）'));
  }

  writeState(Object.assign({}, st, { day, sent: Object.assign({}, st.sent, { [slot.label]: Date.now() }) }));
  log('播报完成（' + msgs.length + ' 条）');
})().catch(e => { console.error('失败：' + (e && e.message)); process.exit(1); });
