// Shared SubStore renderer for sing-box and Shadowrocket.
// Routing groups, matching rules, and rule order live only in routing-policy.json.

const template = JSON.parse($files[0])
const target = template._target || 'sing-box'
delete template._target

if (!['sing-box', 'shadowrocket'].includes(target)) {
  throw new Error(`不支持的客户端目标: ${target}`)
}

const policy = JSON.parse(await produceArtifact({
  name: 'routing-policy',
  type: 'file',
}))

validatePolicy(policy)

const proxies = await loadProxies(target, policy.collection)
if (target === 'sing-box') {
  proxies.push(...await loadSingBoxPrivateRelays(policy, proxies))
}
const proxyTags = proxies.map(proxy => target === 'sing-box' ? proxy.tag : proxy.name)

if (proxyTags.length === 0) {
  throw new Error(`${policy.collection} 没有可用节点，拒绝生成无法连接的配置`)
}
assertUnique(proxyTags, '节点名称')

const groups = buildGroups(policy, proxyTags)
validateRoutingPolicies(policy, groups)

if (target === 'sing-box') {
  $content = JSON.stringify(renderSingBox(template, policy, proxies, groups), null, 2)
} else {
  $content = ProxyUtils.yaml.safeDump(renderShadowrocket(template, policy, proxies, groups), {
    lineWidth: -1,
  })
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
  const parsed = ProxyUtils.yaml.safeLoad(output)
  return Array.isArray(parsed?.proxies) ? parsed.proxies : []
}

async function loadSingBoxPrivateRelays(candidate, baseProxies) {
  const relaySpecs = candidate.singBoxPrivateRelays || []
  const baseTags = new Set(baseProxies.map(proxy => proxy.tag))
  const relays = []

  for (const relay of relaySpecs) {
    if (!baseTags.has(relay.detour)) {
      console.log(`[transform] skipped private relay ${relay.tag}: detour ${relay.detour} is unavailable`)
      continue
    }

    const raw = await produceArtifact({
      name: relay.file,
      type: 'file',
    })
    const privateOutbound = JSON.parse(raw)
    if (!privateOutbound || Array.isArray(privateOutbound) || typeof privateOutbound !== 'object') {
      throw new Error(`私密中转文件 ${relay.file} 必须包含一个 sing-box outbound 对象`)
    }
    if (privateOutbound.type !== relay.protocol) {
      throw new Error(`私密中转文件 ${relay.file} 的协议必须为 ${relay.protocol}`)
    }

    relays.push({
      ...privateOutbound,
      tag: relay.tag,
      detour: relay.detour,
    })
  }

  return relays
}

