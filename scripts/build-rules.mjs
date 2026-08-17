import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(repositoryRoot, 'rules/sources.json'), 'utf8'))
const singBox = process.env.SING_BOX_BIN || 'sing-box'
const hageziUrl = 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.txt'
const generatedHeader = '# Generated file. Do not edit.\n'
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'sub-store-rules-'))
const temporaryOutputDirectory = join(temporaryDirectory, 'output')
const temporaryShadowrocketDirectory = join(temporaryOutputDirectory, 'shadowrocket')

try {
  validateManifest(manifest)
  await mkdir(temporaryShadowrocketDirectory, { recursive: true })
  await buildHagezi()
  for (const ruleSet of manifest.ruleSets) await buildShadowrocketRuleSet(ruleSet)
  await publishArtifacts()
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}

function validateManifest(candidate) {
  if (candidate?.schema !== 1 || !Array.isArray(candidate.ruleSets)) {
    throw new Error('rules/sources.json schema must be 1 and contain ruleSets')
  }
  const outputs = new Set()
  for (const ruleSet of candidate.ruleSets) {
    if (!/^[a-z0-9-]+\.list$/.test(ruleSet.output || '')) {
      throw new Error(`invalid output name: ${ruleSet.output}`)
    }
    if (!/^https:\/\//.test(ruleSet.source || '')) {
      throw new Error(`invalid source URL for ${ruleSet.output}`)
    }
    if (outputs.has(ruleSet.output)) throw new Error(`duplicate output: ${ruleSet.output}`)
    outputs.add(ruleSet.output)
  }
}

async function buildHagezi() {
  const sourceText = (await download(hageziUrl)).toString('utf8')
  const sourcePath = join(temporaryDirectory, 'hagezi-pro.txt')
  const srsPath = join(temporaryOutputDirectory, 'hagezi-pro.srs')
  await writeFile(sourcePath, sourceText)

  const adguardRules = sourceText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('||'))
  if (adguardRules.length < 100000) {
    throw new Error(`HaGeZi Pro source is unexpectedly small: ${adguardRules.length} rules`)
  }

  const unsupported = []
  const domains = []
  for (const rule of adguardRules) {
    const match = /^\|\|([a-z0-9._-]+)\^$/i.exec(rule)
    if (!match) {
      unsupported.push(rule)
      continue
    }
    domains.push(match[1].toLowerCase())
  }
  if (unsupported.length > 0) {
    throw new Error(`unsupported HaGeZi rules: ${unsupported.slice(0, 3).join(', ')}`)
  }

  const uniqueDomains = uniq(domains)
  assertDomainMatch(uniqueDomains, 'googleads.g.doubleclick.net', true)
  assertDomainMatch(uniqueDomains, 'apple.com', false)

  runSingBox(['rule-set', 'convert', '--type', 'adguard', '--output', srsPath, sourcePath])
  const binaryMatch = runSingBox([
    'rule-set', 'match', '--format', 'binary', srsPath, 'googleads.g.doubleclick.net',
  ], { capture: true })
  if (!/^match /m.test(binaryMatch)) throw new Error('HaGeZi SRS semantic match failed')

  const shadowrocketPath = join(temporaryShadowrocketDirectory, 'hagezi-pro.list')
  await writeFile(
    shadowrocketPath,
    `${generatedHeader}# Source: ${hageziUrl}\n${uniqueDomains.map(domain => `DOMAIN-SUFFIX,${domain}`).join('\n')}\n`,
  )
  console.log(`built hagezi-pro: ${uniqueDomains.length} domains`)
}

async function buildShadowrocketRuleSet(ruleSet) {
  const baseName = ruleSet.output.replace(/\.list$/, '')
  const binaryPath = join(temporaryDirectory, `${baseName}.srs`)
  const sourcePath = join(temporaryDirectory, `${baseName}.json`)
  await writeFile(binaryPath, await download(ruleSet.source))
  runSingBox(['rule-set', 'decompile', '--output', sourcePath, binaryPath])

  const source = JSON.parse(await readFile(sourcePath, 'utf8'))
  if (!Array.isArray(source.rules) || source.rules.length === 0) {
    throw new Error(`${ruleSet.output} decompiled to an empty rule-set`)
  }
  const regexCount = source.rules.reduce(
    (count, rule) => count + normalizeList(rule.domain_regex).length,
    0,
  )
  const lines = uniq(source.rules.flatMap(convertRuleObject))
  if (lines.length === 0) throw new Error(`${ruleSet.output} produced no Shadowrocket rules`)

  const outputPath = join(temporaryShadowrocketDirectory, ruleSet.output)
  await writeFile(
    outputPath,
    `${generatedHeader}# Source: ${ruleSet.source}\n${lines.join('\n')}\n`,
  )
  console.log(
    `built ${ruleSet.output}: ${lines.length} rules` +
    (regexCount > 0 ? ` (${regexCount} domain regex converted to wildcard)` : ''),
  )
}

