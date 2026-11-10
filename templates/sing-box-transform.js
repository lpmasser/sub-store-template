// SubStore renderer for sing-box.

const template = JSON.parse($files[0])
const policy = JSON.parse(await produceArtifact({
  name: 'routing-policy',
  type: 'file',
}))
const profile = $arguments.profile || 'default'
const workAccess = $arguments.workAccessFile
  ? JSON.parse(await produceArtifact({ name: $arguments.workAccessFile, type: 'file' }))
  : null
const intranet = $arguments.intranet === 'on'

if (intranet && !workAccess) throw new Error('intranet=on 需要 workAccessFile')

if (profile === 'no-adblock') {
  policy.routing.ruleSets = policy.routing.ruleSets.filter(
    ruleSet => ruleSet.tag !== 'geosite-adblock',
  )
} else if (profile !== 'default') {
  throw new Error(`不支持的 sing-box profile: ${profile}`)
}

const proxies = await produceArtifact({
  name: policy.collection,
  type: 'collection',
  platform: 'sing-box',
  produceType: 'internal',
})
// SubStore currently emits both port forms; sing-box uses the hopping range.
for (const proxy of proxies) {
  if (proxy.type === 'hysteria2' && proxy.server_ports?.length) delete proxy.server_port
}
const proxyTags = proxies.map(proxy => proxy.tag)
const groups = buildGroups(policy, proxyTags)

$content = JSON.stringify(renderConfig(template, policy, proxies, groups, workAccess, intranet), null, 2)

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

function renderConfig(config, candidate, nodes, groups, workAccess, intranet) {
  const work = workAccess ? buildWorkAccess(candidate, workAccess, intranet) : null
  const selectors = groups.map(group => ({
    tag: group.tag,
    type: group.type === 'auto' ? 'urltest' : 'selector',
    outbounds: group.members.map(member => mapPolicy(member, candidate)),
    ...(group.type === 'auto' ? {
      url: candidate.healthCheck.url,
      interval: `${candidate.healthCheck.intervalSeconds}s`,
      tolerance: candidate.healthCheck.toleranceMs,
    } : group.default ? { default: mapPolicy(group.default, candidate) } : {}),
  }))
  config.outbounds = [...selectors, ...(config.outbounds || []), ...nodes]
  if (intranet) {
    config.endpoints = [work.endpoint]
    config.outbounds.push(...work.outbounds, work.remoteSelector)
  }

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
  if (work) {
    config.dns.servers.push(...work.dnsServers)
    config.dns.rules = [...work.dnsRules, ...config.dns.rules]
  }
  config.http_clients = [{ tag: 'rule-set', detour: candidate.routing.downloadDetour }]
  config.route.default_http_client = 'rule-set'
  config.route.rules = [...(config.route.rules || []), ...renderRules(candidate)]
  if (intranet) {
    const privateIndex = config.route.rules.findIndex(rule => rule.ip_is_private === true)
    config.route.rules.splice(privateIndex, 0, ...work.routeRules)
    const tun = config.inbounds.find(inbound => inbound.type === 'tun')
    tun.route_exclude_address = subtractIpv4Cidrs(tun.route_exclude_address, work.reservedIpv4)
  }
  config.route.rule_set = candidate.routing.ruleSets.map(ruleSet => ({
    tag: ruleSet.tag,
    type: 'remote',
    format: 'binary',
    url: ruleSet.singBoxUrl,
  }))
  config.route.final = mapPolicy(candidate.routing.final, candidate)
  return config
}

