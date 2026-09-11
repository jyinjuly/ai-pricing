/* =============================================================================
   小米 MiMo —— 按量计费（pay-as-you-go）价格采集适配器
   -----------------------------------------------------------------------------
   数据源：https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go
   形式：服务端渲染的静态 HTML（纯 HTTP 即可，无需浏览器）。
        「模型国内定价」小节下的 <table class="mdx-table">，每个模型一行：
            | 模型 | 输入（命中缓存） | 输入（未命中缓存） | 输出 |
        单元格形如 <td class="mdx-td"><span ...>¥0.025</span></td>

   站点语义坑（务必保留这些防线）：
     1. 同一页还有「模型海外定价」（$ 计价）同构表格 —— 只能取国内表，否则单位错。
     2. 还有非 token 价格表：ASR「¥0.5 /小时」、联网搜索「¥16 /1000 次」——
        它们不是模型 token 价格，必须排除，否则会多出模型、错位数组。
     3. 页面标注「元 / 百万 tokens」，因此数字可直接用，无需缩放（勿 ×1000）。
     4. 表格 HTML 是非法的（<p> 包着 <tr>/<td>），用「最后一个 <td 到该行末尾」
        的切法，对合法与非法嵌套都成立。

   零依赖：仅 Node 内置模块 + fetch（复用 scrape/lib/http.mjs —— 同样零依赖）。
   抓不到 / 解析不出 / 结果不合理 → throw，绝不编造数字。
   ========================================================================== */

import { httpText, parsePrice } from '../lib/http.mjs';

const adapter = {
  vendor: 'mimo',
  label: '小米 MiMo',
  source: 'https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go',

  async scrape() {
    const { body } = await httpText(this.source, {
      accept: 'text/html,application/xhtml+xml,*/*',
      timeout: 30000,
      retries: 2
    });
    return parseMimoPricing(body);
  }
};

/* ---------------------------------------------------------------- 解析 */

/** 从整页 HTML 中解析出 { models, pricing } 补丁；失败一律 throw */
export function parseMimoPricing(html) {
  if (typeof html !== 'string' || html.length < 1000) {
    throw new Error('页面内容异常（过短），未拿到真实 HTML');
  }
  if (/__NEXT_DATA__|id="root"><\/div>\s*<\/body>/.test(html) && !/mdx-td/.test(html)) {
    throw new Error('页面疑似变成空壳 SPA（价格未内嵌），无法解析');
  }

  const table = findDomesticTokenTable(html);
  const headers = [...table.head.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)]
    .map(m => normalize(cellText(m[1])))
    .map(h => h.replace(/[\s\u00a0]+/g, ''));

  const colModel = headers.findIndex(h => /模型|系列/.test(h));
  const colHit = headers.findIndex(h => /未命中|miss/i.test(h) === false && /命中|hit/i.test(h));
  const colMiss = headers.findIndex(h => /未命中|miss/i.test(h));
  const colOut = headers.findIndex(h => /输出|output/i.test(h));
  if (colModel < 0 || colHit < 0 || colMiss < 0 || colOut < 0) {
    throw new Error('国内定价表表头不符合预期：[' + headers.join(' | ') + ']');
  }
  if (!(colModel < colHit && colHit < colMiss && colMiss < colOut)) {
    throw new Error('国内定价表列序异常：[' + headers.join(' | ') + ']');
  }

  const models = [];
  const hit = [];
  const miss = [];
  const out = [];
  const rawText = [];

  for (const row of splitRows(table.body)) {
    const cells = cellsOf(row);
    if (cells.length < 4) continue; // 非数据行（表头残留、空行）
    const name = cellText(cells[colModel]);
    if (!/^mimo-[A-Za-z0-9.\-_]+$/.test(name)) continue; // 排除 ASR / TTS / 说明行

    const raw = [cellText(cells[colHit]), cellText(cells[colMiss]), cellText(cells[colOut])];
    // token 价格必须带货币符号；带「/小时」「/1000 次」这类单价非 token，视为异常
    for (const t of raw) {
      if (!/[¥￥$]/.test(t)) throw new Error(`${name} 的价格单元格缺少货币符号：${JSON.stringify(t)}`);
      if (/\/\s*(小时|次|秒|千|1000)/.test(t)) throw new Error(`${name} 命中了非 token 计价单元格：${JSON.stringify(t)}`);
    }
    const [h, m, o] = raw.map(t => parsePrice(t));
    for (const [k, v] of [['命中缓存', h], ['未命中缓存', m], ['输出', o]]) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new Error(`${name} 的${k}价格解析失败：${JSON.stringify(raw)}`);
      }
    }
    // 合理区间（元/百万 tokens）：超界说明抓错了表或单位换算错了
    if (!(h < m && m <= o && o < 1000)) {
      throw new Error(`${name} 价格不合常理（命中${h} / 未命中${m} / 输出${o}），疑似抓错表格`);
    }

    models.push(name);
    hit.push(h);
    miss.push(m);
    out.push(o);
    rawText.push({ model: name, hit: raw[0], miss: raw[1], out: raw[2] });
  }

  if (models.length < 2) {
    throw new Error(`国内 token 价格表只解析出 ${models.length} 个模型，预期至少 2 个`);
  }
  if (models.includes('mimo-v2.5-asr')) {
    throw new Error('误把 ASR 按时长计价行当成 token 价格');
  }

  return {
    models: { mimo: models },
    pricing: { mimo: { hit, miss, out } },
    _debug: { rawText } // 仅供独立运行时逐字核对，编排器只取 models/pricing
  };
}