function validatePolicy(candidate) {
  if (candidate?.schema !== 1) throw new Error('routing-policy schema 必须为 1')
  if (!candidate.collection) throw new Error('routing-policy 缺少 collection')
  if (!candidate.directPolicy || !candidate.singBoxDirectTag) {
    throw new Error('routing-policy 缺少直连策略映射')
  }
  if (!Array.isArray(candidate.groups) || candidate.groups.length === 0) {
    throw new Error('routing-policy 缺少策略组')
  }
  if (!Array.isArray(candidate.routing?.ruleSets)) {
    throw new Error('routing-policy 缺少规则集')
  }
  if (!Array.isArray(candidate.routing.inline)) {
    throw new Error('routing-policy 缺少内联规则')
  }
  if (!candidate.routing.final) throw new Error('routing-policy 缺少兜底策略')
  if (!/^https:\/\//.test(candidate.routing.shadowrocketRuleBaseUrl || '')) {
    throw new Error('routing-policy 缺少 Shadowrocket 规则 URL')
  }
  const hasUrlTest = candidate.groups.some(group => group.type === 'urltest')
  if (hasUrlTest && (
    !candidate.urlTest ||
    !/^https:\/\//.test(candidate.urlTest.url || '') ||
    !Number.isInteger(candidate.urlTest.intervalSeconds) || candidate.urlTest.intervalSeconds <= 0 ||
    !Number.isInteger(candidate.urlTest.timeoutSeconds) || candidate.urlTest.timeoutSeconds <= 0 ||
    !Number.isFinite(candidate.urlTest.tolerance) || candidate.urlTest.tolerance < 0
  )) {
    throw new Error('routing-policy 的 urlTest 配置无效')
  }

  assertUnique(candidate.groups.map(group => group.tag), '策略组 tag')
  if (!Array.isArray(candidate.singBoxPrivateRelays)) {
    throw new Error('routing-policy 的 singBoxPrivateRelays 必须为数组')
  }
  assertUnique(candidate.singBoxPrivateRelays.map(relay => relay.tag), '私密中转 tag')
  assertUnique(candidate.routing.ruleSets.map(ruleSet => ruleSet.tag), '规则集 tag')
  assertUnique(candidate.routing.ruleSets.map(ruleSet => ruleSet.shadowrocketFile), 'Shadowrocket 规则文件')

  for (const group of candidate.groups) {
    if (!['selector', 'urltest'].includes(group.type)) {
      throw new Error(`策略组 ${group.tag} 的类型无效: ${group.type}`)
    }
  }

  for (const relay of candidate.singBoxPrivateRelays) {
    if (!relay.file || !relay.protocol || !relay.detour) {
      throw new Error(`私密中转 ${relay.tag} 缺少 file、protocol 或 detour`)
    }
    if (relay.protocol !== 'shadowsocks') {
      throw new Error(`私密中转 ${relay.tag} 的协议必须为 shadowsocks`)
    }
  }

  for (const ruleSet of candidate.routing.ruleSets) {
    if (!/^https:\/\//.test(ruleSet.singBoxUrl || '')) {
      throw new Error(`规则集 ${ruleSet.tag} 缺少 sing-box URL`)
    }
    if (!/^[a-z0-9-]+\.list$/.test(ruleSet.shadowrocketFile || '')) {
      throw new Error(`规则集 ${ruleSet.tag} 的 Shadowrocket 文件名无效`)
    }
    if (ruleSet.policy && !['domain', 'ip'].includes(ruleSet.phase)) {
      throw new Error(`规则集 ${ruleSet.tag} 缺少有效 phase`)
    }
  }

  const phases = candidate.routing.ruleSets
    .filter(ruleSet => ruleSet.policy)
    .map(ruleSet => ruleSet.phase)
  if (phases.indexOf('ip') !== -1 && phases.slice(phases.indexOf('ip')).includes('domain')) {
    throw new Error('routing-policy 的域名规则必须排在 IP 规则之前')
  }
}

function assertUnique(values, label) {
  const seen = new Set()
  for (const value of values) {
    if (!value) throw new Error(`${label} 不能为空`)
    if (seen.has(value)) throw new Error(`${label} 重复: ${value}`)
    seen.add(value)
  }
}

function uniq(values) {
  return Array.from(new Set(values))
}

function buildGroups(candidate, nodes) {
  const nodeTags = new Set(nodes)
  const groupTags = new Set(candidate.groups.map(group => group.tag))

  for (const group of candidate.groups) {
    for (const member of group.members || []) {
      if (member !== candidate.directPolicy && !groupTags.has(member)) {
        throw new Error(`策略组 ${group.tag} 引用了不存在的静态成员: ${member}`)
      }
    }
  }

  for (const node of nodeTags) {
    if (
      groupTags.has(node) ||
      node === candidate.directPolicy ||
      node === candidate.singBoxDirectTag
    ) {
      throw new Error(`节点名称与策略 tag 冲突: ${node}`)
    }
  }

  const workingGroups = candidate.groups.map(group => ({
    ...group,
    members: uniq([
      ...(Array.isArray(group.members) ? group.members : []),
      ...resolveMatch(group.match, candidate.patterns, nodes),
    ]),
  }))

  const viableTags = new Set([...nodes, candidate.directPolicy])
  let changed = true
  while (changed) {
    changed = false
    for (const group of workingGroups) {
      if (viableTags.has(group.tag)) continue
      if (group.members.some(member => member !== group.tag && viableTags.has(member))) {
        viableTags.add(group.tag)
        changed = true
      }
    }
  }

  const removedTags = new Set(
    workingGroups
      .filter(group => !viableTags.has(group.tag))
      .map(group => group.tag),
  )
  const remainingGroups = workingGroups
    .filter(group => !removedTags.has(group.tag))
    .map(group => {
      const members = uniq(
        group.members.filter(member => member !== group.tag && viableTags.has(member)),
      )
      const defaultPolicy = group.default && members.includes(group.default)
        ? group.default
        : members[0]
      return {
        ...group,
        members,
        ...(group.default ? { default: defaultPolicy } : {}),
      }
    })

  if (removedTags.size > 0) {
    console.log(`[transform] removed empty groups: ${Array.from(removedTags).join(', ')}`)
  }

  return remainingGroups
}

