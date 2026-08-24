# SubStore 客户端模板与规则

本仓库保存可公开的 SubStore 客户端模板、共享分流策略和规则产物，不保存节点、订阅 URL 或凭据。

## 客户端模板

- `templates/routing-policy.json`：所有客户端的唯一分流策略源；
- `templates/sing-box.json`：sing-box `1.13.18` 运行时模板；
- `templates/egern.json`：Egern 原生 Profile 模板；
- `templates/sing-box-transform.js`：sing-box 渲染器；
- `templates/egern-transform.js`：Egern 渲染器；
- `templates/transform.test.cjs`：两个客户端的本地转换测试。

SubStore 通过 GitHub Raw 读取 JSON 模板和分流策略，每个客户端的 Script Operator 使用 `link` 模式读取自己的渲染器。修改模板只在本仓库维护，不向基础设施仓库复制第二份。

sing-box 渲染器支持 Script Operator 参数 `profile=no-adblock`。该 profile 复用同一份模板、节点、策略组和分流策略，只在渲染时移除 `geosite-adblock` 规则集；未传参数时保持默认去广告行为。

Egern 的 `auto_update.url` 由线上 SubStore File 的私有 Script Operator 参数 `autoUpdateUrl` 注入；本公开仓库只保存注入逻辑和测试占位值，不保存实际分享 URL。

共享分组采用“业务策略 → 稳定出口 → 协议节点”两级选择结构。业务策略完整保留；出口只使用普通 selector，VLESS 为默认、Hysteria2 为手动备用。
美国与亚太 VPS 管理流量使用独立策略组，分别默认经 DMIT Pro 和 ISIF JP 中转，并保留手动直连选项。

所有客户端节点都来自同一个 SubStore Collection。Egern 输出使用原生 `proxies`、`policy_groups` 和 `rules`，不套用 Clash 配置。美国家宽的 DMIT Pro 与 DMIT EB 路径都由对应 Host 在服务端转发，模板不生成客户端链式代理，也不读取额外的私密节点快照。

sing-box 客户端保留 IPv4/IPv6 双栈 TUN，并按物理默认接口是否具有 `2000::/3` 地址处理本地解析范围：无公网 IPv6 时，AAAA/HTTPS 返回空的 `NOERROR` 响应，规则模式下来自 TUN 的国内字面量 IPv6 在 sniff 前快速拒绝；direct/global 模式保持原语义。`default_interface_address` 反映平台报告的默认接口，源码不保证自动排除 TUN；目前只能确认 SFM 的 direct dial 绑定 `en0`，真 IPv6 网络恢复行为仍需在 macOS 客户端实测。该处理基于已确认存在绕过系统 DNS 的字面量 IPv6，不把具体应用调用链写成确定根因。

规则模式下，除 local DNS scope 和显式 foreign 例外之外，本应使用 FakeIP 的域名对 HTTPS 查询统一返回 `NOERROR` NODATA，A/AAAA 继续使用 FakeIP。这样会放弃 HTTPS/SVCB 首包中的地址 hint、ECH 和 H3 提示，避免真实地址绕过 FakeIP、路由和 selector；后续连接仍可通过实际应用协议自行协商。Apple、Anthropic/AI 和其他代理域名使用同一规则，不维护单域名补丁；Apple selector 仍默认直连但可切代理。相关 Apple 服务与真实 IPv6 网络仍需在 macOS 客户端实测。

FakeIP IPv4 保持 `198.18.0.0/15`，IPv6 使用 RFC 5180 benchmarking 段 `2001:2::/48`；TUN 接口地址仍是 `fdfe:dcba:9876::1/126`，两者用途不同。IANA 将 `2001:2::/48` 标记为 globally reachable=false，但 Chromium 138 的 IPAddressSpace 映射把它视为 public，可避免 `fc00::/7` FakeIP 触发 Electron/Chromium Private Network Access。其他应用自己的 SSRF 或 special-use 地址检查不在本修复保证范围。sing-box 会在 FakeIP 元数据网段变化时重置 FakeIP store，不要求删除整个 `cache.db`；客户端更新后仍需重连 SFM，并完全退出重开 Electron 应用以清理系统和应用 DNS 缓存。

验证：

```sh
node -e 'const fs=require("node:fs"); for (const file of fs.readdirSync("templates").filter(name => name.endsWith(".json"))) JSON.parse(fs.readFileSync("templates/"+file))'
node --check templates/sing-box-transform.js
node --check templates/egern-transform.js
node templates/transform.test.cjs
```

## HaGeZi Pro

- 上游：[HaGeZi DNS Blocklists](https://github.com/hagezi/dns-blocklists)
- 源格式：[HaGeZi Pro Adblock](https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.txt)
- sing-box 产物：`rules/hagezi-pro.srs`
- Egern 产物：`rules/egern/hagezi-pro.yaml`
- 转换器：sing-box `1.13.14`
- 调度：每日 04:23 UTC，也支持手动运行

工作流下载官方源，拒绝异常缩小的输入，校验锁定版本的 sing-box 压缩包，并从同一份 HaGeZi Pro 内容生成 SRS 与 Egern 原生 YAML 规则。

## 路由规则

`rules/sources.json` 记录 sing-box SRS 上游。工作流使用 sing-box 反编译这些 SRS，再生成 `rules/egern/*.yaml`。两个客户端使用相同规则内容，只保留格式与执行策略差异。

`rules/sources.json` 只是格式转换的产物清单，不保存策略组、分流去向或规则顺序。

远程规则使用 `raw.githubusercontent.com` 原始地址。MetaCubeX 的 `sing` 与本仓库的 `main` 分支有意保留，以维持每日规则构建；不额外增加自动改写 commit SHA 的逻辑。仓库测试负责约束 canonical URL、客户端字段和生成结构，每次自动构建产物则由 Git 提交记录实际版本。

Egern 原生保留 `domain_regex` 等受支持字段。如果上游出现未支持的规则字段，构建会直接失败，不会静默丢弃。

不要手工编辑生成产物。HaGeZi 源内容使用 [GPL-3.0](https://github.com/hagezi/dns-blocklists/blob/main/LICENSE)；其他规则来源见 `rules/sources.json`，规则内容与误拦反馈仍以上游项目为准。
