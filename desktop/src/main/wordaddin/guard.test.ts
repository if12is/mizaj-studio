import { describe, expect, it } from 'vitest'
import { RateLimiter, checkApi, checkPage, checkStatic, hostAllowed, safeEqual } from './guard'

const cfg = { port: 47615, scheme: 'https' as const, token: 'tok-abc' }
const good = {
  host: 'localhost:47615',
  origin: 'https://localhost:47615',
  'content-type': 'application/json; charset=utf-8',
  'x-mizaj-pair': 'tok-abc',
  'sec-fetch-site': 'same-origin'
}
const api = (h: Record<string, string>, method = 'POST') =>
  checkApi({ method, headers: { ...good, ...h } }, cfg)

describe('API guard', () => {
  it('accepts exactly the add-in own page with the pairing token', () => {
    expect(api({})).toEqual({ ok: true })
  })
  it('accepts a request without Sec-Fetch-Site (older WebViews) when Origin matches', () => {
    const h: Record<string, string> = { ...good }
    delete h['sec-fetch-site']
    expect(checkApi({ method: 'POST', headers: h }, cfg)).toEqual({ ok: true })
  })
  it('rejects a foreign or missing Origin', () => {
    expect(api({ origin: 'https://evil.example' })).toMatchObject({ code: 'bad_origin' })
    expect(api({ origin: 'https://localhost:9999' })).toMatchObject({ code: 'bad_origin' })
    expect(api({ origin: 'http://localhost:47615' })).toMatchObject({ code: 'bad_origin' })
    expect(api({ origin: '' })).toMatchObject({ code: 'bad_origin' })
  })
  it('rejects DNS-rebinding hosts', () => {
    expect(api({ host: 'evil.example:47615' })).toMatchObject({ code: 'bad_host' })
    expect(api({ host: 'localhost:1' })).toMatchObject({ code: 'bad_host' })
  })
  it('rejects cross-site fetches', () => {
    expect(api({ 'sec-fetch-site': 'cross-site' })).toMatchObject({ code: 'cross_site' })
    expect(api({ 'sec-fetch-site': 'same-site' })).toMatchObject({ code: 'cross_site' })
  })
  it('requires the right pairing token (and none when not installed)', () => {
    expect(api({ 'x-mizaj-pair': 'nope' })).toMatchObject({ code: 'bad_pair' })
    expect(api({ 'x-mizaj-pair': '' })).toMatchObject({ code: 'bad_pair' })
    expect(checkApi({ method: 'POST', headers: good }, { ...cfg, token: null })).toMatchObject({
      code: 'not_paired'
    })
  })
  it('never accepts the general backend token header as a substitute', () => {
    const h: Record<string, string> = { ...good, 'x-mizaj-token': 'tok-abc' }
    delete h['x-mizaj-pair']
    expect(checkApi({ method: 'POST', headers: h }, cfg)).toMatchObject({ code: 'bad_pair' })
  })
  it('POST + JSON only', () => {
    expect(api({}, 'GET')).toMatchObject({ status: 405 })
    expect(api({ 'content-type': 'text/plain' })).toMatchObject({ status: 415 })
  })
})

describe('page / static guard', () => {
  it('pages need the token in the URL', () => {
    const r = { method: 'GET', headers: { host: 'localhost:47615' } }
    expect(checkPage(r, cfg, 'tok-abc')).toEqual({ ok: true })
    expect(checkPage(r, cfg, 'x')).toMatchObject({ code: 'bad_pair' })
    expect(checkPage(r, cfg, null)).toMatchObject({ code: 'bad_pair' })
    expect(checkPage(r, { ...cfg, token: null }, 'tok-abc')).toMatchObject({ code: 'not_paired' })
  })
  it('pages refuse cross-site navigation', () => {
    const r = {
      method: 'GET',
      headers: { host: 'localhost:47615', 'sec-fetch-site': 'cross-site' }
    }
    expect(checkPage(r, cfg, 'tok-abc')).toMatchObject({ code: 'cross_site' })
  })
  it('static files only for GET/HEAD on our host', () => {
    expect(
      checkStatic({ method: 'POST', headers: { host: 'localhost:47615' } }, cfg)
    ).toMatchObject({
      status: 405
    })
    expect(checkStatic({ method: 'GET', headers: { host: 'x:47615' } }, cfg)).toMatchObject({
      code: 'bad_host'
    })
  })
})

describe('helpers', () => {
  it('safeEqual is length-safe', () => {
    expect(safeEqual('a', 'a')).toBe(true)
    expect(safeEqual('a', 'ab')).toBe(false)
  })
  it('host allow-list', () => {
    expect(hostAllowed('127.0.0.1:47615', cfg)).toBe(true)
    expect(hostAllowed('LOCALHOST:47615', cfg)).toBe(true)
    expect(hostAllowed('localhost', cfg)).toBe(false)
  })
  it('rate limiter slides', () => {
    let t = 0
    const l = new RateLimiter(2, 1000, () => t)
    expect([l.allow(), l.allow(), l.allow()]).toEqual([true, true, false])
    t = 1500
    expect(l.allow()).toBe(true)
  })
})
