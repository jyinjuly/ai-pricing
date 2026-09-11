/* 共享 HTTP 工具：统一 UA、超时、重试、JSON 解析。零依赖，仅用 Node 内置 fetch。 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 抓取文本；失败自动重试（指数退避）。返回 { status, contentType, body } */
export async function httpText(url, { accept = '*/*', timeout = 25000, retries = 2, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(600 * attempt);
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept, 'accept-language': 'zh-CN,zh;q=0.9', ...headers },
        signal: AbortSignal.timeout(timeout),
        redirect: 'follow'
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { status: res.status, contentType: res.headers.get('content-type') || '', body, url: res.url };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`抓取失败 ${url} → ${lastErr && lastErr.message}`);
}

/** 抓取并解析 JSON（容错：响应里夹带前缀时尝试截取第一个 { 或 [） */
export async function httpJson(url, opts) {
  const { body } = await httpText(url, { accept: 'application/json,text/plain,*/*', ...opts });
  try { return JSON.parse(body); } catch { /* fallthrough */ }
  const i = Math.min(...['{', '['].map(c => { const p = body.indexOf(c); return p < 0 ? Infinity : p; }));
  if (Number.isFinite(i)) {
    const j = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
    try { return JSON.parse(body.slice(i, j + 1)); } catch { /* fallthrough */ }
  }
  throw new Error(`响应不是合法 JSON：${url}`);
}

/** 从 HTML 中取出指定 id 的 <script type="application/json"> 或 window.XXX = {...} */
export function extractJsonBlob(html, { scriptId, globalVar } = {}) {
  let raw = null;
  if (scriptId) {
    const re = new RegExp(`<script[^>]+id=["']${scriptId}["'][^>]*>([\\s\\S]*?)</script>`, 'i');
    const m = html.match(re);
    if (m) raw = m[1];
  }
  if (!raw && globalVar) {
    const re = new RegExp(`${globalVar}\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;?\\s*</script>`, 'i');
    const m = html.match(re);
    if (m) raw = m[1];
  }
  if (!raw) throw new Error('未找到内联 JSON：' + (scriptId || globalVar));
  return JSON.parse(raw.trim().replace(/;\s*$/, ''));
}

/** 去标签取纯文本（表格类页面用） */
export function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 把 "¥0.025" / "0.025元" / "1.5 元/百万tokens" 归一成数字；无法解析返回 null */
export function parsePrice(text, { scaleToMillion = false } = {}) {
  if (text == null) return null;
  const s = String(text).replace(/,/g, '');
  if (/免费|限时免费|free/i.test(s)) return 0;
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  let v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  // 有些厂商按「千 tokens」标价，需要 ×1000 归一到百万
  if (scaleToMillion || /\/\s*(1|一)?\s*千\s*token|1k\s*token/i.test(s)) v *= 1000;
  return v;
}
