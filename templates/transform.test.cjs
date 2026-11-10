'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const directory = __dirname
const policy = JSON.parse(fs.readFileSync(path.join(directory, 'routing-policy.json'), 'utf8'))
const ruleSources = JSON.parse(fs.readFileSync(path.join(directory, '..', 'rules', 'sources.json'), 'utf8'))
const templates = {
  'sing-box': JSON.parse(fs.readFileSync(path.join(directory, 'sing-box.json'), 'utf8')),
  egern: JSON.parse(fs.readFileSync(path.join(directory, 'egern.json'), 'utf8')),
}
const transformSources = {
  'sing-box': fs.readFileSync(path.join(directory, 'sing-box-transform.js'), 'utf8'),
  egern: fs.readFileSync(path.join(directory, 'egern-transform.js'), 'utf8'),
}
const egernAutoUpdateUrl = 'https://example.invalid/share/file/egern-eloy?token=test-only'
const workAccessFixture = {
  office_networks: ['10.77.52.0/22'],
  company: {
    ip_cidr: ['10.77.0.0/16', '192.168.77.8/32'],
    domain: ['git.example.test'],
    domain_suffix: ['corp.local'],
    dns: '192.168.77.8',
  },
  projects: [
    {
      name: 'example',
      ip_cidr: ['10.88.1.2/32'],
      domain: ['project.example.test'],
      domain_suffix: [],
      dns: '192.168.88.9',
    },
  ],
  tailscale: {
    type: 'tailscale',
    tag: 'work-tailnet',
    hostname: 'work-client',
    state_directory: '/private/example/work-tailnet',
    system_interface: false,
  },
  mac: {
    type: 'shadowsocks',
    tag: '公司 Mac',
    server: '100.64.1.2',
    server_port: 8388,
    method: '2022-blake3-aes-128-gcm',
    password: 'fixture-only',
  },
  backup: {
    type: 'shadowsocks',
    tag: '公司备用 181',
    server: '100.64.1.3',
    server_port: 8388,
    method: '2022-blake3-aes-128-gcm',
    password: 'fixture-only',
  },
}
const workAccessArgs = { workAccessFile: 'work-access' }
const intranetArgs = { ...workAccessArgs, intranet: 'on' }
const officeRule = {
  type: 'logical',
  mode: 'or',
  rules: [
    { network_interface_address: { wifi: workAccessFixture.office_networks } },
    { network_interface_address: { ethernet: workAccessFixture.office_networks } },
  ],
}

const proxyTags = [
  '[自建]dmiteb-hy2',
  '[自建]dmiteb-vless',
  '[自建][家宽拼车]Vircs-SS[经DMIT EB]',
  '[自建][家宽拼车]Vircs-SS[经DMIT Pro]',
  '[自建][家宽拼车]Vircs-SS[经DMIT EB Hy2]',
  '[自建][家宽拼车]Vircs-SS[经DMIT Pro Hy2]',
  '[自建]dmitpro-hy2[美国.LAX]',
  '[自建]dmitpro-vless[美国.LAX]',
  '[自建]isifjp-hy2',
  '[自建]isifjp-vless',
  '[自建][家宽拼车]AaiTR-Verizon[经DMIT Pro Hy2]',
  '[自建][家宽拼车]AaiTR-Verizon[经DMIT EB Hy2]',
  '[自建][家宽拼车]AaiTR-Verizon[经DMIT Pro VLESS]',
  '[自建][家宽拼车]AaiTR-Verizon[经DMIT EB VLESS]',
]
const householdNodes = [
  '[自建][家宽拼车]Vircs-SS[经DMIT Pro Hy2]',
  '[自建][家宽拼车]Vircs-SS[经DMIT EB]',
  '[自建][家宽拼车]Vircs-SS[经DMIT Pro]',
  '[自建][家宽拼车]Vircs-SS[经DMIT EB Hy2]',
]
const aaitrNodes = proxyTags.filter(tag => tag.includes('AaiTR-Verizon'))
const fixturePin = 'a'.repeat(64)
const fixtureNodes = proxyTags.map((name, index) => ({
  name, type: name.includes('hy2') || name.includes('Hy2') ? 'hysteria2' : 'vless',
  server: `node-${index + 1}.example.com`, port: 443,
  ...(name.includes('Hy2') ? { 'tls-fingerprint': fixturePin, ports: '21000-21999' } : {}),
}))
const palantirDomains = [
  'palantir.com',
  'palantirfoundry.com',
  'palantirfoundry.co.uk',
  'palantircloud.com',
  'palantirapollo.com',
]
const legacyRouteExcludeAddress = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
]
const privateRouteExcludeAddress = [
  '10.0.0.0/8',
  '172.16.0.0/15',
  '172.18.0.0/16',
  '172.19.0.4/30',
  '172.19.0.8/29',
  '172.19.0.16/28',
  '172.19.0.32/27',
  '172.19.0.64/26',
  '172.19.0.128/25',
  '172.19.1.0/24',
  '172.19.2.0/23',
  '172.19.4.0/22',
  '172.19.8.0/21',
  '172.19.16.0/20',
  '172.19.32.0/19',
  '172.19.64.0/18',
  '172.19.128.0/17',
  '172.20.0.0/14',
  '172.24.0.0/13',
  '192.168.0.0/16',
]
const motionProGatewayAddress = '123.124.17.242/32'
const routeExcludeAddress = [...privateRouteExcludeAddress, motionProGatewayAddress]
const egernRuleFields = new Set([
  'domain_set',
  'domain_suffix_set',
  'domain_keyword_set',
  'domain_regex_set',
  'ip_cidr_set',
  'ip_cidr6_set',
])

