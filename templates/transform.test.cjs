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
  '[家宽拼车]Vircs-Malibu[美国.LAX]',
  'dmitpro-hy2[美国.LAX]',
  'dmitpro-vless1[美国.LAX]',
  'dmitpro-vless2[美国.LAX]',
]

test('shared policy preserves the current sing-box graph and DNS-only ad blocking', async () => {
  const result = await runTransform('sing-box', currentProxyTags)
  const tags = new Set(result.config.outbounds.map(outbound => outbound.tag))

  assertValidGroups(result.config, 'sing-box')
  assert.ok(tags.has('🇺🇸 美国'))
  assert.ok(!tags.has('🇭🇰 香港'))
  assert.ok(!tags.has('♻️ 香港自动'))
  assert.equal(result.config.dns.rules[0].rule_set, 'geosite-adblock')
  assert.equal(result.config.dns.rules[0].rcode, 'NXDOMAIN')
  assert.equal(
    result.config.route.rules.filter(rule => rule.rule_set === 'geosite-adblock').length,
    0,
  )
  assert.deepEqual(
    result.config.route.rule_set.map(ruleSet => ruleSet.tag),
    policy.routing.ruleSets.map(ruleSet => ruleSet.tag),
  )
  assert.ok(result.logs.some(message => message.includes('removed empty groups')))
})

test('renders one complete Shadowrocket profile with shared groups and REJECT ad blocking', async () => {
  const result = await runTransform('shadowrocket', currentProxyTags)
  const groupTags = new Set(result.config['proxy-groups'].map(group => group.name))

  assertValidGroups(result.config, 'shadowrocket')
  assert.equal(result.config.proxies.length, currentProxyTags.length)
  assert.ok(groupTags.has('🇺🇸 美国'))
  assert.ok(!groupTags.has('🇭🇰 香港'))
  assert.ok(result.config.rules.includes(
    `${'RULE-SET'},${policy.routing.shadowrocketRuleBaseUrl}/hagezi-pro.list,REJECT`,
  ))
  assert.equal(result.config.rules.at(-1), `MATCH,${policy.routing.final}`)

  const renderedRemoteFiles = result.config.rules
    .filter(rule => rule.startsWith('RULE-SET,'))
    .map(rule => rule.split(',')[1].split('/').at(-1))
  assert.deepEqual(
    renderedRemoteFiles,
    policy.routing.ruleSets.map(ruleSet => ruleSet.shadowrocketFile),
  )
})

test('recognizes Singapore nodes consistently in both clients', async () => {
  for (const target of ['sing-box', 'shadowrocket']) {
    const result = await runTransform(target, ['自建-新加坡 SG-01'])
    const group = target === 'sing-box'
      ? result.config.outbounds.find(outbound => outbound.tag === '♻️ 狮城自动')
      : result.config['proxy-groups'].find(candidate => candidate.name === '♻️ 狮城自动')
    const members = target === 'sing-box' ? group?.outbounds : group?.proxies

    assertValidGroups(result.config, target)
    assert.deepEqual(members, ['自建-新加坡 SG-01'])
  }
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
