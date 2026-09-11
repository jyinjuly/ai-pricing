#!/usr/bin/env node
/* =============================================================================
   采集编排器 —— 全自动无人值守的核心
   -----------------------------------------------------------------------------
   流程：读取现有 data.json → 并行运行所有适配器 → 深度合并成功的结果
        → 校验（结构/数值/异常波动）→ 原子写入 data.json + 历史快照 + 运行报告

   设计原则（无人值守时最重要）：
   · 单个适配器失败 → 保留该厂商上一次的数据，绝不写空值、绝不写 0
   · 全部适配器失败 → 完全不碰 data.json（避免无意义地触发前端刷新）
   · 任何写入前先过校验；结构不合法直接放弃本次结果并报警
   · 数据变化超过阈值会被标记为「异常波动」，写进报告供人工抽查

   用法：
     node scrape/run.mjs                   # 抓取并写入
     node scrape/run.mjs --dry             # 只抓取和校验，不写文件
     node scrape/run.mjs --only=kimi,mimo  # 只跑指定适配器
     node scrape/run.mjs --quiet           # 精简输出（给计划任务用）
   ========================================================================== */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA_FILE = path.join(ROOT, 'data.json');
const HISTORY_DIR = path.join(ROOT, 'data-history');
const ADAPTER_DIR = path.join(ROOT, 'scrape', 'adapters');
const REPORT_FILE = path.join(ROOT, 'scrape', 'last-run.json');

// 参数归一化：从聊天窗口 / 文档 / 网页复制命令时，极易混入「长得像 -」的字符
// （U+2010 连字符、U+2011 不换行连字符、U+2013 短破折号、U+2212 减号、U+FF0D 全角减号…）
// 或零宽字符（U+200B/200C/200D/2060/FEFF）。它们肉眼完全看不出来，
// 却会让 --test-notify 与 '--test-notify' 不相等，排查起来极其费劲。
const rawArgs = process.argv.slice(2);
const normalizeArg = s => String(s)
  .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212\uFF0D\uFE63\u2043]/g, '-')
  .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
  .trim();
const args = rawArgs.map(normalizeArg);

const codePoints = s => [...String(s)]
  .map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'))
  .join(' ');

const flag = name => args.includes('--' + name);
const opt = name => {
  const hit = args.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : null;
};
const DRY = flag('dry');
const QUIET = flag('quiet');
const ONLY = opt('only') ? new Set(opt('only').split(',').map(s => s.trim())) : null;
const ADAPTER_TIMEOUT = Number(opt('timeout') || 120000); // 单个适配器上限 2 分钟
const ANOMALY_RATIO = 0.4;  // 相对变化超过 40% 记为异常波动（仅告警，不阻断）
const HISTORY_KEEP = 120;   // 历史快照保留份数

const log = (...a) => { if (!QUIET) console.log(...a); };

// 归一化发生时把原始码点打出来，让「复制粘贴混入怪字符」这类问题一眼可见
rawArgs.forEach((raw, i) => {
  if (raw === args[i]) return;
  console.error(`（提示）第 ${i + 1} 个参数含不可见或全角字符，已自动修正为：${args[i]}`);
  console.error(`         原始码点：${codePoints(raw)}`);
});

// 参数回显 + 未知参数告警：避免「以为传了某个参数，实际没传」这种排查噩梦
const KNOWN_FLAGS = ['dry', 'quiet', 'test-notify'];
const KNOWN_OPTS = ['only', 'timeout'];
const seenFlags = [];
for (const a of args) {
  if (!a.startsWith('--')) continue;
  const eq = a.indexOf('=');
  if (eq < 0) {
    seenFlags.push(a);
    if (!KNOWN_FLAGS.includes(a.slice(2))) {
      console.error(`（提示）未知参数 ${a} 已被忽略。可用：${KNOWN_FLAGS.map(f => '--' + f).join('  ')}  ` +
        `${KNOWN_OPTS.map(o => '--' + o + '=').join('  ')}`);
    }
  } else if (!KNOWN_OPTS.includes(a.slice(2, eq))) {
    console.error(`（提示）未知参数 ${a.slice(0, eq)} 已被忽略。`);
  }
}
if (seenFlags.length) log('参数：' + seenFlags.join(' ') + '\n');

/* ---------------------------------------------------------------- 告警推送
   无人值守最大的风险不是抓取失败，而是「失败了却没人知道」。
   设置环境变量 SCRAPE_WEBHOOK 为钉钉 / 企业微信 / 飞书机器人地址即可收到推送：
     $env:SCRAPE_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/xxxx"
   推送时机：全部失败 / 校验不通过 / 有厂商失败 / 价格异常波动(≥40%) / 价格有更新。
   自测通道：node scrape/run.mjs --test-notify   （只发测试消息，不跑采集） */
