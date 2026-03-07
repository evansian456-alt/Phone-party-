'use strict';

/**
 * Shared input-validation helpers.
 *
 * These lightweight utilities are used by controllers and route handlers to
 * validate request inputs before passing them to the service layer.
 */

/**
 * Ensure a value is a non-empty string.
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Ensure a value is a safe string within the specified length limit.
 * @param {unknown} value
 * @param {number} [maxLength=255]
 * @returns {boolean}
 */
function isSafeString(value, maxLength = 255) {
  return (
    isNonEmptyString(value) &&
    value.trim().length <= maxLength
  );
}

/**
 * Ensure a value is a valid email address (basic structural check).
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidEmail(value) {
  if (typeof value !== 'string') return false;
  // Simple RFC 5322-like check — full validation is done on the backend DB layer.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Return a sanitised copy of `text` with leading/trailing whitespace removed
 * and control characters stripped.
 * @param {string} text
 * @returns {string}
 */
function sanitizeText(text) {
  if (typeof text !== 'string') return '';
  // Strip ASCII control characters except newlines and tabs
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
}

module.exports = {
  isNonEmptyString,
  isSafeString,
  isValidEmail,
  sanitizeText,
};
