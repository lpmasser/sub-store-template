# 客户端规则产物

本仓库只构建当前网络配置使用的规则产物，不保存客户端模板或订阅处理逻辑。

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
