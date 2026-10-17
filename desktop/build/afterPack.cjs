// electron-builder afterPack hook: flip Electron fuses on the packaged binary (8.2.3).
// Runs before signing/installer creation, so the modified binary is what gets shipped.
const { join } = require('node:path')
const { readFileSync, existsSync } = require('node:fs')
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')

/**
 * ASAR integrity needs a digest embedded in the executable. electron-builder 24 only writes it on
 * macOS; on Windows the exe carries it only if an "ELECTRONASAR" resource is present. Turning the
 * fuse on without one risks an app that refuses to start, so it is enabled only when supported.
 * (Linux ignores the fuse; it is still set so the policy is uniform.)
 */
function asarIntegrityUsable(platform, exePath) {
  if (platform === 'darwin' || platform === 'linux') return true
  try {
    return readFileSync(exePath).includes(Buffer.from('ELECTRONASAR', 'utf16le'))
  } catch {
    return false
  }
}

exports.default = async function afterPack(context) {
  const { electronPlatformName: platform, appOutDir, packager } = context
  let exe
  if (platform === 'darwin') {
    exe = join(appOutDir, `${packager.appInfo.productFilename}.app`)
  } else if (platform === 'win32') {
    exe = join(appOutDir, `${packager.appInfo.productFilename}.exe`)
  } else {
    exe = join(appOutDir, packager.executableName)
  }
  if (!existsSync(exe)) throw new Error(`afterPack: executable not found: ${exe}`)

  // TEST BUILDS ONLY (windows-e2e / update-e2e workflows): Playwright attaches to the packaged app with
  // --inspect, which the EnableNodeCliInspectArguments fuse forbids. Release builds never set this.
  const e2eBuild = process.env.MIZAJ_E2E_BUILD === '1'
  if (e2eBuild)
    console.warn(
      '  \u2022 afterPack: MIZAJ_E2E_BUILD=1, Node inspect fuse left ON (NOT for release)'
    )

  const integrity = asarIntegrityUsable(platform, exe)
  if (!integrity) {
    console.warn(
      '  • afterPack: no ASAR integrity digest in the executable; leaving EnableEmbeddedAsarIntegrityValidation off'
    )
  }
  await flipFuses(exe, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: platform === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: e2eBuild,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: integrity,
    [FuseV1Options.OnlyLoadAppFromAsar]: true
  })
  console.log(`  • afterPack: fuses applied to ${exe} (asarIntegrity=${integrity})`)
}
