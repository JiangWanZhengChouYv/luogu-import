# Changelog

## 1.1.1 — 2026-11-17

### 修复：在线编程「评测记录」面板点开后一直空表

`@hydrooj/ui-default@4.59.1` 的 bug，本插件做了兼容处理。

复现：进入在线编程时「评测记录」是收起的（`localStorage['scratchpad/records'] === 'false'`），
之后再点开 → 面板正常展开、按钮正常高亮，但表格永远是空的，**且浏览器不发任何请求**。

上游根因：

- 初始 `records.visible` 只在挂载时读一次 `localStorage`
- 数据也只在 `componentDidMount` 里 `recordsVisible && loadSubmissions()` 拉一次
- 而 toggle 的 reducer 只翻转 `visible` 并写回 `localStorage`，**从不重新拉取**

所以 `visible` 从 `false` → `true` 时没有任何请求。

本插件的处理：面板展开且 tbody 持续约 1.5 秒为空时，自己取一次
`UiContext.getSubmissionsUrl` 并按原生行结构补渲染。

- 延迟 1.5 秒是必需的：挂载时面板本来就展开的情况，原生会在几百毫秒内自己填好，
  抢在前面补会插出**重复行**
- 补之前与插入前都会检查 `tbody.children.length`，原生已填则不动手
- 原生 `<td>` 用的是 `memory`（KB）/ `time`（ms），不是 `memoryKb` / `timeMs`

上游若日后修掉此 bug，本补丁会因「已有行」判断而自动失效，不会重复渲染。

### 说明

「自测」面板空白属预期行为，不是 bug：它不预填样例，需要自己粘贴数据后按 F9。

## 1.1.0 — 2026-11-17

### 新增：中英双语数据范围识别模型

反算的 `targetN` 一直依赖「题面写的数据规模上界」。规则只认变量名 `n`，
P1048 的 `M ≤ 100`、P1003 的 `n ≤ 10^4` 里前者拿不到，就退回默认 20000，
造出违反题面的数据。

现在内置一个候选排序模型：

- 抽出范围文本里所有 `var <= 数值`，给每个候选打分，选出真正的规模参数
- 逻辑回归 + FNV-1a 确定性特征哈希（8192 桶，1942 个非零权重，30 KB）
- 支持中文与英文句式（`不超过` / `at most` / `1{,}000` 千分位 / 表格形式）
- 权重 `src/range-weights.json`，运行时惰性加载，无额外依赖

**实测**：训练集 13003（zh 10984 / en 2019），测试集 top-1 **96.0%**；
中文覆盖从纯规则的 30.4% 提升到 **64.4%**；错误率 1.2%（有运行时检查兜底）。

英文覆盖率 14.3% 是数据问题：14070 份英文题面里 11295 份根本没有 Constraints 段。

### 修复

- `\le` 的正则用了 `\b`，`\le15` 这种紧跟数字的写法无法匹配，
  导致 `n ≤ 15` 整条上界被吃掉（P1094 曾因此解析出 `bounds=[]`）
- 链式上界 `1 ≤ n ≤ 3×10^4` 之前只识别单侧比较，现取上界
- 计数变量不叫 `n` 时（P1048 的 `M ≤ 100`）没有夹住规模，会造出超题面数据
- 同变量多档上界（30%/100%）现在取最大值，避免反算落在部分分档
- 英文千分位 `1{,}000` / `2{,}000{,}000` 无法解析

### 训练脚本

`tools/range-model/`（纯 numpy，无 sklearn 依赖）：

```
dump_zh.js / dump_en.js  → 导出题面范围段
dataset.py               → 构造候选排序训练集
train2.py                → 训练，输出 top-1
export.py                → 导出 range-weights.json
```

## 1.0.0 — 2026-11-16

首个可分发的完整版本。

### 新增

- 洛谷登录态：`_uid` + `__client_id`，AES-256-GCM 加密存 Mongo（`luogu.config`），密钥 `data/backend/luogu.key`；接口 / 日志只暴露长度。
- 全量拉题：按来源 `P/B/CF/SP/AT/UVA` 逐页遍历，Mongo 持久化任务、断点续跑、暂停 / 继续 / 取消、规模与磁盘估算、空号 HEAD 探测补漏。
- 多语言题面：`data.translations` → Hydro `problem.statement`（`zh.md` / `en.md` …），支持 `?lang=` 切换。
- 远端提交：`/luogu/submit/:pid` 页面 + 在线编程工具栏按钮；CSRF、验证码（JPEG，跟随 302）重提；洛谷评测记录轮询。
- 提交即本地评测：同一份代码同时产生洛谷行与 `LOCAL` 行，结果进原生评测记录表格。
- 反算测试点：AC 代码入库为标程，按题面数据范围生成极限规模测试点；方格题 `n²` 填满；10 组 profile；成功 ≥6 组即写入；失败自动清理残缺 `.in`。
- 用户独立提交账号（`luogu.accounts`），与全站拉题账号隔离。
- 管理接口：`/manage/luogu/{config,test-login,estimate,jobs,job-action,status,import,oracle/:pid}`。

### 修复

- 反算生成器 `SEED` 被提前替换为空串，导致 10 组输入全是 `1`。
- 全 0 终止行（如 `0 0 0`）被随机化，输入不符合题面格式。
- 覆盖导入残留旧测试点（空洞 `.out`），本地评测直接判错。
- 反算规模升档曾超过题面上界（P1003 升到 40000），现以解析出的 `n` 上界为硬上限。
- 结构不可放大的题（A+B）不再触发无意义的升档重跑。
- judge 会话失效（`PostFile Fail 403`）导致 generate 记录 System Error，重启 judge 恢复。

### 验证

- 冒烟：登录、管理页、tags / config / test-login / estimate / jobs / status / oracle、提交页、校验路径、账号页、在线编程注入、导航、评测机 Online。
- 真实登录：`MarkZhang0520`（uid 2270787）校验通过。
- 反算：P1003（n≤1e4，10 组 ×195KB）、P1004（N≤9，10 组 ×81 格 + `0 0 0`）、P1001（不可放大，不升档）。
