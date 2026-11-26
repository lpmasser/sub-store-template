// SubStore renderer for Egern.

const template = JSON.parse($files[0])
const autoUpdateUrl = $arguments?.autoUpdateUrl
if (typeof autoUpdateUrl !== 'string' || !autoUpdateUrl.startsWith('https://')) {
  throw new Error('缺少有效的 Egern 自动更新地址')
}
const policy = JSON.parse(await produceArtifact({
  name: 'routing-policy',
  type: 'file',
}))
const collectionNodes = await produceArtifact({
  name: policy.collection,
  type: 'collection',
  platform: 'JSON',
  produceType: 'internal',
})
const names = collectionNodes.map(node => node.name)
const singBoxOnlyNodes = new Set((policy.singBoxGroups || []).flatMap(
  group => matchNodes(policy.patterns[group.match], names),
))
const sourceNodes = collectionNodes.filter(node => !singBoxOnlyNodes.has(node.name))
const output = ProxyUtils.produce(sourceNodes, 'Egern', { prettyYaml: true })
const proxies = ProxyUtils.yaml.safeLoad(output).proxies || []
// SubStore's Egern producer drops the leaf certificate pin.
for (const proxy of proxies) {
  if (!proxy.hysteria2) continue
  const source = sourceNodes.find(node => node.name === proxy.hysteria2.name)
  if (source?.['tls-fingerprint']) {
    proxy.hysteria2.fingerprint_sha256 = source['tls-fingerprint']
    delete proxy.hysteria2.skip_tls_verify
  }
}
const chains = $arguments.residentialFile
  ? buildResidentialChains(
    JSON.parse(await produceArtifact({ name: $arguments.residentialFile, type: 'file' })),
    policy,
    proxies,
  )
  : new Map()
proxies.push(...Array.from(chains.values()).flat())
const proxyTags = proxies.map(getProxyName)
const groups = buildGroups(policy, proxyTags, chains)

$content = ProxyUtils.yaml.safeDump(renderConfig(template, policy, proxies, groups), {
  lineWidth: -1,
})

function getProxyName(proxy) {
  const definition = Object.values(proxy)[0]
  if (!definition?.name) throw new Error(`Egern 节点缺少名称: ${JSON.stringify(proxy)}`)
  return definition.name
}

function buildResidentialChains(document, candidate, proxies) {
  const byName = new Map(proxies.map(proxy => [getProxyName(proxy), proxy]))
  const lineGroups = new Map(candidate.groups.filter(group => group.match).map(group => [group.tag, group]))
  const allowedGroups = new Set([...lineGroups.keys(), ...(candidate.singBoxGroups || []).map(group => group.tag)])
  const chains = new Map()
  for (const [group, outbounds] of Object.entries(document)) {
    if (!allowedGroups.has(group) || !Array.isArray(outbounds) || !outbounds.length) {
      throw new Error('Egern 家宽链式分组无效')
    }
    chains.set(group, outbounds.map(outbound => {
      const upstream = lineGroups.get(outbound?.detour)?.default
      if (outbound?.type !== 'shadowsocks' || !outbound.tag || byName.has(outbound.tag) ||
          !byName.get(upstream)?.vless) {
        throw new Error(`Egern 家宽链式分组 ${group} 的代理或 VLESS 前置无效`)
      }
      const shadowsocks = {
        name: outbound.tag,
        method: outbound.method,
        password: outbound.password,
        server: outbound.server,
        port: outbound.server_port,
        udp_relay: outbound.network !== 'tcp',
        prev_hop: upstream,
      }
      if (outbound.plugin) Object.assign(shadowsocks, egernObfs(outbound, group))
      const proxy = { shadowsocks }
      byName.set(outbound.tag, proxy)
      return proxy
    }))
  }
  return chains
}

function egernObfs(outbound, group) {
  if (outbound.plugin !== 'obfs-local') throw new Error(`Egern 家宽链式分组 ${group} 的混淆插件无效`)
  const options = Object.fromEntries((outbound.plugin_opts || '').split(';').filter(option => option.includes('=')).map(option => {
    const separator = option.indexOf('=')
    return [option.slice(0, separator), option.slice(separator + 1)]
  }))
  if (options.obfs !== 'http' && options.obfs !== 'tls') {
    throw new Error(`Egern 家宽链式分组 ${group} 的混淆模式无效`)
  }
  return {
    obfs: options.obfs,
    ...(options['obfs-host'] ? { obfs_host: options['obfs-host'] } : {}),
    ...(options['obfs-uri'] ? { obfs_uri: options['obfs-uri'] } : {}),
  }
}

