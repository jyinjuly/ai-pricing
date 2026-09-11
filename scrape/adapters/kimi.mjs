#!/usr/bin/env node
/* =============================================================================
   Kimi（月之暗面）采集适配器
   -----------------------------------------------------------------------------
   数据源形式：Mintlify 文档站（platform.kimi.com）
     · 索引：https://platform.kimi.com/docs/llms.txt       （列出全部 .md 文档）
     · 正文：任意文档页 URL 加 `.md` 后缀即返回 markdown 原文
     · 价格：正文里的 MDX 组件，形如
                <DocTable columns={[...]} rows={[[...], [...]]} />
       其中 columns 是列标题（模型 / 计费单位 / 缓存命中 / 缓存未命中 / 输出 / 上下文窗口），
       rows 是二维 JS 数组（含 JS 对象字面量、注释、中文，不是严格 JSON）。
       → 本适配器用「括号配对扫描 + 迷你 JS 字面量解析器」把 rows 抠出来。

   零依赖：仅 Node 内置 fetch（经 scrape/lib/http.mjs）+ 自带的微型解析器。
   抓不到 / 结构变了 / 价格解析失败 → throw，绝不编造数字。
   ========================================================================== */
import { pathToFileURL } from 'node:url';
import { httpText, parsePrice } from '../lib/http.mjs';

const ORIGIN = 'https://platform.kimi.com';
const INDEX_URL = ORIGIN + '/docs/llms.txt';

/** 只认「Chat 模型定价」页；batch / tools / hosted-agents 是别的产品口径，混进来会串价 */
const PAGE_RE = /^https:\/\/platform\.kimi\.com\/docs\/pricing\/chat(?:-[A-Za-z0-9._-]+)?\.md$/;

/** llms.txt 万一挂掉时的兜底页（正常情况下不需要用到） */
const SEED_PAGES = [
  ORIGIN + '/docs/pricing/chat-k3.md',
  ORIGIN + '/docs/pricing/chat-k27-code.md',
  ORIGIN + '/docs/pricing/chat-k26.md'
];

/** 数组顺序必须与 data.json 现有写法逐字一致（顺序即 models[i] ↔ hit[i]/miss[i]/out[i]） */
const CANONICAL_MODELS = [
  'kimi-k3',
  'kimi-k2.7-code',
  'kimi-k2.7-code-highspeed',
  'kimi-k2.6'
];

/* ------------------------------------------------------------------ 微型 JS 字面量解析 */

/** 跳过字符串字面量，返回闭引号的下标 */
function skipString(src, start) {
  const quote = src[start];
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === quote) return i;
  }
  throw new Error('字符串未闭合');
}

/** 从 start（必须是 [ 或 {）开始做括号配对扫描，返回含首尾括号的子串；跳过字符串与注释 */
function scanBalanced(src, start) {
  if (src[start] !== '[' && src[start] !== '{') throw new Error('扫描起点不是括号');
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; continue; }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('括号未闭合');
}

/** 把 JS 数组/对象字面量（含注释、尾逗号、单引号、无引号键）解析成 JS 值 */
function parseJsLiteral(src) {
  let i = 0;
  const n = src.length;

  const skipTrivia = () => {
    for (;;) {
      while (i < n && /\s/.test(src[i])) i++;
      if (src[i] === '/' && src[i + 1] === '/') { i += 2; while (i < n && src[i] !== '\n') i++; continue; }
      if (src[i] === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      return;
    }
  };

  const parseString = () => {
    const quote = src[i];
    i++;
    let out = '';
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        const e = src[i + 1];
        i += 2;
        if (e === 'n') out += '\n';
        else if (e === 't') out += '\t';
        else if (e === 'r') out += '\r';
        else if (e === 'u') {
          const hex = src.slice(i, i + 4);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 4; }
          else out += 'u';
        } else out += e;
        continue;
      }
      if (c === quote) { i++; return out; }
      if (quote === '`' && c === '$' && src[i + 1] === '{') throw new Error('模板字符串含 ${} 表达式，无法静态解析');
      out += c;
      i++;
    }
    throw new Error('字符串未闭合');
  };

  const parseArray = () => {
    i++; // [
    const arr = [];
    for (;;) {
      skipTrivia();
      if (i >= n) throw new Error('数组未闭合');
      if (src[i] === ']') { i++; return arr; }
      arr.push(parseValue());
      skipTrivia();
      if (src[i] === ',') { i++; continue; }
      if (src[i] === ']') { i++; return arr; }
      throw new Error(`数组中出现意外字符 ${JSON.stringify(src[i])}（位置 ${i}）`);
    }
  };

  const parseObject = () => {
    i++; // {
    const obj = {};
    for (;;) {
      skipTrivia();
      if (i >= n) throw new Error('对象未闭合');
      if (src[i] === '}') { i++; return obj; }
      let key;
      if (src[i] === '"' || src[i] === "'" || src[i] === '`') key = parseString();
      else {
        const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
        if (!m) throw new Error(`对象键无法解析（位置 ${i}）`);
        key = m[0];
        i += m[0].length;
      }
      skipTrivia();
      if (src[i] !== ':') throw new Error(`对象键 ${key} 后缺少 :（位置 ${i}）`);
      i++;
      obj[key] = parseValue();
      skipTrivia();
      if (src[i] === ',') { i++; continue; }
      if (src[i] === '}') { i++; return obj; }
      throw new Error(`对象中出现意外字符 ${JSON.stringify(src[i])}（位置 ${i}）`);
    }
  };

  const parseValue = () => {
    skipTrivia();
    if (i >= n) throw new Error('值缺失');
    const c = src[i];
    if (c === '[') return parseArray();
    if (c === '{') return parseObject();
    if (c === '"' || c === "'" || c === '`') return parseString();
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|undefined|NaN)/.exec(src.slice(i));
    if (!m) throw new Error(`字面量无法解析（位置 ${i}）：${JSON.stringify(src.slice(i, i + 24))}`);
    i += m[0].length;
    const tok = m[0];
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null' || tok === 'undefined' || tok === 'NaN') return null;
    return Number(tok);
  };

  const value = parseValue();
  skipTrivia();
  if (i !== n) throw new Error(`字面量后有多余内容：${JSON.stringify(src.slice(i, i + 24))}`);
  return value;
}

