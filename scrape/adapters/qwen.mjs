/**
 * 阿里千问 Qwen（千问AI平台 platform.qianwenai.com）价格采集适配器
 *
 * 逆向路径（可离线复查，侦察文件见 _recon/qwen-price-mod.js）：
 *   1. https://platform.qianwenai.com/pricing/api 是阿里 lowcode-engine 渲染的 SPA，
 *      HTML 里没有价格文本；价格表由低代码模块 @ali/hmod-qwen-api-price@0.1.7 渲染。
 *   2. 该模块里能还原出两条数据通道：
 *        a) POST https://platform-home.qianwenai.com/data/api.json?product=AliyunDeliveryService&action=ListModelSeries
 *           （模型系列列表，需要 sec_token，匿名时返回 ConsoleNeedLogin）
 *        b) POST https://cs-data.qianwenai.com/data/api.json
 *                 ?action=BroadScopeAspnGateway&product=sfm_bailian
 *                 &api=zeldaHttp.dashscopeModel./zelda/api/v1/modelCenter/listModelPrices
 *           价格表实际走的是 (b)，匿名（sec_token 留空）即可返回 200 + 全量数据。
 *      表单体：product / action / sec_token / region / params(JSON)
 *        params.Api  = 'zeldaHttp.dashscopeModel./zelda/api/v1/modelCenter/listModelPrices'
 *        params.Data.cornerstoneParam = {consoleSite:'QIANWENAI', domain:'platform.qianwenai.com',
 *                                        productCode:'p_efm', protocol:'V2', xsp_lang:'zh-CN'}
 *        params.Data.input            = {region:'cn-beijing', categoryLevel1:'Text-Generation',
 *                                        itemCode:'', batch:false, pageNo, pageSize}
 *      （域名/action 取值来自模块内 ot={qianwencloud:...} 表与 MAIN_SITE 的 .qianwenai.com 分支。）
 *   3. 返回结构：
 *        data.DataV2.data.data.{total,pageNo,pageSize,list[]}
 *        list[i]   = { itemCode, rangeName?, timeBand?, priceUnit, prices[] }
 *        prices[j] = { type, ntmAmountType, price, priceUnit, priceName, discount? }
 *
 * 口径说明（与页面表格完全一致）：
 *   - type=input_token        → 输入（缓存未命中）  miss
 *   - type=input_token_cache  → 输入（缓存命中）    hit
 *     （模块 En() 里文本表的三列硬编码为 input_token / output_token / input_token_cache，
 *       locale 把 input_token_cache 标成「输入（缓存命中）」，即页面「缓存命中」列。）
 *   - type=output_token       → 输出                out
 *   - discount（0.8 = 8 折）是限时折扣：模块 pe(price, discount) = price * discount，
 *     表格把原价划掉、展示折后价并挂 "{{10*discount}}折" 标签。
 *     本适配器写**折后价**（页面展示价、实际计费价）。
 *     当前只有 qwen3.7-plus 两档带 discount=0.8：原价 2/6 元 → 折后 1.6/4.8 元。
 *     其余模型无 discount 字段，原价即现价。
 *   - 只取 timeBand 缺失或 === 'standard' 的行；忙/闲时（peak/offpeak，目前仅 deepseek 三方
 *     模型有）不作为独立档位写入。
 *   - priceUnit 已是「每百万tokens」，无需换算。
 *
 * 零依赖：仅 Node 内置模块 + fetch，无无头浏览器。抓不到即 throw，绝不编造数字。
 */

import { sleep } from '../lib/http.mjs';

const SOURCE = 'https://platform.qianwenai.com/pricing/api';

const API_BASE = 'https://cs-data.qianwenai.com/data/api.json';
const API_ACTION = 'BroadScopeAspnGateway';
const API_PRODUCT = 'sfm_bailian';
const API_NAME = 'zeldaHttp.dashscopeModel./zelda/api/v1/modelCenter/listModelPrices';
const CORNERSTONE = {
  consoleSite: 'QIANWENAI',
  domain: 'platform.qianwenai.com',
  productCode: 'p_efm',
  protocol: 'V2',
  xsp_lang: 'zh-CN'
};
const REGION = 'cn-beijing';
const CATEGORY = 'Text-Generation';
const PAGE_SIZE = 200;
const MAX_PAGES = 10;