const WEBHOOK = process.env.SCRAPE_WEBHOOK || '';
const SITE_URL = process.env.SCRAPE_SITE_URL || '';

// 通知策略（环境变量 SCRAPE_NOTIFY）：
//   always  = 每次运行都推送；成功且无变化时发一条「采集成功」回执 —— 默认
//   changes = 只有价格变化、或出问题时才推送
//   alerts  = 只在出问题时才推送
const NOTIFY_MODE = (process.env.SCRAPE_NOTIFY || 'always').trim().toLowerCase();

/**
 * 各家的「成功」判定标准不一样，而且钉钉**失败时 HTTP 状态码依然是 200**，
 * 光看 res.ok 会把失败误判成发送成功。所以必须解析响应体：
 *   钉钉 / 企业微信 → body.errcode === 0
 *   飞书           → body.code === 0
 */
async function postWebhook(body) {
  const res = await fetch(WEBHOOK, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8000)
  });
  const text = (await res.text().catch(() => '')) || '';
  let ok = res.ok, note = '';
  try {
    const j = JSON.parse(text);
    if (typeof j.errcode === 'number') { ok = ok && j.errcode === 0; note = `errcode=${j.errcode}${j.errmsg ? ' ' + j.errmsg : ''}`; }
    else if (typeof j.code === 'number') { ok = ok && j.code === 0; note = `code=${j.code}${j.msg ? ' ' + j.msg : ''}`; }
  } catch { note = text.slice(0, 140); }
  return { ok, status: res.status, note };
}

async function notify(title, lines) {
  if (!WEBHOOK) return false;
  const content = ['【API 价格采集】' + title, ...lines, SITE_URL ? '看板：' + SITE_URL : '']
    .filter(Boolean).join('\n');
  // 依次尝试两种消息格式，谁被接受就用谁（钉钉 / 企业微信一系，飞书一系）
  const payloads = [
    { msgtype: 'text', text: { content } },
    { msg_type: 'text', content: { text: content } }
  ];
  const tried = [];
  for (const body of payloads) {
    try {
      const r = await postWebhook(body);
      if (r.ok) return true;
      tried.push(`HTTP ${r.status} ${r.note}`);
    } catch (e) {
      tried.push(`${e.name}: ${e.message}`);
    }
  }
  console.error('（告警推送失败）机器人返回：' + tried.join('  |  '));
  return false;
}

// --test-notify：只发一条测试消息，不跑采集，用来验证机器人配置是否打通
if (flag('test-notify')) {
  if (!WEBHOOK) {
    console.error('未设置 SCRAPE_WEBHOOK 环境变量，没有可发送的地址。');
    console.error('飞书示例：$env:SCRAPE_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/xxxx"');
    process.exit(1);
  }
  console.log('正在向机器人发送测试消息…');
  const ok = await notify('测试消息', [
    '这是一条测试推送，收到即代表告警通道已打通。',
    '若未收到，请看下面打印的机器人原始响应。'
  ]);
  if (ok) {
    console.log('✓ 机器人已接受。请确认群里真的收到了这条消息。');
  } else {
    console.log('✗ 发送失败，错误详情见上方「机器人返回」。');
    console.log('  飞书常见原因：机器人被停用 / webhook 地址不完整（应为 …/open-apis/bot/v2/hook/…）。');
  }
  process.exit(ok ? 0 : 1);
}

/* ---------------------------------------------------------------- 工具 */

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 深度合并：对象逐键合并，数组整体替换（价格数组必须整体换，不能按位合并） */
function deepMerge(target, patch) {
  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/** 收集两份数据之间的价格差异，用于生成变更日志 */
function diffPrices(before, after) {
  const changes = [];
  const walk = (a, b, trail) => {
    if (Array.isArray(a) && Array.isArray(b)) {
      const n = Math.max(a.length, b.length);
      for (let i = 0; i < n; i++) {
        if (a[i] === b[i]) continue;
        if (isPlainObject(a[i]) || isPlainObject(b[i])) walk(a[i] ?? {}, b[i] ?? {}, trail + '[' + i + ']');
        else changes.push({ path: trail + '[' + i + ']', from: a[i], to: b[i] });
      }
      return;
    }
    if (isPlainObject(a) && isPlainObject(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], trail ? trail + '.' + k : k);
      return;
    }
    if (a !== b) changes.push({ path: trail, from: a, to: b });
  };
  walk(before?.models ?? {}, after?.models ?? {}, 'models');
  walk(before?.pricing ?? {}, after?.pricing ?? {}, 'pricing');
  return changes;
}

