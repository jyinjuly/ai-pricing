/**
 * 智谱 GLM 采集适配器
 *
 * 数据源：智谱开放平台文档站（Mintlify），定价页 markdown 原文
 *   https://docs.bigmodel.cn/cn/guide/start/pricing.md
 *
 * 为什么不用 https://bigmodel.cn/pricing：
 *   该页是 Vue SPA 空壳（webpack 懒加载 chunk），无头浏览器不可用；
 *   而文档站的 Mintlify markdown 接口直接给出官方定价表格，纯 HTTP 可取、稳定、可校验。
 *
 * 表格列（旗舰模型 / 文本模型）：
 *   模型名称 | 上下文 | 输入单价（元/百万 Tokens） | 输出单价（元/百万 Tokens）
 *   | 缓存存储（元/百万 Tokens/小时） | 缓存命中（元/百万 Tokens） | [输入模态]
 *
 * 单位本身就是「元/百万 Tokens」，无需换算。
 */

import { httpText, parsePrice } from '../lib/http.mjs';

const PRICING_URL = 'https://docs.bigmodel.cn/cn/guide/start/pricing.md';

/** 目标模型：label 必须与 data.json 中 models.glm 逐字一致 */
const TARGETS = ['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.2'];

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

function cleanCell(raw) {
  return String(raw)
    .replace(/\\([|\\`*_{}[\]()#+\-.!])/g, '$1') // markdown 转义还原
    .replace(/&(#39|amp|lt|gt|quot|nbsp);/g, (_, k) => HTML_ENTITIES[k] ?? _)
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toNum(text) {
  const v = parsePrice(cleanCell(text));
  return v == null || !Number.isFinite(v) ? null : Number(v);
}

/** 「不支持」/「—」/空 等非价格语义 → null */
function isUnsupported(text) {
  const s = cleanCell(text);
  return s === '' || s === '—' || s === '-' || /不支持|不适用|暂无|未提供|N\/A/i.test(s);
}

/** 把 markdown 拆成一个个 { header: [...], rows: [[...], ...] } 表格 */
function parseMarkdownTables(md) {
  const tables = [];
  let cur = null;

  const endTable = () => {
    if (cur && cur.header.length && cur.rows.length) tables.push(cur);
    cur = null;
  };

  for (const rawLine of md.split(/\r?\n/)) {
    const line = rawLine.trim();
    // 只认「以 | 开头」的表格行，避免正文里的管道符误伤
    if (!line.startsWith('|')) { endTable(); continue; }

    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cleanCell);
    const isSeparator = cells.length > 0 && cells.every(c => c === '' || /^:?-{2,}:?$/.test(c));

    if (!cur) { cur = { header: cells, rows: [] }; continue; }
    if (isSeparator) continue;
    cur.rows.push(cells);
  }
  endTable();
  return tables;
}

/** 在表头里找列下标；找不到返回 -1 */
function findCol(header, patterns) {
  for (let i = 0; i < header.length; i++) {
    const h = header[i];
    if (patterns.some(p => p.test(h))) return i;
  }
  return -1;
}

function scrapePricing(md) {
  if (!md || md.length < 500) throw new Error('定价页内容异常（过短），疑似抓取失败');

  const tables = parseMarkdownTables(md);
  if (!tables.length) throw new Error('定价页未解析出任何 markdown 表格，页面结构可能已变更');

  /** label -> { hit, miss, out }；先命中的优先（accordion 内的旧模型不会覆盖主力表） */
  const found = new Map();
  let usableTables = 0;

  for (const { header, rows } of tables) {
    const cName = findCol(header, [/模型名称/, /^模型$/]);
    const cIn = findCol(header, [/输入单价/]);
    const cOut = findCol(header, [/输出单价/]);
    const cHit = findCol(header, [/缓存命中/]);
    if (cName < 0 || cIn < 0 || cOut < 0) continue; // 非 Token 计价表（按次/按分钟等）
    usableTables++;

    for (const cells of rows) {
      const name = cells[cName];
      if (!name || !TARGETS.includes(name)) continue;
      if (found.has(name)) continue;

      const missRaw = cells[cIn] ?? '';
      const outRaw = cells[cOut] ?? '';
      const hitRaw = cHit >= 0 ? (cells[cHit] ?? '') : '';

      const miss = isUnsupported(missRaw) ? null : toNum(missRaw);
      const out = isUnsupported(outRaw) ? null : toNum(outRaw);
      const hit = hitRaw === '' || isUnsupported(hitRaw) ? null : toNum(hitRaw);

      // 输入/输出是必备档位；拿不到就是解析错位，宁可抛错也不写脏数据
      if (miss == null || out == null) {
        throw new Error(`模型 ${name} 的输入/输出价格解析失败：in="${missRaw}" out="${outRaw}"`);
      }
      found.set(name, { hit, miss, out });
    }
  }

  if (!usableTables) throw new Error('定价页没有找到含「输入单价/输出单价」的 Token 计价表');

  const missing = TARGETS.filter(t => !found.has(t));
  if (missing.length) {
    throw new Error(`定价页未找到目标模型：${missing.join('、')}（已找到 ${[...found.keys()].join('、') || '无'}）`);
  }

  // 严格按 TARGETS 顺序输出，保证与 models.glm 一一对应
  const picked = TARGETS.map(t => found.get(t));
  return {
    models: { glm: [...TARGETS] },
    pricing: {
      glm: {
        hit: picked.map(p => p.hit),
        miss: picked.map(p => p.miss),
        out: picked.map(p => p.out)
      }
    }
  };
}

async function scrape() {
  const { body } = await httpText(PRICING_URL, {
    accept: 'text/markdown,text/plain,*/*',
    timeout: 30000
  });
  return scrapePricing(body);
}

export default {
  vendor: 'glm',
  label: '智谱 GLM',
  source: PRICING_URL,
  scrape
};

const invoked = (process.argv[1] || '').replace(/\\/g, '/');
if (invoked.endsWith('scrape/adapters/glm.mjs')) {
  console.log(JSON.stringify(await scrape(), null, 2));
}
