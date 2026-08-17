# sing-box 规则产物

本仓库只构建当前网络配置使用的二进制规则产物，不再保存客户端模板或订阅处理逻辑。

## HaGeZi Pro

- 上游：[HaGeZi DNS Blocklists](https://github.com/hagezi/dns-blocklists)
- 源格式：[HaGeZi Pro Adblock](https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.txt)
- 产物：`rules/hagezi-pro.srs`
- 转换器：sing-box `1.13.14`
- 调度：每日 04:23 UTC，也支持手动运行

工作流下载官方源，拒绝异常缩小的输入，校验锁定版本的 sing-box 压缩包，并通过 `sing-box rule-set convert --type adguard` 转换。只有 SRS 内容变化时才会自动提交产物。

不要手工编辑 SRS。HaGeZi 源内容使用 [GPL-3.0](https://github.com/hagezi/dns-blocklists/blob/main/LICENSE)；规则内容与误拦反馈仍以上游项目为准。
