# SubStore 客户端模板与规则

本仓库保存可公开的 SubStore 客户端模板、共享分流策略和规则产物，不保存节点、订阅 URL 或凭据。

## 客户端模板

- `templates/routing-policy.json`：sing-box 与 Shadowrocket 的唯一分流策略源；
- `templates/sing-box.json`：sing-box `1.13.14` 运行时模板；
- `templates/shadowrocket.json`：Shadowrocket Clash 兼容模板；
- `templates/transform.js`：SubStore 共享渲染器；
- `templates/transform.test.cjs`：两个客户端的本地转换测试。

SubStore 通过 GitHub Raw 读取 JSON 模板和分流策略，Script Operator 使用 `link` 模式读取 `transform.js`。修改模板只在本仓库维护，不向基础设施仓库复制第二份。

共享分组采用“业务策略 → 稳定出口 → 协议节点”两级选择结构。业务策略完整保留；出口使用普通 selector，VLESS 为默认、Hysteria2 为手动备用，不进行周期性 URLTest。

sing-box 还可以通过 `routing-policy.json` 的 `singBoxPrivateRelays` 引用 SubStore 中的私密本地文件，生成不把凭据写入 Git 的链式出站。当前美国家宽的第二条路径使用 DMIT EB VLESS 作为 `detour`，再直连私密文件中的 Vircs Shadowsocks 上游；Shadowrocket 输出不读取该私密文件。

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

sing-box 的 `domain_regex` 在 Shadowrocket 没有等价的域名规则类型，构建器会转换为 `DOMAIN-WILDCARD` 并在日志中报告数量。通配符无法表达字符范围和重复次数，因此这部分规则可能比上游正则稍宽；其他域名与 IP 规则保持原类型。如果上游出现未支持的规则字段，构建会直接失败，不会静默丢弃。

不要手工编辑生成产物。HaGeZi 源内容使用 [GPL-3.0](https://github.com/hagezi/dns-blocklists/blob/main/LICENSE)；其他规则来源见 `rules/sources.json`，规则内容与误拦反馈仍以上游项目为准。
