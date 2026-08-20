// SubStore renderer for sing-box.

const template = JSON.parse($files[0])
const policy = JSON.parse(await produceArtifact({
  name: 'routing-policy',
  type: 'file',
}))
const proxies = await produceArtifact({
  name: policy.collection,
  type: 'collection',
  platform: 'sing-box',
  produceType: 'internal',
})
const proxyTags = proxies.map(proxy => proxy.tag)
const groups = buildGroups(policy, proxyTags)

$content = JSON.stringify(renderConfig(template, policy, proxies, groups), null, 2)

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
  return tag === candidate.directPolicy ? candidate.singBoxDirectTag : tag
}

function renderConfig(config, candidate, nodes, groups) {
  const selectors = groups.map(group => ({
    tag: group.tag,
    type: 'selector',
    outbounds: group.members.map(member => mapPolicy(member, candidate)),
    ...(group.default ? { default: mapPolicy(group.default, candidate) } : {}),
  }))
  config.outbounds = [...selectors, ...(config.outbounds || []), ...nodes]

  const dnsBlockRules = candidate.routing.ruleSets
    .filter(ruleSet => ruleSet.singBoxDns === 'nxdomain')
    .map(ruleSet => ({
      rule_set: ruleSet.tag,
      action: 'predefined',
      rcode: 'NXDOMAIN',
    }))
  const dnsRules = config.dns.rules || []
  const localDnsScope = buildLocalDnsScope(candidate)
  const foreignRuleIndex = dnsRules.findIndex(rule => rule.server === 'foreign')
  dnsRules.splice(
    foreignRuleIndex + 1,
    0,
    {
      type: 'logical',
      mode: 'and',
      rules: [
        { query_type: 'HTTPS' },
        ...localDnsScope.map(rule => ({ ...rule, invert: true })),
      ],
      action: 'predefined',
      rcode: 'NOERROR',
    },
    {
      type: 'logical',
      mode: 'and',
      rules: [
        { query_type: ['AAAA', 'HTTPS'] },
        { default_interface_address: '2000::/3', invert: true },
        { type: 'logical', mode: 'or', rules: localDnsScope },
      ],
      action: 'predefined',
      rcode: 'NOERROR',
    },
    { type: 'logical', mode: 'or', rules: localDnsScope, server: 'local' },
  )
  config.dns.rules = [...dnsBlockRules, ...dnsRules]
  config.route.rules = [...(config.route.rules || []), ...renderRules(candidate)]
  config.route.rule_set = candidate.routing.ruleSets.map(ruleSet => ({
    tag: ruleSet.tag,
    type: 'remote',
    format: 'binary',
    url: ruleSet.singBoxUrl,
    download_detour: candidate.routing.downloadDetour,
  }))
  config.route.final = mapPolicy(candidate.routing.final, candidate)
  return config
}

function buildLocalDnsScope(candidate) {
  const rules = [{ rule_set: candidate.dns.localRuleSets }]
  for (const type of ['domain', 'domain_suffix', 'domain_keyword', 'domain_regex']) {
    const values = candidate.routing.inline
      .filter(rule => rule.policy === candidate.directPolicy && rule.type === type)
      .flatMap(rule => rule.values)
    if (values.length > 0) rules.push({ [type]: unique(values) })
  }
  return rules
}

function renderRules(candidate) {
  const rules = candidate.routing.inline.map(rule => ({
    [rule.type]: rule.values,
    outbound: mapPolicy(rule.policy, candidate),
  }))
  let resolved = false

  for (const ruleSet of candidate.routing.ruleSets) {
    if (!ruleSet.policy) continue
    if (ruleSet.phase === 'ip' && !resolved) {
      rules.push({ action: 'resolve' })
      resolved = true
    }
    rules.push({
      rule_set: ruleSet.tag,
      outbound: mapPolicy(ruleSet.policy, candidate),
    })
  }
  return rules
}