/** 价格行 type → data.json 的三张数组 */
const TYPE_MISS = 'input_token';
const TYPE_HIT = 'input_token_cache';
const TYPE_OUT = 'output_token';

/**
 * 目标模型（与 data.json 现有 9 条逐字一致，含 ≤ 与 en dash –）。
 * itemCode + 计费区间 rangeName（null = 不分档）。
 */
const TARGETS = [
  { itemCode: 'qwen3.8-max-0902', rangeName: null },
  { itemCode: 'qwen3.8-flash', rangeName: null },
  { itemCode: 'qwen3.8-2.4t-a95b', rangeName: null },
  { itemCode: 'qwen3.7-plus', rangeName: '输入<=256k' },
  { itemCode: 'qwen3.7-plus', rangeName: '256k<输入<=1m' },
  { itemCode: 'qwen3.7-max', rangeName: null },
  { itemCode: 'qwen3.7-flash', rangeName: '输入<=32k' },
  { itemCode: 'qwen3.7-flash', rangeName: '32k<输入<=256k' },
  { itemCode: 'qwen3.7-flash', rangeName: '256k<输入<=1m' }
];

/**
 * 把接口的 rangeName 还原成 data.json 的档位后缀，逐字对齐现有写法：
 *   '输入<=256k'      → '≤256k'
 *   '256k<输入<=1m'   → '256k–1m'    （en dash U+2013）
 *   '输入<=32k'       → '≤32k'
 *   '32k<输入<=256k'  → '32k–256k'
 * 无法识别的格式返回 null（随后找不到档位会 throw，不会静默写错标签）。
 */
function rangeToSegment(rangeName) {
  if (rangeName == null) return '';
  const raw = String(rangeName).replace(/\s+/g, '');
  const m = raw.match(/^(.*)<=([^<]*)$/);
  if (!m) return null;
  const [, left, right] = m;
  if (left === '输入') return `≤${right}`;
  const inner = left.match(/^(.*)<输入$/);
  if (inner) return `${inner[1]}–${right}`;
  return null;
}

/**
 * 取某 type 的实际计费价（含折扣）。
 * 缺失 / 非数字 → null；「0」是合法价格（如缓存创建有时为 0），不能当假值丢掉。
 */
function priceOf(entry, type) {
  const list = Array.isArray(entry.prices) ? entry.prices : [];
  const row = list.find(p => p && p.type === type);
  if (!row) return null;
  const base = Number(row.price);
  if (!Number.isFinite(base)) return null;
  const disc = row.discount == null ? 1 : Number(row.discount);
  const eff = Number.isFinite(disc) && disc > 0 && disc < 1 ? base * disc : base;
  // 去掉浮点尾巴（0.4 * 0.8 = 0.32000000000000006 → 0.32）
  return Number(eff.toPrecision(12));
}

/** lib/http.mjs 的 httpText 只做 GET，这里按同样的 UA / 重试语义包一层 POST */
async function postForm(url, body, { retries = 2, timeout = 30000 } = {}) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(600 * attempt);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'user-agent': UA,
          accept: 'application/json, text/plain, */*',
          'accept-language': 'zh-CN,zh;q=0.9',
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://platform.qianwenai.com',
          referer: SOURCE
        },
        body,
        signal: AbortSignal.timeout(timeout),
        redirect: 'follow'
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return text;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`抓取失败 ${url} → ${lastErr && lastErr.message}`);
}