/* ------------------------------------------------------------------ DocTable 抽取 */

/** 取出一个页面里所有 <DocTable ... /> 的 { columns, rows } */
function extractDocTables(markdown) {
  const tables = [];
  const re = /<DocTable\b/g;
  let m;
  while ((m = re.exec(markdown))) {
    const from = m.index;
    // 只在到本标签结束（/>）为止的窗口内找属性，避免跨到下一个组件
    const closeIdx = markdown.indexOf('/>', from);
    const window = markdown.slice(from, closeIdx < 0 ? markdown.length : closeIdx + 2);
    const tablesForThis = {};
    for (const attr of ['columns', 'rows']) {
      // JSX 属性形如 columns={[...]}：跳过表达式容器的 {，定位真正的 JS 字面量
      const am = new RegExp(attr + '\\s*=\\s*\\{\\s*([\\[{])').exec(window);
      if (!am) continue;
      const braceStart = from + am.index + am[0].length - 1;
      tablesForThis[attr] = parseJsLiteral(scanBalanced(markdown, braceStart));
    }
    if (Array.isArray(tablesForThis.rows) && Array.isArray(tablesForThis.columns)) tables.push(tablesForThis);
    re.lastIndex = from + 1;
  }
  return tables;
}

/* ------------------------------------------------------------------ 列定位与价格解析 */

const colIndex = (columns, test) => {
  for (let i = 0; i < columns.length; i++) {
    const title = String(columns[i] && typeof columns[i] === 'object' ? columns[i].title ?? '' : columns[i] ?? '');
    if (test(title)) return i;
  }
  return -1;
};

/** 计费单位是「1K tokens」时把价格 ×1000 归一到百万 */
function unitScale(unitText) {
  const t = String(unitText ?? '');
  if (/百万|1?\s*M\s*tokens?/i.test(t)) return 1;
  if (/(^|[^A-Za-z])1?\s*[Kk]\s*tokens?/i.test(t) || /千\s*(个)?\s*token/i.test(t)) return 1000;
  return 1;
}

/** 解析一个价格单元格 → { value, raw }；无法解析时 value = null */
function parseCell(cell, scale) {
  const raw = cell == null ? '' : String(cell).trim();
  if (!raw) return { value: null, raw };
  if (/[$€£]|USD|美元/i.test(raw) && !/[¥￥元]/.test(raw)) {
    throw new Error(`价格单元格不是人民币计价，无法换算：${JSON.stringify(raw)}`);
  }
  const v = parsePrice(raw);
  return { value: v == null ? null : Number((v * scale).toFixed(10)), raw };
}

/* ------------------------------------------------------------------ 抓取 */

async function discoverPages() {
  const pages = new Set();
  let indexOk = false;
  try {
    const { body } = await httpText(INDEX_URL, { accept: 'text/plain,text/markdown,*/*' });
    for (const m of body.matchAll(/\]\((https:\/\/[^)\s]+\.md)\)/g)) {
      if (PAGE_RE.test(m[1])) pages.add(m[1]);
    }
    indexOk = true;
  } catch { /* 索引失败时用兜底页 */ }
  for (const p of SEED_PAGES) pages.add(p);
  return { pages: [...pages].sort(), indexOk };
}

