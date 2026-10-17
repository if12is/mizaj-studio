#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
'use strict'
/**
 * Sync desktop/package.json "version" with the release version.
 *   RELEASE_VERSION (workflow_dispatch input)  >  GITHUB_REF_NAME (v*.*.* tag)
 * A tag/input that is not valid semver fails the build loudly.
 * A branch dispatch without a version keeps the current package.json version.
 * Writes `version=<v>` to $GITHUB_OUTPUT when running in Actions.
 */
const fs = require('node:fs')
const path = require('node:path')

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/** @returns {{version: string|null, source: string}} version null => keep current */
function resolveVersion(env) {
  const input = (env.RELEASE_VERSION || '').trim()
  const ref = (env.GITHUB_REF_NAME || '').trim()
  const isTag = env.GITHUB_REF_TYPE === 'tag' || /^v\d/.test(ref)
  let raw = null
  let source = ''
  if (input) {
    raw = input
    source = 'RELEASE_VERSION'
  } else if (isTag) {
    raw = ref
    source = 'GITHUB_REF_NAME'
  }
  if (raw === null) return { version: null, source: 'package.json' }
  const v = raw.replace(/^v/, '')
  if (!SEMVER.test(v)) {
    throw new Error(`Invalid version "${raw}" from ${source}: expected semver like 1.2.3 or v1.2.3`)
  }
  return { version: v, source }
}

function syncVersion(pkgPath, env) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const { version, source } = resolveVersion(env)
  if (version === null) return { version: pkg.version, source, changed: false }
  const changed = pkg.version !== version
  pkg.version = version
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  return { version, source, changed }
}

module.exports = { resolveVersion, syncVersion, SEMVER }

if (require.main === module) {
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json')
    const r = syncVersion(pkgPath, process.env)
    console.log(`desktop version = ${r.version} (from ${r.source}${r.changed ? ', updated' : ''})`)
    if (process.env.GITHUB_OUTPUT)
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${r.version}\n`)
  } catch (e) {
    console.error(`::error::${e.message}`)
    process.exit(1)
  }
}
