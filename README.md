# OpenCode 2 Free（Magpie 插件）

在 Magpie（以及任何兼容 OpenCode 插件的宿主）里使用 OpenCode 2.0.31 的全部免费模型。
Provider id：`opencode-2-free`。

OpenCode 2 的免费额度只对「看起来像 OpenCode 2 发出的请求」开放，否则网关返回
`403 FreeTierError`。插件按 OpenCode 2.0.31 的真实身份发请求：客户端版本、
`User-Agent`、会话 id 形式、请求 id 形式，以及免费层要求的流式请求和工具声明。
用户不需要登录，也不需要自己的 API key。

## 安装

从 GitHub 安装：

```sh
magpie plugin add github:ferocknew/magpie-opencode-2-free-plug-in
magpie plugin login opencode-2-free
```

从本地目录安装（开发或离线）：

```sh
git clone https://github.com/ferocknew/magpie-opencode-2-free-plug-in.git
magpie plugin add ./magpie-opencode-2-free-plug-in
magpie plugin login opencode-2-free
```

在 Magpie 的图形界面里也可以：设置 → 插件 → 添加插件，填入上方的 GitHub 地址或本地
目录，然后在模型供应商里找到 **OpenCode 2 Free**。

## 登录

密钥字段填 `public`，或直接留空。任何填写的值都会被忽略：免费层使用共享的
`public` 凭证，自己的 OpenCode 账号 key 在这里不起作用。凭证保存在 Magpie 的
`plugin-auth.json` 或 OpenCode 的 `auth.json`。

## 可用模型

插件预置了 OpenCode 2.0.31 当前的 10 个免费模型，并在启动时向网关和
`models.opencode.ai` 的目录重新拉取，自动补充新出现的免费模型、下架已停用的模型：

| 模型 id | 名称 | 上下文 | 多模态 |
| --- | --- | --- | --- |
| `glm-5.3-flash-free` | GLM-5.3-Flash Free | 200K | 文本 / 图片 / 视频 / PDF |
| `deepseek-v4.1-flash-free` | DeepSeek V4.1 Flash Free | 200K | 文本 / 图片 |
| `big-pickle` | Big Pickle | 200K | 文本 |
| `beam-free` | Beam Free | 1M | 文本 |
| `nemotron-3.5-super-vl-free` | Nemotron 3.5 Super VL Free | 1M | 文本 / 图片 |
| `space-bunny-free` | Space Bunny Free | 1M | 文本 / 图片 / 视频 |
| `mimo-v2.6-flash-free` | MiMo-V2.6-Flash Free | 200K | 文本 / 图片 / 音频 / 视频 |
| `nemotron-3.5-lightning-free` | Nemotron 3.5 Lightning Free | 256K | 文本 |
| `nemotron-3-ultra-free` | Nemotron 3 Ultra Free | 1M | 文本 |
| `longcat-2.5-preview-free` | LongCat 2.5 Preview Free | 1M | 文本 / 图片 |

调用方式：`opencode-2-free/<模型 id>`，例如 `opencode-2-free/big-pickle`。

所有模型都支持：

- 流式输出的 `reasoning_content`（思考过程），并按模型自身支持的档位生成 reasoning effort 变体；
- 工具调用（function calling）；
- 各自声明的图片、音频、视频、PDF 输入。

模型列表最多每分钟向网关刷新一次。请求一个当前不免费的模型会得到 404，错误信息里会列出
此刻可用的免费模型。

## 请求行为

请求发往 `https://opencode.ai/inference/openai/v1/chat/completions`（Chat Completions 协议）。

网关的免费层有三道门禁，插件在边界处统一补齐，宿主和用户无感知：

1. **必须流式**：请求体固定 `stream: true`。宿主如果要求非流式回复，插件在本地把 SSE
   折叠成普通 JSON 返回。
2. **必须声明核心工具**：请求里至少要有 `read`，插件会补齐 `bash`、`edit`、`glob`、
   `grep`、`read` 五个 OpenCode 核心工具（已声明的不重复添加，参数 schema 完整）。
3. **必须是 OpenCode 2 的身份**：
   - `User-Agent: opencode/2.0.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`
   - `x-opencode-client: cli`
   - 会话 id 为 `opencodeID("ses", true)` 的降序形式，请求 id 为
     `opencodeID("msg", false)`；
   - `authorization: Bearer public`。

会话 id 优先透传宿主（OpenCode/Magpie）提供的真实会话；没有真实会话时，按首条用户消息
的哈希为每个会话生成一个稳定的伪造会话，保证多轮对话落在同一会话里。

## 工具名适配

模型经常直接返回 OpenCode 原生的工具名，而 agent 声明的可能不同（例如模型返回 `bash`，
agent 声明的是 `Bash`）。插件会：

- 仅大小写不同（`bash` → `Bash`）且唯一匹配时改名；
- 仅大小写和分隔符不同（`todowrite` → `todo_write`）且唯一匹配时改名；
- 找不到对应工具的调用从回复中剔除，并在正文里写明被剔除的工具名；若整轮调用都被剔除，
  该轮按普通文本回答结束。

## 流截断与错误

- 上游偶尔在 `[DONE]` 前关闭流。有正文且没有未完成的工具调用时，按普通回答结束并注明
  「cut short」，再次提问即可继续；有未完成工具调用、没有任何正文，或被折叠给非流式客户端
  时，返回带响应 id 和已接收内容的错误。
