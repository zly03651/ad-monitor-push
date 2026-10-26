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
 *   ① 只在工作时段跑（周一~周四 09:00-20:30 / 周五 09:00-18:30，北京时间）
 *   ② 内容没变就不推（.state/last.json 记上次指纹）
 * 需要环境变量：APP_PASSWORD（过访问口令闸）、WECOM_WEBHOOK（群机器人）
 * ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'https://ad-monitor-dashboard-20394.app.workbuddy.host';
const AP_MIN = Number(process.env.AP_MIN || 60);
const DRY = process.env.DRY_RUN === '1';
const STATE_DIR = path.join(process.cwd(), '.state');
const STATE_FILE = path.join(STATE_DIR, 'last.json');

const PW = (process.env.APP_PASSWORD || '').trim();
const HOOK = (process.env.WECOM_WEBHOOK || '').trim();

function log(msg) { console.log('[' + new Date().toISOString() + '] ' + msg); }

/* 北京时间的工作时段：周一~周四 09:00-20:30，周五 09:00-18:30，周末不跑 */
function inWorkWindow(now) {
  const bj = new Date(now.getTime() + 8 * 3600e3);      // UTC → 北京
  const dow = bj.getUTCDay();                            // 0=周日
  if (dow === 0 || dow === 6) return false;
  const min = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const end = dow === 5 ? 18 * 60 + 30 : 20 * 60 + 30;
  return min >= 9 * 60 && min <= end;
}

async function login() {
  const r = await fetch(BASE + '/__login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'pw=' + encodeURIComponent(PW),
    redirect: 'manual',
  });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (!sc.length) throw new Error('口令闸登录失败（status ' + r.status + '），检查 APP_PASSWORD');
  return sc.map(x => String(x).split(';')[0]).join('; ');
}

async function snapshot(cookie) {
  const r = await fetch(BASE + '/api/snapshot', { headers: { Cookie: cookie } });
  if (r.status !== 200) throw new Error('/api/snapshot 返回 ' + r.status);
  const j = await r.json();
  return (j && j.data) ? j.data : j;      /* 该端点裸返回，两种都兼容 */
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

function buildMessage(targets) {
  const byOwner = {};
  targets.forEach(x => {
    const o = x.c.ownerName;
    (byOwner[o] = byOwner[o] || []).push(x);
  });
  const lines = [];
  lines.push('## 投放监控 · 重点计划 ' + targets.length + ' 个（AP>' + AP_MIN + '）');
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

async function push(content) {
  if (DRY) { console.log('--- DRY RUN，消息内容 ---\n' + content); return { ok: true, dry: true }; }
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

  if (!inWorkWindow(new Date())) { log('不在工作时段，跳过'); return; }

  const cookie = await login();
  log('已过口令闸');
  const snap = await snapshot(cookie);
  log('快照：' + (snap.campaigns || []).length + ' 个计划');

  const targets = pickTargets(snap);
  log('命中判据：' + targets.length + ' 个');
  if (!targets.length) { log('没有 AP>' + AP_MIN + ' 的重点计划，不推送'); return; }

  const key = targets.map(x => x.c.name + ':' + x.ap.toFixed(0)).join('|');
  const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const st = readState();
  if (st.day === day && st.key === key) { log('内容与上次相同，不重复打扰'); return; }

  const content = buildMessage(targets);
  const r = await push(content);
  if (!r.ok) { console.error('推送失败：' + JSON.stringify(r.detail)); process.exit(1); }
  log('已推送（' + targets.length + ' 个计划）');
  writeState({ day, key, ts: Date.now() });
})().catch(e => { console.error('失败：' + (e && e.message)); process.exit(1); });
