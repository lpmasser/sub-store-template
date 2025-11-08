let config = (ProxyUtils.JSON5 || JSON).parse($content ?? $files[0]) // 文件中的第一个
let proxies = await produceArtifact({
    type: 'subscription', // 如果是组合订阅 就是 'collection'
    name: '订阅的name', // 订阅的"名称", 不是"显示名称"
    platform: 'sing-box',
    produceType: 'internal'
})

// 先将全部节点结构插到 outbounds
config.outbounds.push(...proxies)

config.outbounds.map(i => {
  // 在 全部节点 中插入全部节点名
  if (['全部节点'].includes(i.tag)) {
    i.outbounds.push(...proxies.map(p => p.tag))
  }
  // 在 美国节点 中插入全部美国节点名
  if (['美国节点'].includes(i.tag)) {
    i.outbounds.push(...proxies.filter(p => /美国|🇺🇸|us|united states/i.test(p.tag)).map(p => p.tag))
  }
})

$content = JSON.stringify(config, null, 2)