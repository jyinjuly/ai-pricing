# 定价数据自动采集（scrape/）

把 `data.json` 从「人工维护」升级为「**每天自动从七家厂商官网抓取**」。抓完直接写回 `data.json`，前端页面（`index.html`）最多 30 秒内自动同步，全程不需要人工介入。

---

## 一、最快上手

```powershell
cd C:\Users\tengeer\workspace\ai-pricing

node scrape/run.mjs --dry     # ① 先空跑：只抓取和校验，不写文件，看清楚会改哪些价格
node scrape/run.mjs           # ② 确认无误后正式执行：写入 data.json
```

看到 `✓ 已写入 data.json（v2）` 就成功了。此时前端页面（如果开着）会在 30 秒内自动更新。

> **强烈建议第一次先跑 `--dry`。** 它会打印每一处价格变化（`pricing.kimi.out[0]: 100 → 90`）和异常波动告警，让你在数据落盘前确认抓取逻辑没跑偏。

---

## 二、三种运行方式，按场景选一个

| 方式 | 命令 | 适合 |
|---|---|---|
| **手动 / 一次性** | `node scrape/run.mjs` | 想更新时点一下；也可以挂到 CI（GitHub Actions） |
| **常驻进程** | `node scrape/watch.mjs --every=6h` | 服务器、云主机、有 pm2/自启动的环境 |
| **Windows 计划任务**（推荐） | 见下方 | 自己的电脑：开机自启、休眠恢复也会补跑、不占内存 |

### Windows 计划任务（推荐给个人电脑）

```powershell
# 每天 09:00 自动采集
powershell -ExecutionPolicy Bypass -File scrape\install-windows-task.ps1

# 自定义时间 / 任务名
powershell -ExecutionPolicy Bypass -File scrape\install-windows-task.ps1 -Time 08:30 -Name "农夫AI定价采集"

# 立即试跑一次
Start-ScheduledTask -TaskName "NongfuAI-Pricing-Scrape"

# 取消
powershell -ExecutionPolicy Bypass -File scrape\install-windows-task.ps1 -Remove
```

### 失败告警（强烈建议开启）

无人值守最大的风险不是抓取失败，而是**失败了却没人发现**。配一个钉钉 / 企业微信 / 飞书机器人地址即可：

```powershell
$env:SCRAPE_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/你的token"

node scrape/run.mjs --test-notify   # 先发一条测试消息，确认通道打通
node scrape/run.mjs                 # 正常采集
```

**推送时机**（成功且无变化时不会打扰）：

| 情况 | 消息标题 |
|---|---|
| 七家**全部**抓取失败 | 全部适配器失败 |
| 数据**校验不通过**（结果被丢弃） | 数据校验未通过 |
| 有**任意一家**抓取失败 | 部分厂商抓取失败 |
| 价格**异常波动**（相对变化 ≥ 40%） | 价格出现异常波动 |
| 价格有正常更新 | 价格已更新 |

**`--test-notify` 会打印机器人的原始响应**，这是判断有没有真正发出去的唯一可靠方式——

> ⚠️ **坑**：钉钉和飞书在「token 无效 / 关键词不匹配 / 机器人被停用」这类失败场景下，**HTTP 状态码依然是 200**，错误藏在响应体的 `errcode` / `code` 字段里。只看 HTTP 状态会把失败误判成成功。脚本已按 `errcode===0`（钉钉/企业微信）/ `code===0`（飞书）判定，失败时会把原始错误打印出来。

**飞书配置**：群设置 → 群机器人 → 添加机器人 → 自定义机器人 → 复制 Webhook 地址（形如 `…/open-apis/bot/v2/hook/xxxx`）。飞书不强制关键词，但如果开了「签名校验」，本脚本不支持，请改用「自定义关键词」模式。

**钉钉配置**：群设置 → 智能群助手 → 添加机器人 → 自定义 → 安全设置选「自定义关键词」→ 关键词填 `农夫AI`（脚本的消息标题固定以「【API 价格采集】」开头，能匹配上）。

