/**
 * billing/products.js
 * Server-side product catalog.
 * Single source of truth for all purchasable products across platforms.
 *
 * Products include:
 *   - party_pass        – one-time purchase granting PARTY_PASS tier
 *   - pro_monthly       – subscription granting PRO tier
 *   - extra_songs_5     – addon: +5 upload slots for current party
 *   - extra_songs_10    – addon: +10 upload slots for current party
 *   - extra_songs_20    – addon: +20 upload slots for current party
 *
 * Extra-song addons are party-scoped and only available to PARTY_PASS holders.
 * Addon bundle details (songs, price) are kept in sync with upload-config.js.
 */

'use strict';

const { ADDON_BUNDLES } = require('../upload-config');

const PRODUCTS = {
  party_pass: {
    key: 'party_pass',
    type: 'one_time',
    stripe: {
      priceId: process.env.STRIPE_PRICE_ID_PARTY_PASS || 'price_1T730tK3GhmyOKSB36mifw84'
    },
    apple: {
      productId: 'com.houseparty.partypass'
    },
    google: {
      productId: 'com.houseparty.partypass'
    },
    entitlement: {
      tier: 'PARTY_PASS'
    }
  },
  pro_monthly: {
    key: 'pro_monthly',
    type: 'subscription',
    stripe: {
      priceId: process.env.STRIPE_PRICE_ID_PRO_MONTHLY || 'price_1T733rK3GhmyOKSBsghjQPUZ'
    },
    apple: {
      productId: 'com.houseparty.pro.monthly'
    },
    google: {
      productId: 'com.houseparty.pro.monthly'
    },
    entitlement: {
      tier: 'PRO'
    }
  },

  // ── Extra-song addon bundles (Party Pass holders only, party-scoped) ──────
  extra_songs_5: {
    key: 'extra_songs_5',
    type: 'addon',
    stripe: {
      priceId: ADDON_BUNDLES.extra_songs_5.stripePriceId
    },
    entitlement: {
      type: 'addon',
      addonKey: 'extra_songs_5',
      extraSongs: ADDON_BUNDLES.extra_songs_5.songs,
    }
  },
  extra_songs_10: {
    key: 'extra_songs_10',
    type: 'addon',
    stripe: {
      priceId: ADDON_BUNDLES.extra_songs_10.stripePriceId
    },
    entitlement: {
      type: 'addon',
      addonKey: 'extra_songs_10',
      extraSongs: ADDON_BUNDLES.extra_songs_10.songs,
    }
  },
  extra_songs_20: {
    key: 'extra_songs_20',
    type: 'addon',
    stripe: {
      priceId: ADDON_BUNDLES.extra_songs_20.stripePriceId
    },
    entitlement: {
      type: 'addon',
      addonKey: 'extra_songs_20',
      extraSongs: ADDON_BUNDLES.extra_songs_20.songs,
    }
  },
};

/**
 * Get product by key.
 * @param {string} key - product key (e.g. 'party_pass', 'pro_monthly', 'extra_songs_5')
 * @returns {object|null}
 */
function getProduct(key) {
  return PRODUCTS[key] || null;
}

/**
 * Find a product by its platform-specific productId.
 * @param {string} provider - 'apple' | 'google'
 * @param {string} productId
 * @returns {object|null}
 */
function getProductByPlatformId(provider, productId) {
  for (const product of Object.values(PRODUCTS)) {
    if (product[provider] && product[provider].productId === productId) {
      return product;
    }
  }
  return null;
}

/**
 * Find a product by its Stripe price ID.
 * @param {string} stripePriceId
 * @returns {object|null}
 */
function getProductByStripePriceId(stripePriceId) {
  for (const product of Object.values(PRODUCTS)) {
    if (product.stripe && product.stripe.priceId === stripePriceId) {
      return product;
    }
  }
  return null;
}

module.exports = { PRODUCTS, getProduct, getProductByPlatformId, getProductByStripePriceId };
