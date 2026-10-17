#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
'use strict'
/**
 * SBOM + license compliance (7.6.7).
 *   node scripts/sbom.cjs [--python <exe>] [--out dist/sbom.json]
 *                         [--licenses build/THIRD_PARTY_LICENSES.txt] [--skip-python] [--check]
 * - npm components: `npm sbom` (CycloneDX) when available, else the lockfile + node_modules.
 * - python components: scripts/sbom_python.py (importlib.metadata of the given interpreter).
 * - data/model/font components that are bundled but are not packages.
 * Fails (exit 1) when a license is incompatible with GPL-3.0-or-later.
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')

const ROOT = path.resolve(__dirname, '..')

/** Not GPL-3.0-or-later compatible (or not redistributable). */
const INCOMPATIBLE = [
  /^GPL-2\.0(-only)?$/i,
  /^GPL-2$/i,
  /proprietary/i,
  /commercial/i,
  /^SSPL/i,
  /^BUSL/i,
  /CC-BY-NC/i,
  /^LicenseRef-.*(Proprietary|Commercial)/i
]

const BUNDLED_DATA = [
  {
    name: 'PyInstaller bootloader (frozen engine)',
    version: '6.5.0',
    license: 'GPL-2.0-or-later WITH Bootloader-exception',
    type: 'library',
    url: 'https://pyinstaller.org'
  },
  {
    name: 'CATT encoder/decoder ONNX models (abjadai/catt v2)',
    version: 'v2',
    license: 'Apache-2.0',
    type: 'machine-learning-model',
    url: 'https://github.com/abjadai/catt'
  },
  {
    name: 'ayaspell Arabic dictionary (hunspell-ar)',
    version: '3.5',
    license: 'MPL-2.0 OR LGPL-2.1-or-later',
    type: 'data',
    url: 'https://github.com/linuxscout/ayaspell'
  },
  {
    name: 'Amiri font',
    version: '1.000',
    license: 'OFL-1.1',
    type: 'data',
    url: 'https://github.com/alif-type/amiri'
  },
  {
    name: 'Cairo font',
    version: '5.0',
    license: 'OFL-1.1',
    type: 'data',
    url: 'https://github.com/Gue3bara/Cairo'
  }
]

function normalizeLicense(raw) {
  if (!raw) return ''
  let s = String(raw).trim()
  if (/^\(.*\)$/.test(s)) s = s.slice(1, -1)
  const map = {
    'GNU GPLv3': 'GPL-3.0-only',
    GPLv3: 'GPL-3.0-only',
    'GPLv3+': 'GPL-3.0-or-later',
    BSD: 'BSD-3-Clause',
    'Apache 2.0': 'Apache-2.0',
    'Apache License 2.0': 'Apache-2.0',
    'MIT License': 'MIT'
  }
  return map[s] ?? s
}

/** For SPDX "A OR B" expressions one compatible option is enough. */
function isCompatible(license) {
  const l = normalizeLicense(license)
  if (!l) return true // unknown is reported separately
  const options = l.split(/\s+OR\s+/i)
  return options.some((o) => !INCOMPATIBLE.some((re) => re.test(o.trim())))
}

function checkLicenses(components, exceptions = {}) {
  const incompatible = []
  const unknown = []
  for (const c of components) {
    const lic = exceptions[`${c.name}`] ?? exceptions[`${c.name}@${c.version}`] ?? c.license
    if (!lic) unknown.push(c)
    else if (!isCompatible(lic)) incompatible.push({ ...c, license: lic })
  }
  return { incompatible, unknown }
}

function purl(kind, name, version) {
  return `pkg:${kind}/${encodeURIComponent(name).replace('%40', '@').replace('%2F', '/')}@${version}`
}

function npmComponentsFromLock(root) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  const out = []
  for (const [p, info] of Object.entries(lock.packages ?? {})) {
    if (!p || info.dev || info.devOptional || info.optional) continue
    const name = info.name ?? p.replace(/^.*node_modules\//, '')
    let license = typeof info.license === 'string' ? info.license : ''
    const pj = path.join(root, p, 'package.json')
    if (!license && fs.existsSync(pj)) {
      try {
        const j = JSON.parse(fs.readFileSync(pj, 'utf8'))
        license = typeof j.license === 'string' ? j.license : (j.license && j.license.type) || ''
      } catch {
        /* ignore */
      }
    }
    out.push({ ecosystem: 'npm', name, version: info.version, license: normalizeLicense(license) })
  }
  return out
}

function npmComponents(root) {
  try {
    const raw = execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['sbom', '--sbom-format', 'cyclonedx', '--omit', 'dev', '--package-lock-only'],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: process.platform === 'win32'
      }
    )
    const bom = JSON.parse(raw)
    const comps = (bom.components ?? []).map((c) => ({
      ecosystem: 'npm',
      name: c.group ? `${c.group}/${c.name}` : c.name,
      version: c.version,
      license: normalizeLicense(
        (c.licenses ?? [])
          .map((l) => l.license?.id ?? l.license?.name ?? l.expression ?? '')
          .filter(Boolean)
          .join(' OR ')
      )
    }))
    if (comps.length) return { comps, source: 'npm sbom' }
  } catch {
    /* fall through */
  }
  return { comps: npmComponentsFromLock(root), source: 'package-lock.json' }
}

