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
  assert.equal(groups.find(group => group[tagKey] === '🚀 默认代理')[defaultKey], '🇺🇸 DMIT Pro')
  assert.equal(groups.find(group => group[tagKey] === '🧠 AI')[defaultKey], '🏠 美国家宽')
  assert.equal(groups.find(group => group[tagKey] === 'VPS管理-美国')[defaultKey], '🇺🇸 DMIT Pro')
  assert.equal(groups.find(group => group[tagKey] === 'VPS管理-亚太')[defaultKey], '🇯🇵 ISIF JP')
  assert.deepEqual(groups.find(group => group[tagKey] === '🏠 美国家宽')[membersKey], householdNodes)
}

test('renders the sing-box profile from eight ordinary nodes', async () => {
  const config = await render('sing-box')
  const nodes = config.outbounds.filter(outbound => outbound.type === 'vless')
  const groups = config.outbounds.filter(outbound => outbound.type === 'selector')

  assert.equal(nodes.length, 8)
  assert.equal(groups.length, 21)
  assert.ok(nodes.every(node => !Object.hasOwn(node, 'detour')))
  assertDefaults(groups, 'tag', 'outbounds', 'default')
  assert.equal(config.dns.rules[0].rule_set, 'geosite-adblock')
  assert.equal(config.dns.rules[0].rcode, 'NXDOMAIN')
  assert.equal(config.route.rule_set.length, 22)
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
    provider.format === 'text'
  )))
  assert.equal(config.rules.length, 49)
  assert.ok(config.rules.includes('RULE-SET,geosite-adblock,REJECT'))
  assert.equal(config.rules.at(-1), 'MATCH,🐟 漏网之鱼')
})