function validateRoutingPolicies(candidate, groupModels) {
  const available = new Set([
    candidate.directPolicy,
    ...groupModels.map(group => group.tag),
  ])
  const references = [
    ...candidate.routing.inline.map(rule => rule.policy),
    ...candidate.routing.ruleSets.map(ruleSet => ruleSet.policy).filter(Boolean),
    candidate.routing.final,
  ]
  for (const reference of references) {
    if (!available.has(reference)) throw new Error(`分流规则引用了不存在的策略: ${reference}`)
  }
}

function resolveMatch(match, patterns, nodes) {
  if (!match) return []
  if (match === ':all') return nodes
  const pattern = patterns?.[match]
  if (!pattern) throw new Error(`策略组引用了不存在的匹配条件: ${match}`)
  const expression = toJSRegex(pattern)
  return nodes.filter(node => expression.test(node))
}

function toJSRegex(spec) {
  if (spec && typeof spec === 'object') {
    if (typeof spec.src === 'string') return new RegExp(spec.src, spec.flags || 'u')
    if (isLogicSpec(spec)) {
      const built = buildPattern(spec)
      return new RegExp(built.src, built.flags)
    }
  }
  return new RegExp(String(spec), 'u')
}

function escapeRegex(value) {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
}

function isAsciiWord(value) {
  return /^[A-Za-z0-9_]+$/.test(value)
}

function toTokenPattern(token) {
  if (typeof token === 'string') {
    const escaped = escapeRegex(token)
    return isAsciiWord(token) ? `\\b${escaped}\\b` : escaped
  }
  if (token && typeof token === 'object' && typeof token.raw === 'string') {
    return token.boundary ? `\\b(?:${token.raw})\\b` : token.raw
  }
  return ''
}

function anyOf(values) {
  return `(?:${values.map(toTokenPattern).join('|')})`
}

function isLogicSpec(value) {
  if (!value || typeof value !== 'object' || typeof value.src === 'string') return false
  return (
    Array.isArray(value.all) ||
    Array.isArray(value.any) ||
    Array.isArray(value.not) ||
    Array.isArray(value.branches) ||
    typeof value.ci === 'boolean'
  )
}

function buildPattern(spec) {
  const flags = spec.ci ? 'iu' : 'u'
  if (Array.isArray(spec.branches) && spec.branches.length > 0) {
    const branches = spec.branches.map(branch => buildPattern(branch).src)
    return { src: `^(?:${branches.join('|')})$`, flags }
  }

  const parts = []
  if (Array.isArray(spec.all)) {
    for (const item of spec.all) {
      if (item && typeof item === 'object' && Array.isArray(item.any)) {
        parts.push(`(?=.*${anyOf(item.any)})`)
      } else {
        parts.push(`(?=.*${toTokenPattern(item)})`)
      }
    }
  }
  if (Array.isArray(spec.any) && spec.any.length > 0) {
    parts.push(`(?=.*${anyOf(spec.any)})`)
  }
  if (Array.isArray(spec.not) && spec.not.length > 0) {
    parts.push(`(?!.*${anyOf(spec.not)})`)
  }
  return { src: `^${parts.join('')}.*$`, flags }
}

function mapPolicy(tag, clientTarget, candidate) {
  if (tag !== candidate.directPolicy) return tag
  return clientTarget === 'sing-box' ? candidate.singBoxDirectTag : 'DIRECT'
}