/* ---------------------------------------------------------------- 适配器加载 */

async function loadAdapters() {
  if (!existsSync(ADAPTER_DIR)) return [];
  const files = readdirSync(ADAPTER_DIR).filter(f => f.endsWith('.mjs') && !f.startsWith('_'));
  const adapters = [];
  for (const f of files) {
    try {
      const mod = await import(pathToFileURL(path.join(ADAPTER_DIR, f)).href);
      const a = mod.default;
      if (!a || typeof a.scrape !== 'function' || !a.vendor) {
        log(`  ! 跳过 ${f}：导出不符合契约（需要 default.vendor 和 default.scrape）`);
        continue;
      }
      if (ONLY && !ONLY.has(a.vendor) && !ONLY.has(f.replace(/\.mjs$/, ''))) continue;
      adapters.push({ ...a, file: f });
    } catch (e) {
      log(`  ! 加载 ${f} 失败：${e.message}`);
    }
  }
  return adapters;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`超时（>${ms / 1000}s）`)), ms); })
  ]);
}

/* ---------------------------------------------------------------- 校验 */

/** 校验模型数组与价格数组长度是否一致（顺序对应关系无法自动校验，只能靠适配器的单元测试） */
function validate(data) {
  const errors = [];
  const warnings = [];
  const groups = {
    deepseek: ['deepseek'],
    kimi: ['kimi'],
    glm: ['glm'],
    minimax: ['minimaxStd'],
    mimo: ['mimo'],
    qwen: ['qwen'],
    doubao: ['doubaoReg', 'doubaoLow']
  };

  for (const [vendor, keys] of Object.entries(groups)) {
    const models = data.models?.[vendor];
    if (!Array.isArray(models) || !models.length) { errors.push(`models.${vendor} 缺失或为空`); continue; }
    for (const key of keys) {
      const p = data.pricing?.[key];
      if (!p) { errors.push(`pricing.${key} 缺失`); continue; }
      for (const dim of ['hit', 'miss', 'out']) {
        const arr = p[dim];
        if (!Array.isArray(arr)) { errors.push(`pricing.${key}.${dim} 不是数组`); continue; }
        if (arr.length !== models.length) {
          errors.push(`长度不匹配：models.${vendor}=${models.length} 但 pricing.${key}.${dim}=${arr.length}`);
        }
        arr.forEach((v, i) => {
          if (v === null) return;
          if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`pricing.${key}.${dim}[${i}] 非数字：${JSON.stringify(v)}`);
          else if (v < 0) errors.push(`pricing.${key}.${dim}[${i}] 为负数：${v}`);
        });
      }
    }
  }

  // 档位顺序：同一模型的分档标签应保持字典序递增（≤32k → 32-128k → 128-256k），顺序错乱通常意味着抓取错位
  for (const [vendor, models] of Object.entries(data.models || {})) {
    const tiers = models.filter(m => /≤|>|-|–/.test(m));
    if (tiers.length && tiers.length !== models.length) {
      const first = models.findIndex(m => /≤|>|-|–/.test(m));
      const contiguous = models.slice(first).every(m => /≤|>|-|–/.test(m));
      if (!contiguous) warnings.push(`models.${vendor} 分档模型与普通模型交错，顺序可能错乱：${models.join(' | ')}`);
    }
  }
  return { errors, warnings };
}

/** 与上一版对比，找出异常波动 */
function findAnomalies(before, after) {
  const anomalies = [];
  for (const c of diffPrices({ models: before.models, pricing: before.pricing }, { models: before.models, pricing: after.pricing })) {
    const { from, to } = c;
    if (typeof from !== 'number' || typeof to !== 'number') continue;
    if (from === 0) { if (to !== 0) anomalies.push({ ...c, note: '由 0 变为非 0' }); continue; }
    const ratio = Math.abs(to - from) / Math.abs(from);
    if (ratio >= ANOMALY_RATIO) anomalies.push({ ...c, ratio: Number(ratio.toFixed(3)), note: `变动 ${(ratio * 100).toFixed(0)}%` });
  }
  return anomalies;
}

/* ---------------------------------------------------------------- 落盘 */

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  writeFileSync(tmp, text, 'utf8');
  try { renameSync(tmp, file); } catch { writeFileSync(file, text, 'utf8'); try { unlinkSync(tmp); } catch {} }
}

