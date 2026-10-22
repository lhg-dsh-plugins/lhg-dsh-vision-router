# BUGFIX — 可信 GLM 视觉提示在比对前静默剥除 URL 的 query/fragment，被改动的 URL 可冒充已验证的官方 BigModel 端点

## 标题

`trustedVisionHints` 信任边界失效：`https://open.bigmodel.cn/api/paas/v4?model=other` 这类带 query（或 `#fragment`）的被改动 URL，会被静默剥除修饰后当作已精确验证的官方端点，错误地获得 4 条可信 GLM 视觉模型提示（glm-4.6v / glm-4.6v-flash / glm-4.1v-thinking-flash / glm-4v-flash）。上游已在 Draft PR #749 / #750 中记录同一发现（截至固定 SHA 时尚未合入主线）；本 fork 独立复现并按其根路径方案修复。

## 证据链（失败 → 通过）

环境：node v24.20.0、pnpm 11.20.0、离线最小复现脚本（直接调用构建产物 `lib/trusted-vision-hints.js` 的 `trustedVisionHintsForTransport` / `trustedVisionHintsForProvider`，不涉及任何真实模型 API）。

修复前（基线 6bce1d8，复现脚本输出）：

```text
exact official: hints=4 TRUSTED
trailing slash: hints=4 TRUSTED
QUERY (should NOT trust): hints=4 TRUSTED      ← bug
FRAGMENT (should NOT trust): hints=4 TRUSTED   ← bug
ctx QUERY path: 4 (should be 0)                ← bug（经 providerTransportFor 的根调用路径同样中招）
ctx exact path: 4 (should be 4)
```

基线既有性证明：`git stash` 回退本次修复并重建后，复现脚本输出与修复前逐行一致（QUERY/FRAGMENT/ctx QUERY 均为 4）；`git stash pop` 恢复后回到修复后输出。故该缺陷为上游基线既有，非本次改动引入。基线全量测试亦为全绿（见下），说明现有测试未覆盖此负例。

修复后（同一复现脚本）：

```text
exact official: hints=4 TRUSTED
trailing slash: hints=4 TRUSTED
QUERY (should NOT trust): hints=0 not-trusted
FRAGMENT (should NOT trust): hints=0 not-trusted
ctx QUERY path: 0 (should be 0)
ctx exact path: 4 (should be 4)
```

附加负例（修复后均为 0）：带 userinfo 的 URL、非默认端口 `:8443`、路径仿冒 `/api/paas/v4/evil`、主机仿冒 `open.bigmodel.cn.evil.com`、`http:` 明文协议。

## 根因

两处叠加的静默剥除：

1. `src/lib/trusted-vision-hints.js` 的 `normalizeEndpoint()` 在与可信常量 `https://open.bigmodel.cn/api/paas/v4` 比对前执行 `url.hash=''`、`url.search=''`，把被改动的 URL 归一化成官方端点。
2. 真实 Host 调用路径上更早一层 `src/lib/live-model-discovery.js` 的 `normalizeBaseURL()` 同样先剥除 `?query`/`#fragment`，`providerTransportFor()` 产出的 transport 到达比对层时修饰已被抹掉——只修第 1 处覆盖不了 Settings/registry 根路径（与上游 PR #750 的根路径审计结论一致）。

## 改动（仅 2 个文件，最小改动）

- `src/lib/trusted-vision-hints.js`：
  - `normalizeEndpoint()` 不再剥除 query/fragment；URL 含 userinfo、query 或 fragment 时直接拒绝（返回 `undefined`），精确官方 URL 与尾斜杠变体保持可用。
  - `trustedVisionHintsForProvider()` / `trustedVisionHintEntries()` 改为以 `{ strictBaseURL: true }` 请求 transport 证据。
- `src/lib/live-model-discovery.js`：
  - `normalizeBaseURL(value, { strictBaseURL })` 新增可选严格模式：严格时在剥除前若 raw URL 含 userinfo/query/fragment 则返回 `undefined`；默认行为不变，普通 live `/models` 发现不受影响。
  - `transportForProvider()` / `providerTransportFor()` / `configuredProviderTransports()` 透传该选项（新增参数均可选、向后兼容，其余调用方签名与行为不变）。

其余文件、配置与行为未动；`package.json` 仅 version 3.0.5 → 3.0.6 与 `repository.url` 改为本 fork 落点仓。

## 复验

- 构建：`pnpm build` 成功（183 个 runtime artifacts）。
- 最小复现：修复前 3 处误授信（query / fragment / ctx 根路径），修复后全部为 0，官方精确 URL 与尾斜杠仍为 4。
- 全量测试（`pnpm test`）：修复前与修复后结果完全一致——主套件 1801 测 / 1795 通过 / 0 失败（其余为平台 skip），regression-closure 28/28，最终补充套件 41/41，退出码 0，无回归。
- 类型检查：`pnpm typecheck`（host + client + declaration）退出码 0。

## 边界

- 只修复离线可验证的信任判定逻辑，未调用任何真实模型 API、未改动 provider 注册/目录、端点抓取、运行时模型分发、回退链与凭据处理。
- 本缺陷是准入范围（admission-scope）逻辑不一致；与上游 PR #750 声明一致，不主张曾有真实用户利用过它。
- 默认（非严格）`normalizeBaseURL` 行为刻意保持不变，避免影响普通 live 模型发现。