/** 抓取全部 chat 定价页并归集成 模型ID → { hit, miss, out, raw, page } */
async function collectPrices() {
  const { pages, indexOk } = await discoverPages();
  const errors = [];
  const byModel = new Map();
  const seen = [];

  for (const url of pages) {
    let md;
    try {
      ({ body: md } = await httpText(url, { accept: 'text/markdown,text/plain,*/*' }));
    } catch (e) {
      errors.push(`${url} 抓取失败：${e.message}`);
      continue;
    }
    let tables;
    try {
      tables = extractDocTables(md);
    } catch (e) {
      errors.push(`${url} 文档解析失败：${e.message}`);
      continue;
    }
    let rowCount = 0;
    for (const { columns, rows } of tables) {
      const iModel = colIndex(columns, t => /模型|model/i.test(t) && !/单位/.test(t));
      const iHit = colIndex(columns, t => /命中/.test(t) && !/未命中/.test(t));
      const iMiss = colIndex(columns, t => /未命中/.test(t));
      const iOut = colIndex(columns, t => /输出/.test(t));
      const iUnit = colIndex(columns, t => /计费单位|单位/.test(t));
      if (iModel < 0 || iHit < 0 || iMiss < 0 || iOut < 0) continue; // 不是「模型定价」表，跳过

      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        const model = String(row[iModel] ?? '').trim();
        if (!model) continue;
        const scale = iUnit >= 0 ? unitScale(row[iUnit]) : 1;
        const hit = parseCell(row[iHit], scale);
        const miss = parseCell(row[iMiss], scale);
        const out = parseCell(row[iOut], scale);
        const entry = {
          model,
          hit: hit.value, miss: miss.value, out: out.value,
          raw: { hit: hit.raw, miss: miss.raw, out: out.raw, unit: iUnit >= 0 ? String(row[iUnit] ?? '') : '1M tokens' },
          page: url
        };
        const prev = byModel.get(model);
        if (prev) {
          if (prev.hit !== entry.hit || prev.miss !== entry.miss || prev.out !== entry.out) {
            throw new Error(`模型 ${model} 在多张表里价格不一致（${prev.page} vs ${url}），拒绝猜测`);
          }
          continue;
        }
        byModel.set(model, entry);
        rowCount++;
      }
    }
    seen.push({ url, rows: rowCount });
  }

  return { byModel, seen, errors, indexOk, pageCount: pages.length };
}

/* ------------------------------------------------------------------ 对外接口 */

const adapter = {
  vendor: 'kimi',
  label: 'Kimi',
  source: 'https://platform.kimi.com/docs/pricing/chat',

  async scrape() {
    const { byModel, seen, errors, indexOk, pageCount } = await collectPrices();

    if (!byModel.size) {
      const detail = errors.length ? errors.join('；') : '所有页面均已抓取成功，但没有找到可识别的「模型定价」DocTable（列结构可能已变更）';
      throw new Error(`未从任何 Kimi 定价页解析出价格（页 ${pageCount} 个）。${detail}`);
    }

    // 顺序：先按 data.json 现有顺序，再追加官网新增的模型（保证与既有标签逐字一致）
    const order = [...CANONICAL_MODELS];
    for (const entry of [...byModel.values()]) if (!order.includes(entry.model)) order.push(entry.model);

    const missing = CANONICAL_MODELS.filter(m => !byModel.has(m));
    if (missing.length) {
      throw new Error(`缺少既有模型：${missing.join('、')}。${errors.join('；')}`);
    }

    const nulls = [];
    for (const m of order) {
      const e = byModel.get(m);
      for (const k of ['hit', 'miss', 'out']) {
        if (e[k] == null) nulls.push(`${m}.${k}（原文 ${JSON.stringify(e.raw[k])}）`);
      }
    }
    if (nulls.length) throw new Error(`以下价格无法从 markdown 稳定解析：${nulls.join('、')}`);

    const patch = {
      models: { kimi: order },
      pricing: {
        kimi: {
          hit: order.map(m => byModel.get(m).hit),
          miss: order.map(m => byModel.get(m).miss),
          out: order.map(m => byModel.get(m).out)
        }
      }
    };

    // 供人工核对：把原始价格文本一并带出（不进入 patch，仅挂在 this._debug）
    this._debug = { indexOk, pages: seen, entries: order.map(m => byModel.get(m)), errors };
    return patch;
  }
};

export default adapter;

/* ------------------------------------------------------------------ 独立运行 */

const isMain = (() => {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  const a = process.argv[1];
  if (!a) return false;
  try { return import.meta.url === pathToFileURL(a).href; } catch { return false; }
})();

if (isMain) {
  try {
    const patch = await adapter.scrape();
    const d = adapter._debug;
    console.log(`Kimi（月之暗面）采集  源：${adapter.source}`);
    console.log(`  索引 llms.txt：${d.indexOk ? 'OK' : '不可用（已用兜底页）'}`);
    for (const p of d.pages) console.log(`  · ${p.url}  →  ${p.rows} 行`);
    for (const e of d.errors) console.log(`  ! ${e}`);
    console.log('\n原始价格文本核对（官网 markdown DocTable → 归一值 元/百万 tokens）：');
    for (const e of d.entries) {
      const src = e.page.replace(/^https:\/\/platform\.kimi\.com\/docs\/pricing\//, '');
      console.log(
        '  ' + e.model.padEnd(26) +
        `命中 ${e.raw.hit.padEnd(8)} 未命中 ${e.raw.miss.padEnd(8)} 输出 ${e.raw.out.padEnd(9)}` +
        `[${e.raw.unit}]  ← ${src}`
      );
    }
    console.log('\n' + JSON.stringify(patch, null, 2));
  } catch (err) {
    console.error('采集失败：' + err.message);
    process.exit(1);
  }
}
