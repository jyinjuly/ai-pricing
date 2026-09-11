/**
 * MiniMax 采集适配器
 *
 * 数据源：MiniMax 开放平台官方文档「按量计费」定价页（Mintlify 文档站）。
 *   https://platform.minimax.cn/docs/guides/pricing-paygo
 *   Mintlify 站点在页面 URL 后加 `.md` 即返回 markdown 正文，价格表就在正文里，
 *   无需无头浏览器、无需解析 HTML。
 *
 * 为什么不用 https://platform.minimax.cn/subscribe/token-plan?tab=api-enterprise ：
 *   该页 __NEXT_DATA__ 里只有 Token Plan 订阅套餐价（Plus/Max/Ultra）与 i18n 文案，
 *   没有按量付费的 token 单价表；套餐价不能冒充 token 价（契约 §3.6 精神）。
 *   该页 FAQ 明确写「1,000 积分 = ¥7，与开放平台 API 按量付费目录价等值」，
 *   指向的正是 docs 的「按量计费」页，即本适配器的数据源。
 *
 * 契约 §3.3：只写 minimaxStd（标准价）。文档里「优先」档 = 标准价 × 1.5，
 *   由页面按 minimaxPriFactor 放大，本适配器不写入、只做交叉校验。
 *
 * 价格口径：文档同时展示「~~原价~~ 折后价」（M3 标「永久五折」）。
 *   data.json 现存数值 = 折后价（如 M3 ≤512k 输入 2.10），故本适配器取折后价。
 */

import { pathToFileURL } from 'node:url';
import { httpText } from '../lib/http.mjs';

const SOURCE_PAGE = 'https://platform.minimax.cn/docs/guides/pricing-paygo';

// 同一份文档的两个官方域名，互为备份（内容一致）；先 .cn 后 .com。
const DOC_URLS = [
  'https://platform.minimax.cn/docs/guides/pricing-paygo.md',
  'https://platform.minimaxi.com/docs/guides/pricing-paygo.md'
];

const UNIT = '元/百万 tokens';

/* ------------------------------------------------------------------ *
 * markdown 结构处理
 * ------------------------------------------------------------------ */

/** 截取「## 语言模型」到下一个二级标题之间的正文 */
function languageSection(md) {
  const start = md.search(/^##\s*语言模型\s*$/m);
  if (start < 0) throw new Error('文档里找不到「## 语言模型」章节，页面结构可能已改版');
  const rest = md.slice(start);
  const next = rest.slice(1).search(/^##\s/m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** 抽出 <Tab title="X">…</Tab> 的内容 */
function extractTabs(text) {
  const tabs = new Map();
  const re = /<Tab\s+title="([^"]+)"\s*>([\s\S]*?)<\/Tab>/g;
  let m;
  while ((m = re.exec(text))) tabs.set(m[1].trim(), m[2]);
  return tabs;
}

/** 删掉所有 Tab / 手风琴 / 包裹标签，只留下与档位无关的正文（M2.7 价格表在这里） */
function outsideTabs(text) {
  return text
    .replace(/<Tab\s+title="[^"]+"\s*>[\s\S]*?<\/Tab>/g, '')
    .replace(/<\/?Tabs>/g, '')
    .replace(/<Accordion\b[^>]*>[\s\S]*?<\/Accordion>/g, '');
}

/** 把 markdown 文本里的表格拆成「行 → 单元格」 */
function parseTables(text) {
  const tables = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^\|.*\|$/.test(line)) {
      if (!cur) { cur = []; tables.push(cur); }
      cur.push(line.slice(1, -1).split('|').map(c => c.trim()));
    } else if (cur) {
      cur = null;
    }
  }
  return tables;
}

