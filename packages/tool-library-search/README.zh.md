---
description: "模型可调用的 library_search 工具：跨 npm、crates.io、Maven、Go、PyPI、RubyGems 与 GitHub 回答『这个库是不是已经有人做过了?』——全部使用免费的免密钥 API，精确名称优先排序，star/下载量作为活跃度信号。"
kind: "package-reference"
---

# @hy-sde-org/dsh-tool-library-search

[English](README.md) | 中文

## 概览

`dsh-tool-library-search` 给模型一个工具——`library_search`——其全部职责就是在它写新库或重新造轮子之前回答"这东西是不是已经有人做过了"。一次调用把查询并发地发往**免费、无需凭据**的数据源（deps.dev 负责跨生态的存在性检查，npm + crates.io 负责描述与下载量，GitHub 仓库搜索负责"已经有人做过"的语义信号），合并命中结果，并让**精确名称匹配排在最前**——人气只用于打破平局，因此一个恰好同名的小包会排在名字不同的大热门仓库之前。

内置的 `library:search` 提示词片段教会模型何时使用它。

## 工具面

- `library_search [query] [ecosystems] [language] [maxResults]` —— 一个自然语言需求或精确包名，例如 `"parse yaml"` 或 `"serde_yaml"`。
  - `ecosystems` —— 限定到 `npm | cargo | maven | go | pypi | rubygems | nuget | github`（默认全部）。
  - `language` —— GitHub 语言偏置（如 `rust`、`typescript`）；只影响 GitHub 仓库结果。
  - `maxResults` —— 返回候选的上限（默认 20）。

每个候选都标注了生态，并携带 GitHub star 或月下载量作为活跃度信号，以及报告它的来源（跨来源一致是置信度加分项）。

## 数据源（2026-09-06 实测验证）

| 来源 | 为什么入选 | 限制 |
|---|---|---|
| **deps.dev** `deps.dev/_/search` | 唯一一次调用就能知道 npm/cargo/maven/go/pypi/rubygems/nuget 及 GitHub 项目里是否存在该名字。Maven/PyPI 没有可用的免费搜索，这是它们唯一的通道。 | 仅按名称检索：自然语言查询返回 0 条。未文档化的端点——按尽力而为对待。 |
| **npm** `registry.npmjs.org/-/v1/search` | 免费集合中最好的描述搜索 + 月下载量。 | 无明确配额；高频突发可能被限流。 |
| **crates.io** `crates.io/api/v1/crates` | Cargo 描述 + 下载量。 | 需要非默认 User-Agent（裸客户端会 403）。按名称排序。 |
| **GitHub** `api.github.com/search/repositories` | 语义优先：同时匹配名称与描述，按 star 排序，可选语言偏置。 | **未认证 10 次/分钟**（带 token 30 次/分钟）；代码搜索需要认证，不在范围内。未认证时绝不分页；带 token 且 `perSourceLimit` 大于 100 时按 `page=` 链接翻页（最多 5 页，每页 1 次搜索）以喂养语义池。 |
| **pkg.go.dev** `pkg.go.dev/search` | Go 模块：唯一能用自然语言**描述** Go 的免费来源（摘要 + "Imported by" 数量；以规范导入路径为名称）。 | **只有 HTML，没有 JSON API** —— 用正则解析 `SearchSnippet` 卡片；页面结构变化时返回 0 条（不导致调用失败；deps.dev 仍覆盖 Go 名称）。 |

经实测排除的：**libraries.io**（需要 API key，401）、**OpenLib**（反爬 403）、**PyPI 搜索**（XML-RPC 已移除；`/search` 位于客户端挑战之后）、**Maven solrsearch**（`q=yaml` 前 30 条都没有 `org.yaml:snakeyaml`——只有 `a:<artifact>` 字段查询可用）、**api.deps.dev/v3alpha/search**（404）。

## 排序

1. **精确名称匹配**（2）——名称或其最后一个路径段在压缩后等于查询（`serde_yaml` ≡ `serde-yaml` ≡ `serdeyaml`；覆盖 `org.yaml:snakeyaml`、`dtolnay/serde-yaml`）。这种精确性按设计是整体/末段相等：`*_serde_yaml` 分叉是*相关*（1），而非精确。
2. **全 token 匹配**（1）——查询的**每一个** token 都出现在名称中。特意不是"任意一个 token"：在 `"yaml parser"` 里只共享 `parser` 会得到 0，从而让人气浮现出权威的大 star 仓库，而不是每一个 `*-parser` 包。
3. **人气**——对数尺度 star（权重 35）高于下载量（权重 10）；pkg.go.dev 的 "Imported by" 数并入下载量权重，让 Go 候选也有活跃度数字。
4. **共识**——被多个来源报告的候选获得一个小的加分。

精确性按设计以两个数量级压过人气：如果存在恰好同名的包，那它就是"这个有没有人做过"的答案，无关某个不同名字的仓库有多少 star。

**描述会被截断**。候选的一行描述（GitHub 仓库描述是未经审核的用户文本）在合并/排序前被剪到 300 字符并以 `…` 结尾，避免某条数万字符的恶意仓库描述淹没答案。

## 语义重排（README 相似度）

在名称/人气排序之外,`semantic: true`(随附的 `cordis.patch.yml` 已启用)会把查询与每个候选的 README 嵌入向量空间,再按余弦相似度重排。这正是名称检索看不到的场景的解药:`saphyr` 不含 "yaml parser",但它就是 Rust 的 YAML 解析器;`pulldown-cmark` 不含 "markdown parser",但它确实是。

