/* DeepSeek 定价采集适配器
 * 数据源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ （Docusaurus 静态 HTML）
 * 页面正文内嵌一张 <table>，含 rowspan/colspan 合并单元格：
 *   表头      模型 | deepseek-flash(1) | deepseek-v4-pro(2)
 *   模型版本   ...  | DeepSeek-V4.1-Flash | DeepSeek-V4-Pro-0813
 *   价格(3)   [百万tokens输入（缓存命中） | 空闲时段/高峰时段] [缓存未命中 …] [输出 …]
 * 契约 3.2：data.json 只存「高峰价」，若页面只给空闲价则 ×2 换算；此处页面两档都给了，
 * 直接取高峰时段即可，绝不使用空闲价（更不做二次放大）。
 * 零依赖：仅 Node 内置 fetch（复用 scrape/lib/http.mjs）。
 */

import { httpText } from '../lib/http.mjs';

const SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&times;': '×', '&le;': '≤', '&ge;': '≥', '&mdash;': '—', '&ndash;': '–'
};

function decode(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&[a-z]+;|&#\d+;/gi, m => (m in ENTITIES ? ENTITIES[m] : m));
}

/** 单元格纯文本：<br> 视作换行，去标签、解码实体、压缩空白 */
function cellText(html) {
  return decode(
    String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** 取出 <table> 的 <tr> 序列（外层表格，不再往下嵌套） */
function tableRows(html) {
  const start = html.search(/<table[\s>]/i);
  if (start < 0) throw new Error('页面中未找到 <table>，页面结构可能已改版');
  const end = html.indexOf('</table>', start);
  const table = html.slice(start, end < 0 ? html.length : end);
  const rows = table.match(/<tr[\s\S]*?<\/tr>/gi);
  if (!rows || !rows.length) throw new Error('<table> 中未解析到任何 <tr>');
  return rows;
}

function rowCells(rowHtml) {
  return [...rowHtml.matchAll(/<t[dh]([^>]*)>([\s\S]*?)<\/t[dh]>/gi)].map(m => {
    const attrs = m[1] || '';
    const span = name => {
      const mm = attrs.match(new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, 'i'));
      return mm ? Math.max(1, Number(mm[1])) : 1;
    };
    return { colspan: span('colspan'), rowspan: span('rowspan'), text: cellText(m[2]) };
  });
}

/**
 * 取「时段」语义标签：含行内继承的 rowspan 标签（如「空闲时段」/「高峰时段」），
 * 但排除价格区标题「价格(3)」。时段关键词本身必须保留，否则会误取空闲价（契约 3.2 只存高峰价）。
 */
const tierLabels = row => row.map(x => x.text).filter(t => t && !/价格/.test(t)).join(' ');

/**
 * 把带 rowspan/colspan 的表格还原成矩形网格（这是不错位的关键）。
 * 采用 HTML 表格布局算法：
 *  - cursor[c] 记录该列下一次可用的行号：rowspan 单元格把其覆盖的每一列推进到 row+rowspan，
 *    因此「跨行延续槽位」不会被后续行覆盖；
 *  - 行首从上一行结束的位置继续；若与跨行单元格冲突则整行从第 1 列重来（此时 c 会跳过延续槽位）；
 *  - 价格列与表头模型列必须严格对齐：错一格就会读到隔壁模型/隔壁时段的价格。
 */
function buildGrid(rows) {
  const parsed = rows.map(rowCells);
  const width = Math.max(1, ...parsed.map(cells => cells.reduce((s, x) => s + x.colspan, 0)));
  const cursor = new Array(width).fill(0); // cursor[c] = 该列下一个可用行号
  const grid = [];

  const spans = [];   // 跨行单元格：{ r, c, rowspan, colspan, text }
  for (let r = 0; r < parsed.length; r++) {
    grid[r] = grid[r] || [];
    let c = 0;
    for (const cell of parsed[r]) {
      let grew = false;
      while (c < cursor.length && cursor[c] > r) { c++; grew = true; } // 跳过跨行延续槽位
      // 与跨行单元格冲突时，整行重新从第 1 列开始布局
      while (c + cell.colspan > cursor.length) { c = 0; grew = true; }
      if (grew && c + cell.colspan > width) c = 0;
      for (let k = 0; k < cell.colspan; k++) {
        const cc = c + k;
        grid[r][cc] = { text: cell.text, colspan: 1, rowspan: 1, anchor: k === 0 };
        if (cell.rowspan > 1) cursor[cc] = r + cell.rowspan;
      }
      if (cell.rowspan > 1) spans.push({ r, c, rowspan: cell.rowspan, colspan: cell.colspan, text: cell.text });
      c += cell.colspan;
    }
  }
  // 关键：跨行单元格的文本必须「延续」到它占据的每一行。
  // DeepSeek 价格表里「百万tokens输入（缓存命中）」等档位列 rowspan=2，
  // 若只留空，紧跟着的「高峰时段」行就没有档位标签，会被整行跳过 →
  // 表现为「缺少 hit 价格」而误报采集失败。
  for (const s of spans) {
    for (let t = 1; t < s.rowspan; t++) {
      const rr = s.r + t;
      if (rr >= parsed.length) break;
      grid[rr] = grid[rr] || [];
      for (let k = 0; k < s.colspan; k++) {
        const cc = s.c + k;
        if (cc >= width || grid[rr][cc]) continue;
        grid[rr][cc] = { text: s.text, colspan: 1, rowspan: 1, anchor: false, carry: true };
      }
    }
  }
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < width; c++) {
      if (!grid[r][c]) grid[r][c] = { text: '', colspan: 1, rowspan: 1, anchor: false, carry: true };
    }
  }
  return grid;
}