const isSeparatorRow = cells => cells.every(c => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')));

/* ------------------------------------------------------------------ *
 * 单元格解析
 * ------------------------------------------------------------------ */

const tidy = s => s
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<span\b[^>]*>[\s\S]*?<\/span>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/~~[\s\S]*?~~/g, ' ')
  .replace(/\*\*/g, '')
  .replace(/\\/g, '')
  .replace(/\u00a0/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * 模型单元格 → data.json 里的模型标签。
 * 契约 §3.5：标签必须与 data.json 逐字一致 → 「MiniMax-M3 ≤ 512k 输入 tokens」归一为「MiniMax-M3 ≤512k」。
 */
function modelLabel(cell) {
  const s = tidy(cell);
  const name = s.match(/MiniMax-[A-Za-z0-9][A-Za-z0-9.\-]*/i);
  if (!name) throw new Error(`无法从单元格识别模型名：${JSON.stringify(s)}`);
  const band = s.match(/(≤|>=|>)\s*(\d+(?:\.\d+)?)\s*k/i);
  return band ? `${name[0]} ${band[1]}${band[2]}k` : name[0];
}

/**
 * 价格单元格 → Number。
 * 文档同时给「~~原价~~ 折后价」，去掉删除线后取剩余数字（= 当前实际展示价）。
 * 契约 §3.4：标注「千 tokens」时 ×1000 归一到百万。
 */
function priceCell(cell, scale) {
  const s = tidy(cell).replace(/<del\b[^>]*>[\s\S]*?<\/del>/gi, ' ');
  if (/免费|free/i.test(s)) return 0;
  const m = s.match(/\d+(?:\.\d+)?/);
  if (!m) throw new Error(`价格单元格里没有数字：${JSON.stringify(cell)}`);
  const v = Number(m[0]) * scale;
  if (!Number.isFinite(v)) throw new Error(`价格无法解析：${JSON.stringify(cell)}`);
  return v;
}

/** 表头单位系数：元/百万 tokens → 1；元/千 tokens → 1000 */
function unitScale(headerCell) {
  const s = tidy(headerCell);
  if (/百万|million|1[,，]?000[,，]?000|\bM\b/i.test(s)) return 1;
  if (/千\s*token|1\s*k\s*token|thousand/i.test(s)) return 1000;
  throw new Error(`表头单位无法识别：${JSON.stringify(s)}`);
}

/**
 * 解析一张 markdown 表 → [{ label, hit, miss, out }]
 * 列名对应（契约 §2）：输入价格 = miss（缓存未命中）、输出价格 = out、缓存读取 = hit。
 */
function parsePriceTable(rows, ctx) {
  const headerIdx = rows.findIndex(cells => cells.some(c => /输入价格/.test(tidy(c))));
  if (headerIdx < 0) return [];

  const header = rows[headerIdx].map(tidy);
  const col = { miss: header.findIndex(c => /输入价格/.test(c)) };
  col.out = header.findIndex(c => /输出价格/.test(c));
  col.hit = header.findIndex(c => /缓存读取/.test(c));
  for (const k of ['miss', 'out', 'hit']) {
    if (col[k] < 0) throw new Error(`${ctx}：表头缺少「${k}」对应列（${header.join(' / ')}）`);
  }
  const scale = unitScale(rows[headerIdx][col.miss]);

  const out = [];
  for (const cells of rows.slice(headerIdx + 1)) {
    if (isSeparatorRow(cells)) continue;
    const nameCell = cells[0] ?? '';
    if (!tidy(nameCell)) continue;
    out.push({
      label: modelLabel(nameCell),
      miss: priceCell(cells[col.miss] ?? '', scale),
      out: priceCell(cells[col.out] ?? '', scale),
      hit: priceCell(cells[col.hit] ?? '', scale)
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 采集
 * ------------------------------------------------------------------ */

function parsePaygo(md) {
  if (!/按量计费/.test(md)) throw new Error('返回内容不是 MiniMax「按量计费」定价文档');

  const section = languageSection(md);
  const tabs = extractTabs(section);
  const standardTab = [...tabs].find(([title]) => /标准/.test(title));
  const priorityTab = [...tabs].find(([title]) => /优先/.test(title));
  if (tabs.size && !standardTab) throw new Error('「语言模型」里找不到「标准」档 Tab，页面结构可能已改版');

  // 标准档内容 + Tab 之外的正文（M2.7 / M2.7-highspeed 表）
  const stdText = [standardTab ? standardTab[1] : '', outsideTabs(section)].filter(Boolean).join('\n');

  const rows = parseTables(stdText).flatMap(t => parsePriceTable(t, '标准档'));
  if (!rows.length) throw new Error('标准档里没有解析到任何 token 价格行');

  const labels = rows.map(r => r.label);
  if (new Set(labels).size !== labels.length) throw new Error(`出现重复模型标签：${labels.join(', ')}`);
  for (const r of rows) {
    if (!Number.isFinite(r.miss) || !Number.isFinite(r.out) || !Number.isFinite(r.hit)) {
      throw new Error(`${r.label} 存在非数字价格`);
    }
  }

  // 交叉校验：确认取到的是「标准」而不是「优先」档（契约 §3.3 不允许把优先价写进去）
  const ratioNote = { checked: 0, factor: null };
  if (priorityTab) {
    const priRows = parseTables(priorityTab[1]).flatMap(t => parsePriceTable(t, '优先档'));
    const priByLabel = new Map(priRows.map(r => [r.label, r]));
    for (const r of rows) {
      const p = priByLabel.get(r.label);
      if (!p) continue;
      const ratio = p.miss / r.miss;
      ratioNote.checked++;
      if (Math.abs(ratio - 1) < 1e-9) {
        throw new Error(`标准档与优先档金额完全相同（${r.label}），疑似取错档位，拒绝写入`);
      }
      ratioNote.factor = ratio;
      if (Math.abs(ratio - 1.5) > 0.01) {
        console.error(`[minimax] 警告：优先档倍率 ${ratio} ≠ 1.5，minimaxPriFactor 可能已过期（本次仍只写标准价）`);
      }
    }
  }

  return {
    models: { minimax: labels },
    pricing: {
      minimaxStd: {
        hit: rows.map(r => r.hit),
        miss: rows.map(r => r.miss),
        out: rows.map(r => r.out)
      }
    },
    _diag: { labels, rows, ratioNote }
  };
}

export default {
  vendor: 'minimax',
  label: 'MiniMax',
  source: SOURCE_PAGE,

  async scrape() {
    const errors = [];
    for (const url of DOC_URLS) {
      try {
        const { body } = await httpText(url, { accept: 'text/markdown,text/plain,*/*' });
        const { _diag, ...patch } = parsePaygo(body);
        const n = patch.models.minimax.length;
        if (n !== patch.pricing.minimaxStd.hit.length ||
            n !== patch.pricing.minimaxStd.miss.length ||
            n !== patch.pricing.minimaxStd.out.length) {
          throw new Error('模型与价格数组长度不一致');
        }
        return patch;
      } catch (e) {
        errors.push(`${url} → ${e && e.message}`);
      }
    }
    throw new Error(`MiniMax 按量计费价格采集失败：\n  ${errors.join('\n  ')}`);
  }
};

/* ------------------------------------------------------------------ *
 * 独立运行：node scrape/adapters/minimax.mjs
 * ------------------------------------------------------------------ */

const invoked = Boolean(process.argv[1]) &&
  pathToFileURL(process.argv[1]).href.toLowerCase() === import.meta.url.toLowerCase();

if (invoked) {
  const errors = [];
  let ok = false;
  for (const url of DOC_URLS) {
    try {
      const { body } = await httpText(url, { accept: 'text/markdown,text/plain,*/*' });
      const { _diag, ...patch } = parsePaygo(body);
      console.log(JSON.stringify(patch, null, 2));
      console.error(`\n[minimax] 来源 ${url}`);
      for (const r of _diag.rows) {
        console.error(`  ${r.label.padEnd(24)} miss ${r.miss}  hit ${r.hit}  out ${r.out}`);
      }
      console.error(`[minimax] 优先档倍率校验：${_diag.ratioNote.checked} 项，倍率 ${_diag.ratioNote.factor}（仅校验，不写入）`);
      ok = true;
      break;
    } catch (e) {
      errors.push(`${url} → ${e && e.message}`);
    }
  }
  if (!ok) {
    console.error(`采集失败：\n  ${errors.join('\n  ')}`);
    process.exit(1);
  }
}