**企业微信**：群机器人 Webhook，无需额外配置。

脚本会依次尝试钉钉/企业微信格式和飞书格式，哪种被接受就用哪种，所以你填哪种地址都能用。

---

## 三、安全设计（为什么可以放心无人值守）

采集脚本最怕的不是抓不到，而是**抓错了还悄悄写进去**。为此做了五层防护：

1. **单个厂商失败 → 保留旧值**
   适配器抓不到就 `throw`，编排器只合并成功的厂商，失败的那家维持上一次的数据。绝不会出现空数组或 0。

2. **全部失败 → 完全不碰 `data.json`**
   避免无意义地修改文件、触发前端刷新。退出码 `2`。

3. **落盘前强制校验，不通过就丢弃整份结果**（退出码 `3`）
   - 模型数组长度必须与 `hit` / `miss` / `out` 三个数组**严格相等**（错位是最危险的错误）
   - 所有价格必须是有限非负数字或 `null`，不允许字符串、`NaN`、负数
   - 分档模型出现顺序错乱会告警

4. **异常波动检测**
   与上一版对比，任何价格相对变化 ≥ 40% 都会被标记并写进报告 + 推送告警。厂商真涨价了正常放行，抓错了你马上知道。

5. **历史留档 + 变更日志**
   每次**实际发生更新**都会存一份快照到 `data-history/data-<时间戳>.json`（保留最近 120 份），
   完整变更明细写在 `scrape/last-run.json`。想回滚或看价格走势都有据可查。

另外，写入采用「先写临时文件再改名」的原子写法，不会出现写到一半的半截 JSON。

### 关于 `index.html` 里的内联兜底值

`index.html` 内部仍保留一份数据副本，**只在两种情况下生效**：浏览器禁止读取本地 JSON（`file://` 直接双击打开），或 `data.json` 一时拉取不到。它保证页面任何情况下都不会白屏。

**但请以 `data.json` 为准**——内联副本是写入时的一份快照，不会随采集自动更新，长期不用会逐渐过时。页面右上角的状态点会明确告诉你当前用的是哪一份：

- 🟢 **数据已同步** / "N 秒前同步" → 用的是 `data.json`（正常状态，悬停可看采集方式与版本号）
- 🔴 **离线 · 内置数据** → 用的是内联兜底值，价格可能已过时

看到红灯就去检查服务是不是没起来（`node serve.js`）。


---

## 四、退出码约定（用于脚本/计划任务判断）

| 退出码 | 含义 | 处理建议 |
|---|---|---|
| `0` | 正常（有更新，或数据无变化） | — |
| `1` | 环境问题：找不到 `data.json` 或没有可用适配器 | 检查工作目录 |
| `2` | 所有适配器都失败 | 看 `scrape/last-run.json`，多半是网络或官网改版 |
| `3` | 校验未通过，结果已丢弃 | 报告里有具体原因，属于适配器需要修 |

---

## 五、目录结构

```
scrape/
├── run.mjs                      # 编排器：跑适配器 → 合并 → 校验 → 落盘 → 报告/告警
├── watch.mjs                    # 常驻定时循环（--every=6h）
├── install-windows-task.ps1     # 注册 Windows 计划任务
├── CONTRACT.md                  # 适配器开发契约（新增厂商时看这个）
├── last-run.json                # 最近一次运行报告（不入库）
├── run.log                      # 常驻模式的日志（不入库）
├── lib/
│   └── http.mjs                 # 共享 HTTP 工具：超时/重试/JSON 提取/价格归一
└── adapters/
    ├── deepseek.mjs
    ├── kimi.mjs
    ├── glm.mjs
    ├── minimax.mjs
    ├── mimo.mjs
    ├── qwen.mjs
    └── doubao.mjs
```

每个适配器都可以**独立运行**，用来单独排查问题：

```powershell
node scrape/adapters/kimi.mjs          # 只抓 Kimi，打印原始文本 + 解析结果
node scrape/run.mjs --only=kimi,mimo   # 只跑指定厂商
```

---

## 六、厂商数据源与维护风险

