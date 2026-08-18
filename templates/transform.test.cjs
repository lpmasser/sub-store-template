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
const egernRuleFields = new Set([
  'domain_set',
  'domain_suffix_set',
  'domain_keyword_set',
  'domain_regex_set',
  'ip_cidr_set',
  'ip_cidr6_set',
])

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
      if (request.platform === 'Egern') {
        return JSON.stringify({
          proxies: proxyTags.map((name, index) => ({
            vless: {
              name,
              server: `node-${index + 1}.example.com`,
              port: 443,
              user_id: 'test-only',
            },
          })),
        })
      }
      throw new Error(`unexpected platform: ${request.platform}`)
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

function assertDefaults(groups, tagKey, membersKey, defaultKey, directTag) {
  for (const group of groups) {
    assert.ok(group[defaultKey], `${group[tagKey]} must declare a default`)
    assert.ok(group[membersKey].includes(group[defaultKey]), `${group[tagKey]} default must exist`)
  }
  assert.equal(groups.find(group => group[tagKey] === '🚀 默认代理')[defaultKey], '🇺🇸 DMIT Pro')
  assert.equal(groups.find(group => group[tagKey] === '🧠 AI')[defaultKey], '🏠 美国家宽')
  assert.equal(groups.find(group => group[tagKey] === 'VPS管理-美国')[defaultKey], '🇺🇸 DMIT Pro')
  assert.equal(groups.find(group => group[tagKey] === 'VPS管理-亚太')[defaultKey], '🇯🇵 ISIF JP')
  assert.deepEqual(groups.find(group => group[tagKey] === '🏠 美国家宽')[membersKey], householdNodes)
  const apple = groups.find(group => group[tagKey] === '🍏 Apple')
  assert.equal(apple[membersKey].length, 6)
  assert.equal(apple[defaultKey], directTag)
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

test('renders the sing-box profile from eight ordinary nodes', async () => {
  const config = await render('sing-box')
  const nodes = config.outbounds.filter(outbound => outbound.type === 'vless')
  const groups = config.outbounds.filter(outbound => outbound.type === 'selector')
  const tun = config.inbounds.find(inbound => inbound.type === 'tun')
  const mixed = config.inbounds.find(inbound => inbound.type === 'mixed')

  assert.equal(nodes.length, 8)
  assert.equal(groups.length, 21)
  assert.ok(nodes.every(node => !Object.hasOwn(node, 'detour')))
  assertDefaults(groups, 'tag', 'outbounds', 'default', '🎯 直连')

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
    rule.action === 'predefined' && rule.rcode === 'NOERROR' && rule.type === 'logical'
  ))
  const localIndex = config.dns.rules.findIndex(rule => rule.type === 'logical' && rule.server === 'local')
  const appleNoDataIndex = config.dns.rules.findIndex(rule => (
    rule.rule_set === policy.dns.appleRuleSet &&
    rule.query_type === 'HTTPS' &&
    rule.action === 'predefined' &&
    rule.rcode === 'NOERROR'
  ))
  const fakeIpIndex = config.dns.rules.findIndex(rule => rule.server === 'fakeip' && rule.rewrite_ttl)
  assert.deepEqual(
    config.dns.rules.find(rule => rule.clash_mode === 'direct'),
    { clash_mode: 'direct', server: 'local' },
  )
  assert.deepEqual(
    config.dns.rules.find(rule => rule.clash_mode === 'global'),
    { clash_mode: 'global', server: 'fakeip' },
  )
  assert.equal(noDataIndex, foreignIndex + 1)
  assert.equal(localIndex, noDataIndex + 1)
  assert.equal(appleNoDataIndex, localIndex + 1)
  assert.ok(fakeIpIndex > appleNoDataIndex)
  assert.equal(config.dns.rules[fakeIpIndex].rewrite_ttl, 60)
  assert.deepEqual(config.dns.rules[fakeIpIndex].query_type, ['A', 'AAAA'])

  const noDataRule = config.dns.rules[noDataIndex]
  assert.deepEqual(noDataRule.rules[0], { query_type: ['AAAA', 'HTTPS'] })
  assert.deepEqual(noDataRule.rules[1], {
    default_interface_address: '2000::/3',
    invert: true,
  })
  const noDataScope = noDataRule.rules[2].rules
  assert.deepEqual(noDataScope[0].rule_set, policy.dns.localRuleSets)
  assert.ok(!noDataScope[0].rule_set.includes(policy.dns.appleRuleSet))
  assert.deepEqual(
    noDataScope.find(rule => rule.domain).domain,
    policy.routing.inline.find(rule => rule.policy === 'DIRECT' && rule.type === 'domain').values,
  )
  assert.deepEqual(config.dns.rules[localIndex].rules, noDataScope)
  assert.ok(!JSON.stringify(config.dns.rules[localIndex]).includes(policy.dns.appleRuleSet))
  assert.deepEqual(config.dns.rules[appleNoDataIndex], {
    query_type: 'HTTPS',
    rule_set: 'geosite-apple',
    action: 'predefined',
    rcode: 'NOERROR',
  })
  assert.deepEqual(
    config.dns.rules
      .slice(0, fakeIpIndex)
      .filter(rule => JSON.stringify(rule).includes(policy.dns.appleRuleSet)),
    [config.dns.rules[appleNoDataIndex]],
  )

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
  assert.equal(
    config.route.rules.find(rule => rule.rule_set === 'geosite-apple').outbound,
    '🍏 Apple',
  )
  assert.deepEqual(config.route.default_domain_resolver, { server: 'public' })
  assert.equal(config.route.final, '🐟 漏网之鱼')
})

test('renders a native Egern profile with matching groups and remote rule sets', async () => {
  const config = await render('egern')
  const groups = config.policy_groups.map(group => group.select)
  const remoteRules = config.rules.filter(rule => rule.rule_set).map(rule => rule.rule_set)

  assert.equal(config.proxies.length, 8)
  assert.ok(config.proxies.every(proxy => Object.values(proxy)[0].name))
  assert.ok(config.proxies.every(proxy => !Object.hasOwn(Object.values(proxy)[0], 'prev_hop')))
  assert.equal(groups.length, 21)
  assert.ok(config.policy_groups.every(group => Object.keys(group).join() === 'select'))
  assert.equal(groups.find(group => group.name === '🚀 默认代理').policies[0], '🇺🇸 DMIT Pro')
  assert.equal(groups.find(group => group.name === '🧠 AI').policies[0], '🏠 美国家宽')
  assert.equal(groups.find(group => group.name === 'VPS管理-美国').policies[0], '🇺🇸 DMIT Pro')
  assert.equal(groups.find(group => group.name === 'VPS管理-亚太').policies[0], '🇯🇵 ISIF JP')
  assert.deepEqual(groups.find(group => group.name === '🏠 美国家宽').policies, householdNodes)
  assert.equal(groups.find(group => group.name === '🍏 Apple').policies[0], 'DIRECT')

  assert.equal(remoteRules.length, 22)
  assert.ok(remoteRules.every(rule => (
    rule.match.startsWith('https://raw.githubusercontent.com/') &&
    rule.match.endsWith('.yaml') &&
    !rule.match.includes('gh-proxy.com') &&
    rule.update_interval === 86400
  )))
  assert.equal(remoteRules[0].policy, 'REJECT')
  assert.equal(config.rules.length, 49)
  assert.deepEqual(config.rules[0], {
    ip_cidr: { match: '127.0.0.0/8', policy: 'DIRECT', no_resolve: true },
  })
  assert.deepEqual(config.rules.at(-1), { default: { policy: '🐟 漏网之鱼' } })
})