function pruneHistory() {
  try {
    const files = readdirSync(HISTORY_DIR).filter(f => /^data-.*\.json$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - HISTORY_KEEP))) {
      try { unlinkSync(path.join(HISTORY_DIR, f)); } catch {}
    }
  } catch {}
}

/* ---------------------------------------------------------------- 主流程 */

const startedAt = new Date();
log('API 价格采集  ' + startedAt.toLocaleString('zh-CN'));
log('─'.repeat(62));

if (!existsSync(DATA_FILE)) {
  console.error('找不到 data.json，无法确定基准结构。请先确认项目根目录正确。');
  process.exit(1);
}
const before = JSON.parse(readFileSync(DATA_FILE, 'utf8'));

const adapters = await loadAdapters();
if (!adapters.length) {
  console.error('没有可用的适配器（scrape/adapters/*.mjs）。');
  process.exit(1);
}
log(`适配器 ${adapters.length} 个：${adapters.map(a => a.label || a.vendor).join('、')}\n`);

const results = await Promise.all(adapters.map(async a => {
  const t0 = Date.now();
  try {
    const patch = await withTimeout(Promise.resolve().then(() => a.scrape()), ADAPTER_TIMEOUT, a.vendor);
    const ms = Date.now() - t0;
    if (!isPlainObject(patch)) throw new Error('scrape() 必须返回对象');
    const nModels = patch.models?.[a.vendor]?.length ?? 0;
    log(`  ✓ ${(a.label || a.vendor).padEnd(10)} ${ms}ms  模型 ${nModels} 个`);
    return { vendor: a.vendor, label: a.label, source: a.source, ok: true, ms, patch };
  } catch (e) {
    const ms = Date.now() - t0;
    log(`  ✗ ${(a.label || a.vendor).padEnd(10)} ${ms}ms  ${e.message}`);
    return { vendor: a.vendor, label: a.label, source: a.source, ok: false, ms, error: e.message };
  }
}));

const succeeded = results.filter(r => r.ok);
const failed = results.filter(r => !r.ok);

log('\n' + '─'.repeat(62));
log(`成功 ${succeeded.length} / 失败 ${failed.length}`);

if (!succeeded.length) {
  // 全部失败：一个字都不写，避免无意义地刷新前端
  log('全部适配器失败，data.json 保持不变。');
  const report = {
    at: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(),
    ok: false, written: false, results: results.map(({ patch, ...r }) => r)
  };
  if (DRY) {
    log('--dry 模式：未写入任何文件，也未发送任何告警。');
    log('  ⓘ 按本次结果，正式运行会推送 1 条「全部适配器失败」。');
    console.log(JSON.stringify(report, null, 2));
  } else {
    writeAtomic(REPORT_FILE, JSON.stringify(report, null, 2) + '\n');
    await notify('全部适配器失败', [
      '本轮 7 家厂商一个都没抓到，data.json 保持不变。',
      ...failed.map(f => `· ${f.label || f.vendor}：${f.error}`)
    ]);
  }
  process.exit(2);
}

// 合并：只有成功的适配器才会覆盖对应字段
let after = before;
for (const r of succeeded) {
  const patch = { models: r.patch.models || {}, pricing: r.patch.pricing || {} };
  const next = deepMerge(after, patch);
  const modelsChanged = JSON.stringify(next.models) !== JSON.stringify(after.models);
  const pricingChanged = JSON.stringify(next.pricing) !== JSON.stringify(after.pricing);
  if (modelsChanged || pricingChanged) after = next;
}

const { errors, warnings } = validate(after);
const changes = diffPrices(before, after);
const anomalies = findAnomalies(before, after);

if (errors.length) {
  console.error('\n校验未通过，本次结果被丢弃（data.json 保持不变）：');
  for (const e of errors) console.error('  ✗ ' + e);
  const report = {
    at: startedAt.toISOString(), ok: false, written: false, errors,
    results: results.map(({ patch, ...r }) => r)
  };
  if (DRY) {
    log('--dry 模式：未写入任何文件，也未发送任何告警。');
    log('  ⓘ 按本次结果，正式运行会推送 1 条「数据校验未通过」。');
    console.log(JSON.stringify(report, null, 2));
  } else {
    writeAtomic(REPORT_FILE, JSON.stringify(report, null, 2) + '\n');
    await notify('数据校验未通过', ['本次结果已丢弃，data.json 保持不变。', ...errors.slice(0, 8)]);
  }
  process.exit(3);
}

