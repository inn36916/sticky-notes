'use strict'

/**
 * 敏感凭据编解码回归测试（lib/secret-codec.js）
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { ENC_PREFIX, isEncrypted, encryptSecret, decryptSecret } = require('../lib/secret-codec')

function makeFakeSafeStorage ({ available = true, failEncrypt = false, failDecrypt = false } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => {
      if (failEncrypt) throw new Error('mock encrypt fail')
      // 简单可逆混淆，验证确经 encryptString/decryptString 往返
      const raw = Buffer.from(String(text), 'utf8')
      const xored = Buffer.from(raw.map(b => b ^ 0x5a))
      return xored
    },
    decryptString: (buf) => {
      if (failDecrypt) throw new Error('mock decrypt fail')
      const raw = Buffer.from(buf)
      return Buffer.from(raw.map(b => b ^ 0x5a)).toString('utf8')
    }
  }
}

test('加密与解密往返一致，且密文不泄漏原串', () => {
  const ss = makeFakeSafeStorage()
  const cipher = encryptSecret('sk-secret-123456', ss)
  assert.ok(isEncrypted(cipher))
  assert.ok(cipher.startsWith(ENC_PREFIX))
  assert.equal(cipher.includes('sk-secret-123456'), false)
  assert.equal(decryptSecret(cipher, ss), 'sk-secret-123456')
})

test('重复加密具有幂等性，不会产生双重前缀', () => {
  const ss = makeFakeSafeStorage()
  const once = encryptSecret('sk-once', ss)
  const twice = encryptSecret(once, ss)
  assert.equal(twice, once)
  assert.equal(decryptSecret(twice, ss), 'sk-once')
})

test('空字符串输入直接返回空串', () => {
  const ss = makeFakeSafeStorage()
  assert.equal(encryptSecret('', ss), '')
  assert.equal(decryptSecret('', ss), '')
  assert.equal(isEncrypted(''), false)
})

test('历史明文数据直接透传兼容（未加 ENC_PREFIX 时不破坏旧配置/E2E）', () => {
  const ss = makeFakeSafeStorage()
  assert.equal(decryptSecret('sk-legacy-plain', ss), 'sk-legacy-plain')
  assert.equal(decryptSecret('sk-legacy-plain', null), 'sk-legacy-plain')
})

test('系统加密后端不可用时，加密优雅降级、密文不误当作明文透传', () => {
  const unavailable = makeFakeSafeStorage({ available: false })
  assert.equal(encryptSecret('sk-abc', unavailable), 'sk-abc')
  const cipher = encryptSecret('sk-abc', makeFakeSafeStorage({ available: true }))
  assert.equal(decryptSecret(cipher, unavailable), '')
})

test('加解密抛错时不崩溃并触发 onError 回调', () => {
  const errs = []
  const broken = makeFakeSafeStorage({ failEncrypt: true, failDecrypt: true })
  const out = encryptSecret('sk-abc', broken, { onError: e => errs.push(e.message) })
  assert.equal(out, 'sk-abc')
  assert.equal(errs.length, 1)

  const cipher = encryptSecret('sk-abc', makeFakeSafeStorage())
  const dec = decryptSecret(cipher, broken, { onError: e => errs.push(e.message) })
  assert.equal(dec, '')
  assert.equal(errs.length, 2)
})