async function render(target, scriptArguments = {}) {
  const execute = new AsyncFunction(
    '$files',
    'produceArtifact',
    'ProxyUtils',
    '$arguments',
    `${transformSources[target]}\nreturn $content`,
  )
  const content = await execute(
    [JSON.stringify(templates[target])],
    async request => {
      if (request.type === 'file' && request.name === 'routing-policy') {
        return JSON.stringify(policy)
      }
      if (request.type === 'file' && request.name === 'work-access') {
        return JSON.stringify(workAccessFixture)
      }
      if (request.type !== 'collection' || request.name !== policy.collection) {
        throw new Error(`unexpected artifact request: ${JSON.stringify(request)}`)
      }
      if (request.platform === 'sing-box') {
        return proxyTags.map(tag => ({ tag, type: 'vless' }))
      }
      if (request.platform === 'JSON') return structuredClone(fixtureNodes)
      throw new Error(`unexpected platform: ${request.platform}`)
    },
    {
      produce(nodes, target) {
        assert.equal(target, 'Egern')
        return JSON.stringify({ proxies: nodes.map(node => ({
          [node.type]: { name: node.name, server: node.server, port: node.port,
            ...(node.type === 'hysteria2' ? { auth: 'test-only', skip_tls_verify: true, port_hopping: node.ports } : { user_id: 'test-only' }),
          },
        })) })
      },
      yaml: {
        safeLoad: JSON.parse,
        safeDump: JSON.stringify,
      },
    },
    target === 'egern'
      ? { autoUpdateUrl: egernAutoUpdateUrl, ...scriptArguments }
      : scriptArguments,
  )
  return JSON.parse(content)
}

function assertDefaults(groups, tagKey, membersKey, defaultKey, directTag) {
  for (const group of groups) {
    if (group.type === 'urltest') {
      assert.ok(!group[membersKey].includes(directTag), `${group[tagKey]} must not contain direct`)
      continue
    }
    assert.ok(group[membersKey].includes(directTag), `${group[tagKey]} must contain direct`)
    assert.ok(group[defaultKey], `${group[tagKey]} must declare a default`)
    assert.ok(group[membersKey].includes(group[defaultKey]), `${group[tagKey]} default must exist`)
  }
  assert.equal(groups.find(group => group[tagKey] === '🚀 默认代理')[defaultKey], '🇺🇸 DMIT Pro')
  assert.equal(groups.find(group => group[tagKey] === '🧠 AI')[defaultKey], '🏠 AaiTR-Verizon家宽')
  assert.equal(groups.find(group => group[tagKey] === '🔮 Palantir')[defaultKey], '🏠 AaiTR-Verizon家宽')
  assert.equal(groups.find(group => group[tagKey] === 'VPS管理-美国')[defaultKey], '🇺🇸 DMIT Pro')
  assert.equal(groups.find(group => group[tagKey] === 'VPS管理-亚太')[defaultKey], '🇯🇵 ISIF JP')
  assert.deepEqual(groups.find(group => group[tagKey] === '🏠 VIRCS家宽')[membersKey], householdNodes)
  assert.deepEqual(groups.find(group => group[tagKey] === '🏠 AaiTR-Verizon家宽')[membersKey], aaitrNodes)
  assert.ok(!groups.some(group => group[tagKey] === '🏠 QQPW家宽'))
  const apple = groups.find(group => group[tagKey] === '🍏 Apple')
  assert.equal(apple[membersKey].length, 7)
  assert.equal(apple[defaultKey], directTag)
}

function assertManagementOrder(groups, tagKey) {
  const tags = groups.map(group => group[tagKey])
  const catchAllIndex = tags.indexOf('🐟 漏网之鱼')
  assert.deepEqual(
    tags.slice(catchAllIndex - 3, catchAllIndex + 1),
    ['VPS管理-美国', 'VPS管理-亚太', 'VPS管理-公司新加坡', '🐟 漏网之鱼'],
  )
}

function ipv4CidrRange(value) {
  const [address, rawPrefix] = value.split('/')
  const prefix = Number(rawPrefix)
  const integer = address
    .split('.')
    .reduce((result, part) => (result << 8n) + BigInt(part), 0n)
  const size = 1n << BigInt(32 - prefix)
  const start = integer - (integer % size)
  return { start, end: start + size - 1n }
}

function rangesOverlap(left, right) {
  return left.start <= right.end && right.start <= left.end
}

function normalizeIpv4Cidrs(values) {
  const ranges = values
    .map(ipv4CidrRange)
    .sort((left, right) => left.start < right.start ? -1 : 1)
  const normalized = []

  for (const range of ranges) {
    const previous = normalized.at(-1)
    if (!previous || range.start > previous.end + 1n) {
      normalized.push({ ...range })
    } else {
      previous.end = previous.end > range.end ? previous.end : range.end
    }
  }
  return normalized
}