CI 状态见每次运行后的 `scrape/last-run.json`。各家的数据源形态决定了改版时的脆弱程度：

| 厂商 | 实际数据源 | 稳定性 |
|---|---|---|
| **DeepSeek** | 官方文档页静态 HTML 表格（含合并单元格，按行取「高峰时段」） | ⭐⭐⭐ 最稳 |
| **MiMo** | 官方文档页静态 HTML 表格（`td.mdx-td`） | ⭐⭐⭐ 最稳 |
| **Kimi** | Mintlify 文档站：`llms.txt` 索引 → `/docs/pricing/chat-*.md`，解析 MDX `<DocTable rows={[...]} />` | ⭐⭐⭐ 稳 |
| **GLM** | Mintlify 文档站：`docs.bigmodel.cn/cn/guide/start/pricing.md` | ⭐⭐⭐ 稳 |
| **MiniMax** | Mintlify 文档站：`platform.minimax.cn/docs/guides/pricing-paygo.md`（token-plan 页只有套餐价，不可用） | ⭐⭐⭐ 稳 |
| **Doubao** | 火山文档公开内容接口 `docs.volcengine.com/api/doc/getDocDetail?DocumentID=1544106` → `Result.MDContent`；失败自动兜底页面 `_ROUTER_DATA` 里的 markdown | ⭐⭐ 中等（有双通道兜底） |
| **Qwen** | 千问百炼 CS 数据网关 `POST cs-data.qianwenai.com/data/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=…listModelPrices`（逆向自低代码模块，匿名可用） | ⭐ 较脆（未公开接口） |

**共同失败模式（设计内）**：厂商改版 → 适配器 `throw` → 该厂商数据停留在上一版 + 你收到告警。
**宁可旧，不可错**。收到告警后跑 `node scrape/adapters/<厂商>.mjs` 就能看到具体卡在哪一步。

### 已知折扣口径（重要）

自动采集写入的是**官网当前展示的实际计费价**，各家的折扣处理方式不同：

- **Qwen**：接口直接返回 `discount` 字段（如 qwen3.7-plus 为 `0.8`），适配器按 `原价 × discount` 写入**折后价**。折扣一旦取消，采集结果会自动跟随变为原价并触发波动告警。
- **MiniMax**：文档站展示「~~原价~~ 永久五折折后价」，取**折后价**。
- **GLM**：`GLM-5.3-Flash` 原本记录的「限时 5 折价 0.115 / 0.4 / 1.4」经核对**促销已结束**，现按官网标准价 **0.23 / 0.8 / 2.8** 采集（页面注释已同步修正）。

> **约定**：页面上的 `<p class="note">` 注释只描述**计费规则**（时段、分档、倍率），**不写具体价格**——具体价格一律由 `data.json` 提供，避免数据已更新、注释还停在旧价导致页面自相矛盾。


---

## 七、想新增一家厂商？

1. 读 `scrape/CONTRACT.md`（接口契约 + 站点语义约定，务必遵守单位与标签写法）
2. 复制一个现成适配器改名，实现 `scrape()` 返回 `{ models, pricing }` 局部补丁
3. `node scrape/adapters/<新厂商>.mjs` 验证能独立跑通
4. 把新厂商加进 `scrape/run.mjs` 里 `validate()` 的 `groups` 映射表

---

## 八、部署到线上时注意

采集脚本只是**改本机的 `data.json`**。如果看板部署在静态托管（GitHub Pages / Nginx / OSS），还需要把更新后的文件发布出去，二选一：

- **让采集直接产出到站点目录**（本地 Nginx 场景最简单，`data.json` 就是站点根下的文件）；
- **采集完自动提交并推送**（GitHub Pages 场景）：在计划任务里追加 `git add data.json data-history && git commit -m "chore: 更新定价 $(date)" && git push`。

另外，线上访问量大的话，建议把 `data.json` 里的 `meta.pollIntervalMs` 从 `30000` 调到 `300000`（5 分钟）——数据是每天更新的，30 秒轮询对个人站够用，对高流量站没必要。
