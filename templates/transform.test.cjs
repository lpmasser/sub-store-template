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
  shadowrocket: JSON.parse(fs.readFileSync(path.join(directory, 'shadowrocket.json'), 'utf8')),
}
const transformSource = fs.readFileSync(path.join(directory, 'transform.js'), 'utf8')

const proxyTags = [
  '[自建]dmiteb-hy2',
  '[自建]dmiteb-vless',
  '[自建][家宽拼车]Vircs-SS[经DMIT EB]',
  '[自建][家宽拼车]Vircs-SS[经DMIT Pro]',
  '[自建]dmitpro-hy2[美国.LAX]',
  '[自建]dmitpro-vless[美国.LAX]',
  '[自建]isifjp-hy2',
  '[自建]isifjp-vless',
]
const householdNodes = [
  '[自建][家宽拼车]Vircs-SS[经DMIT Pro]',
  '[自建][家宽拼车]Vircs-SS[经DMIT EB]',
]

async function render(target) {
  const execute = new AsyncFunction(
    '$files',
    'produceArtifact',
    'ProxyUtils',
    `${transformSource}\nreturn $content`,
  )
  const content = await execute(
    [JSON.stringify(templates[target])],
    async request => {
      if (request.type === 'file' && request.name === 'routing-policy') {
        return JSON.stringify(policy)
      }
      if (request.type !== 'collection' || request.name !== policy.collection) {
        throw new Error(`unexpected artifact request: ${JSON.stringify(request)}`)
      }
      if (request.platform === 'sing-box') {
        return proxyTags.map(tag => ({ tag, type: 'vless' }))
      }
      return JSON.stringify({
        proxies: proxyTags.map((name, index) => ({
          name,
          type: 'vless',
          server: `node-${index + 1}.example.com`,
          port: 443,
          uuid: 'test-only',
        })),
      })
    },
    {
      yaml: {
        safeLoad: JSON.parse,
        safeDump: JSON.stringify,
      },
    },
  )
  return JSON.parse(content)
}

function assertDefaults(groups, tagKey, membersKey, defaultKey) {
  for (const group of groups) {
    assert.ok(group[defaultKey], `${group[tagKey]} must declare a default`)
    assert.ok(group[membersKey].includes(group[defaultKey]), `${group[tagKey]} default must exist`)
  }
  assert.equal(groups.find(group => group[tagKey] === '🚀 默认代理')[defaultKey], '🇺🇸 DMIT Pro')
  assert.equal(groups.find(group => group[tagKey] === '🧠 AI')[defaultKey], '🏠 美国家宽')
  assert.equal(groups.find(group => group[tagKey] === 'VPS管理-美国')[defaultKey], '🇺🇸 DMIT Pro')
  assert.equal(groups.find(group => group[tagKey] === 'VPS管理-亚太')[defaultKey], '🇯🇵 ISIF JP')
  assert.deepEqual(groups.find(group => group[tagKey] === '🏠 美国家宽')[membersKey], householdNodes)
}