async function publishArtifacts() {
  const rulesDirectory = join(repositoryRoot, 'rules')
  const shadowrocketDirectory = join(rulesDirectory, 'shadowrocket')
  const expectedFiles = new Set([
    'hagezi-pro.list',
    ...manifest.ruleSets.map(ruleSet => ruleSet.output),
  ])

  await mkdir(shadowrocketDirectory, { recursive: true })
  for (const fileName of expectedFiles) {
    await copyFile(
      join(temporaryShadowrocketDirectory, fileName),
      join(shadowrocketDirectory, fileName),
    )
  }
  await copyFile(
    join(temporaryOutputDirectory, 'hagezi-pro.srs'),
    join(rulesDirectory, 'hagezi-pro.srs'),
  )

  for (const entry of await readdir(shadowrocketDirectory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.list') && !expectedFiles.has(entry.name)) {
      await unlink(join(shadowrocketDirectory, entry.name))
      console.log(`removed stale artifact: ${entry.name}`)
    }
  }
}

function convertRuleObject(rule) {
  const supportedKeys = new Set([
    'domain',
    'domain_suffix',
    'domain_keyword',
    'domain_regex',
    'ip_cidr',
  ])
  const unknownKeys = Object.entries(rule)
    .filter(([key, value]) => !supportedKeys.has(key) && normalizeList(value).length > 0)
    .map(([key]) => key)
  if (unknownKeys.length > 0) {
    throw new Error(`unsupported sing-box rule fields: ${unknownKeys.join(', ')}`)
  }

  const lines = []
  appendRules(lines, 'DOMAIN', rule.domain)
  appendRules(lines, 'DOMAIN-SUFFIX', rule.domain_suffix)
  appendRules(lines, 'DOMAIN-KEYWORD', rule.domain_keyword)
  appendRules(lines, 'DOMAIN-WILDCARD', normalizeList(rule.domain_regex).map(regexToWildcard))
  for (const cidr of normalizeList(rule.ip_cidr)) {
    lines.push(`${cidr.includes(':') ? 'IP-CIDR6' : 'IP-CIDR'},${cidr}`)
  }
  return lines
}

function appendRules(lines, type, values) {
  for (const value of normalizeList(values)) lines.push(`${type},${value}`)
}

function normalizeList(value) {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function regexToWildcard(pattern) {
  let wildcard = `${pattern}`
    .replace(/^\(\^\|\\\.\)/, '*')
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\\\./g, '\u0000')
    .replace(/\\[dwsS]/g, '*')
    .replace(/\[[^\]]+\]/g, '*')
    .replace(/\([^)]*\)/g, '*')
    .replace(/\.\+|\.\*/g, '*')
    .replace(/\./g, '*')
    .replace(/\{[^}]+\}/g, '*')
    .replace(/[+?|]/g, '*')
    .replace(/\\(.)/g, '$1')
    .replace(/\*+/g, '*')
    .replace(/\u0000/g, '.')

  if (!/[a-z0-9]/i.test(wildcard) || !/^[a-z0-9.*_-]+$/i.test(wildcard)) {
    throw new Error(`cannot convert domain regex to wildcard: ${pattern} -> ${wildcard}`)
  }
  return wildcard
}

function assertDomainMatch(domains, candidate, expected) {
  const matched = domains.some(domain => candidate === domain || candidate.endsWith(`.${domain}`))
  if (matched !== expected) {
    throw new Error(`unexpected HaGeZi match for ${candidate}: ${matched}`)
  }
}

function uniq(values) {
  return Array.from(new Set(values))
}

async function download(url) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'sub-store-template-rule-builder' },
        signal: AbortSignal.timeout(30000),
      })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise(resolveDelay => setTimeout(resolveDelay, attempt * 1000))
    }
  }
  throw new Error(`failed to download ${url}: ${lastError?.message || lastError}`)
}

function runSingBox(args, options = {}) {
  const result = spawnSync(singBox, ['--disable-color', ...args], {
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`sing-box ${args.join(' ')} failed: ${result.stderr || result.status}`)
  }
  return options.capture ? `${result.stdout || ''}${result.stderr || ''}` : ''
}
