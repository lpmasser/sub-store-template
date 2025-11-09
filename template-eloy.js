// ————————————————————————————————————————————————————————————————
// 声明式分组表（统一追加，不重置原有分组）
//
// 使用方法：
// - 仅维护 APPEND_GROUPS：所有分组均使用 appendToGroup 在原有 outbounds 基础上追加匹配结果；
//   不会覆盖或清空已有配置（例如模板中预设的“默认代理/地区自动”等）。
// - pattern: 字符串正则、对象规格（{ any/all/not, ci }），或特殊值 ':all' 表示全部节点。
// - 只需编辑 APPEND_GROUPS 即可，无需改动逻辑代码。
//
// 说明：
// - 已移除 PCRE 内联标志兼容（如 (?i) / (?i:...)）。统一使用 JS 原生 RegExp 标志。
// - 统一去重，避免重复添加节点名；不做空结果 DIRECT 兜底（因不重置，仅追加）。
// - 构造大小写不敏感：通过对象规格的 { ci: true } 让 flags 含 i。
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
/**
 * 去重数组（保持顺序）。
 * @template T
 * @param {T[]} list - 输入数组
 * @returns {T[]} - 去重后的新数组
 */
function uniq(list) {
  return Array.from(new Set(list))
}

// 将正则源与 flags 生成 JS RegExp（不再兼容 PCRE 内联标志）
/**
 * 编译正则：
 * - 字符串：按 'u' 标志创建 RegExp；
 * - {src, flags}：按给定 flags 创建；
 * - 逻辑规格对象（all/any/not/ci/branches）：先用 buildPattern 生成 {src, flags} 再编译。
 * @param {string | {src: string, flags?: string} | {all?: any[], any?: any[], not?: any[], ci?: boolean, branches?: any[]}} spec
 * @returns {RegExp}
 */
function toJSRegex(spec) {
  if (spec && typeof spec === 'object') {
    if (typeof spec.src === 'string') {
      return new RegExp(spec.src, spec.flags || 'u')
    }
    if (isLogicSpec(spec)) {
      const built = buildPattern(spec)
      return new RegExp(built.src, built.flags)
    }
  }
  return new RegExp(String(spec), 'u')
}

// 根据正则字符串筛选节点名
/**
 * 使用 toJSRegex 将正则编译后匹配 proxyTags。
 * @param {string | {src: string, flags?: string} | {all?: any[], any?: any[], not?: any[], ci?: boolean, branches?: any[]}} pattern - 正则源/对象规格
 * @returns {string[]} - 匹配到的 tag 列表
 */
function filterByPattern(pattern) {
  const re = toJSRegex(pattern)
  return proxyTags.filter(t => re.test(t))
}

// 统一写入：在原有 outbounds 基础上追加
/**
 * 将 list 中的节点追加到指定分组 tag，保持去重不覆盖原有顺序。
 * @param {string} tag - 目标分组标识
 * @param {string[]} list - 要追加的节点标签数组
 */
function appendToGroup(tag, list) {
  const g = config.outbounds.find(o => o.tag === tag)
  if (!g) return
  const out = uniq([...(g.outbounds || []), ...list])
  g.outbounds = out
}

// 小助手：将声明表中的 pattern 解析为节点列表
/**
 * 将声明表里的 pattern 转换为节点列表；支持 ':all'。
 * @param {string | {src: string, flags?: string} | {all?: any[], any?: any[], not?: any[], ci?: boolean, branches?: any[]}} pattern - 正则源/对象规格 或 ':all'
 * @returns {string[]} - 节点标签数组
 */
function resolveList(pattern) {
  if (pattern === ':all') return proxyTags
  return filterByPattern(pattern)
}

// —— 基于数组的原生正则构造 ——
/**
 * 转义正则元字符，使普通字符串可安全拼入正则。
 * @param {string} s - 原始文本
 * @returns {string} - 安全的正则片段
 */
function escapeRegex2(s) {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
}
/**
 * 判断是否为 ASCII 单词片段（影响是否自动加 \\b 边界）。
 * @param {string} s
 * @returns {boolean}
 */
function isAsciiWord(s) {
  return /^[A-Za-z0-9_]+$/.test(s)
}
/**
 * 将词条转换为正则片段：
 * - string：先转义；若为 ASCII 单词则包裹 \\b 边界；
 * - {raw,boundary}：直接注入 raw，可选按单词边界包裹。
 * @param {string | {raw: string, boundary?: boolean}} t
 * @returns {string}
 */