for (const w of warnings) log('  ⚠ ' + w);
if (anomalies.length) {
  log(`\n⚠ 检测到 ${anomalies.length} 处异常波动（已写入报告，建议人工抽查）：`);
  for (const a of anomalies.slice(0, 12)) log(`    ${a.path}: ${a.from} → ${a.to}  (${a.note})`);
}

log(`\n数据变更 ${changes.length} 处`);
if (changes.length && !QUIET) {
  for (const c of changes.slice(0, 20)) log(`    ${c.path}: ${c.from} → ${c.to}`);
  if (changes.length > 20) log(`    …… 其余 ${changes.length - 20} 处见 scrape/last-run.json`);
}

const report = {
  at: startedAt.toISOString(),
  durationMs: Date.now() - startedAt.getTime(),
  ok: true,
  written: false,
  succeeded: succeeded.map(s => s.vendor),
  failed: failed.map(f => ({ vendor: f.vendor, error: f.error })),
  warnings,
  anomalies,
  changes,
  results: results.map(({ patch, ...r }) => r)
};

/* ---------------------------------------------------------------- 推送内容
   策略见顶部 NOTIFY_MODE（默认 always：成功也推）。
   成功时那条就是「跑过了」的回执 —— 否则「任务没跑」和「跑了但没事」
   在手机上完全无法区分，而前者恰恰是无人值守最需要发现的故障。 */
const alertLines = [];
if (failed.length) alertLines.push('抓取失败：' + failed.map(f => `${f.label || f.vendor}(${f.error})`).join('、'));
if (anomalies.length) alertLines.push(...anomalies.slice(0, 6).map(a => `⚠ ${a.path}: ${a.from} → ${a.to}（${a.note}）`));
if (changes.length) {
  alertLines.push(`价格更新 ${changes.length} 处：`);
  for (const c of changes.slice(0, 8)) alertLines.push(`· ${c.path}: ${c.from} → ${c.to}`);
  if (changes.length > 8) alertLines.push(`· …其余 ${changes.length - 8} 处见 scrape/last-run.json`);
}
if (!failed.length && !anomalies.length && !changes.length) {
  alertLines.push(`${succeeded.length} 家厂商全部抓取成功，价格无变化。`);
}
alertLines.push(
  `耗时 ${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)} 秒 · 数据版本 v${before.meta?.version ?? '?'}` +
  (changes.length ? ` → v${(before.meta?.version || 0) + 1}` : '')
);

// 标题必须反映真实原因：只是正常调价时不能说成「异常波动」
const alertTitle = failed.length ? '部分厂商抓取失败'
  : anomalies.length ? '价格出现异常波动'
  : changes.length ? '价格已更新'
  : '采集成功';

const hasProblem = failed.length > 0 || anomalies.length > 0;
const shouldNotify = NOTIFY_MODE === 'alerts' ? hasProblem
  : NOTIFY_MODE === 'changes' ? (hasProblem || changes.length > 0)
  : true; // always

if (DRY) {
  log('\n--dry 模式：未写入任何文件，也未发送任何告警。');
  if (shouldNotify) {
    log(`  ⓘ 按本次结果，正式运行会推送 1 条「${alertTitle}」：`);
    for (const l of alertLines.slice(0, 5)) log('      ' + l);
  } else {
    log(`  ⓘ SCRAPE_NOTIFY=${NOTIFY_MODE}，本次正式运行不推送。`);
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

if (changes.length) {
  after.meta = {
    ...(after.meta || {}),
    updatedAt: new Date().toISOString(),
    version: (before.meta?.version || 0) + 1,
    source: '自动采集：' + succeeded.map(s => s.label || s.vendor).join('、')
  };
  writeAtomic(DATA_FILE, JSON.stringify(after, null, 2) + '\n');

  mkdirSync(HISTORY_DIR, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  writeAtomic(path.join(HISTORY_DIR, `data-${stamp}.json`), JSON.stringify(after, null, 2) + '\n');
  pruneHistory();

  report.written = true;
  log(`\n✓ 已写入 data.json（v${after.meta.version}）并留档 data-history/data-${stamp}.json`);
  log('  前端最多 30 秒内自动同步。');
} else {
  log('\n数据无变化，未改动 data.json。');
}

writeAtomic(REPORT_FILE, JSON.stringify(report, null, 2) + '\n');
log(`运行报告：scrape/last-run.json`);

// 推送（内容与标题已在前面按 NOTIFY_MODE 备好）
if (shouldNotify) {
  await notify(alertTitle, alertLines);
} else {
  log(`（SCRAPE_NOTIFY=${NOTIFY_MODE}，本次无需推送）`);
}