- 上游错误（包括 403）原样透传给宿主，不吞错、不改写状态码。

## 限额

额度、速率限制和可用性由 OpenCode 2 决定，插件不保存剩余额度数据。免费层随 OpenCode 2
的发布策略变化而调整，插件通过运行时发现自动跟进。

## 卸载

```sh
magpie plugin remove opencode-2-free
```

---

# OpenCode 2 Free (Magpie plugin)

OpenCode 2.0.31's free models in Magpie (and any host that loads OpenCode
plugins). Provider id: `opencode-2-free`.

OpenCode 2's free tier only answers requests that look like they come from
OpenCode 2; anything else gets `403 FreeTierError`. The plugin sends exactly
OpenCode 2.0.31's identity: client version, `User-Agent`, session id shape,
request id shape, plus the streaming and tool declarations the free tier
requires. No sign-in and no personal API key are needed.

## Install

From GitHub:

```sh
magpie plugin add github:ferocknew/magpie-opencode-2-free-plug-in
magpie plugin login opencode-2-free
```

From a local directory:

```sh
git clone https://github.com/ferocknew/magpie-opencode-2-free-plug-in.git
magpie plugin add ./magpie-opencode-2-free-plug-in
magpie plugin login opencode-2-free
```

In Magpie's UI: Settings → Plugins → Add plugin, then enter the GitHub URL or
the local directory, and pick **OpenCode 2 Free** under providers.

## Sign in

Enter `public`, or leave the field blank. Whatever is typed is ignored: the
free tier uses the shared `public` credential, and a key made under your own
OpenCode account does nothing here. The credential is kept in Magpie's
`plugin-auth.json` or OpenCode's `auth.json`.

## Models

The plugin ships the ten free models OpenCode 2.0.31 offers today, and
refreshes them from the gateway and the `models.opencode.ai` catalog, so a
newly free model joins and a retired one leaves:

| Model id | Name | Context | Inputs |
| --- | --- | --- | --- |
| `glm-5.3-flash-free` | GLM-5.3-Flash Free | 200K | text / image / video / PDF |
| `deepseek-v4.1-flash-free` | DeepSeek V4.1 Flash Free | 200K | text / image |
| `big-pickle` | Big Pickle | 200K | text |
| `beam-free` | Beam Free | 1M | text |
| `nemotron-3.5-super-vl-free` | Nemotron 3.5 Super VL Free | 1M | text / image |
| `space-bunny-free` | Space Bunny Free | 1M | text / image / video |
| `mimo-v2.6-flash-free` | MiMo-V2.6-Flash Free | 200K | text / image / audio / video |
| `nemotron-3.5-lightning-free` | Nemotron 3.5 Lightning Free | 256K | text |
| `nemotron-3-ultra-free` | Nemotron 3 Ultra Free | 1M | text |
| `longcat-2.5-preview-free` | LongCat 2.5 Preview Free | 1M | text / image |

Use `opencode-2-free/<model id>`, for example `opencode-2-free/big-pickle`.

Every model streams `reasoning_content`, calls tools, and accepts its declared
image, audio, video or PDF inputs. Reasoning-effort variants are generated for
the levels each model supports.

The list is refreshed from the gateway at most once a minute. A request for a
model that is not free now gets a 404 naming the free models available at that
moment.

## Requests

Requests go to `https://opencode.ai/inference/openai/v1/chat/completions`
(Chat Completions). The free tier's three gates are filled in at the plugin's
boundary, invisible to the host and the user:

1. **Streaming is mandatory**: the body always has `stream: true`. A host that
   asked for a non-streaming reply gets the SSE collapsed back to JSON locally.
2. **Core tools are mandatory**: a request must declare at least `read`. The
   plugin adds `bash`, `edit`, `glob`, `grep` and `read` with full parameter
   schemas, without duplicating tools the agent already declared.
3. **The identity must be OpenCode 2's**:
   - `User-Agent: opencode/2.0.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`
   - `x-opencode-client: cli`
   - session ids in `opencodeID("ses", true)` (descending) form, request ids in
     `opencodeID("msg", false)` form
   - `authorization: Bearer public`

A real session id from the host is passed through. Without one, the plugin
derives a stable made-up session from the first user message, so the turns of
one conversation share one session.

## Tool names

Models often call OpenCode's native tool names while the agent declares
different ones (`bash` vs `Bash`). The plugin renames a call when exactly one
declared tool differs only in case, or only in case and `_`/`-`
(`todowrite` → `todo_write`). A call with no such tool is left out of the reply,
and the reply's text says which name was left out; a turn whose every call was
left out ends as an ordinary answer.

## Stream cuts and errors

- Upstream sometimes closes a stream before `[DONE]`. With text and no
  unfinished tool call, the turn ends as an ordinary answer marked as cut
  short, and asking again continues. With an unfinished tool call, no text, or
  a reply collapsed for a non-streaming client, the request fails with an error
  naming the reply id and how much arrived.
- Upstream errors, 403 included, are passed through unchanged.

## Limits

Quota, rate limits and availability are set by OpenCode 2; the plugin holds no
remaining-quota data. The free tier follows OpenCode 2's release policy, and
the plugin tracks it through runtime discovery.

## Uninstall

```sh
magpie plugin remove opencode-2-free
```