/** 某格向上/向左收集最近的标签（用于定位「空闲时段/高峰时段」与「缓存命中/未命中/输出」） */
function rowLabel(grid, r, c) {
  for (let i = r - 1; i >= 0; i--) {
    const t = grid[i][c] && grid[i][c].text;
    if (t) return t;
  }
  return '';
}
function colLabel(grid, r, c) {
  for (let j = c - 1; j >= 0; j--) {
    const t = grid[r][j] && grid[r][j].text;
    if (t) return t;
  }
  return '';
}

function isEmptyCell(t) {
  return !t || /^[\s\-–—/]+$/.test(t);
}

/** 价格文本 → 元/百万 tokens（页面本身就以百万 tokens 计价） */
function price(text) {
  const s = decode(text).replace(/[,，\s]/g, '');
  if (!s) return null;
  if (/免费|free/i.test(s)) return 0;
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

/** 从价格区某一行里，取「第 i 个模型列」的数值 */
function priceAt(grid, r, valueCols, i) {
  const cell = grid[r] && grid[r][valueCols[i]];
  return price(cell ? cell.text : '');
}

function scrapeTable(html) {
  const grid = buildGrid(tableRows(html));

  // 模型标签：价格表里「模型版本」行以 DeepSeek- 开头的值单元格
  let versionRow = -1;
  for (let r = 0; r < grid.length; r++) {
    const label = grid[r].map(x => x.text).join(' ');
    if (/模型版本/.test(label) && grid[r].some(x => /^deepseek-/i.test(x.text.trim()))) { versionRow = r; break; }
  }
  // 兜底：任意一行含 >=2 个 DeepSeek-V 开头的单元格
  if (versionRow < 0) {
    versionRow = grid.findIndex(row => row.filter(x => /^deepseek-v/i.test(x.text.trim())).length >= 2);
  }
  if (versionRow < 0) throw new Error('未找到「模型版本」行，无法确定模型标签');

  const valueCols = [];
  const modelNames = [];
  for (let c = 0; c < grid[versionRow].length; c++) {
    const t = grid[versionRow][c].text.trim();
    if (/^deepseek-[a-z0-9.\-]+$/i.test(t)) { valueCols.push(c); modelNames.push(t); }
  }
  if (!modelNames.length) throw new Error('「模型版本」行中未解析到模型名');
  if (new Set(modelNames).size !== modelNames.length) throw new Error('解析出的模型名重复：' + modelNames.join(', '));

  // 定位价格区起始行（含「价格」的行），只在其后查找价格行，避免误取上下文/输出长度等数字
  let priceStart = -1;
  for (let r = versionRow; r < grid.length; r++) {
    if (/价格/.test(grid[r].map(x => x.text).join(' '))) { priceStart = r; break; }
  }
  if (priceStart < 0) throw new Error('未找到「价格」表格区域');

  // 行语义：先看行首标签（缓存命中 / 缓存未命中 / 输出），再看左侧时段列（高峰 / 空闲）
  const picked = new Map(); // key -> { value, row, tier }
  const offPeak = new Map(); // key -> 空闲价（仅用于诊断输出）
  for (let r = priceStart; r < grid.length; r++) {
    const row = grid[r];
    const joined = row.map(x => x.text).join(' ');
    if (/并发|限制/.test(joined) && !/价格/.test(joined)) break; // 价格区结束
    let key = null;
    for (let c = 0; c < valueCols[0]; c++) {
      const t = row[c] && row[c].text;
      if (!t) continue;
      if (/缓存命中|缓存未命中|输入/.test(t)) key = /未命中/.test(t) ? 'miss' : 'hit';
      else if (/输出/.test(t) && !/长度/.test(t)) key = 'out';
    }
    if (!key) continue;
    const tierText = tierLabels(row.slice(0, valueCols[0]));
    const isOff = /空闲/.test(tierText);
    const isPeak = /高峰/.test(tierText);
    for (let i = 0; i < valueCols.length; i++) {
      const v = priceAt(grid, r, valueCols, i);
      if (v == null) continue;
      if (isPeak) { if (!picked.has(key)) picked.set(key, { value: v, row: r + 1, tier: '高峰时段' }); }
      else if (isOff) { if (!offPeak.has(key)) offPeak.set(key, { value: v, row: r + 1 }); }
      else if (!picked.has(key) && !offPeak.has(key)) { picked.set(key, { value: v, row: r + 1, tier: '未分时段' }); }
    }
  }

  const peakRowsFound = [...picked.values()].filter(x => x.tier === '高峰时段').length;
  const hasTiers = offPeak.size > 0;
  if (peakRowsFound === 0 && hasTiers) {
    // 页面只给了空闲价 → 契约 3.2：×2 换算成高峰价（必须在下面的空值校验之前完成）
    for (const [k, v] of offPeak) picked.set(k, { ...v, tier: '空闲时段×2' });
  }
  if (!picked.size) throw new Error('价格区未解析到任何价格行');
  const factor = peakRowsFound === 0 && hasTiers ? 2 : 1;

  // 逐模型逐档取值，缺任何一档即抛错（绝不填 0 或猜数）
  const raw = { hit: [], miss: [], out: [] };
  const rowsSeen = [];
  for (const key of ['hit', 'miss', 'out']) {
    for (let i = 0; i < modelNames.length; i++) {
      let found = null;
      for (let r = priceStart; r < grid.length && found == null; r++) {
        const row = grid[r];
        const joined = row.map(x => x.text).join(' ');
        if (/并发|限制/.test(joined) && !/价格/.test(joined)) break;        let k = null;
        for (let c = 0; c < valueCols[0]; c++) {
          const t = row[c] && row[c].text;
          if (!t) continue;
          if (c === 0 && /^价格/.test(t)) continue; // 价格区标题行标签，不代表档位
          if (/缓存命中|缓存未命中|输入/.test(t)) k = /未命中/.test(t) ? 'miss' : 'hit';
          else if (/输出/.test(t) && !/长度/.test(t)) k = 'out';
        }
        if (k !== key) continue;
        const tierText = tierLabels(row.slice(0, valueCols[0]));
        rowsSeen.push(`[${r}] key=${k} tier=${JSON.stringify(tierText)} isPeak=${/高峰/.test(tierText)}`);
        if (hasTiers && !/高峰/.test(tierText)) continue;
        found = priceAt(grid, r, valueCols, i);
      }
      if (found == null) throw new Error(`模型「${modelNames[i]}」缺少「${key}」价格（已扫描：${rowsSeen.join(' | ') || '无匹配行'}）`);
      raw[key].push(found * factor);
    }
  }

  if (!modelNames.length || raw.hit.length !== modelNames.length || raw.miss.length !== modelNames.length || raw.out.length !== modelNames.length) {
    throw new Error('模型数与价格档位数不一致，解析失败');
  }
  for (const key of ['hit', 'miss', 'out']) {
    for (const v of raw[key]) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`价格异常：${key} = ${JSON.stringify(raw[key])}`);
    }
  }
  return { modelNames, raw, factor, picked, offPeak, priceStart, valueCols };
}

