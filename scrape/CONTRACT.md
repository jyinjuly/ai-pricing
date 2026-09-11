# 采集适配器契约（务必逐条遵守）

目标：为 `ai-pricing` 项目的每一家厂商写一个**零依赖**的数据采集适配器，自动产出 `data.json` 中属于该厂商的那部分数据。

---

## 1. 文件与导出

路径：`scrape/adapters/<vendor>.mjs`

```js
export default {
  vendor: 'deepseek',                 // 唯一标识
  label: 'DeepSeek',                  // 中文名，用于日志/报告
  source: 'https://...',              // 官方定价页 URL
  async scrape() {
    // 成功：返回 data.json 的「局部补丁」
    // 失败：throw（编排器会保留上一次的数据，不会写坏线上）
    return {
      models:  { deepseek: ['DeepSeek-V4.1-Flash', 'DeepSeek-V4-Pro-0813'] },
      pricing: { deepseek: { hit: [0.04, 0.30], miss: [2.0, 9.0], out: [8.0, 27.0] } }
    };
  }
};
```

**必须能独立运行**：

```bash
node scrape/adapters/deepseek.mjs
```

直接运行时要把 `scrape()` 的结果打印成 JSON（用文件末尾的 `import.meta.main` 判断或 `if (process.argv[1].endsWith('deepseek.mjs'))` 之类方式），便于验证。

**硬性约束**
- 只能使用 Node 内置模块 + `fetch`；**不得**引入任何 npm 依赖。
- **不得使用无头浏览器**（本环境无法启动 Chrome）——只允许纯 HTTP 抓取。
- 抓不到就 `throw`，**绝对不要编造或猜测价格**。
- 数值必须是 `Number` 类型，不要字符串。无法确定的档位用 `null`。

---

## 2. data.json 结构（与采集相关的部分）

```jsonc
{
  "models": {
    "deepseek": [...], "kimi": [...], "glm": [...], "minimax": [...],
    "mimo": [...], "qwen": [...], "doubao": [...]
  },
  "pricing": {
    "deepseek":       { "hit": [...], "miss": [...], "out": [...] },
    "kimi":           { "hit": [...], "miss": [...], "out": [...] },
    "glm":            { "hit": [...], "miss": [...], "out": [...] },
    "minimaxStd":     { "hit": [...], "miss": [...], "out": [...] },
    "minimaxPriFactor": [1.5, 1.5, 1, 1],
    "mimo":           { "hit": [...], "miss": [...], "out": [...] },
    "qwen":           { "hit": [...], "miss": [...], "out": [...] },
    "doubaoReg":      { "hit": [...], "miss": [...], "out": [...] },
    "doubaoLow":      { "hit": [...], "miss": [...], "out": [...] }
  }
}
```

`hit` = 输入（缓存命中）、`miss` = 输入（缓存未命中）、`out` = 输出。
**单位统一：元 / 百万 tokens（￥/MTok）。**

---

## 3. 站点语义约定（破坏了页面就会显示错，务必遵守）

1. **数组顺序严格对应**：`models.<vendor>[i]` 的三项价格就是 `hit[i] / miss[i] / out[i]`，不能错位。
2. **DeepSeek**：`data.json` 只存**高峰价**，页面自动把空闲价算成高峰价 × 0.5。
   若官方页给的是空闲价，请 **×2** 换算回高峰价再写入。并保持「2 个模型」的顺序：Flash、Pro。
3. **MiniMax**：只写 `minimaxStd`（标准价）；优先档由页面按 `minimaxPriFactor` 放大，适配器不用管。
4. **Doubao**：`doubaoReg`（常规）与 `doubaoLow`（低延迟）两套并存；低延迟不提供的档位写 `null`。
5. **分档模型**（如 `≤512k`、`32-128k`、`256k–1m`）是**独立的数组元素**，标签必须与现有 `data.json` 中的写法**逐字一致**（含空格、`≤`、`–` 等字符），否则页面筛选和标签会错乱。
6. 若官方新增/下线了模型，可以增删数组元素，但必须同步 `models` 与三张价格数组，保持长度相等。
7. 价格单位若官方按「千 tokens」标注，请 ×1000 归一到百万。

---

## 4. 已有侦察结论（可直接用，避免重复劳动）

原始页面已下载在 `_recon/` 目录，可离线分析：

| vendor | 侦察结论 |
|---|---|
| deepseek | `_recon/deepseek.txt` 是静态 HTML，价格在 `<table>` 里，可直接正则/解析提取 |
| kimi | Mintlify 文档站！`https://platform.kimi.com/docs/llms.txt` 是索引；每个模型定价页加 `.md` 后缀即得 markdown，正文里是 `<DocTable rows={[...]} />` 的 JSX 数组。相关页：`/docs/pricing/chat-k3.md`、`chat-k27-code.md`、`chat-k26.md` |
| mimo | `_recon/mimo.txt` 静态 HTML，价格在 `<td class="mdx-td">` 单元格里，形如 `¥0.025` |
| minimax | `_recon/minimax.txt` 含 `__NEXT_DATA__`，里面嵌了 markdown 正文（含加价表格） |
| doubao | `_recon/doubao.txt` 含 `window._ROUTER_DATA = {...}`（819KB JSON），文档正文在 `loaderData['docs/(libid)/(docid$)/page']` 一带，需自行定位价格文本 |
| qwen | `_recon/qwen.txt` 是阿里低代码页面；`_recon/qwen-price-mod.js` 里有 `https://${OPENAPI_DOMAIN}/data/api.json?product=..&action=..` 这类接口模板，需还原出真实域名与参数 |
| glm | `_recon/glm.txt` 是纯 Vue SPA 空壳；`_recon/glm-app.js` 是 webpack 主包（无 price 字样，说明定价页是懒加载 chunk）。线索：`https://static.bigmodel.cn/wd-paas-front/js/runtime.22c4142d.js` 里有 chunk 映射，可据此找到定价页 chunk，再从 chunk 里挖接口或内嵌数据 |

> `_recon/` 是临时目录，最终会被删除；**不要**把适配器写成依赖它的形式，适配器必须自己联网抓取。

---

## 5. 验收标准

1. `node scrape/adapters/<vendor>.mjs` 能打印出**当前官网真实价格**的 JSON。
2. 打印结果与 `data.json` 中现有该厂商的结构、标签写法完全同构。
3. 连续运行两次结果一致（无随机性）。
4. 抓取失败时抛错，而不是返回空数组或全 0。
