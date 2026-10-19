import {
  X509Certificate,
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign
} from 'node:crypto'

/**
 * Self-signed TLS certificate for https://localhost (the Word add-in host), built with node:crypto
 * only (no OpenSSL binary, no dependency). One certificate per install:
 *  - ECDSA P-256 / SHA-256, a LEAF (CA:FALSE) that is its own trust anchor: installing it in the
 *    CurrentUser Root store trusts exactly this certificate for exactly localhost / 127.0.0.1 / ::1,
 *    never "any certificate it could sign" (there is no CA and no signing key kept around);
 *  - the SAN is mandatory for Chromium/WebView2 (the CN alone is ignored);
 *  - validity 730 days; `needsRenewal` flags the last 30 days.
 */

export const CERT_VALID_DAYS = 730
export const RENEW_BEFORE_DAYS = 30

export interface GeneratedCert {
  certPem: string
  /** PKCS#8 PEM of the private key (the caller must store it protected, never in clear text) */
  keyPem: string
  /** SHA-1 of the DER, upper-case hex: what certutil / the Windows store call the "thumbprint" */
  thumbprint: string
  notBefore: Date
  notAfter: Date
}

// ---- minimal DER writer -------------------------------------------------------------------
const lenBytes = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n])
  const out: number[] = []
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff)
  return Buffer.from([0x80 | out.length, ...out])
}
const tlv = (tag: number, ...c: Buffer[]): Buffer => {
  const body = Buffer.concat(c)
  return Buffer.concat([Buffer.from([tag]), lenBytes(body.length), body])
}
const seq = (...c: Buffer[]): Buffer => tlv(0x30, ...c)
const set = (...c: Buffer[]): Buffer => tlv(0x31, ...c)
const octets = (b: Buffer): Buffer => tlv(0x04, b)
const bitString = (b: Buffer): Buffer => tlv(0x03, Buffer.from([0]), b)
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'))
const bool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0]))

function derInteger(b: Buffer): Buffer {
  let i = 0
  while (i < b.length - 1 && b[i] === 0) i++
  let v = b.subarray(i)
  if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v])
  return tlv(0x02, v)
}

function oid(dotted: string): Buffer {
  const p = dotted.split('.').map(Number)
  const out: number[] = [p[0] * 40 + p[1]]
  for (const n of p.slice(2)) {
    const chunk = [n & 0x7f]
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128))
      chunk.unshift((v & 0x7f) | 0x80)
    out.push(...chunk)
  }
  return tlv(0x06, Buffer.from(out))
}

/** UTCTime until 2049 (RFC 5280), GeneralizedTime afterwards. */
function time(d: Date): Buffer {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  const y = d.getUTCFullYear()
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  return y < 2050
    ? tlv(0x17, Buffer.from(`${p(y % 100)}${rest}`, 'ascii'))
    : tlv(0x18, Buffer.from(`${p(y, 4)}${rest}`, 'ascii'))
}

const OID = {
  cn: '2.5.4.3',
  org: '2.5.4.10',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  san: '2.5.29.17',
  ski: '2.5.29.14'
}

const extension = (id: string, critical: boolean, value: Buffer): Buffer =>
  seq(oid(id), ...(critical ? [bool(true)] : []), octets(value))

const name = (): Buffer =>
  seq(
    set(seq(oid(OID.org), utf8('Mizaj Studio'))),
    set(seq(oid(OID.cn), utf8('localhost (Mizaj Word add-in)')))
  )

function sanValue(): Buffer {
  const dns = tlv(0x82, Buffer.from('localhost', 'ascii'))
  const ip4 = tlv(0x87, Buffer.from([127, 0, 0, 1]))
  const ip6 = tlv(0x87, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]))
  return seq(dns, ip4, ip6)
}

export function certThumbprint(der: Buffer): string {
  return createHash('sha1').update(der).digest('hex').toUpperCase()
}

export function pemToDer(pem: string): Buffer {
  const b64 = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '')
  return Buffer.from(b64, 'base64')
}

const toPem = (der: Buffer): string =>
  `-----BEGIN CERTIFICATE-----\n${(der.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END CERTIFICATE-----\n`

export function generateCert(now: Date = new Date()): GeneratedCert {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const notBefore = new Date(now.getTime() - 5 * 60_000) // clock skew tolerance
  const notAfter = new Date(now.getTime() + CERT_VALID_DAYS * 86_400_000)
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const serial = randomBytes(16)
  serial[0] &= 0x7f // positive
  const sigAlg = seq(oid(OID.ecdsaSha256))
  const keyId = createHash('sha1').update(spki).digest()
  const exts = seq(
    extension(OID.basicConstraints, true, seq()), // CA:FALSE (the default, an empty SEQUENCE)
    extension(OID.keyUsage, true, bitString(Buffer.from([0x80]))), // digitalSignature
    extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
    extension(OID.san, false, sanValue()),
    extension(OID.ski, false, octets(keyId))
  )
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), // v3
    derInteger(serial),
    sigAlg,
    name(),
    seq(time(notBefore), time(notAfter)),
    name(),
    spki,
    tlv(0xa3, exts)
  )
  const sig = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' })
  const der = seq(tbs, sigAlg, bitString(sig))
  return {
    certPem: toPem(der),
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    thumbprint: certThumbprint(der),
    notBefore,
    notAfter
  }
}

export interface CertInfo {
  thumbprint: string
  notAfter: Date
  expired: boolean
  needsRenewal: boolean
  validForLocalhost: boolean
  isCa: boolean
}

/** Reads a stored certificate; null for anything that is not a parsable X.509 PEM. */
export function inspectCert(certPem: string, now: Date = new Date()): CertInfo | null {
  try {
    const x = new X509Certificate(certPem)
    const notAfter = new Date(x.validTo)
    const left = notAfter.getTime() - now.getTime()
    return {
      thumbprint: x.fingerprint.replace(/:/g, '').toUpperCase(),
      notAfter,
      expired: left <= 0 || new Date(x.validFrom).getTime() > now.getTime() + 86_400_000,
      needsRenewal: left < RENEW_BEFORE_DAYS * 86_400_000,
      validForLocalhost:
        x.checkHost('localhost') !== undefined && x.checkIP('127.0.0.1') !== undefined,
      isCa: x.ca
    }
  } catch {
    return null
  }
}

/** True when the PEM private key belongs to the PEM certificate. */
export function keyMatchesCert(certPem: string, keyPem: string): boolean {
  try {
    return new X509Certificate(certPem).checkPrivateKey(createPrivateKey(keyPem))
  } catch {
    return false
  }
}
