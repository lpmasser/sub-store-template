// Shared SubStore renderer for sing-box and Shadowrocket.

const template = JSON.parse($files[0])
const target = template._target || 'sing-box'
delete template._target

const policy = JSON.parse(await produceArtifact({
  name: 'routing-policy',
  type: 'file',
}))
const proxies = await loadProxies(target, policy.collection)
const proxyTags = proxies.map(proxy => target === 'sing-box' ? proxy.tag : proxy.name)
const groups = buildGroups(policy, proxyTags)

if (target === 'sing-box') {
  $content = JSON.stringify(renderSingBox(template, policy, proxies, groups), null, 2)
} else if (target === 'shadowrocket') {
  $content = ProxyUtils.yaml.safeDump(renderShadowrocket(template, policy, proxies, groups), {
    lineWidth: -1,
  })
} else {
  throw new Error(`不支持的客户端目标: ${target}`)
}

async function loadProxies(clientTarget, collection) {
  if (clientTarget === 'sing-box') {
    return produceArtifact({
      name: collection,
      type: 'collection',
      platform: 'sing-box',
      produceType: 'internal',
    })
  }

  const output = await produceArtifact({
    name: collection,
    type: 'collection',
    platform: 'Shadowrocket',
    produceOpts: { prettyYaml: true },
  })
  return ProxyUtils.yaml.safeLoad(output).proxies || []
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

function mapPolicy(tag, clientTarget, candidate) {
  if (tag !== candidate.directPolicy) return tag
  return clientTarget === 'sing-box' ? candidate.singBoxDirectTag : 'DIRECT'
}

function renderSingBox(config, candidate, nodes, groups) {
  const selectors = groups.map(group => ({
    tag: group.tag,
    type: 'selector',
    outbounds: group.members.map(member => mapPolicy(member, 'sing-box', candidate)),
    ...(group.default ? { default: mapPolicy(group.default, 'sing-box', candidate) } : {}),
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
  config.route.rules = [...(config.route.rules || []), ...renderSingBoxRules(candidate)]
  config.route.rule_set = candidate.routing.ruleSets.map(ruleSet => ({
    tag: ruleSet.tag,
    type: 'remote',
    format: 'binary',
    url: ruleSet.singBoxUrl,
    download_detour: candidate.routing.downloadDetour,
  }))
  config.route.final = mapPolicy(candidate.routing.final, 'sing-box', candidate)
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

function renderSingBoxRules(candidate) {
  const rules = candidate.routing.inline.map(rule => ({
    [rule.type]: rule.values,
    outbound: mapPolicy(rule.policy, 'sing-box', candidate),
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
      outbound: mapPolicy(ruleSet.policy, 'sing-box', candidate),
    })
  }
  return rules
}

function renderShadowrocket(config, candidate, nodes, groups) {
  config.proxies = nodes
  config['proxy-groups'] = groups.map(group => {
    const members = group.members.map(member => mapPolicy(member, 'shadowrocket', candidate))
    const selected = group.default
      ? mapPolicy(group.default, 'shadowrocket', candidate)
      : undefined
    return {
      name: group.tag,
      type: 'select',
      proxies: selected ? [selected, ...members.filter(member => member !== selected)] : members,
      ...(selected ? { 'policy-select-name': selected } : {}),
    }
  })

  config['rule-providers'] = Object.fromEntries(
    candidate.routing.ruleSets.map(ruleSet => [
      ruleSet.tag,
      {
        type: 'http',
        behavior: 'classical',
        format: 'text',
        url: `${candidate.routing.shadowrocketRuleBaseUrl}/${ruleSet.shadowrocketFile}`,
        path: `./rule-providers/${ruleSet.shadowrocketFile}`,
        interval: 86400,
      },
    ]),
  )

  const rules = [
    'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
    'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
    'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
    'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
    'IP-CIDR,169.254.0.0/16,DIRECT,no-resolve',
    'IP-CIDR6,::1/128,DIRECT,no-resolve',
    'IP-CIDR6,fc00::/7,DIRECT,no-resolve',
    'IP-CIDR6,fe80::/10,DIRECT,no-resolve',
  ]

  for (const rule of candidate.routing.inline) {
    const type = {
      domain: 'DOMAIN',
      domain_suffix: 'DOMAIN-SUFFIX',
      ip_cidr: 'IP-CIDR',
    }[rule.type]
    const destination = mapPolicy(rule.policy, 'shadowrocket', candidate)
    for (const value of rule.values) {
      rules.push(`${type},${value},${destination}${rule.type === 'ip_cidr' ? ',no-resolve' : ''}`)
    }
  }

  for (const ruleSet of candidate.routing.ruleSets) {
    const destination = ruleSet.shadowrocketPolicy || (
      ruleSet.policy ? mapPolicy(ruleSet.policy, 'shadowrocket', candidate) : undefined
    )
    if (destination) rules.push(`RULE-SET,${ruleSet.tag},${destination}`)
  }

  rules.push(`MATCH,${mapPolicy(candidate.routing.final, 'shadowrocket', candidate)}`)
  config.rules = rules
  return config
}
