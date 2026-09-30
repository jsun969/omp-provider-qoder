# omp-provider-qoder

[English](./README.md) | **简体中文**

一个把 **Qoder** 注册为模型 provider 的 omp(oh-my-pi)扩展,由 `pi-provider-qoder` 移植到 omp 扩展 API。

同时支持**中国区**(`qoder-cn`,默认启用)和**全球区**(`qoder`)网关。两者均完整实现;将 [`index.ts`](./index.ts) 中的 `QODER_PROVIDER_MODES` 改为 `["cn", "global"]` 可同时暴露两个 provider。


## 安装

```bash
git clone https://github.com/jsun969/omp-provider-qoder ~/.omp/agent/extensions/omp-provider-qoder
```

omp 会自动发现 `~/.omp/agent/extensions/` 下的扩展,含 `index.ts` 的目录即为合法入口。无需构建 —— 直接用 Bun 加载 TypeScript 源码。之后新开一个 omp 会话即可生效。

## 登录

### 中国区

```text
/login qoder-cn        # PAT 输入框
```

PAT 页面: https://qoder.com.cn/account/integrations

### 全球区

```text
/login qoder           # 浏览器设备码流程 (PKCE + OAuth) 或 PAT
```

PAT 页面: https://qoder.com/account/integrations

如需启用全球区 provider,请将 [`index.ts`](./index.ts) 中的 `QODER_PROVIDER_MODES` 改为 `["cn", "global"]` 后重启 omp。
环境变量里设置了 PAT 时,provider 在启动时即完成登录(按顺序取第一个非空变量):

| Provider | 环境变量 |
| --- | --- |
| `qoder-cn` | `QODERCN_API_KEY`, `QODERCN_PERSONAL_ACCESS_TOKEN`, `QODERCN_PAT` |
| `qoder` | `QODER_API_KEY`, `QODER_PERSONAL_ACCESS_TOKEN`, `QODER_PAT` |

## 使用

```bash
omp --provider qoder-cn --model DeepSeek-V4-Flash
```

```text
/login qoder-cn
/model DeepSeek-V4-Flash
```

## 模型

模型在 omp 中的 id 等于上游 `display_name` 去掉空白字符(`Qwen3.7 Plus` → `Qwen3.7Plus`)。上游目录 key(如 `qmodel_latest`)保存在缓存里,请求时作为 `X-Model-Key` 发送。

登录后实时目录会缓存到 `~/.omp/agent/qoder-cn-models-cache.json`,最多每小时重建一次(登录、token 刷新时,以及 `session_start` 发现过期时)。没有缓存时回退到 [`catalog.ts`](./catalog.ts) 中内置的静态目录。上下文窗口取目录公布的最大档位(默认 1M);最大输出 128K。

## 端点

| | 全球区(`qoder`) | 中国区(`qoder-cn`) |
| --- | --- | --- |
| Chat 网关 | `https://api3.qoder.sh/` | `https://gateway.qoder.com.cn/` |
| 模型列表 | `<网关>algo/api/v2/model/list?Encode=1` | 同左 |
| Chat SSE | `<网关>algo/api/v2/service/pro/sse/agent_chat_generation?...` | 同左 |
| OpenAPI(PAT 换取、userinfo) | `https://openapi.qoder.sh` | `https://openapi.qoder.com.cn` |
| Token 刷新 | `https://center.qoder.sh` | `https://gateway.qoder.com.cn` |

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `index.ts` | `registerProvider` 接线:模型、OAuth 钩子、`streamSimple`、`session_start` 时的缓存刷新 |
| `region.ts` | 分区配置:provider id、端点、环境变量名、自定义 base64 URL 拼接 |
| `auth/oauth.ts` | 凭据生命周期:身份解析、sidecar 持久化、token 刷新 |
| `auth/login.ts` | 交互式登录:PAT 输入、全球区浏览器设备码流程(PKCE + 轮询) |
| `auth/pat.ts` | PAT → job token 换取、userinfo、`pat\|...` refresh 字段编码 |
| `catalog.ts` | 实时模型目录拉取、磁盘缓存、静态回退、thinking 档位映射 |
| `cosy.ts` | 机器码、COSY 请求签名(AES + RSA + MD5 签名头) |
| `protocol/stream.ts` | 请求组装、SSE 消费、pi-ai 事件流输出 |
| `protocol/transform.ts` | pi-ai 消息/工具 → Qoder 线上格式 |
| `protocol/thinking.ts` | `<thinking>` 类标签抽取、DSML 残留清理 |
| `protocol/encoding.ts` | Qoder 自定义 base64 body 编码 |

## 协议要点

- **Body 编码** —— 请求体使用自定义 base64 字母表并做三分之一分块轮转,填充符用 `$` 而非 `=`(`protocol/encoding.ts`)。
- **鉴权** —— `Authorization: Bearer COSY.<payload>.<sig>`;payload 内的用户信息用 AES-128-CBC 加密、其密钥用 RSA 包裹,签名是 payload/key/时间戳/body/sig-path 的 MD5。身份(uid/email)是必需的,来自 sidecar 或实时 userinfo 查询,而不是 job token 本身。
- **SSE** —— 网关把 OpenAI 风格的 chunk 包在 `{"statusCodeValue":200,"body":"<json>"}` 信封里;终止符 `[DONE]` 可能裸发也可能包在信封里,收到即结束读取循环(否则 socket 会一直挂着)。
- **用量换算** —— 把 OpenAI 语义(`prompt_tokens` 含缓存 token)换算成 pi 的口径:`input = prompt_tokens − cached − cache_write`。
- **Thinking** —— `reasoning_content` 映射为 thinking 块;泄漏进 content 通道的字面 `<thinking>`/`<think>`/`<reasoning>`/`<thought>` 标签会被跨 chunk 解析剥离。泄漏的 DSML 工具调用标记同样清理;若一轮回复既无文本、无工具调用、reasoning 尾部又是 DSML 残留,则以可重试的 `server error` 上报,而不是静默 `stop`。
- **推理档位** —— 由 omp 的 thinking level 驱动 `enable_thinking`,并仅在模型公布 `thinking_config.enabled.efforts` 时附带 `reasoning_effort`。
- **pi-ai 兼容** —— 同时兼容扁平 `Context`(systemPrompt/tools,≤0.85)与 `TranscriptContext`(≥0.86)两种 provider 契约,运行时特性探测。

## 本地状态

| 路径 | 用途 |
| --- | --- |
| `~/.omp/agent/qoder-cn-models-cache.json` | 实时模型目录(全球区为 `qoder-models-cache.json`) |
| `~/.omp/agent/qoder-credentials.json` | 身份 sidecar(uid/email/name/机器码);omp 的 `agent.db` 只存 token,不存身份 |
| `~/.omp/agent/qoder-machine-id` | 生成的机器码(存在 `~/.qoder/.auth/machine_id` 时复用该文件) |

设置 `QODER_DEBUG=1` 可打印被跳过的畸形 SSE 行。
## 感谢

基于 [pi-provider-qoder](https://github.com/simonsmh/pi-provider-qoder)。