/** 拉取全部「文本生成」价格行（分页合并），返回 list[] */
async function listTextGenerationPrices() {
  const url = `${API_BASE}?action=${API_ACTION}&product=${API_PRODUCT}&api=${API_NAME}`;
  const all = [];
  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
    const body = new URLSearchParams({
      product: API_PRODUCT,
      action: API_ACTION,
      sec_token: '',
      region: REGION,
      params: JSON.stringify({
        Api: API_NAME,
        Data: {
          cornerstoneParam: CORNERSTONE,
          input: {
            region: REGION,
            categoryLevel1: CATEGORY,
            itemCode: '',
            batch: false,
            pageNo,
            pageSize: PAGE_SIZE
          }
        }
      })
    }).toString();

    const text = await postForm(url, body);

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`千问价格接口返回非 JSON（${url}）：${text.slice(0, 200)}`);
    }
    const data = json?.data?.DataV2?.data?.data;
    if (!data || !Array.isArray(data.list)) {
      throw new Error(`千问价格接口结构异常（${url}）：${JSON.stringify(json).slice(0, 300)}`);
    }
    all.push(...data.list);
    const total = Number(data.total) || all.length;
    if (all.length >= total || data.list.length === 0) break;
    if (pageNo === MAX_PAGES) throw new Error(`千问价格接口分页异常：已取 ${all.length}/${total}`);
  }
  if (all.length === 0) throw new Error('千问价格接口返回空列表');
  return all;
}

/** 同一 itemCode+rangeName 可能有忙/闲等多行，只保留标准时段 */
function isStandardTimeBand(entry) {
  const tb = entry?.timeBand;
  return tb == null || tb === '' || tb === 'standard';
}

const adapter = {
  vendor: 'qwen',
  label: '阿里千问',
  source: SOURCE,

  async scrape() {
    const entries = (await listTextGenerationPrices()).filter(isStandardTimeBand);
    if (entries.length === 0) throw new Error('千问价格接口没有返回标准时段数据');

    // key: itemCode \u0000 rangeName
    const byKey = new Map();
    for (const e of entries) {
      const code = typeof e.itemCode === 'string' ? e.itemCode.trim() : '';
      if (!code) continue;
      const rn = e.rangeName == null ? '' : String(e.rangeName).trim();
      const key = `${code}\u0000${rn}`;
      if (!byKey.has(key)) byKey.set(key, e); // 首次出现为准 → 结果确定
    }

    const models = [];
    const hit = [];
    const miss = [];
    const out = [];
    const problems = [];

    for (const t of TARGETS) {
      const key = `${t.itemCode}\u0000${t.rangeName ?? ''}`;
      const seg = rangeToSegment(t.rangeName);
      if (seg == null) {
        problems.push(`${t.itemCode} / ${t.rangeName}：档位标签无法解析`);
        continue;
      }
      const label = t.rangeName == null ? t.itemCode : `${t.itemCode} ${seg}`;
      const entry = byKey.get(key);
      if (!entry) {
        problems.push(`${t.itemCode} / ${t.rangeName ?? '(不分档)'}：接口中不存在`);
        continue;
      }
      const h = priceOf(entry, TYPE_HIT);
      const m = priceOf(entry, TYPE_MISS);
      const o = priceOf(entry, TYPE_OUT);
      if (h == null || m == null || o == null) {
        problems.push(`${t.itemCode} / ${t.rangeName ?? '(不分档)'}：缺少 hit/miss/out 价格行`);
        continue;
      }
      models.push(label);
      hit.push(h);
      miss.push(m);
      out.push(o);
    }

    if (problems.length) {
      throw new Error(`千问价格采集失败（官网可能已改版）：${problems.join('；')}`);
    }
    if (models.length !== TARGETS.length || hit.length !== TARGETS.length || miss.length !== TARGETS.length || out.length !== TARGETS.length) {
      throw new Error(`千问适配器内部错误：数组长度不一致（models=${models.length}）`);
    }

    return { models: { qwen: models }, pricing: { qwen: { hit, miss, out } } };
  }
};

export default adapter;

// ---- 独立运行：node scrape/adapters/qwen.mjs ----
const isMain = process.argv[1] != null && /(^|[\\/])qwen\.mjs$/.test(process.argv[1]);
if (isMain) {
  try {
    const result = await adapter.scrape();
    console.log(JSON.stringify(result, null, 2));
    console.log('\n--- 可读视图（元 / 百万 tokens，折后价）---');
    result.models.qwen.forEach((name, i) => {
      console.log(`${name.padEnd(26)} hit=${result.pricing.qwen.hit[i]}  miss=${result.pricing.qwen.miss[i]}  out=${result.pricing.qwen.out[i]}`);
    });
  } catch (e) {
    console.error('采集失败：' + (e && e.message));
    process.exit(1);
  }
}
