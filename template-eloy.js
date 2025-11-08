// ————————————————————————————————————————————————————————————————
// 声明式分组表（统一追加，不重置原有分组）
//
// 使用方法：
// - 仅维护 APPEND_GROUPS：所有分组均使用 appendToGroup 在原有 outbounds 基础上追加匹配结果；
//   不会覆盖或清空已有配置（例如模板中预设的“默认代理/地区自动”等）。
// - pattern: 字符串正则（兼容旧式 (?i)、(?i:...)），或特殊值 ':all' 表示全部节点。
// - 只需编辑 APPEND_GROUPS 即可，无需改动逻辑代码。
//
// 说明：
// - 保留旧正则兼容（PCRE 风格 (?i)），便于沿用旧配置。
// - 统一去重，避免重复添加节点名；不做空结果 DIRECT 兜底（因不重置，仅追加）。
// - 如不再需要旧正则兼容，可将 toJSRegex 简化为 `new RegExp(src, 'iu')`。
// ————————————————————————————————————————————————————————————————

// 读取模板配置
let config = JSON.parse($files[0])

// 生成订阅产物（集合）并注入到 outbounds
let proxies = await produceArtifact({
  name: 'singbox-all',
  type: 'collection',
  platform: 'sing-box',
  produceType: 'internal',
})
config.outbounds.push(...proxies)

// 缓存全部节点名，后续分组都基于此做匹配
const proxyTags = proxies.map(p => p.tag)

// ——— 工具函数区域 ———
function uniq(list) {
  return Array.from(new Set(list))
}

// 将旧配置里常见的 PCRE 写法转为 JS 正则（保留 i/unicode 行为）
function toJSRegex(src) {
  let flags = 'u'
  let s = src
  if (/\(\?i\)/i.test(s) || /\(\?i:/.test(s)) flags += 'i'
  s = s.replace(/\(\?i:([^)]*)\)/gi, '(?:$1)')
  s = s.replace(/\(\?i\)/gi, '')
  return new RegExp(s, flags)
}

// 根据正则字符串筛选节点名
function filterByPattern(pattern) {
  const re = toJSRegex(pattern)
  return proxyTags.filter(t => re.test(t))
}

// 统一写入：在原有 outbounds 基础上追加
function appendToGroup(tag, list) {
  const g = config.outbounds.find(o => o.tag === tag)
  if (!g) return
  const out = uniq([...(g.outbounds || []), ...list])
  g.outbounds = out
}

// 小助手：将声明表中的 pattern 解析为节点列表
function resolveList(pattern) {
  if (pattern === ':all') return proxyTags
  return filterByPattern(pattern)
}

// ——— 声明式分组表（全部采用 appendToGroup） ———
const APPEND_GROUPS = [
  // 选择器 & 自动类（原重置型，现改为追加，不会清空模板默认项）
  { tag: '♻️ 自动选择', pattern: '(?=.*(IPLC))^((?!(E|F|套餐|奈飛|流媒體)).)*$' },
  { tag: '♻️ 自建VPS', pattern: '(?=.*(自建))' },
  // { tag: '♻️ 公益VPS', pattern: '(?=.*(linuxdo))' },
  { tag: '♻️ 美国自动', pattern: '(?=.*(美|US|(?i)States|America))^((?!(E|F|港|台|日|韩|新|遊戲專線|视频專線)).)*$' },
  { tag: '♻️ 香港自动', pattern: '(?=.*(港|HK|(?i)Hong))^((?!(E|F|台|日|韩|新|深|美|遊戲專線|视频專線)).)*$' },
  { tag: '♻️ 日本自动', pattern: '(?=.*(日|JP|(?i)Japan))^((?!(E|F|港|台|韩|新|美|遊戲專線|视频專線)).)*$' },
  { tag: '♻️ 狮城自动', pattern: '(?=.*(狮|SG|(?i)Singapore))^((?!(E|F|港|台|韩|新|美|遊戲專線|视频專線)).)*$' },
  { tag: '♻️ 台湾自动', pattern: '(?=.*(台|TW|(?i)Taiwan))^((?!(E|F|港|日|韩|新|美|遊戲專線|视频專線)).)*$' },
  { tag: '♻️ 欧洲自动', pattern: '(?=.*(欧|EU|(?i)Europe|UK|United\\s*Kingdom|GB|Britain|England|DE|Germany|FR|France|NL|Netherlands|IT|Italy|ES|Spain|SE|Sweden|CH|Switzerland|AT|Austria|IE|Ireland|BE|Belgium|PL|Poland|CZ|Czech|NO|Norway|DK|Denmark|FI|Finland|PT|Portugal|GR|Greece|HU|Hungary|RO|Romania|BG|Bulgaria|UA|Ukraine))^((?!(E|F|港|台|日|韩|新|美|遊戲專線|视频專線)).)*$' },
  { tag: '🌐 全部节点', pattern: ':all' },
  // { tag: '🌐 高倍专线', pattern: '(?=.*(遊戲專線|视频專線))' },

  // 业务分组
  { tag: '🧠 AI', pattern: '(?i)ChatGPT|openai|自建' },
  { tag: '🎶 Spotify', pattern: '(?i)buyvm' },
  { tag: '🎥 NETFLIX', pattern: '(?i:NETFLIX)|奈飛|buyvm|视频' },

  // 地区中间层：仅追加匹配节点（自动组已在模板中写入）
  { tag: '🇭🇰 香港', pattern: '(?=.*(港|HK|(?i)Hong))^((?!(E|F|台|日|韩|新|深|美|遊戲專線|视频專線)).)*$' },
  { tag: '🇯🇵 日本', pattern: '(?=.*(日|JP|(?i)Japan))^((?!(E|F|港|台|韩|新|美|遊戲專線|视频專線)).)*$' },
  { tag: '🇸🇬 狮城', pattern: '(?=.*(狮|SG|(?i)Singapore))^((?!(E|F|港|台|韩|新|美|遊戲專線|视频專線)).)*$' },
  { tag: '🇹🇼 台湾', pattern: '(?=.*(台|TW|(?i)Taiwan))^((?!(E|F|港|日|韩|新|美|遊戲專線|视频專線)).)*$' },
  { tag: '🇪🇺 欧洲', pattern: '(?=.*(欧|EU|(?i)Europe|UK|United\\s*Kingdom|GB|Britain|England|DE|Germany|FR|France|NL|Netherlands|IT|Italy|ES|Spain|SE|Sweden|CH|Switzerland|AT|Austria|IE|Ireland|BE|Belgium|PL|Poland|CZ|Czech|NO|Norway|DK|Denmark|FI|Finland|PT|Portugal|GR|Greece|HU|Hungary|RO|Romania|BG|Bulgaria|UA|Ukraine))^((?!(E|F|港|台|日|韩|新|美|遊戲專線|视频專線)).)*$' },
]

// 应用声明式分组表（统一追加）
for (const g of APPEND_GROUPS) {
  appendToGroup(g.tag, resolveList(g.pattern))
}

// 输出最终配置
$content = JSON.stringify(config, null, 2)