test('uses the same canonical upstream for sing-box and generated Shadowrocket rules', () => {
  const sources = new Map(ruleSources.ruleSets.map(ruleSet => [ruleSet.output, ruleSet.source]))
  for (const ruleSet of policy.routing.ruleSets) {
    assert.match(ruleSet.singBoxUrl, /^https:\/\/raw\.githubusercontent\.com\//)
    assert.ok(!ruleSet.singBoxUrl.includes('gh-proxy.com'))
    if (ruleSet.tag !== 'geosite-adblock') {
      assert.equal(ruleSet.singBoxUrl, sources.get(ruleSet.shadowrocketFile))
    }
  }
  assert.match(policy.routing.shadowrocketRuleBaseUrl, /^https:\/\/raw\.githubusercontent\.com\//)
})

test('renders the sing-box profile from eight ordinary nodes', async () => {
  const config = await render('sing-box')
  const nodes = config.outbounds.filter(outbound => outbound.type === 'vless')
  const groups = config.outbounds.filter(outbound => outbound.type === 'selector')
  const tun = config.inbounds.find(inbound => inbound.type === 'tun')
  const mixed = config.inbounds.find(inbound => inbound.type === 'mixed')

  assert.equal(nodes.length, 8)
  assert.equal(groups.length, 21)
  assert.ok(nodes.every(node => !Object.hasOwn(node, 'detour')))
  assertDefaults(groups, 'tag', 'outbounds', 'default')

  assert.deepEqual(tun.address, ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'])
  assert.equal(tun.auto_route, true)
  assert.equal(tun.strict_route, true)
  assert.equal(mixed.listen, '0.0.0.0')
  assert.equal(mixed.listen_port, 7890)
  assert.equal(config.dns.strategy, 'prefer_ipv4')
  assert.equal(config.experimental.cache_file.store_fakeip, true)

  assert.equal(config.dns.rules[0].rule_set, 'geosite-adblock')
  assert.equal(config.dns.rules[0].rcode, 'NXDOMAIN')
  const foreignIndex = config.dns.rules.findIndex(rule => rule.server === 'foreign')
  const noDataIndex = config.dns.rules.findIndex(rule => (
    rule.action === 'predefined' && rule.rcode === 'NOERROR'
  ))
  const localIndex = config.dns.rules.findIndex(rule => rule.type === 'logical' && rule.server === 'local')
  const fakeIpIndex = config.dns.rules.findIndex(rule => rule.server === 'fakeip' && rule.rewrite_ttl)
  assert.equal(noDataIndex, foreignIndex + 1)
  assert.equal(localIndex, noDataIndex + 1)
  assert.ok(fakeIpIndex > localIndex)
  assert.equal(config.dns.rules[fakeIpIndex].rewrite_ttl, 60)

  const noDataRule = config.dns.rules[noDataIndex]
  assert.deepEqual(noDataRule.rules[0], { query_type: ['AAAA', 'HTTPS'] })
  assert.deepEqual(noDataRule.rules[1], {
    default_interface_address: '2000::/3',
    invert: true,
  })
  const noDataScope = noDataRule.rules[2].rules
  assert.deepEqual(noDataScope[0].rule_set, policy.dns.localRuleSets)
  assert.deepEqual(
    noDataScope.find(rule => rule.domain).domain,
    policy.routing.inline.find(rule => rule.policy === 'DIRECT' && rule.type === 'domain').values,
  )
  assert.deepEqual(config.dns.rules[localIndex].rules, noDataScope)

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
  assert.ok(config.route.rule_set.every(ruleSet => (
    ruleSet.url.startsWith('https://raw.githubusercontent.com/') &&
    !ruleSet.url.includes('gh-proxy.com') &&
    ruleSet.download_detour === '🚀 默认代理' &&
    !Object.hasOwn(ruleSet, 'http_client')
  )))
  assert.ok(!Object.hasOwn(config, 'http_clients'))
  assert.equal(config.route.final, '🐟 漏网之鱼')
})

test('renders the matching Shadowrocket profile and remote rule providers', async () => {
  const config = await render('shadowrocket')
  const groups = config['proxy-groups']
  const providers = config['rule-providers']

  assert.equal(config.proxies.length, 8)
  assert.equal(groups.length, 21)
  assert.ok(groups.every(group => group.type === 'select'))
  assert.ok(config.proxies.every(proxy => !Object.hasOwn(proxy, 'dialer-proxy')))
  assertDefaults(groups, 'name', 'proxies', 'policy-select-name')
  assert.equal(Object.keys(providers).length, 22)
  assert.deepEqual(Object.keys(providers), policy.routing.ruleSets.map(ruleSet => ruleSet.tag))
  assert.ok(Object.values(providers).every(provider => (
    provider.type === 'http' &&
    provider.behavior === 'classical' &&
    provider.format === 'text' &&
    provider.url.startsWith('https://raw.githubusercontent.com/') &&
    !provider.url.includes('gh-proxy.com')
  )))
  const serialized = JSON.stringify(config)
  for (const field of [
    'default_interface_address',
    'download_detour',
    'http_client',
    'http_clients',
    'store_fakeip',
    'no_drop',
  ]) {
    assert.ok(!serialized.includes(field), `Shadowrocket must not contain ${field}`)
  }
  assert.equal(config.rules.length, 49)
  assert.ok(config.rules.includes('RULE-SET,geosite-adblock,REJECT'))
  assert.equal(config.rules.at(-1), 'MATCH,🐟 漏网之鱼')
})