function toTokenPattern(t) {
  if (typeof t === 'string') {
    const e = escapeRegex2(t)
    return isAsciiWord(t) ? `\\b${e}\\b` : e
  }
  if (t && typeof t === 'object' && typeof t.raw === 'string') {
    const core = t.raw
    return t.boundary ? `\\b(?:${core})\\b` : core
  }
  return ''
}
/**
 * 构造非捕获分组的“任一匹配” (?:a|b|c)。
 * @param {Array<string | {raw: string, boundary?: boolean}>} list
 * @returns {string}
 */
function anyOf(list) {
  return `(?:${list.map(toTokenPattern).join('|')})`
}
/**
 * 判定是否为逻辑规格对象（而不是 token/raw 或 {src,flags}）。
 * @param {any} x
 * @returns {boolean}
 */
function isLogicSpec(x) {
  if (!x || typeof x !== 'object') return false
  if (typeof x.src === 'string') return false
  return (
    Array.isArray(x.all) ||
    Array.isArray(x.any) ||
    Array.isArray(x.not) ||
    Array.isArray(x.branches) ||
    typeof x.ci === 'boolean'
  )
}

/**
 * 构建混合 AND/OR/NOT 的行级匹配。
 * 规格：{ all?: Tokens[], any?: Tokens[], not?: Tokens[], ci?: boolean, branches?: Spec[] }
 * - all: 每项转换为独立正向先行断言；若项为 {any:[...] } 则构造成组 OR 的先行断言。
 * - any: 合并为单个 OR 先行断言。
 * - not: 合并为单个 OR 的负向先行断言。
 * - branches: 多分支 OR（顶层 OR），每个分支按上述规则构建，再用 (?:b1|b2) 包裹。
 * 返回 {src, flags}，flags 含 'u'，ci=true 时附加 'i'。
 * @param {{ all?: any[], any?: any[], not?: any[], ci?: boolean, branches?: any[] }} spec
 * @returns {{src: string, flags: string}}
 */
function buildPattern(spec) {
  const ci = !!spec.ci
  const flags = ci ? 'iu' : 'u'

  // 顶层多分支 OR
  if (Array.isArray(spec.branches) && spec.branches.length) {
    const branchSrcs = spec.branches.map(b => buildPattern(b).src)
    return { src: `^(?:${branchSrcs.join('|')})$`, flags }
  }

  const parts = []

  // all: 每一项一个 (?=.*...)
  if (Array.isArray(spec.all) && spec.all.length) {
    for (const item of spec.all) {
      if (item && typeof item === 'object' && Array.isArray(item.any)) {
        parts.push(`(?=.*${anyOf(item.any)})`)
      } else {
        parts.push(`(?=.*${toTokenPattern(item)})`)
      }
    }
  }

  // any: 合并为一个 (?=.*(?:a|b|c))
  if (Array.isArray(spec.any) && spec.any.length) {
    parts.push(`(?=.*${anyOf(spec.any)})`)
  }

  // not: 合并为一个 (?!.*(?:a|b|c))
  if (Array.isArray(spec.not) && spec.not.length) {
    parts.push(`(?!.*${anyOf(spec.not)})`)
  }

  const src = `^${parts.join('')}.*$`
  return { src, flags }
}
 

// 复用的排除关键词
const EX_BASE = ['E', 'F', '遊戲專線', '视频專線']