function buildGroups(candidate, nodes, chains) {
  const extraGroups = (candidate.singBoxGroups || []).filter(group => chains.has(group.tag))
  const groups = [...candidate.groups, ...extraGroups].map(group => {
    const chain = chains.get(group.tag)
    if (chain) {
      const members = chain.map(getProxyName)
      return { ...group, members, default: members[0] }
    }
    return {
      ...group,
      members: unique([
        ...(group.members || []),
        ...(group.singBoxMembers || []).filter(member => chains.has(member)),
        ...matchNodes(candidate.patterns[group.match], nodes),
      ]),
    }
  })
  const available = new Set([...nodes, candidate.directPolicy, ...groups.map(group => group.tag)])

  for (const group of groups) {
    if (group.members.length === 0) throw new Error(`策略组 ${group.tag} 没有节点`)
    for (const member of group.members) {
      if (!available.has(member)) throw new Error(`策略组 ${group.tag} 引用了不存在的成员: ${member}`)
    }
    if (group.default && !group.members.includes(group.default)) {
      throw new Error(`策略组 ${group.tag} 的默认节点不存在: ${group.default}`)
    }
    if (group.default) {
      group.members = [group.default, ...group.members.filter(member => member !== group.default)]
    }
  }

  return groups
}

function matchNodes(keywords, nodes) {
  if (!keywords) return []
  const normalized = keywords.map(keyword => keyword.toLowerCase())
  return nodes.filter(node => {
    const name = node.toLowerCase()
    return normalized.every(keyword => name.includes(keyword))
  })
}

function unique(values) {
  return Array.from(new Set(values))
}

function mapPolicy(tag, candidate) {
  return tag === candidate.directPolicy ? 'DIRECT' : tag
}

function renderConfig(config, candidate, nodes, groups) {
  config.auto_update = {
    url: autoUpdateUrl,
    interval: 86400,
  }
  config.proxies = nodes
  config.policy_groups = groups.map(group => ({
    [group.type === 'auto' ? 'auto_test' : 'select']: {
      name: group.tag,
      policies: group.members.map(member => mapPolicy(member, candidate)),
      ...(group.type === 'auto' ? {
        latency_test_url: candidate.healthCheck.url,
        interval: candidate.healthCheck.intervalSeconds,
        tolerance: candidate.healthCheck.toleranceMs,
      } : {}),
    },
  }))

  const rules = [
    egernRule('ip_cidr', '127.0.0.0/8', 'DIRECT', true),
    egernRule('ip_cidr', '10.0.0.0/8', 'DIRECT', true),
    egernRule('ip_cidr', '172.16.0.0/12', 'DIRECT', true),
    egernRule('ip_cidr', '192.168.0.0/16', 'DIRECT', true),
    egernRule('ip_cidr', '169.254.0.0/16', 'DIRECT', true),
    egernRule('ip_cidr6', '::1/128', 'DIRECT', true),
    egernRule('ip_cidr6', 'fc00::/7', 'DIRECT', true),
    egernRule('ip_cidr6', 'fe80::/10', 'DIRECT', true),
  ]

  for (const rule of candidate.routing.inline) {
    const destination = mapPolicy(rule.policy, candidate)
    for (const value of rule.values) {
      rules.push(egernRule(rule.type, value, destination, rule.type === 'ip_cidr'))
    }
  }

  for (const ruleSet of candidate.routing.ruleSets) {
    const destination = ruleSet.egernPolicy || (
      ruleSet.policy ? mapPolicy(ruleSet.policy, candidate) : undefined
    )
    if (!destination) continue
    rules.push({
      rule_set: {
        match: `${candidate.routing.ruleBaseUrl}/${ruleSet.artifact}.yaml`,
        policy: destination,
        update_interval: 86400,
      },
    })
  }

  rules.push({ default: { policy: mapPolicy(candidate.routing.final, candidate) } })
  config.rules = rules
  return config
}

function egernRule(type, match, policy, noResolve = false) {
  return {
    [type]: {
      match,
      policy,
      ...(noResolve ? { no_resolve: true } : {}),
    },
  }
}
