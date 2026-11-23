'use strict'

/**
 * 敏感凭据（如 AI 供应商 API Key）编解码工具。
 *
 * 不直接依赖 electron，由调用方注入 safeStorage（便于 node:test 单元测试），
 * 同时兼容历史明文与不可用系统加密后端时的优雅降级。
 */

const ENC_PREFIX = 'enc:v1:'

/**
 * 判断存储串是否已带加密前缀。
 * @param {*} value
 * @returns {boolean}
 */
function isEncrypted (value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX)
}

/**
 * 使用注入的 safeStorage 加密明文；空串或已加密串幂等返回。
 * 当系统加密不可用或抛错时降级返回原文，避免阻断用户配置保存。
 *
 * @param {string} plain
 * @param {object} [safeStorage]
 * @param {object} [opts]
 * @param {function} [opts.onError]
 * @returns {string}
 */
function encryptSecret (plain, safeStorage, opts = {}) {
  const raw = typeof plain === 'string' ? plain : String(plain == null ? '' : plain)
  if (!raw) return ''
  if (isEncrypted(raw)) return raw
  try {
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()) {
      const buf = safeStorage.encryptString(raw)
      return ENC_PREFIX + Buffer.from(buf).toString('base64')
    }
  } catch (err) {
    if (typeof opts.onError === 'function') {
      try { opts.onError(err) } catch (_) {}
    }
  }
  return raw
}

/**
 * 解密已存储的密钥；兼容历史明文直接透传。
 * 带加密前缀但解密失败（或无可用加密后端）时返回空串，绝不将密文当作 Bearer Token 发往上游。
 *
 * @param {string} stored
 * @param {object} [safeStorage]
 * @param {object} [opts]
 * @param {function} [opts.onError]
 * @returns {string}
 */
function decryptSecret (stored, safeStorage, opts = {}) {
  const raw = typeof stored === 'string' ? stored : String(stored == null ? '' : stored)
  if (!raw) return ''
  if (!isEncrypted(raw)) return raw
  try {
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()) {
      const payload = raw.slice(ENC_PREFIX.length)
      if (!payload) return ''
      return safeStorage.decryptString(Buffer.from(payload, 'base64'))
    }
  } catch (err) {
    if (typeof opts.onError === 'function') {
      try { opts.onError(err) } catch (_) {}
    }
  }
  return ''
}

module.exports = {
  ENC_PREFIX,
  isEncrypted,
  encryptSecret,
  decryptSecret
}
