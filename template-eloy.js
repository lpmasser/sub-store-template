const { type, name } = $arguments

let config = JSON.parse($files[0])

let proxies = await produceArtifact({
  name,
  type: /^1$|col/i.test(type) ? 'collection' : 'subscription',
  platform: 'sing-box',
  produceType: 'internal',
})

config.outbounds.push(...proxies)

const proxyTags = proxies.map(p => p.tag)

function uniq(list) {
  return Array.from(new Set(list))
}

function toJSRegex(src) {
  let flags = 'u'
  let s = src
  if (/\(\?i\)/i.test(s) || /\(\?i:/.test(s)) flags += 'i'
  s = s.replace(/\(\?i:([^)]*)\)/gi, '(?:$1)')
  s = s.replace(/\(\?i\)/gi, '')
  return new RegExp(s, flags)
}

function filterByPattern(pattern) {
  const re = toJSRegex(pattern)
  return proxyTags.filter(t => re.test(t))
}

function setGroup(tag, list, fallbackDirect = false) {
  const g = config.outbounds.find(o => o.tag === tag)
  if (!g) return
  const out = uniq(list)
  if (out.length === 0 && fallbackDirect) {
    g.outbounds = ['DIRECT']
  } else {
    g.outbounds = out
  }
}

function appendToGroup(tag, list) {
  const g = config.outbounds.find(o => o.tag === tag)
  if (!g) return
  const out = uniq([...(g.outbounds || []), ...list])
  g.outbounds = out
}

// 1) include-all + filter 组（严格沿用旧配置正则）
setGroup('♻️ 自动选择', filterByPattern('(?=.*(IPLC))^((?!(E|F|套餐|奈飛|流媒體)).)*$'), true)
setGroup('♻️ 自建VPS', filterByPattern('(?=.*(自建))'), true)
// setGroup('♻️ 公益VPS', filterByPattern('(?=.*(linuxdo))'), true)
setGroup('♻️ 美国自动', filterByPattern('(?=.*(美|US|(?i)States|America))^((?!(E|F|港|台|日|韩|新|遊戲專線|视频專線)).)*$'), true)
setGroup('♻️ 香港自动', filterByPattern('(?=.*(港|HK|(?i)Hong))^((?!(E|F|台|日|韩|新|深|美|遊戲專線|视频專線)).)*$'), true)
setGroup('♻️ 日本自动', filterByPattern('(?=.*(日|JP|(?i)Japan))^((?!(E|F|港|台|韩|新|美|遊戲專線|视频專線)).)*$'), true)
setGroup('♻️ 狮城自动', filterByPattern('(?=.*(狮|SG|(?i)Singapore))^((?!(E|F|港|台|韩|新|美|遊戲專線|视频專線)).)*$'), true)
setGroup('♻️ 台湾自动', filterByPattern('(?=.*(台|TW|(?i)Taiwan))^((?!(E|F|港|日|韩|新|美|遊戲專線|视频專線)).)*$'), true)
setGroup('♻️ 欧洲自动', filterByPattern('(?=.*(欧|EU|(?i)Europe|UK|United\\s*Kingdom|GB|Britain|England|DE|Germany|FR|France|NL|Netherlands|IT|Italy|ES|Spain|SE|Sweden|CH|Switzerland|AT|Austria|IE|Ireland|BE|Belgium|PL|Poland|CZ|Czech|NO|Norway|DK|Denmark|FI|Finland|PT|Portugal|GR|Greece|HU|Hungary|RO|Romania|BG|Bulgaria|UA|Ukraine))^((?!(E|F|港|台|日|韩|新|美|遊戲專線|视频專線)).)*$'), true)

// 2) 选择器：全部节点与高倍专线
setGroup('🌐 全部节点', proxyTags)
// setGroup('🌐 高倍专线', filterByPattern('(?=.*(遊戲專線|视频專線))'))

// 3) 业务分组保留原追加节点（在模板已有“默认代理+各地区”的基础上追加匹配节点）
appendToGroup('🧠 AI', filterByPattern('(?i)ChatGPT|openai|自建'))
appendToGroup('🎶 Spotify', filterByPattern('(?i)buyvm'))
appendToGroup('🎥 NETFLIX', filterByPattern('(?i:NETFLIX)|奈飛|buyvm|视频'))

// 4) 地区中间层：仅追加匹配节点（自动组已在模板中写入）
appendToGroup('🇭🇰 香港', filterByPattern('(?=.*(港|HK|(?i)Hong))^((?!(E|F|台|日|韩|新|深|美|遊戲專線|视频專線)).)*$'))
appendToGroup('🇯🇵 日本', filterByPattern('(?=.*(日|JP|(?i)Japan))^((?!(E|F|港|台|韩|新|美|遊戲專線|视频專線)).)*$'))
appendToGroup('🇸🇬 狮城', filterByPattern('(?=.*(狮|SG|(?i)Singapore))^((?!(E|F|港|台|韩|新|美|遊戲專線|视频專線)).)*$'))
appendToGroup('🇹🇼 台湾', filterByPattern('(?=.*(台|TW|(?i)Taiwan))^((?!(E|F|港|日|韩|新|美|遊戲專線|视频專線)).)*$'))
appendToGroup('🇪🇺 欧洲', filterByPattern('(?=.*(欧|EU|(?i)Europe|UK|United\\s*Kingdom|GB|Britain|England|DE|Germany|FR|France|NL|Netherlands|IT|Italy|ES|Spain|SE|Sweden|CH|Switzerland|AT|Austria|IE|Ireland|BE|Belgium|PL|Poland|CZ|Czech|NO|Norway|DK|Denmark|FI|Finland|PT|Portugal|GR|Greece|HU|Hungary|RO|Romania|BG|Bulgaria|UA|Ukraine))^((?!(E|F|港|台|日|韩|新|美|遊戲專線|视频專線)).)*$'))

$content = JSON.stringify(config, null, 2)