/** 供独立运行核对用的官方原始价格文本（只读诊断，不参与数据生成） */
function rawEvidence(html, valueCols, modelNames, priceStart) {
  const grid = buildGrid(tableRows(html));
  const out = [];
  for (let r = priceStart; r < grid.length; r++) {
    const row = grid[r];
    const joined = row.map(x => x.text).join(' ');
    if (/并发|限制/.test(joined) && !/价格/.test(joined)) break;
    const cells = valueCols.map(c => (row[c] ? row[c].text.replace(/\n/g, ' ') : ''));
    if (!cells.some(t => /\d/.test(t))) continue;
    const labels = row.slice(0, valueCols[0]).map(x => x.text).filter(Boolean).join(' / ').replace(/\n/g, ' ');
    out.push(`[${r + 1}] ${labels} → ${cells.map((t, i) => `${modelNames[i]}="${t}"`).join('  ')}`);
  }
  return out;
}

const adapter = {
  vendor: 'deepseek',
  label: 'DeepSeek',
  source: SOURCE,

  async scrape() {
    const { body } = await httpText(SOURCE, {
      accept: 'text/html,application/xhtml+xml',
      headers: { 'accept-language': 'zh-CN,zh;q=0.9' }
    });
    if (!/<table[\s>]/i.test(body)) throw new Error('响应中不含表格，可能被拦截或页面改版');
    if (!/模型版本|deepseek-flash/.test(body)) throw new Error('响应内容与 DeepSeek 定价页不符（可能被重定向/风控）');

    const { modelNames, raw, factor, picked, offPeak, priceStart, valueCols } = scrapeTable(body);

    return {
      models: { deepseek: modelNames },
      pricing: { deepseek: { hit: raw.hit, miss: raw.miss, out: raw.out } },
      _debug: { factor, peakRows: [...picked.entries()].map(([k, v]) => `${k}:${v.value}@row${v.row}(${v.tier})`), offPeakRows: [...offPeak.entries()].map(([k, v]) => `${k}:${v.value}@row${v.row}`), evidence: rawEvidence(body, valueCols, modelNames, priceStart) }
    };
  }
};

export default adapter;

/* ------------------------------ 独立运行 ------------------------------ */
const invokedDirectly = process.argv[1] && /deepseek\.mjs$/i.test(process.argv[1]);
if (invokedDirectly) {
  try {
    const result = await adapter.scrape();
  const { _debug, ...data } = result;
  console.log('=== 官网原始价格文本（逐行核对）===');
  for (const line of _debug.evidence) console.log(line);
  console.log('\n=== 解析结果（供 data.json 使用）===');
  console.log(JSON.stringify(data, null, 2));
  console.log('\n=== 诊断 ===');
  console.log('高峰价行：', _debug.peakRows.join(', ') || '(无)');
  console.log('空闲价行：', _debug.offPeakRows.join(', ') || '(无)');
    console.log('换算系数：', _debug.factor, _debug.factor === 1 ? '（页面已给高峰价，契约 3.2 无需 ×2）' : '（页面仅给空闲价，已 ×2 换算为高峰价）');
  } catch (e) {
    console.error('采集失败：', e && e.message);
    process.exitCode = 1;
  }
}