function buildWorkAccess(candidate, access, intranet) {
  const office = {
    type: 'logical',
    mode: 'or',
    rules: [
      { network_interface_address: { wifi: access.office_networks } },
      { network_interface_address: { ethernet: access.office_networks } },
    ],
  }
  const companyDomainMatches = []
  if (access.company.domain.length) companyDomainMatches.push({ domain: access.company.domain })
  if (access.company.domain_suffix.length) {
    companyDomainMatches.push({ domain_suffix: access.company.domain_suffix })
  }
  const companyNetworkMatches = [
    ...(access.company.ip_cidr.length ? [{ ip_cidr: access.company.ip_cidr }] : []),
    ...companyDomainMatches,
  ]
  const dnsServers = [{
    tag: 'work-company-local',
    type: 'udp',
    server: access.company.dns,
    detour: candidate.singBoxDirectTag,
  }]

  if (!intranet) {
    const dnsRules = []
    if (access.company.domain_suffix.length) {
      dnsRules.push(
        {
          type: 'logical',
          mode: 'and',
          rules: [office, { domain_suffix: access.company.domain_suffix }],
          server: 'work-company-local',
        },
        { domain_suffix: access.company.domain_suffix, action: 'reject' },
      )
    }
    return { dnsServers, dnsRules }
  }

  dnsServers.push({
    tag: 'work-company-remote',
    type: 'udp',
    server: access.company.dns,
    detour: '公司远程出口',
  })
  const dnsRules = []
  const routeRules = []
  access.projects.forEach((project, index) => {
    const tag = `work-project-${index}`
    dnsServers.push({ tag, type: 'udp', server: project.dns, detour: access.mac.tag })
    if (project.ip_cidr.length) {
      routeRules.push({ ip_cidr: project.ip_cidr, outbound: access.mac.tag })
    }
    for (const type of ['domain', 'domain_suffix']) {
      if (!project[type].length) continue
      dnsRules.push({ [type]: project[type], server: tag })
      routeRules.push({ [type]: project[type], outbound: access.mac.tag })
    }
  })
  if (companyDomainMatches.length) {
    dnsRules.push(
      {
        type: 'logical',
        mode: 'and',
        rules: [office, { type: 'logical', mode: 'or', rules: companyDomainMatches }],
        server: 'work-company-local',
      },
      {
        type: 'logical',
        mode: 'or',
        rules: companyDomainMatches,
        server: 'work-company-remote',
      },
    )
  }
  if (companyNetworkMatches.length) {
    routeRules.push(
      {
        type: 'logical',
        mode: 'and',
        rules: [office, { type: 'logical', mode: 'or', rules: companyNetworkMatches }],
        outbound: candidate.singBoxDirectTag,
      },
      ...companyNetworkMatches.map(match => ({ ...match, outbound: '公司远程出口' })),
    )
  }

  const reservedIpv4 = [
    ...access.company.ip_cidr,
    ...access.projects.flatMap(project => project.ip_cidr),
  ].filter(address => !address.includes(':'))
  return {
    dnsServers,
    dnsRules,
    routeRules,
    endpoint: { ...access.tailscale },
    outbounds: [
      { ...access.mac, detour: access.tailscale.tag },
      { ...access.backup, detour: access.tailscale.tag },
    ],
    remoteSelector: {
      tag: '公司远程出口',
      type: 'selector',
      outbounds: [access.mac.tag, access.backup.tag],
      default: access.mac.tag,
      interrupt_exist_connections: true,
    },
    reservedIpv4,
  }
}

function subtractIpv4Cidrs(exclude, subtract) {
  const removals = subtract.map(ipv4CidrRange)
  const result = []
  for (const value of exclude) {
    if (value.includes(':')) {
      result.push(value)
      continue
    }
    for (const range of subtractIpv4Ranges(ipv4CidrRange(value), removals)) {
      result.push(...rangeToIpv4Cidrs(range))
    }
  }
  return result
}

function ipv4CidrRange(value) {
  const [address, prefixText] = value.split('/')
  const size = 1n << BigInt(32 - Number(prefixText))
  const start = ipv4Integer(address)
  const alignedStart = start - (start % size)
  return { start: alignedStart, end: alignedStart + size - 1n }
}

function ipv4Integer(address) {
  return address.split('.').reduce((result, part) => (result << 8n) + BigInt(part), 0n)
}

function subtractIpv4Ranges(base, removals) {
  let ranges = [base]
  for (const removal of removals) {
    const remaining = []
    for (const range of ranges) {
      if (removal.end < range.start || removal.start > range.end) {
        remaining.push(range)
        continue
      }
      if (removal.start > range.start) {
        remaining.push({ start: range.start, end: removal.start - 1n })
      }
      if (removal.end < range.end) {
        remaining.push({ start: removal.end + 1n, end: range.end })
      }
    }
    ranges = remaining
  }
  return ranges
}

function rangeToIpv4Cidrs(range) {
  const result = []
  let start = range.start
  while (start <= range.end) {
    const remainingBits = (range.end - start + 1n).toString(2).length - 1
    const sizeBits = Math.min(ipv4Alignment(start), remainingBits, 32)
    result.push(`${ipv4Address(start)}/${32 - sizeBits}`)
    start += 1n << BigInt(sizeBits)
  }
  return result
}

function ipv4Alignment(value) {
  let bits = 0
  while (bits < 32 && value % (1n << BigInt(bits + 1)) === 0n) bits += 1
  return bits
}

function ipv4Address(value) {
  return [24n, 16n, 8n, 0n]
    .map(shift => String((value >> shift) & 255n))
    .join('.')
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
