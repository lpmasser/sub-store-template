'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const directory = __dirname
const policy = JSON.parse(fs.readFileSync(path.join(directory, 'routing-policy.json'), 'utf8'))
const templates = {
  'sing-box': JSON.parse(fs.readFileSync(path.join(directory, 'sing-box.json'), 'utf8')),
  shadowrocket: JSON.parse(fs.readFileSync(path.join(directory, 'shadowrocket.json'), 'utf8')),
}
const transformSource = fs.readFileSync(path.join(directory, 'transform.js'), 'utf8')

async function runTransform(target, proxyTags, options = {}) {
  const logs = []
  const inputPolicy = options.policy || policy
  const inputTemplate = options.template || templates[target]
  const execute = new AsyncFunction(
    '$files',
    'produceArtifact',
    'ProxyUtils',
    'console',
    `${transformSource}\nreturn $content`,
  )
  const content = await execute(
    [JSON.stringify(inputTemplate)],
    async request => {
      if (request.type === 'file' && request.name === 'routing-policy') {
        return JSON.stringify(inputPolicy)
      }
      if (request.type === 'file' && request.name === 'vircs-client-ss') {
        return JSON.stringify({
          tag: 'runtime-secret-tag',
          type: 'shadowsocks',
          server: 'residential.example.com',
          server_port: 443,
          method: 'aes-128-gcm',
          password: 'test-only',
          network: 'tcp',
        })
      }
      if (request.type !== 'collection' || request.name !== inputPolicy.collection) {
        throw new Error(`unexpected artifact request: ${JSON.stringify(request)}`)
      }
      if (request.platform === 'sing-box') {
        return proxyTags.map(tag => ({ tag, type: 'direct' }))
      }
      if (request.platform === 'Shadowrocket') {
        return JSON.stringify({
          proxies: proxyTags.map((name, index) => ({
            name,
            type: 'ss',
            server: `node-${index + 1}.example.com`,
            port: 443,
            cipher: 'aes-128-gcm',
            password: 'test-only',
          })),
        })
      }
      throw new Error(`unexpected platform: ${request.platform}`)
    },
    {
      yaml: {
        safeLoad: JSON.parse,
        safeDump: value => JSON.stringify(value),
      },
    },
    { log: message => logs.push(String(message)) },
  )
  return { config: JSON.parse(content), logs }
}

function assertValidGroups(config, target) {
  const groups = target === 'sing-box'
    ? config.outbounds.filter(outbound => ['selector', 'urltest'].includes(outbound.type))
    : config['proxy-groups']
  const groupTags = new Set(groups.map(group => target === 'sing-box' ? group.tag : group.name))
  const proxyTags = new Set(
    target === 'sing-box'
      ? config.outbounds
        .filter(outbound => !groupTags.has(outbound.tag) && outbound.tag !== policy.singBoxDirectTag)
        .map(outbound => outbound.tag)
      : config.proxies.map(proxy => proxy.name),
  )
  const terminalTags = new Set([...proxyTags, target === 'sing-box' ? policy.singBoxDirectTag : 'DIRECT'])

  assert.equal(groupTags.size, groups.length, 'group tags must be unique')
  for (const group of groups) {
    const tag = target === 'sing-box' ? group.tag : group.name
    const members = target === 'sing-box' ? group.outbounds : group.proxies
    assert.ok(Array.isArray(members) && members.length > 0, `${tag} must not be empty`)
    for (const member of members) {
      assert.ok(groupTags.has(member) || terminalTags.has(member), `${tag} references missing ${member}`)
    }
    const defaultPolicy = target === 'sing-box' ? group.default : group['policy-select-name']
    if (defaultPolicy) assert.ok(members.includes(defaultPolicy), `${tag} has an invalid default`)
  }
}

const currentProxyTags = [
  '[自建][家宽拼车]Vircs-SS[经DMIT Pro]',
  '[自建]dmitpro-hy2[美国.LAX]',
  '[自建]dmitpro-vless[美国.LAX]',
  '[自建]dmiteb-hy2',
  '[自建]dmiteb-vless',
  '[自建]isifjp-hy2',
  '[自建]isifjp-vless',
]

const strategyTags = [
  '🚀 默认代理',
  '🧠 AI',
  'VPS管理-美国',
  'VPS管理-亚太',
  '🍀 Google',
  '📹 YouTube',
  '🎥 NETFLIX',
  '🍏 Apple',
  '🎶 Spotify',
  '👨🏿‍💻 GitHub',
  '🪟 Microsoft',
  '💶 PayPal',
  '📲 Telegram',
  '🎵 TikTok',
  '🐬 OneDrive',
  '🎮 Steam',
  '🐟 漏网之鱼',
]

const egressDefaults = new Map([
  ['🇺🇸 DMIT Pro', '[自建]dmitpro-vless[美国.LAX]'],
  ['🇺🇸 DMIT EB', '[自建]dmiteb-vless'],
  ['🇯🇵 ISIF JP', '[自建]isifjp-vless'],
  ['🏠 美国家宽', '[自建][家宽拼车]Vircs-SS[经DMIT Pro]'],
])