function pythonComponents(python, requirements) {
  const args = [path.join(__dirname, 'sbom_python.py')]
  if (requirements) args.push('--requirements', requirements)
  const raw = execFileSync(python, args, { encoding: 'utf8', maxBuffer: 1 << 26 })
  return JSON.parse(raw).map((d) => ({
    ecosystem: 'pypi',
    name: d.name,
    version: d.version,
    license: normalizeLicense(d.license)
  }))
}

function toCycloneDx(components, appVersion, now = new Date()) {
  const comp = (c) => ({
    type: c.type ?? 'library',
    'bom-ref': c.ecosystem
      ? purl(c.ecosystem === 'npm' ? 'npm' : 'pypi', c.name, c.version)
      : `data:${c.name}@${c.version}`,
    name: c.name,
    version: c.version,
    ...(c.ecosystem
      ? { purl: purl(c.ecosystem === 'npm' ? 'npm' : 'pypi', c.name, c.version) }
      : {}),
    ...(c.license
      ? {
          licenses: c.license
            .split(/\s+OR\s+/i)
            .map((id) => ({ license: /^[A-Za-z0-9.+-]+$/.test(id) ? { id } : { name: id } }))
        }
      : {}),
    ...(c.url ? { externalReferences: [{ type: 'website', url: c.url }] } : {})
  })
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: now.toISOString(),
      tools: [{ vendor: 'Mizaj Studio', name: 'sbom.cjs', version: '1' }],
      component: {
        type: 'application',
        name: 'mizaj-studio',
        version: appVersion,
        licenses: [{ license: { id: 'GPL-3.0-or-later' } }]
      }
    },
    components: components.map(comp)
  }
}

function renderLicenses(components, appVersion) {
  const group = (eco) =>
    components.filter((c) => c.ecosystem === eco).sort((a, b) => a.name.localeCompare(b.name))
  const line = (c) => `  ${c.name} ${c.version}  [${c.license || 'see package'}]`
  const data = components.filter((c) => !c.ecosystem)
  return [
    `Mizaj Studio ${appVersion}`,
    'License: GNU General Public License v3.0 or later (GPL-3.0-or-later)',
    `Corresponding source: https://github.com/if12is/mizaj-studio/tree/v${appVersion}`,
    '',
    'This application bundles the third-party components below. Their licenses are',
    'compatible with GPL-3.0-or-later. Full license texts ship inside each package;',
    'the complete machine-readable list is the CycloneDX file sbom.json attached to the release.',
    '',
    'Bundled data, models and fonts',
    ...data.map(line),
    '',
    `Python engine packages (${group('pypi').length})`,
    ...group('pypi').map(line),
    '',
    `Desktop (npm) packages (${group('npm').length})`,
    ...group('npm').map(line),
    ''
  ].join('\n')
}

module.exports = {
  normalizeLicense,
  isCompatible,
  checkLicenses,
  toCycloneDx,
  renderLicenses,
  npmComponentsFromLock,
  BUNDLED_DATA,
  INCOMPATIBLE
}

if (require.main === module) {
  const arg = (n, d) => {
    const i = process.argv.indexOf(n)
    return i >= 0 ? process.argv[i + 1] : d
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const out = path.resolve(ROOT, arg('--out', 'dist/sbom.json'))
  const licOut = path.resolve(ROOT, arg('--licenses', 'build/THIRD_PARTY_LICENSES.txt'))
  const npm = npmComponents(ROOT)
  let comps = [...npm.comps]
  if (!process.argv.includes('--skip-python'))
    comps = comps.concat(
      pythonComponents(
        arg('--python', 'python'),
        path.resolve(ROOT, arg('--requirements', '../backend/requirements.txt'))
      )
    )
  comps = comps.concat(BUNDLED_DATA.map((d) => ({ ...d, ecosystem: undefined })))
  const exceptionsFile = path.join(__dirname, 'license-exceptions.json')
  const exceptions = fs.existsSync(exceptionsFile)
    ? JSON.parse(fs.readFileSync(exceptionsFile, 'utf8'))
    : {}
  const { incompatible, unknown } = checkLicenses(comps, exceptions)
  for (const c of unknown) console.warn(`warning: no license metadata for ${c.name}@${c.version}`)
  if (incompatible.length) {
    for (const c of incompatible)
      console.error(
        `::error::license ${c.license} of ${c.name}@${c.version} is not compatible with GPL-3.0-or-later`
      )
    process.exit(1)
  }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.mkdirSync(path.dirname(licOut), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(toCycloneDx(comps, pkg.version), null, 2))
  fs.writeFileSync(licOut, renderLicenses(comps, pkg.version))
  console.log(
    `SBOM: ${comps.length} components (npm via ${npm.source}) -> ${path.relative(ROOT, out)}; licenses -> ${path.relative(ROOT, licOut)}; unknown=${unknown.length}`
  )
}
