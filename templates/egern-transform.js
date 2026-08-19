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
const output = await produceArtifact({
  name: policy.collection,
  type: 'collection',
  platform: 'Egern',
  produceOpts: { prettyYaml: true },
})
const proxies = ProxyUtils.yaml.safeLoad(output).proxies || []
const proxyTags = proxies.map(getProxyName)
const groups = buildGroups(policy, proxyTags)

$content = ProxyUtils.yaml.safeDump(renderConfig(template, policy, proxies, groups), {
  lineWidth: -1,
})

function getProxyName(proxy) {
  const definition = Object.values(proxy)[0]
  if (!definition?.name) throw new Error(`Egern 节点缺少名称: ${JSON.stringify(proxy)}`)
  return definition.name
}

function buildGroups(candidate, nodes) {
  const groups = candidate.groups.map(group => ({
    ...group,
    members: unique([
      ...(group.members || []),
      ...matchNodes(candidate.patterns[group.match], nodes),
    ]),
  }))
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
    select: {
      name: group.tag,
      policies: group.members.map(member => mapPolicy(member, candidate)),
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