// —— 声明式分组表（全部采用 appendToGroup） ——
const APPEND_GROUPS = [
  { tag: '♻️ 自动选择', pattern: { any: ['IPLC'], not: ['E', 'F', '套餐', '奈飛', '流媒體'] } },
  // { tag: '♻️ 自建VPS', pattern: { any: ['自建'] } },
  // { tag: '♻️ 公益VPS', pattern: { any: ['linuxdo'] } },
  { tag: '♻️ 自建dmitpro', pattern: { all: ['自建', 'dmitpro'], ci: true } },
  { tag: '♻️ 自建dmiteb', pattern: { all: ['自建', 'dmiteb'], ci: true } },
  { tag: '♻️ 自建isifjp', pattern: { all: ['自建', 'isifjp'], ci: true } },
  { tag: '♻️ 自建vmiss', pattern: { all: ['自建', 'vmiss'], ci: true } },

  { tag: '♻️ 美国自动', pattern: { any: ['美', 'US', 'States', 'America'], not: [...EX_BASE, '港', '台', '日', '韩', '新'], ci: true } },
  { tag: '♻️ 香港自动', pattern: { any: ['港', 'HK', 'Hong'], not: [...EX_BASE, '台', '日', '韩', '新', '深', '美'], ci: true } },
  { tag: '♻️ 日本自动', pattern: { any: ['日', 'JP', 'Japan'], not: [...EX_BASE, '港', '台', '韩', '新', '美'], ci: true } },
  { tag: '♻️ 狮城自动', pattern: { any: ['狮', 'SG', 'Singapore'], not: [...EX_BASE, '港', '台', '韩', '新', '美'], ci: true } },
  { tag: '♻️ 台湾自动', pattern: { any: ['台', 'TW', 'Taiwan'], not: [...EX_BASE, '港', '日', '韩', '新', '美'], ci: true } },
  { tag: '♻️ 欧洲自动', pattern: { any: [
      '欧', 'EU', 'Europe', 'UK', { raw: 'United\\s*Kingdom', boundary: true }, 'GB', 'Britain', 'England',
      'DE', 'Germany', 'FR', 'France', 'NL', 'Netherlands', 'IT', 'Italy', 'ES', 'Spain', 'SE', 'Sweden', 'CH', 'Switzerland',
      'AT', 'Austria', 'IE', 'Ireland', 'BE', 'Belgium', 'CZ', 'Czech', 'NO', 'Norway', 'DK', 'Denmark', 'FI', 'Finland',
      'PT', 'Portugal', 'GR', 'Greece', 'HU', 'Hungary', 'RO', 'Romania', 'BG', 'Bulgaria', 'UA', 'Ukraine'
    ], not: [...EX_BASE, '港', '台', '日', '韩', '新', '美'], ci: true } },

  { tag: '🌐 全部节点', pattern: ':all' },
  // { tag: '🌐 高倍专线', pattern: { any: ['遊戲專線', '视频專線'] } },

  // 业务分组
  { tag: '🧠 AI', pattern: { any: ['ChatGPT', 'openai'], ci: true } },
  { tag: '🎶 Spotify', pattern: { any: ['buyvm'], ci: true } },
  { tag: '🎥 NETFLIX', pattern: { any: ['NETFLIX', '奈飛', 'buyvm', '视频'], ci: true } },

  // 地区中间层：仅追加匹配节点（自动组已在模板中写入）
  { tag: '🇺🇸 美国', pattern: { any: ['美', 'US', 'States', 'America'], not: [...EX_BASE, '港', '台', '日', '韩', '新'], ci: true } },
  { tag: '🇭🇰 香港', pattern: { any: ['港', 'HK', 'Hong'], not: [...EX_BASE, '台', '日', '韩', '新', '深', '美'], ci: true } },
  { tag: '🇯🇵 日本', pattern: { any: ['日', 'JP', 'Japan'], not: [...EX_BASE, '港', '台', '韩', '新', '美'], ci: true } },
  { tag: '🇸🇬 狮城', pattern: { any: ['狮', 'SG', 'Singapore'], not: [...EX_BASE, '港', '台', '韩', '新', '美'], ci: true } },
  { tag: '🇹🇼 台湾', pattern: { any: ['台', 'TW', 'Taiwan'], not: [...EX_BASE, '港', '日', '韩', '新', '美'], ci: true } },
  { tag: '🇪🇺 欧洲', pattern: { any: [
      '欧', 'EU', 'Europe', 'UK', { raw: 'United\\s*Kingdom', boundary: true }, 'GB', 'Britain', 'England',
      'DE', 'Germany', 'FR', 'France', 'NL', 'Netherlands', 'IT', 'Italy', 'ES', 'Spain', 'SE', 'Sweden', 'CH', 'Switzerland',
      'AT', 'Austria', 'IE', 'Ireland', 'BE', 'Belgium', 'CZ', 'Czech', 'NO', 'Norway', 'DK', 'Denmark', 'FI', 'Finland',
      'PT', 'Portugal', 'GR', 'Greece', 'HU', 'Hungary', 'RO', 'Romania', 'BG', 'Bulgaria', 'UA', 'Ukraine'
    ], not: [...EX_BASE, '港', '台', '日', '韩', '新', '美'], ci: true } },
]

// 应用声明式分组表（统一追加）
for (const g of APPEND_GROUPS) {
  appendToGroup(g.tag, resolveList(g.pattern))
}

// 输出最终配置
$content = JSON.stringify(config, null, 2)
