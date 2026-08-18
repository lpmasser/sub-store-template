# SubStore 客户端模板与规则

本仓库保存可公开的 SubStore 客户端模板、共享分流策略和规则产物，不保存节点、订阅 URL 或凭据。

## 客户端模板

- `templates/routing-policy.json`：sing-box 与 Shadowrocket 的唯一分流策略源；
- `templates/sing-box.json`：sing-box `1.13.18` 运行时模板；
- `templates/shadowrocket.json`：Shadowrocket Clash 兼容模板；
- `templates/transform.js`：SubStore 共享渲染器；
- `templates/transform.test.cjs`：两个客户端的本地转换测试。

SubStore 通过 GitHub Raw 读取 JSON 模板和分流策略，Script Operator 使用 `link` 模式读取 `transform.js`。修改模板只在本仓库维护，不向基础设施仓库复制第二份。

共享分组采用“业务策略 → 稳定出口 → 协议节点”两级选择结构。业务策略完整保留；出口只使用普通 selector，VLESS 为默认、Hysteria2 为手动备用。
美国与亚太 VPS 管理流量使用独立策略组，分别默认经 DMIT Pro 和 ISIF JP 中转，并保留手动直连选项。

所有客户端节点都来自同一个 SubStore Collection。美国家宽的 DMIT Pro 与 DMIT EB 路径都由对应 Host 在服务端转发，模板不生成客户端链式代理，也不读取额外的私密节点快照。

sing-box 客户端保留 IPv4/IPv6 双栈 TUN，并按物理默认接口是否具有 `2000::/3` 地址处理本地解析范围：无公网 IPv6 时，AAAA/HTTPS 返回空的 `NOERROR` 响应，规则模式下来自 TUN 的国内字面量 IPv6 在 sniff 前快速拒绝；direct/global 模式保持原语义。`default_interface_address` 反映平台报告的默认接口，源码不保证自动排除 TUN；目前只能确认 SFM 的 direct dial 绑定 `en0`，真 IPv6 网络恢复行为仍需在 macOS 客户端实测。该处理基于已确认存在绕过系统 DNS 的字面量 IPv6，不把具体应用调用链写成确定根因。

Apple 是可切换出口的 selector，因此不进入无条件本地 DNS 范围。规则模式下 Apple 的 A/AAAA 使用通用 FakeIP，HTTPS 单独返回 `NOERROR` NODATA，避免 SVCB/HTTPS 提示绕开 selector；默认选择直连时由 `route.default_domain_resolver` 解析，切换为代理时保留域名交给代理出口。iCloud、App Store、推送和中国区 CDN 仍需在 macOS 客户端实测。

验证：

```sh
jq empty templates/*.json
node --check templates/transform.js
node --test templates/transform.test.cjs
```

## HaGeZi Pro

- 上游：[HaGeZi DNS Blocklists](https://github.com/hagezi/dns-blocklists)
- 源格式：[HaGeZi Pro Adblock](https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.txt)
- sing-box 产物：`rules/hagezi-pro.srs`
- Shadowrocket 产物：`rules/shadowrocket/hagezi-pro.list`
- 转换器：sing-box `1.13.14`
- 调度：每日 04:23 UTC，也支持手动运行

工作流下载官方源，拒绝异常缩小的输入，校验锁定版本的 sing-box 压缩包，并从同一份 HaGeZi Pro 内容生成 SRS 与 Shadowrocket 文本规则。

## 路由规则

`rules/sources.json` 记录 sing-box SRS 上游。工作流使用 sing-box 反编译这些 SRS，再生成 `rules/shadowrocket/*.list`。因此两个客户端使用相同规则内容，只保留格式与执行策略差异。

`rules/sources.json` 只是格式转换的产物清单，不保存策略组、分流去向或规则顺序。

远程规则使用 `raw.githubusercontent.com` 原始地址。MetaCubeX 的 `sing` 与本仓库的 `main` 分支有意保留，以维持每日规则构建；不额外增加自动改写 commit SHA 的逻辑。仓库测试负责约束 canonical URL、客户端字段和生成结构，每次自动构建产物则由 Git 提交记录实际版本。

sing-box 的 `domain_regex` 在 Shadowrocket 没有等价的域名规则类型，构建器会转换为 `DOMAIN-WILDCARD` 并在日志中报告数量。通配符无法表达字符范围和重复次数，因此这部分规则可能比上游正则稍宽；其他域名与 IP 规则保持原类型。如果上游出现未支持的规则字段，构建会直接失败，不会静默丢弃。

不要手工编辑生成产物。HaGeZi 源内容使用 [GPL-3.0](https://github.com/hagezi/dns-blocklists/blob/main/LICENSE)；其他规则来源见 `rules/sources.json`，规则内容与误拦反馈仍以上游项目为准。