**实现方式**(`src/readme.ts` + `src/semantic.ts`):

1. **README 获取,尽力而为、按候选进行。** npm 包取自 registry 自带的 `readme` 字段(每包一个 JSON 调用);GitHub 项目(以及 crates.io 条目带有 `repository` 的 cargo crate)取自 `raw.githubusercontent.com/<owner>/<repo>/HEAD/README.md`(附 `.rst` 回退)。**不使用** crates.io 的 `/readme` 端点:它重定向到 `static.crates.io/readmes/...`,对非浏览器客户端返回 403(2026-09-06 验证);改为跟随 `repository` 字段到 GitHub raw。Maven/PyPI 与 pkg.go.dev 的 Go 命中（没有 repository 字段）没有 README 通道——这些候选只嵌入名称+描述。抓取以有界并发(6)进行,每个 6s 超时,且单项容错:某个 README 缺失永远不会导致调用失败。
2. **本地嵌入,免费且免密钥。** 查询 + 最多约 30 段 README 文本在一次批处理调用中嵌入,使用小型 all-MiniLM-L6-v2 量化模型(约 25 MB,首次下载后缓存),通过**可选对等依赖** `@huggingface/transformers`。无需 API key,无需外部嵌入服务。未安装该对等依赖时,`semantic: true` 会优雅降级为词法排序并在工具输出中说明。
3. **重排,契约保留。** 精确名称匹配(精确度 2)仍是硬顶层层级——没有任何东西能取代叫这个名字的包。其下 README 相似度(权重 800)主导;全名称 token 匹配只有 +300 的先手;人气只用于打破接近的分数。README 精确描述你所需内容的仓库即使名字毫不相关也会浮现出来。

## 配置

```ts
import toolLibrarySearch from '@hy-sde-org/dsh-tool-library-search'

ctx.plugin(toolLibrarySearch, {
  timeoutMs: 12000,     // 单来源传输超时（默认 10000）
  maxResults: 20,       // 合并排序后的默认结果上限（默认 15）
  perSourceLimit: 8,    // 合并前单来源命中上限；带 token 时 >100 会对 GitHub 翻页
  githubToken: 'ghp_…', // 可选：把 GitHub 仓库搜索配额从 10/分钟 提升到 30/分钟，并启用翻页
  semantic: true,       // 启用 README 相似度重排（默认 false）
  embedderModel: 'Xenova/all-MiniLM-L6-v2', // 可选本地模型 id
  semanticPoolSize: 50, // 进入重排的候选数（在 maxResults 截断之前）
})
```

> 安装可选对等依赖以激活语义重排：
> `npm i @huggingface/transformers`（或 `pnpm add @huggingface/transformers`）。
> 首次调用下载约 25 MB 模型权重；后续调用复用内存中的流水线。未安装对等依赖时工具仍可完整按词法工作。

通过随附的 `cordis.patch.yml` 以 preset/补丁行安装（行 id `hy-sde-libsearch-tool-library-search`），同时注册 `library:search` 提示词片段。

## 已知限制与后续工作

- **语义是单轮、限 README 规模。** 重排只读取候选的 README（≤ 12k 字符）与查询——没有跨查询学习缓存、没有第二阶段语料、没有跨对话 RAG。all-MiniLM-L6-v2 会把长 README 截断到其 256-token 窗口,对 README 开头摘要足够,但会漏掉深入章节。
- **deps.dev 搜索未文档化**（`_/search` 是网站内部端点；文档化的 v3alpha 搜索已 404）。它可能无预警变化；该来源隔离在单个模块之后。
- **GitHub 配额决定调用成本。** 未认证时超过约 10 次/分钟会 403，GitHub 来源会报告失败（可容忍；其他来源照常回答）。繁忙部署请设置 `githubToken`。
- **PyPI/Maven 没有一流的免费搜索**；这些生态由 deps.dev 名称存在性 + GitHub 仓库覆盖，语义层对它们没有 README 通道（仅名称+描述）。Go 通过 pkg.go.dev 有了真正的通道（摘要 + imports），但同样没有 README。
- **GitHub 分页需要 token 才有意义。** 无 token 时来源始终只翻一页（10/分钟预算）；带 token 时把 `perSourceLimit` 设到 100 以上（如 300）即可按 5×100 星标仓库翻页，给语义池更深的候选集（每页占用 30/分钟 中的 1 次搜索）。
- **crates.io 按名称排序**：很少浮现名称中不含查询 token 的 crate（`markdown parser` 下的 `pulldown-cmark`）。当 crate 注册了 `repository` 时,语义重排可部分弥补。

## 开发说明

```bash
pnpm install
pnpm -r check   # tsc --noEmit 覆盖 src + tests
pnpm -r test    # vitest（封闭式：stubbed fetch，无网络）
pnpm -r build   # tsc 输出到 dist
```

源码解析测试为每个免费 API 固定一个 fixture；排序测试固定"精确名称胜过人气"的行为；语义测试用 stub 嵌入器固定"精确名称优先"契约（CI 不下载模型）。可用类似探针的脚本对构建后的 `dist` 做真实网络冒烟测试；语义路径可在一次性目录安装可选对等依赖（或 `pnpm add -D @huggingface/transformers`）后验证。