function renderSingBox(config, candidate, nodes, groupModels) {
  const staticOutbounds = Array.isArray(config.outbounds) ? config.outbounds : []
  const renderedGroups = groupModels.map(group => {
    const outbound = {
      tag: group.tag,
      type: group.type,
      outbounds: group.members.map(member => mapPolicy(member, 'sing-box', candidate)),
    }
    if (group.type === 'urltest') {
      outbound.url = candidate.urlTest.url
      outbound.interval = formatDuration(candidate.urlTest.intervalSeconds)
      outbound.tolerance = candidate.urlTest.tolerance
    }
    if (group.default) {
      outbound.default = mapPolicy(group.default, 'sing-box', candidate)
    }
    return outbound
  })
  config.outbounds = [...renderedGroups, ...staticOutbounds, ...nodes]
  assertUnique(config.outbounds.map(outbound => outbound.tag), 'sing-box outbound tag')

  const dnsBlockRules = candidate.routing.ruleSets
    .filter(ruleSet => ruleSet.singBoxDns === 'nxdomain')
    .map(ruleSet => ({
      rule_set: ruleSet.tag,
      action: 'predefined',
      rcode: 'NXDOMAIN',
    }))
  config.dns.rules = [...dnsBlockRules, ...(config.dns.rules || [])]

  const sharedRules = renderSingBoxRules(candidate)
  config.route.rules = [...(config.route.rules || []), ...sharedRules]
  config.route.rule_set = candidate.routing.ruleSets.map(ruleSet => ({
    tag: ruleSet.tag,
    type: 'remote',
    format: 'binary',
    url: ruleSet.singBoxUrl,
    download_detour: candidate.singBoxDirectTag,
  }))
  config.route.final = mapPolicy(candidate.routing.final, 'sing-box', candidate)

  return config
}

function renderSingBoxRules(candidate) {
  const rules = candidate.routing.inline.map(rule => ({
    [rule.type]: rule.values,
    outbound: mapPolicy(rule.policy, 'sing-box', candidate),
  }))

  let resolveAdded = false
  for (const ruleSet of candidate.routing.ruleSets) {
    if (!ruleSet.policy) continue
    if (ruleSet.phase === 'ip' && !resolveAdded) {
      rules.push({ action: 'resolve' })
      resolveAdded = true
    }
    rules.push({
      rule_set: ruleSet.tag,
      outbound: mapPolicy(ruleSet.policy, 'sing-box', candidate),
    })
  }
  return rules
}

function renderShadowrocket(config, candidate, nodes, groupModels) {
  config.proxies = nodes
  config['proxy-groups'] = groupModels.map(group => {
    const mappedMembers = group.members.map(member => mapPolicy(member, 'shadowrocket', candidate))
    const mappedDefault = group.default
      ? mapPolicy(group.default, 'shadowrocket', candidate)
      : undefined
    const orderedMembers = mappedDefault
      ? [mappedDefault, ...mappedMembers.filter(member => member !== mappedDefault)]
      : mappedMembers
    const rendered = {
      name: group.tag,
      type: group.type === 'urltest' ? 'url-test' : 'select',
      proxies: orderedMembers,
    }
    if (group.type === 'urltest') {
      rendered.url = candidate.urlTest.url
      rendered.interval = candidate.urlTest.intervalSeconds
      rendered.tolerance = candidate.urlTest.tolerance
      rendered.timeout = candidate.urlTest.timeoutSeconds
    }
    if (mappedDefault) rendered['policy-select-name'] = mappedDefault
    return rendered
  })

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
    const type = shadowrocketRuleType(rule.type)
    const destination = mapPolicy(rule.policy, 'shadowrocket', candidate)
    for (const value of rule.values) {
      const option = rule.type === 'ip_cidr' ? ',no-resolve' : ''
      rules.push(`${type},${value},${destination}${option}`)
    }
  }

  for (const ruleSet of candidate.routing.ruleSets) {
    const destination = ruleSet.shadowrocketPolicy || (
      ruleSet.policy ? mapPolicy(ruleSet.policy, 'shadowrocket', candidate) : undefined
    )
    if (!destination) continue
    const url = `${candidate.routing.shadowrocketRuleBaseUrl}/${ruleSet.shadowrocketFile}`
    rules.push(`RULE-SET,${url},${destination}`)
  }

  rules.push(`MATCH,${mapPolicy(candidate.routing.final, 'shadowrocket', candidate)}`)
  config.rules = rules
  return config
}

function shadowrocketRuleType(type) {
  const mapping = {
    domain: 'DOMAIN',
    domain_suffix: 'DOMAIN-SUFFIX',
    ip_cidr: 'IP-CIDR',
  }
  if (!mapping[type]) throw new Error(`Shadowrocket 不支持共享内联规则类型: ${type}`)
  return mapping[type]
}

function formatDuration(seconds) {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}
