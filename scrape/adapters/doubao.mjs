/**
 * 火山方舟 Doubao（字节跳动 / 火山引擎）价格采集适配器
 *
 * 数据源（首选，纯 HTTP）
 *   https://docs.volcengine.com/api/doc/getDocDetail?DocumentID=1544106
 *   → Result.MDContent 是文档《模型价格》的 markdown 正文，
 *     其中「## 在线推理（常规）」「## 在线推理（低延迟）」两张表就是
 *     doubaoReg / doubaoLow 的价格来源。
 *
 * 数据源（兜底）
 *   https://docs.volcengine.com/docs/82379/1544106?lang=zh
 *   → 页面内联 `window._ROUTER_DATA = {...}`，
 *     loaderData['docs/(libid)/(docid$)/page'].curDoc.MDContent（或 curDoc.Content 富文本）
 *
 * 单位：官方表格列头即为「元/百万token」，无需换算（本文件会校验列头，
 *       若官网哪天改成「千 token」会直接 throw 而不是写错数字）。
 *
 * 站点语义（见 scrape/CONTRACT.md §3.4 / §3.5）
 *   - doubaoReg / doubaoLow 两套并存，低延迟未提供的档位为 null。
 *   - 分档模型是独立数组元素，标签写法必须与 data.json 逐字一致。
 */

import { httpJson, httpText } from '../lib/http.mjs';

const VENDOR = 'doubao';

const SOURCE_PAGE = 'https://docs.volcengine.com/docs/82379/1544106?lang=zh';
const DOC_DETAIL_API = 'https://docs.volcengine.com/api/doc/getDocDetail?DocumentID=1544106';

/** 常规 / 低延迟两节的标题（markdown 原文用全角括号） */
const SEC_REG = '在线推理（常规）';
const SEC_LOW = '在线推理（低延迟）';

/* ------------------------------------------------------------------ *
 * markdown 表格解析
 * ------------------------------------------------------------------ */

/** markdown 转义还原：`doubao\-seed\-2.1` → `doubao-seed-2.1` */
function unesc(s) {
  return s.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1');
}