const vircsEBRelayTag = '[自建][家宽拼车]Vircs-SS[经DMIT EB]'

test('renders the complete sing-box strategy and egress graph without URLTest', async () => {
  const result = await runTransform('sing-box', currentProxyTags)
  const tags = new Set(result.config.outbounds.map(outbound => outbound.tag))
  const groups = result.config.outbounds.filter(outbound => ['selector', 'urltest'].includes(outbound.type))
  const groupTags = new Set(groups.map(group => group.tag))

  assertValidGroups(result.config, 'sing-box')
  assert.deepEqual(groupTags, new Set([...strategyTags, ...egressDefaults.keys()]))
  assert.ok(groups.every(group => group.type === 'selector'))
  assert.equal(groups.find(group => group.tag === '🚀 默认代理').default, '🇺🇸 DMIT Pro')
  assert.equal(groups.find(group => group.tag === '🧠 AI').default, '🏠 美国家宽')
  assert.equal(groups.find(group => group.tag === 'VPS管理-美国').default, '🇺🇸 DMIT Pro')
  assert.equal(groups.find(group => group.tag === 'VPS管理-亚太').default, '🇯🇵 ISIF JP')
  assert.ok(!groupTags.has('🧩 代理补充'))
  for (const [tag, defaultNode] of egressDefaults) {
    assert.equal(groups.find(group => group.tag === tag).default, defaultNode)
  }
  assert.equal(result.config.dns.rules[0].rule_set, 'geosite-adblock')
  assert.equal(result.config.dns.rules[0].rcode, 'NXDOMAIN')
  assert.equal(
    result.config.route.rules.filter(rule => rule.rule_set === 'geosite-adblock').length,
    0,
  )
  assert.deepEqual(
    result.config.route.rules.find(rule => rule.domain?.includes('ssh.git.eloyzh.de')),
    { domain: ['ssh.git.eloyzh.de'], outbound: 'VPS管理-美国' },
  )
  assert.deepEqual(
    result.config.route.rules.find(rule => rule.ip_cidr?.includes('152.53.81.181/32')),
    {
      ip_cidr: ['154.21.86.201/32', '154.17.227.251/32', '152.53.81.181/32', '23.81.118.181/32'],
      outbound: 'VPS管理-美国',
    },
  )
  assert.deepEqual(
    result.config.route.rules.find(rule => rule.ip_cidr?.includes('45.129.8.190/32')),
    {
      ip_cidr: ['45.129.8.190/32', '152.175.36.149/32'],
      outbound: 'VPS管理-亚太',
    },
  )
  assert.ok(!JSON.stringify(result.config.route.rules).includes('46.3.43.12'))
  assert.deepEqual(
    result.config.route.rule_set.map(ruleSet => ruleSet.tag),
    policy.routing.ruleSets.map(ruleSet => ruleSet.tag),
  )
  assert.ok(!result.logs.some(message => message.includes('removed empty groups')))
  for (const tag of currentProxyTags) assert.ok(tags.has(tag))
  const vircsEBRelay = result.config.outbounds.find(outbound => outbound.tag === vircsEBRelayTag)
  assert.equal(vircsEBRelay.type, 'shadowsocks')
  assert.equal(vircsEBRelay.detour, '[自建]dmiteb-vless')
  assert.deepEqual(
    groups.find(group => group.tag === '🏠 美国家宽').outbounds,
    ['[自建][家宽拼车]Vircs-SS[经DMIT Pro]', vircsEBRelayTag],
  )
})