function countIpv4Addresses(values) {
  return values
    .map(ipv4CidrRange)
    .reduce((total, range) => total + range.end - range.start + 1n, 0n)
}

function containsAddress(values, address) {
  const target = ipv4CidrRange(address.includes('/') ? address : `${address}/32`)
  return values.some(value => {
    const range = ipv4CidrRange(value)
    return range.start <= target.start && target.end <= range.end
  })
}

test('uses the same canonical upstream for both client rule formats', () => {
  const sources = new Map(ruleSources.ruleSets.map(ruleSet => [ruleSet.artifact, ruleSet.source]))
  for (const ruleSet of policy.routing.ruleSets) {
    assert.match(ruleSet.singBoxUrl, /^https:\/\/raw\.githubusercontent\.com\//)
    assert.ok(!ruleSet.singBoxUrl.includes('gh-proxy.com'))
    if (ruleSet.tag !== 'geosite-adblock') {
      assert.equal(ruleSet.singBoxUrl, sources.get(ruleSet.artifact))
    }
  }
  assert.match(policy.routing.ruleBaseUrl, /^https:\/\/raw\.githubusercontent\.com\//)
})

test('generated Egern rule sets use native fields and valid YAML scalars', () => {
  const expectedArtifacts = new Set(policy.routing.ruleSets.map(ruleSet => ruleSet.artifact))
  const egernDirectory = path.join(directory, '..', 'rules', 'egern')
  const actualArtifacts = new Set(
    fs.readdirSync(egernDirectory)
      .filter(file => file.endsWith('.yaml'))
      .map(file => file.replace(/\.yaml$/, '')),
  )
  assert.deepEqual(actualArtifacts, expectedArtifacts)

  for (const artifact of expectedArtifacts) {
    const lines = fs.readFileSync(path.join(egernDirectory, `${artifact}.yaml`), 'utf8')
      .split(/\r?\n/)
    let currentField
    let values = 0
    for (const line of lines) {
      if (line === '' || line.startsWith('#')) continue
      if (line === 'no_resolve: true') continue
      const field = /^([a-z0-9_]+):$/.exec(line)
      if (field) {
        assert.ok(egernRuleFields.has(field[1]), `${artifact} has unsupported field ${field[1]}`)
        currentField = field[1]
        continue
      }
      const item = /^  - (.+)$/.exec(line)
      assert.ok(item && currentField, `${artifact} has malformed YAML line: ${line}`)
      assert.equal(typeof JSON.parse(item[1]), 'string')
      values += 1
    }
    assert.ok(values > 0, `${artifact} must contain rules`)
  }
})

test('keeps private LAN exclusions except for the sing-box TUN IPv4 subnet', () => {
  const config = templates['sing-box']
  const tun = config.inbounds.find(inbound => inbound.type === 'tun')
  const fakeIpServer = config.dns.servers.find(server => server.type === 'fakeip')
  const removedTunSubnet = '172.19.0.0/30'
  const excludedRanges = tun.route_exclude_address.map(ipv4CidrRange)
  const privateExclusions = tun.route_exclude_address.filter(address => address !== motionProGatewayAddress)

  assert.deepEqual(tun.route_exclude_address, routeExcludeAddress)
  assert.deepEqual(
    normalizeIpv4Cidrs([...privateExclusions, removedTunSubnet]),
    normalizeIpv4Cidrs(legacyRouteExcludeAddress),
  )
  assert.equal(
    countIpv4Addresses(legacyRouteExcludeAddress) - countIpv4Addresses(privateExclusions),
    4n,
  )
  assert.ok(excludedRanges.every(range => !rangesOverlap(range, ipv4CidrRange(removedTunSubnet))))
  assert.ok(excludedRanges.every(range => !rangesOverlap(range, ipv4CidrRange(fakeIpServer.inet4_range))))
  assert.ok(tun.route_exclude_address.every(value => !value.includes(':')))
  assert.ok(tun.address.some(value => value === 'fdfe:dcba:9876::1/126'))
  assert.equal(fakeIpServer.inet6_range, '2001:2::/48')
  assert.ok(!Object.hasOwn(config.dns, 'independent_cache'))
  assert.ok(!Object.hasOwn(tun, 'dns_mode'))
  assert.ok(!Object.hasOwn(tun, 'dns_address'))
})

test('renders the sing-box profile from fourteen relay and ordinary nodes', async () => {
  const config = await render('sing-box')
  const nodes = config.outbounds.filter(outbound => proxyTags.includes(outbound.tag))
  const groups = config.outbounds.filter(outbound => ['selector', 'urltest'].includes(outbound.type))
  const tun = config.inbounds.find(inbound => inbound.type === 'tun')
  const mixed = config.inbounds.find(inbound => inbound.type === 'mixed')
  const fakeIpServer = config.dns.servers.find(server => server.type === 'fakeip')

  assert.equal(nodes.length, 14)
  assert.equal(groups.length, 25)
  assert.ok(nodes.every(node => !Object.hasOwn(node, 'detour')))
  assertDefaults(groups, 'tag', 'outbounds', 'default', '🎯 直连')
  assertManagementOrder(groups, 'tag')

  assert.deepEqual(tun.address, ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'])
  assert.deepEqual(tun.route_exclude_address, routeExcludeAddress)
  assert.equal(tun.auto_route, true)
  assert.equal(tun.strict_route, true)
  assert.equal(tun.address[1], 'fdfe:dcba:9876::1/126')
  assert.equal(mixed.listen, '0.0.0.0')
  assert.equal(mixed.listen_port, 7890)
  assert.equal(fakeIpServer.inet4_range, '198.18.0.0/15')
  assert.equal(fakeIpServer.inet6_range, '2001:2::/48')
  assert.notEqual(parseInt(fakeIpServer.inet6_range.split(':')[0], 16) & 0xfe00, 0xfc00)
  assert.equal(config.dns.strategy, 'prefer_ipv4')
  assert.equal(config.experimental.cache_file.store_fakeip, true)

  assert.equal(config.dns.rules[0].rule_set, 'geosite-adblock')
  assert.equal(config.dns.rules[0].rcode, 'NXDOMAIN')
  const foreignIndex = config.dns.rules.findIndex(rule => rule.server === 'foreign')
  const fakeIpHttpsNoDataIndex = config.dns.rules.findIndex(rule => (
    rule.action === 'predefined' &&
    rule.rcode === 'NOERROR' &&
    rule.type === 'logical' &&
    rule.rules?.[0]?.query_type === 'HTTPS'
  ))
  const directNoDataIndex = config.dns.rules.findIndex(rule => (
    rule.action === 'predefined' &&
    rule.rcode === 'NOERROR' &&
    rule.type === 'logical' &&
    Array.isArray(rule.rules?.[0]?.query_type)
  ))
  const localIndex = config.dns.rules.findIndex(rule => rule.type === 'logical' && rule.server === 'local')
  const fakeIpIndex = config.dns.rules.findIndex(rule => rule.server === 'fakeip' && rule.rewrite_ttl)
  assert.deepEqual(
    config.dns.rules.find(rule => rule.clash_mode === 'direct'),
    { clash_mode: 'direct', server: 'local' },
  )
  assert.deepEqual(
    config.dns.rules.find(rule => rule.clash_mode === 'global'),
    { clash_mode: 'global', server: 'fakeip' },
  )
  assert.equal(fakeIpHttpsNoDataIndex, foreignIndex + 1)
  assert.equal(directNoDataIndex, fakeIpHttpsNoDataIndex + 1)
  assert.equal(localIndex, directNoDataIndex + 1)
  assert.ok(fakeIpIndex > localIndex)
  assert.equal(config.dns.rules[fakeIpIndex].rewrite_ttl, 60)
  assert.deepEqual(config.dns.rules[fakeIpIndex].query_type, ['A', 'AAAA'])

  const localDnsScope = config.dns.rules[localIndex].rules
  const fakeIpHttpsNoData = config.dns.rules[fakeIpHttpsNoDataIndex]
  assert.deepEqual(fakeIpHttpsNoData.rules[0], { query_type: 'HTTPS' })
  assert.deepEqual(
    fakeIpHttpsNoData.rules.slice(1),
    localDnsScope.map(rule => ({ ...rule, invert: true })),
  )
  assert.ok(fakeIpHttpsNoData.rules.slice(1).every(rule => rule.invert === true))

  const directNoDataRule = config.dns.rules[directNoDataIndex]
  assert.deepEqual(directNoDataRule.rules[0], { query_type: ['AAAA', 'HTTPS'] })
  assert.deepEqual(directNoDataRule.rules[1], {
    default_interface_address: '2000::/3',
    invert: true,
  })
  assert.deepEqual(directNoDataRule.rules[2].rules, localDnsScope)
  assert.deepEqual(localDnsScope[0].rule_set, policy.dns.localRuleSets)
  assert.ok(!policy.dns.localRuleSets.includes('geosite-apple'))
  assert.ok(!policy.dns.localRuleSets.includes('geosite-ai'))
  assert.deepEqual(
    localDnsScope.find(rule => rule.domain).domain,
    policy.routing.inline.find(rule => rule.policy === 'DIRECT' && rule.type === 'domain').values,
  )
  assert.ok(!Object.hasOwn(policy.dns, 'appleRuleSet'))
  assert.ok(!config.dns.rules.some(rule => JSON.stringify(rule).includes('geosite-apple')))

  const anthropicDomain = 'api.anthropic.com'
  assert.ok(!localDnsScope.find(rule => rule.domain).domain.includes(anthropicDomain))
  assert.ok(!config.dns.rules[foreignIndex].domain_suffix.some(suffix => (
    anthropicDomain === suffix || anthropicDomain.endsWith(`.${suffix}`)
  )))

  const ipv6Reject = config.route.rules[0]
  const sniffIndex = config.route.rules.findIndex(rule => rule.action === 'sniff')
  assert.equal(ipv6Reject.action, 'reject')
  assert.equal(ipv6Reject.no_drop, true)
  assert.equal(ipv6Reject.mode, 'and')
  assert.deepEqual(ipv6Reject.rules[0], {
    inbound: 'tun-in',
    clash_mode: 'rule',
    ip_version: 6,
    rule_set: 'geoip-cn',
  })
  assert.deepEqual(ipv6Reject.rules[1], {
    default_interface_address: '2000::/3',
    invert: true,
  })
  assert.ok(sniffIndex > 0)
  assert.deepEqual(
    config.route.rules.find(rule => rule.clash_mode === 'global'),
    { clash_mode: 'global', outbound: '🚀 默认代理' },
  )
  assert.deepEqual(
    config.route.rules.find(rule => rule.clash_mode === 'direct'),
    { clash_mode: 'direct', outbound: '🎯 直连' },
  )
  assert.ok(!config.route.rules.some(rule => (
    rule.action === 'reject' && JSON.stringify(rule).includes('"clash_mode":"global"')
  )))

  assert.equal(config.route.rule_set.length, 22)
  assert.deepEqual(config.http_clients, [{ tag: 'rule-set', detour: '🚀 默认代理' }])
  assert.equal(config.route.default_http_client, 'rule-set')
  assert.ok(config.route.rule_set.every(ruleSet => (
    ruleSet.url.startsWith('https://raw.githubusercontent.com/') &&
    !ruleSet.url.includes('gh-proxy.com') &&
    !Object.hasOwn(ruleSet, 'download_detour') &&
    !Object.hasOwn(ruleSet, 'http_client')
  )))
  assert.equal(
    config.route.rules.find(rule => rule.rule_set === 'geosite-ai').outbound,
    '🧠 AI',
  )
  assert.deepEqual(
    config.route.rules.find(rule => rule.outbound === '🔮 Palantir'),
    { domain_suffix: palantirDomains, outbound: '🔮 Palantir' },
  )
  assert.equal(
    config.route.rules.find(rule => rule.rule_set === 'geosite-apple').outbound,
    '🍏 Apple',
  )
  assert.deepEqual(config.route.default_domain_resolver, { server: 'public' })
  assert.equal(config.route.final, '🐟 漏网之鱼')
})

test('renders a sing-box profile without ad blocking when requested', async () => {
  const defaultConfig = await render('sing-box')
  const noAdblockConfig = await render('sing-box', { profile: 'no-adblock' })
  const expected = structuredClone(defaultConfig)

  expected.dns.rules = expected.dns.rules.filter(rule => rule.rule_set !== 'geosite-adblock')
  expected.route.rule_set = expected.route.rule_set.filter(
    ruleSet => ruleSet.tag !== 'geosite-adblock',
  )

  assert.deepEqual(noAdblockConfig, expected)
  assert.deepEqual(
    noAdblockConfig.inbounds.find(inbound => inbound.type === 'tun').route_exclude_address,
    routeExcludeAddress,
  )
  assert.ok(!JSON.stringify(noAdblockConfig).includes('geosite-adblock'))
  await assert.rejects(
    () => render('sing-box', { profile: 'unknown' }),
    /不支持的 sing-box profile: unknown/,
  )
})

test('resolves .local names through the system DNS server first', async () => {
  const config = await render('sing-box')
  assert.deepEqual(
    config.dns.servers.find(server => server.tag === 'local'),
    { tag: 'local', type: 'local' },
  )
  const localSuffixIndex = config.dns.rules.findIndex(rule => rule.server === 'local' && rule.domain_suffix)
  assert.deepEqual(config.dns.rules[localSuffixIndex], { domain_suffix: ['local'], server: 'local' })
  const foreignIndex = config.dns.rules.findIndex(rule => rule.server === 'foreign')
  const fakeIpIndex = config.dns.rules.findIndex(rule => rule.server === 'fakeip' && rule.rewrite_ttl)
  assert.ok(localSuffixIndex < foreignIndex)
  assert.ok(localSuffixIndex < fakeIpIndex)
  assert.ok(!JSON.stringify(config).includes('split-dns'))
  const stale = await render('sing-box', {
    splitDnsDomain: 'repo.example.invalid',
    splitDnsServer: '192.0.2.53',
  })
  assert.deepEqual(stale, config)
  const noAdblock = await render('sing-box', { profile: 'no-adblock' })
  assert.deepEqual(noAdblock.dns.rules[0], { domain_suffix: ['local'], server: 'local' })
})

test('keeps the legacy sing-box output without a work access file', async () => {
  const config = await render('sing-box')
  assert.deepEqual(await render('sing-box', { profile: 'default' }), config)
  assert.ok(!config.endpoints)
  assert.ok(!config.dns.servers.some(server => server.tag.startsWith('work-')))
  assert.ok(!config.dns.rules.some(rule => rule.server?.startsWith('work-')))
  assert.ok(!config.outbounds.some(outbound => (
    ['公司 Mac', '公司备用 181', '公司远程出口'].includes(outbound.tag)
  )))
  assert.ok(!JSON.stringify(config).includes('work-tailnet'))
  await assert.rejects(
    () => render('sing-box', { intranet: 'on' }),
    /intranet=on 需要 workAccessFile/,
  )
})

test('protects company suffixes before .local without remote objects when intranet is off', async () => {
  const config = await render('sing-box', workAccessArgs)
  const tun = config.inbounds.find(inbound => inbound.type === 'tun')
  const localSuffixIndex = config.dns.rules.findIndex(rule => rule.server === 'local' && rule.domain_suffix)
  const adblockIndex = config.dns.rules.findIndex(rule => rule.rule_set === 'geosite-adblock')

  assert.deepEqual(config.dns.servers.filter(server => server.tag.startsWith('work-')), [{
    tag: 'work-company-local',
    type: 'udp',
    server: '192.168.77.8',
    detour: '🎯 直连',
  }])
  assert.deepEqual(config.dns.rules.slice(0, 2), [
    {
      type: 'logical',
      mode: 'and',
      rules: [officeRule, { domain_suffix: ['corp.local'] }],
      server: 'work-company-local',
    },
    { domain_suffix: ['corp.local'], action: 'reject' },
  ])
  assert.ok(localSuffixIndex > 1)
  assert.ok(adblockIndex > 1)
  assert.ok(!config.dns.rules.some(rule => rule.server === 'work-company-remote'))
  assert.ok(!JSON.stringify(config.dns.rules).includes('work-project-'))
  assert.ok(!JSON.stringify(config.dns.rules.slice(0, 2)).includes('git.example.test'))
  assert.ok(!config.endpoints)
  assert.ok(!config.outbounds.some(outbound => (
    ['公司 Mac', '公司备用 181', '公司远程出口'].includes(outbound.tag)
  )))
  assert.deepEqual(tun.route_exclude_address, routeExcludeAddress)
})

test('renders intranet routing, DNS and the physical NIC OR condition', async () => {
  const config = await render('sing-box', intranetArgs)
  const workServers = config.dns.servers.filter(server => server.tag.startsWith('work-'))
  const projectDns = config.dns.rules.find(rule => rule.server === 'work-project-0')
  const companyLocal = config.dns.rules.find(rule => rule.server === 'work-company-local')
  const companyRemote = config.dns.rules.find(rule => rule.server === 'work-company-remote')
  const localSuffixIndex = config.dns.rules.findIndex(rule => rule.server === 'local' && rule.domain_suffix)
  const fakeIpIndex = config.dns.rules.findIndex(rule => rule.server === 'fakeip' && rule.rewrite_ttl)
  const projectDnsIndex = config.dns.rules.indexOf(projectDns)
  const companyLocalIndex = config.dns.rules.indexOf(companyLocal)
  const companyRemoteIndex = config.dns.rules.indexOf(companyRemote)

  assert.deepEqual(workServers, [
    { tag: 'work-company-local', type: 'udp', server: '192.168.77.8', detour: '🎯 直连' },
    { tag: 'work-company-remote', type: 'udp', server: '192.168.77.8', detour: '公司远程出口' },
    { tag: 'work-project-0', type: 'udp', server: '192.168.88.9', detour: '公司 Mac' },
  ])
  assert.deepEqual(projectDns, { domain: ['project.example.test'], server: 'work-project-0' })
  assert.deepEqual(companyLocal, {
    type: 'logical',
    mode: 'and',
    rules: [officeRule, {
      type: 'logical',
      mode: 'or',
      rules: [
        { domain: ['git.example.test'] },
        { domain_suffix: ['corp.local'] },
      ],
    }],
    server: 'work-company-local',
  })
  assert.deepEqual(companyRemote, {
    type: 'logical',
    mode: 'or',
    rules: [{ domain: ['git.example.test'] }, { domain_suffix: ['corp.local'] }],
    server: 'work-company-remote',
  })
  assert.deepEqual(
    companyLocal.rules[0].rules.map(rule => Object.keys(rule.network_interface_address)),
    [['wifi'], ['ethernet']],
  )
  assert.ok(projectDnsIndex < companyLocalIndex)
  assert.ok(companyLocalIndex < companyRemoteIndex)
  assert.ok(companyRemoteIndex < localSuffixIndex)
  assert.ok(localSuffixIndex < fakeIpIndex)

  const projectIp = config.route.rules.find(rule => rule.ip_cidr?.[0] === '10.88.1.2/32')
  const projectDomain = config.route.rules.find(rule => rule.domain?.[0] === 'project.example.test')
  const companyDirect = config.route.rules.find(rule => (
    rule.type === 'logical' && rule.outbound === '🎯 直连'
  ))
  const companyRemoteIp = config.route.rules.find(rule => (
    rule.outbound === '公司远程出口' && rule.ip_cidr
  ))
  const companyRemoteDomain = config.route.rules.find(rule => (
    rule.outbound === '公司远程出口' && rule.domain
  ))
  const companyRemoteSuffix = config.route.rules.find(rule => (
    rule.outbound === '公司远程出口' && rule.domain_suffix
  ))
  const hijackIndex = config.route.rules.findIndex(rule => rule.action === 'hijack-dns')
  const privateIndex = config.route.rules.findIndex(rule => rule.ip_is_private === true)

  assert.deepEqual(projectIp, { ip_cidr: ['10.88.1.2/32'], outbound: '公司 Mac' })
  assert.deepEqual(projectDomain, { domain: ['project.example.test'], outbound: '公司 Mac' })
  assert.deepEqual(companyDirect, {
    type: 'logical',
    mode: 'and',
    rules: [officeRule, {
      type: 'logical',
      mode: 'or',
      rules: [
        { ip_cidr: ['10.77.0.0/16', '192.168.77.8/32'] },
        { domain: ['git.example.test'] },
        { domain_suffix: ['corp.local'] },
      ],
    }],
    outbound: '🎯 直连',
  })
  assert.deepEqual(companyRemoteIp, {
    ip_cidr: ['10.77.0.0/16', '192.168.77.8/32'],
    outbound: '公司远程出口',
  })
  assert.deepEqual(companyRemoteDomain, {
    domain: ['git.example.test'],
    outbound: '公司远程出口',
  })
  assert.deepEqual(companyRemoteSuffix, {
    domain_suffix: ['corp.local'],
    outbound: '公司远程出口',
  })
  assert.ok(hijackIndex < config.route.rules.indexOf(projectIp))
  assert.ok(config.route.rules.indexOf(projectIp) < config.route.rules.indexOf(companyDirect))
  assert.ok(config.route.rules.indexOf(companyDirect) < config.route.rules.indexOf(companyRemoteIp))
  assert.ok(config.route.rules.indexOf(companyRemoteSuffix) < privateIndex)
  assert.equal(config.route.rules[0].action, 'reject')

  assert.deepEqual(config.endpoints, [workAccessFixture.tailscale])
  assert.deepEqual(config.outbounds.find(outbound => outbound.tag === '公司 Mac'), {
    ...workAccessFixture.mac,
    detour: 'work-tailnet',
  })
  assert.deepEqual(config.outbounds.find(outbound => outbound.tag === '公司备用 181'), {
    ...workAccessFixture.backup,
    detour: 'work-tailnet',
  })
  assert.deepEqual(config.outbounds.find(outbound => outbound.tag === '公司远程出口'), {
    tag: '公司远程出口',
    type: 'selector',
    outbounds: ['公司 Mac', '公司备用 181'],
    default: '公司 Mac',
    interrupt_exist_connections: true,
  })
})

test('subtracts only selected company and project IPv4 ranges from TUN exclusions', async () => {
  const config = await render('sing-box', intranetArgs)
  const tun = config.inbounds.find(inbound => inbound.type === 'tun')
  const excluded = tun.route_exclude_address
  const reserved = [
    ...workAccessFixture.company.ip_cidr,
    ...workAccessFixture.projects.flatMap(project => project.ip_cidr),
  ]

  for (const value of excluded) {
    for (const removal of reserved) {
      assert.ok(
        !rangesOverlap(ipv4CidrRange(value), ipv4CidrRange(removal)),
        `${value} must not overlap ${removal}`,
      )
    }
  }
  assert.ok(!containsAddress(excluded, '10.77.1.1'))
  assert.ok(!containsAddress(excluded, '192.168.77.8'))
  assert.ok(!containsAddress(excluded, '10.88.1.2'))
  assert.ok(containsAddress(excluded, '10.0.0.1'))
  assert.ok(containsAddress(excluded, '172.16.0.1'))
  assert.ok(containsAddress(excluded, '192.168.1.10'))
  assert.ok(containsAddress(excluded, motionProGatewayAddress))
  assert.ok(!containsAddress(excluded, '172.19.0.2'))
  assert.ok(excluded.every(value => !value.includes(':')))
  assert.ok(excluded.every(value => (
    !rangesOverlap(ipv4CidrRange(value), ipv4CidrRange('172.19.0.0/30'))
  )))
  assert.equal(
    countIpv4Addresses(excluded),
    countIpv4Addresses(routeExcludeAddress) - 65538n,
  )
  assert.deepEqual(
    config.inbounds.find(inbound => inbound.type === 'mixed'),
    templates['sing-box'].inbounds.find(inbound => inbound.type === 'mixed'),
  )
})

test('keeps both ad profiles with intranet routing', async () => {
  const onDefault = await render('sing-box', intranetArgs)
  const onNoAdblock = await render('sing-box', { ...intranetArgs, profile: 'no-adblock' })
  const expected = structuredClone(onDefault)

  expected.dns.rules = expected.dns.rules.filter(rule => rule.rule_set !== 'geosite-adblock')
  expected.route.rule_set = expected.route.rule_set.filter(
    ruleSet => ruleSet.tag !== 'geosite-adblock',
  )

  assert.ok(onDefault.dns.rules.some(rule => rule.rule_set === 'geosite-adblock'))
  assert.deepEqual(onNoAdblock, expected)
  assert.ok(!onNoAdblock.dns.rules.some(rule => rule.rule_set === 'geosite-adblock'))
  assert.deepEqual(onNoAdblock.dns.servers, onDefault.dns.servers)
  assert.deepEqual(
    onNoAdblock.dns.rules.filter(rule => rule.server?.startsWith('work-')),
    onDefault.dns.rules.filter(rule => rule.server?.startsWith('work-')),
  )

  const offNoAdblock = await render('sing-box', { ...workAccessArgs, profile: 'no-adblock' })
  assert.ok(!offNoAdblock.dns.rules.some(rule => rule.rule_set === 'geosite-adblock'))
  assert.deepEqual(offNoAdblock.dns.rules.slice(0, 2), [
    {
      type: 'logical',
      mode: 'and',
      rules: [officeRule, { domain_suffix: ['corp.local'] }],
      server: 'work-company-local',
    },
    { domain_suffix: ['corp.local'], action: 'reject' },
  ])
})

test('keeps Egern output independent of work access arguments', async () => {
  const baseline = await render('egern')
  assert.deepEqual(await render('egern', intranetArgs), baseline)
  assert.ok(!JSON.stringify(baseline).includes('公司远程出口'))
})

test('renders a native Egern profile with matching groups and remote rule sets', async () => {
  const config = await render('egern')
  const groups = config.policy_groups.map(group => Object.values(group)[0])
  const remoteRules = config.rules.filter(rule => rule.rule_set).map(rule => rule.rule_set)

  assert.equal(config.proxies.length, 14)
  assert.deepEqual(config.auto_update, {
    url: egernAutoUpdateUrl,
    interval: 86400,
  })
  assert.ok(config.proxies.every(proxy => Object.values(proxy)[0].name))
  assert.ok(config.proxies.every(proxy => !Object.hasOwn(Object.values(proxy)[0], 'prev_hop')))
  assert.equal(groups.length, 25)
  assert.equal(config.policy_groups.filter(group => group.auto_test).length, 5)
  for (const entry of config.policy_groups) {
    const [type, group] = Object.entries(entry)[0]
    if (type === 'auto_test') {
      assert.ok(!group.policies.includes('DIRECT'), `${group.name} 自动测速组不得包含直连`)
    } else {
      assert.ok(group.policies.includes('DIRECT'), `${group.name} 手动选择组必须包含直连`)
    }
  }
  assert.ok(config.policy_groups.find(group => group.auto_test?.name === '🇯🇵 ISIF JP'))
  assertManagementOrder(groups, 'name')
  assert.equal(groups.find(group => group.name === '🚀 默认代理').policies[0], '🇺🇸 DMIT Pro')
  assert.equal(groups.find(group => group.name === '🧠 AI').policies[0], '🏠 AaiTR-Verizon家宽')
  assert.equal(groups.find(group => group.name === '🔮 Palantir').policies[0], '🏠 AaiTR-Verizon家宽')
  assert.equal(groups.find(group => group.name === 'VPS管理-美国').policies[0], '🇺🇸 DMIT Pro')
  assert.equal(groups.find(group => group.name === 'VPS管理-亚太').policies[0], '🇯🇵 ISIF JP')
  assert.deepEqual(groups.find(group => group.name === '🏠 VIRCS家宽').policies, householdNodes)
  assert.deepEqual(groups.find(group => group.name === '🏠 AaiTR-Verizon家宽').policies, aaitrNodes)
  assert.ok(!groups.some(group => group.name === '🏠 QQPW家宽'))
  assert.equal(groups.find(group => group.name === '🍏 Apple').policies[0], 'DIRECT')

  assert.equal(remoteRules.length, 22)
  assert.ok(remoteRules.every(rule => (
    rule.match.startsWith('https://raw.githubusercontent.com/') &&
    rule.match.endsWith('.yaml') &&
    !rule.match.includes('gh-proxy.com') &&
    rule.update_interval === 86400
  )))
  assert.equal(remoteRules[0].policy, 'REJECT')
  assert.equal(config.rules.length, 56)
  assert.deepEqual(
    config.rules
      .filter(rule => rule.domain_suffix?.policy === '🔮 Palantir')
      .map(rule => rule.domain_suffix.match),
    palantirDomains,
  )
  const serialized = JSON.stringify(config)
  for (const field of [
    'default_interface_address',
    'download_detour',
    'store_fakeip',
    'no_drop',
    'dialer-proxy',
    'privateRelays',
    'url-test',
    'inet4_range',
    'inet6_range',
    '2001:2::/48',
    'fdfe:dcba:9876::1/126',
    'tun-in',
    'auto_route',
    'strict_route',
  ]) {
    assert.ok(!serialized.includes(field), `Egern must not contain ${field}`)
  }
  assert.deepEqual(config.rules[0], {
    ip_cidr: { match: '127.0.0.0/8', policy: 'DIRECT', no_resolve: true },
  })
  assert.deepEqual(config.rules.at(-1), { default: { policy: '🐟 漏网之鱼' } })
})

test('automatically checks each egress and residential paths', async () => {
  const config = await render('sing-box')
  const automatic = config.outbounds.filter(node => node.type === 'urltest')
  assert.deepEqual(automatic.map(node => node.tag), ['🇺🇸 DMIT Pro', '🇺🇸 DMIT EB', '🇯🇵 ISIF JP', '🏠 VIRCS家宽', '🏠 AaiTR-Verizon家宽'])
  for (const node of automatic) {
    assert.equal(node.interval, '60s')
    assert.equal(node.url, 'https://www.gstatic.com/generate_204')
    assert.equal(node.tolerance, 100)
    assert.ok(!Object.hasOwn(node, 'default'))
  }
  assert.equal(automatic[0].outbounds[0], '[自建]dmitpro-hy2[美国.LAX]')
  assert.equal(config.outbounds.find(node => node.tag === '🇯🇵 ISIF JP').type, 'urltest')
  assert.ok(!JSON.stringify(config).includes('QQPW'))
  const egern = await render('egern')
  for (const proxy of egern.proxies.filter(node => node.hysteria2?.name.includes('Hy2'))) {
    assert.equal(proxy.hysteria2.fingerprint_sha256, fixturePin)
    assert.ok(!Object.hasOwn(proxy.hysteria2, 'skip_tls_verify'))
    assert.equal(proxy.hysteria2.port_hopping, '21000-21999')
  }
})