/** 定位「模型国内定价」小节里的 token 价格表（排除海外表与其它表） */
function findDomesticTokenTable(html) {
  const start = html.search(/模型国内定价/);
  if (start < 0) throw new Error('页面中找不到「模型国内定价」小节，官方页面结构可能已改版');

  const region = html.slice(start, start + 120000);
  const re = /<table\b[^>]*class="[^"]*mdx-table[^"]*"[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = re.exec(region))) {
    const t = m[1];
    if (!/mdx-td/.test(t)) continue;
    if (/¥|￥/.test(t) && /命中/.test(t)) {
      const head = (t.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i) || [])[1] || '';
      const body = (t.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i) || [])[1] || t;
      return { head, body };
    }
  }
  throw new Error('「模型国内定价」下未找到人民币 token 价格表');
}

/** 按 <tr> 起始切行：返回每行从该 <tr 到下个 <tr 之间的片段 */
function splitRows(body) {
  const rows = [];
  const re = /<tr\b/gi;
  let m;
  const starts = [];
  while ((m = re.exec(body))) starts.push(m.index);
  for (let i = 0; i < starts.length; i++) {
    rows.push(body.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : body.length));
  }
  return rows;
}

/** 取一行里的所有 <td> 内容：从最后一个 <td 切到行尾（兼容非法嵌套的 <p>） */
function cellsOf(row) {
  const tds = [];
  const re = /<td\b/gi;
  let m;
  while ((m = re.exec(row))) tds.push(m.index);
  const cells = [];
  for (let i = 0; i < tds.length; i++) {
    const seg = i + 1 < tds.length ? row.slice(tds[i], tds[i + 1]) : row.slice(tds[i]);
    const inner = i + 1 < tds.length ? seg : seg.replace(/<\/tr>[\s\S]*$/i, '');
    cells.push(inner);
  }
  return cells;
}

/** 去标签 + 解实体 + 压缩空白 */
function cellText(htmlFragment) {
  return normalize(
    String(htmlFragment)
      .replace(/<[^>]*>/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
  );
}

function normalize(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------------------------------------------------------------- 独立运行 */

export default adapter;

const isMain = (() => {
  try {
    return process.argv[1] && import.meta.url === new URL('file://' + String(process.argv[1]).replace(/\\/g, '/')).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const res = await adapter.scrape();
  console.log('数据源：' + adapter.source + '（静态 HTML 表格 / 模型国内定价）');
  console.log('逐字核对官网原始单元格：');
  for (const r of res._debug.rawText) {
    console.log(`  ${r.model.padEnd(14)} 命中 ${r.hit.padEnd(8)} 未命中 ${r.miss.padEnd(8)} 输出 ${r.out}`);
  }
  console.log('\n适配器输出：');
  console.log(JSON.stringify({ models: res.models, pricing: res.pricing }, null, 2));
}