/** 单元格归一：去 <br><br> 与转义、压缩空白 */
function normCell(s) {
  return unesc(String(s).replace(/<br\s*\/?>/gi, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** 单元格 → 数字；`-` / `\-` / 空 视为 null（官方用它表示「不支持」） */
function num(s) {
  const t = normCell(s);
  if (t === '' || t === '-' || /^[—–－]+$/.test(t) || /不支持|免费/.test(t)) return null;
  const m = t.replace(/,/g, '').match(/^-?\d+(?:\.\d+)?$/);
  return m ? Number(m[0]) : null;
}

/** 把一段 markdown 拆成表格行（每行是已归一的单元格数组），跳过表头分隔行 */
function tableRows(section) {
  const rows = [];
  for (const raw of section.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(normCell);
    if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue; // |---|---| 分隔行
    rows.push(cells);
  }
  return rows;
}

/** 取第 n 个 `##` 标题到下一个 `##`/`#` 标题之间的正文 */
function section(md, title) {
  const lines = md.split('\n');
  const isHeading = l => /^#{1,6}\s/.test(l.trim());
  const h2 = l => /^##\s/.test(l.trim());
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (h2(lines[i]) && normCell(lines[i].replace(/^#+\s*/, '')) === title) { start = i + 1; break; }
  }
  if (start < 0) throw new Error(`[${VENDOR}] 未在官方文档中找到小节「${title}」`);
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (isHeading(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

/* ------------------------------------------------------------------ *
 * 条件文本 → 档位后缀（必须逐字匹配 data.json 的标签写法）
 * ------------------------------------------------------------------ */

/**
 * 条件文本 → 分档区间（单位：k token）。
 * `输入长度 [0, 1024]`  → { lower: 0,   upper: 1024, closed: true }
 * `输入长度 (32, 128]`  → { lower: 32,  upper: 128,  closed: false }
 * `输入长度 [0, 32]<br><br>且输出长度 (0.2,+∞)` → 只取输入长度那段。
 * 返回 null 表示该行没有输入长度分档条件（如 `-`）。
 */
function parseInterval(cond) {
  const c = normCell(cond);
  if (!c || c === '-') return null;
  const m = c.match(/输入长度\s*([\[(])\s*(\d+)\s*,\s*(\d+)\s*[\])]/);
  if (!m) return null; // 例如 TPM 保障包等其它形态，交给调用方忽略
  return { lower: Number(m[2]), upper: Number(m[3]), closed: m[1] === '[' };
}

/** 区间 → 标签后缀：从 0 起且上界 ≤32 → `≤32k`；否则用区间下界 → `32-128k` */
function tierSuffix(iv) {
  if (iv.lower === 0 && iv.upper <= 32) return `≤${iv.upper}k`;
  return `${iv.lower}-${iv.upper}k`;
}

/* ------------------------------------------------------------------ *
 * 价格表解析
 * ------------------------------------------------------------------ */

/**
 * 解析一张「在线推理」表。
 * 官方列：模型名称 | 条件 | 输入(非音频) | 输入(音频) | [缓存存储] | 缓存命中(非音频) | 缓存命中(音频) | 输出
 * 分段计费时模型名只在首行出现，后续行的「模型名称」为空 → 继承上一行的模型名。
 */
function parseTierTable(sectionText, sectionLabel) {
  const rows = tableRows(sectionText);
  if (rows.length < 3) throw new Error(`[${VENDOR}] 「${sectionLabel}」表格行数异常：${rows.length}`);

  const header = rows[0];
  const col = needle => {
    const i = header.findIndex(h => h.replace(/\s/g, '').includes(needle));
    if (i < 0) throw new Error(`[${VENDOR}] 「${sectionLabel}」表头缺少列「${needle}」：${header.join(' / ')}`);
    return i;
  };
  // 表头单位校验：官方若改成「千 token」，必须报错而不是静默写错数字
  const missHeader = header[col('输入(非音频)')] || '';
  const hitHeader = header[col('缓存命中(非音频)')] || '';
  const outHeader = header[col('输出')] || '';
  for (const [name, h] of [['输入', missHeader], ['缓存命中', hitHeader], ['输出', outHeader]]) {
    if (!/百万\s*token/i.test(h.replace(/\s/g, ''))) {
      throw new Error(`[${VENDOR}] 「${sectionLabel}」${name}列单位不是「元/百万token」：${h}`);
    }
    if (/千\s*token/i.test(h.replace(/百万\s*token/gi, ''))) {
      throw new Error(`[${VENDOR}] 「${sectionLabel}」${name}列疑似按千 token 计价：${h}`);
    }
  }

  const iModel = 0;
  const iCond = 1;
  const iMiss = col('输入(非音频)');
  const iHit = col('缓存命中(非音频)');
  const iOut = col('输出');

  const out = [];
  let current = null;
  for (const cells of rows.slice(1)) {
    if (cells[iModel]) current = cells[iModel];
    if (!current) continue;
    if (!/^doubao-/.test(current)) continue; // 只取豆包自家模型（文档里混排了 glm / deepseek 等）
    const iv = parseInterval(cells[iCond]);
    const miss = num(cells[iMiss]);
    const hit = num(cells[iHit]);
    const outv = num(cells[iOut]);
    if (miss === null && hit === null && outv === null) continue;
    out.push({ model: current, iv, miss, hit, out: outv });
  }
  if (!out.length) throw new Error(`[${VENDOR}] 「${sectionLabel}」未解析出任何 doubao 档位`);
  return out;
}

/* ------------------------------------------------------------------ *
 * 页面在售的 15 个分档（标签逐字对应 data.json）
 *
 * 官方文档同时列出几十个模型（seed-1.8 / seed-1.6 / 1.5 系列、translation、
 * vision 等），但页面 data.json 只跟踪下面这 15 档；这里按
 * 「模型名 + 输入长度区间下界/上界」精确白名单抓取，多余的行忽略，
 * 缺失或歧义的行直接报错，避免把数字挂错档位。
 * ------------------------------------------------------------------ */
const TRACKED = [
  ['doubao-seed-evolving', 0, 1024, '≤1024k'],
  ['doubao-seed-2.1-pro', 0, 256, '≤256k'],
  ['doubao-seed-2.1-turbo', 0, 256, '≤256k'],
  ['doubao-seed-2.0-pro', 0, 32, '≤32k'],
  ['doubao-seed-2.0-pro', 32, 128, '32-128k'],
  ['doubao-seed-2.0-pro', 128, 256, '128-256k'],
  ['doubao-seed-2.0-lite', 0, 32, '≤32k'],
  ['doubao-seed-2.0-lite', 32, 128, '32-128k'],
  ['doubao-seed-2.0-lite', 128, 256, '128-256k'],
  ['doubao-seed-2.0-mini', 0, 32, '≤32k'],
  ['doubao-seed-2.0-mini', 32, 128, '32-128k'],
  ['doubao-seed-2.0-mini', 128, 256, '128-256k'],
  ['doubao-seed-2.0-code', 0, 32, '≤32k'],
  ['doubao-seed-2.0-code', 32, 128, '32-128k'],
  ['doubao-seed-2.0-code', 128, 256, '128-256k']
].map(([model, lower, upper, suffix]) => ({
  model,
  lower,
  upper,
  label: `${model} ${suffix}`
}));

const keyOf = (model, lower, upper) => `${model}|${lower}|${upper}`;

/**
 * 按白名单从一张表的解析结果里挑出 15 档。
 * - 没出现的档位 → null（低延迟表只提供部分档位，契约要求写 null）
 * - 同一 key 命中多行（如 seed-1.6/1.8 按输出长度再分档）视为歧义 → 报错
 */
function pickTracked(rows, sectionLabel) {
  const byKey = new Map();
  for (const r of rows) {
    if (!r.iv) continue;
    const k = keyOf(r.model, r.iv.lower, r.iv.upper);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  return TRACKED.map(t => {
    const hits = byKey.get(keyOf(t.model, t.lower, t.upper)) || [];
    if (hits.length > 1) {
      throw new Error(
        `[${VENDOR}] 「${sectionLabel}」中 ${t.label} 命中 ${hits.length} 行（期望 0~1 行）：官网档位可能已调整`
      );
    }
    if (!hits.length) return { label: t.label, hit: null, miss: null, out: null };
    return { label: t.label, ...hits[0] };
  });
}

/** 从 markdown 正文解析出 { reg:[...], low:[...] }（仅白名单 15 档） */
function parsePricing(md) {
  if (!md || typeof md !== 'string') throw new Error(`[${VENDOR}] markdown 正文为空`);
  return {
    reg: pickTracked(parseTierTable(section(md, SEC_REG), SEC_REG), SEC_REG),
    low: pickTracked(parseTierTable(section(md, SEC_LOW), SEC_LOW), SEC_LOW)
  };
}

/* ------------------------------------------------------------------ *
 * 正文获取：优先官方内容接口，失败兜底页面 HTML
 * ------------------------------------------------------------------ */

/** 兜底：从页面 HTML 里抠出 window._ROUTER_DATA（含字符串感知的括号配对） */
function extractRouterData(html) {
  const at = html.indexOf('window._ROUTER_DATA');
  if (at < 0) throw new Error('页面中未找到 window._ROUTER_DATA');
  const start = html.indexOf('{', at);
  if (start < 0) throw new Error('window._ROUTER_DATA 缺少对象起始符');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  throw new Error('window._ROUTER_DATA 括号未闭合');
}

function markdownFromRouterData(data) {
  const ld = data && data.loaderData;
  if (!ld) throw new Error('_ROUTER_DATA 缺少 loaderData');
  for (const key of Object.keys(ld)) {
    const page = ld[key];
    const doc = page && page.curDoc;
    if (!doc) continue;
    if (typeof doc.MDContent === 'string' && doc.MDContent.trim()) return doc.MDContent;
    if (typeof doc.Content === 'string' && doc.Content.trim()) {
      // 富文本 delta：把所有 insert 文本拼起来后交给块解析
      const delta = JSON.parse(doc.Content);
      return Object.values(delta.data || {})
        .map(node => (node.ops || []).map(op => op.insert || '').join(''))
        .join('\n');
    }
  }
  throw new Error('_ROUTER_DATA 中未找到文档正文');
}

/** 拉取官方《模型价格》markdown 正文 */
async function fetchMarkdown({ log = () => {} } = {}) {
  try {
    const j = await httpJson(DOC_DETAIL_API, { timeout: 25000 });
    const md = j && j.Result && j.Result.MDContent;
    if (typeof md === 'string' && md.includes(SEC_REG)) {
      const r = j.Result;
      log(`  · 内容接口命中：${r.Title}（LibraryID=${r.LibraryID}，更新于 ${r.UpdatedTime}）`);
      return md;
    }
    log('  · 内容接口返回的正文不含预期小节，转用页面兜底');
  } catch (e) {
    log(`  · 内容接口不可用（${e.message}），转用页面兜底`);
  }
  const { body } = await httpText(SOURCE_PAGE, { accept: 'text/html,*/*' });
  const md = markdownFromRouterData(extractRouterData(body));
  log('  · 页面 _ROUTER_DATA 兜底命中');
  return md;
}

/* ------------------------------------------------------------------ *
 * 适配器导出
 * ------------------------------------------------------------------ */

const adapter = {
  vendor: VENDOR,
  label: '火山方舟 Doubao',
  source: SOURCE_PAGE,

  async scrape({ log = () => {} } = {}) {
    log(`[${VENDOR}] 抓取官方定价文档…`);
    const md = await fetchMarkdown({ log });
    const { reg, low } = parsePricing(md);

    // 常规表是主表：模型顺序以它为准；低延迟按同名标签对齐，缺失档位为 null
    const lowMap = new Map(low.map(r => [r.label, r]));
    const models = reg.map(r => r.label);
    const doubaoReg = {
      hit: reg.map(r => r.hit),
      miss: reg.map(r => r.miss),
      out: reg.map(r => r.out)
    };
    const doubaoLow = {
      hit: models.map(l => (lowMap.has(l) ? lowMap.get(l).hit : null)),
      miss: models.map(l => (lowMap.has(l) ? lowMap.get(l).miss : null)),
      out: models.map(l => (lowMap.has(l) ? lowMap.get(l).out : null))
    };

    // 自检：三张数组等长、数值类型正确、常规档价格齐全
    if (!models.length) throw new Error(`[${VENDOR}] 未解析出任何模型档位`);
    for (const [k, a] of Object.entries({ doubaoReg, doubaoLow })) {
      for (const f of ['hit', 'miss', 'out']) {
        if (a[f].length !== models.length) throw new Error(`[${VENDOR}] ${k}.${f} 与 models 长度不一致`);
        for (const v of a[f]) {
          if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) {
            throw new Error(`[${VENDOR}] ${k}.${f} 出现非数字：${v}`);
          }
        }
      }
    }
    if (doubaoReg.miss.some(v => v === null)) throw new Error(`[${VENDOR}] 常规价存在缺失档位，拒绝输出`);

    log(`  · 常规 ${models.length} 档，低延迟 ${low.filter(r => models.includes(r.label)).length} 档对齐`);
    return { models: { [VENDOR]: models }, pricing: { doubaoReg, doubaoLow } };
  }
};

export default adapter;

/* ------------------------------------------------------------------ *
 * 独立运行：node scrape/adapters/doubao.mjs
 * ------------------------------------------------------------------ */
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scrape/adapters/doubao.mjs')) {
  const log = m => console.error(m);
  try {
    const out = await adapter.scrape({ log });
    console.log(JSON.stringify(out, null, 2));
    log('\n（单位：元 / 百万 tokens；低延迟表未提供的档位为 null）');
  } catch (e) {
    console.error(`采集失败：${e.message}`);
    process.exitCode = 1;
  }
}