test('renders one complete Shadowrocket profile with the same selectors and REJECT ad blocking', async () => {
  const result = await runTransform('shadowrocket', currentProxyTags)
  const groups = result.config['proxy-groups']
  const groupTags = new Set(groups.map(group => group.name))
  const providers = result.config['rule-providers']

  assertValidGroups(result.config, 'shadowrocket')
  assert.equal(result.config.proxies.length, currentProxyTags.length + 1)
  assert.equal(groups.length, 21)
  assert.equal(groups.filter(group => group.type === 'url-test').length, 0)
  const vircsEBRelay = result.config.proxies.find(proxy => proxy.name === vircsEBRelayTag)
  assert.deepEqual(vircsEBRelay, {
    name: vircsEBRelayTag,
    type: 'ss',
    server: 'residential.example.com',
    port: 443,
    cipher: 'aes-128-gcm',
    password: 'test-only',
    udp: false,
    'dialer-proxy': '[自建]dmiteb-vless',
  })
  assert.deepEqual(groupTags, new Set([...strategyTags, ...egressDefaults.keys()]))
  assert.ok(groups.every(group => group.type === 'select'))
  assert.equal(
    groups.find(group => group.name === '🚀 默认代理')['policy-select-name'],
    '🇺🇸 DMIT Pro',
  )
  assert.equal(groups.find(group => group.name === '🧠 AI')['policy-select-name'], '🏠 美国家宽')
  assert.equal(groups.find(group => group.name === 'VPS管理-美国')['policy-select-name'], '🇺🇸 DMIT Pro')
  assert.equal(groups.find(group => group.name === 'VPS管理-亚太')['policy-select-name'], '🇯🇵 ISIF JP')
  assert.ok(!groupTags.has('🧩 代理补充'))
  for (const [tag, defaultNode] of egressDefaults) {
    const group = groups.find(candidate => candidate.name === tag)
    assert.equal(group['policy-select-name'], defaultNode)
    assert.equal(group.proxies[0], defaultNode)
  }
  assert.deepEqual(
    groups.find(group => group.name === '🏠 美国家宽').proxies,
    ['[自建][家宽拼车]Vircs-SS[经DMIT Pro]', vircsEBRelayTag],
  )
  assert.equal(Object.keys(providers).length, 22)
  assert.deepEqual(Object.keys(providers), policy.routing.ruleSets.map(ruleSet => ruleSet.tag))
  for (const ruleSet of policy.routing.ruleSets) {
    assert.deepEqual(providers[ruleSet.tag], {
      type: 'http',
      behavior: 'classical',
      format: 'text',
      url: `${policy.routing.shadowrocketRuleBaseUrl}/${ruleSet.shadowrocketFile}`,
      path: `./rule-providers/${ruleSet.shadowrocketFile}`,
      interval: 86400,
    })
  }

  assert.equal(result.config.rules.length, 49)
  assert.equal(result.config.rules.at(-1), `MATCH,${policy.routing.final}`)
  assert.ok(result.config.rules.includes('DOMAIN,ssh.git.eloyzh.de,VPS管理-美国'))
  assert.ok(result.config.rules.includes('IP-CIDR,152.53.81.181/32,VPS管理-美国,no-resolve'))
  assert.ok(result.config.rules.includes('IP-CIDR,45.129.8.190/32,VPS管理-亚太,no-resolve'))
  assert.ok(result.config.rules.includes('IP-CIDR,152.175.36.149/32,VPS管理-亚太,no-resolve'))
  assert.ok(!result.config.rules.some(rule => rule.includes('46.3.43.12')))

  const renderedRuleSets = result.config.rules
    .filter(rule => rule.startsWith('RULE-SET,'))
  assert.equal(renderedRuleSets.length, 22)
  assert.ok(renderedRuleSets.every(rule => !rule.split(',')[1].startsWith('http')))
  assert.ok(renderedRuleSets.every(rule => Object.hasOwn(providers, rule.split(',')[1])))
  assert.deepEqual(
    renderedRuleSets.map(rule => rule.split(',')[1]),
    policy.routing.ruleSets.map(ruleSet => ruleSet.tag),
  )
  assert.ok(result.config.rules.includes('RULE-SET,geosite-adblock,REJECT'))
})

test('removes unavailable egresses but preserves every strategy group', async () => {
  const dmitProOnly = [
    '[自建]dmitpro-hy2[美国.LAX]',
    '[自建]dmitpro-vless[美国.LAX]',
  ]

  for (const target of ['sing-box', 'shadowrocket']) {
    const result = await runTransform(target, dmitProOnly)
    const groups = target === 'sing-box'
      ? result.config.outbounds.filter(outbound => ['selector', 'urltest'].includes(outbound.type))
      : result.config['proxy-groups']
    const tags = new Set(groups.map(group => target === 'sing-box' ? group.tag : group.name))

    assertValidGroups(result.config, target)
    for (const strategyTag of strategyTags) assert.ok(tags.has(strategyTag))
    assert.ok(tags.has('🇺🇸 DMIT Pro'))
    assert.ok(!tags.has('🇺🇸 DMIT EB'))
    assert.ok(!tags.has('🇯🇵 ISIF JP'))
    assert.ok(!tags.has('🏠 美国家宽'))
    assert.ok(result.logs.some(message => message.includes('removed empty groups')))
  }
})

test('requires URLTest settings only when a URLTest group is configured', async () => {
  const policyWithUrlTest = structuredClone(policy)
  policyWithUrlTest.groups.push({
    tag: 'test-urltest',
    type: 'urltest',
    match: 'dmitpro',
  })

  await assert.rejects(
    () => runTransform('sing-box', currentProxyTags, { policy: policyWithUrlTest }),
    /routing-policy 的 urlTest 配置无效/,
  )
})

test('refuses to render either client without proxy nodes', async () => {
  for (const target of ['sing-box', 'shadowrocket']) {
    await assert.rejects(() => runTransform(target, []), /proxy-all 没有可用节点/)
  }
})

test('refuses duplicate and reserved proxy names before rendering', async () => {
  for (const target of ['sing-box', 'shadowrocket']) {
    await assert.rejects(
      () => runTransform(target, ['duplicate', 'duplicate']),
      /节点名称 重复: duplicate/,
    )
    await assert.rejects(
      () => runTransform(target, [policy.singBoxDirectTag]),
      /节点名称与策略 tag 冲突/,
    )
  }
})
