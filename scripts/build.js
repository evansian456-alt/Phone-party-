#!/usr/bin/env node
/**
 * build.js — Minimal static build for Capacitor (npm run build)
 *
 * Copies the static front-end files (index.html, app.js, styles.css, etc.)
 * into the `dist/` folder that capacitor.config.json points to as `webDir`.
 *
 * This is a plain Node.js script — no bundler required.  The backend
 * (server.js) is NOT included; Capacitor wraps the static shell and
 * talks to the Cloud Run backend via the URL in capacitor.config.json.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

/** Files / directories to copy into dist/. */
const ENTRIES = [
  'index.html',
  'app.js',
  'config.js',
  'router.js',
  'styles.css',
  'manifest.json',
  'service-worker.js',
  'auth.js',
  'auth-utils.js',
  'payment-client.js',
  'visual-stage.js',
  'moderation.js',
  'network-accessibility.js',
  'qr-deeplink.js',
  'sync-status-ui.js',
  'referral-ui.js',
  'sync-client.js',
  'media-session.js',
  'icons',
  'ui',
  'public'
];

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      copyRecursive(path.join(src, child), path.join(dest, child));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// Clean + recreate dist/
if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

let copied = 0;
for (const entry of ENTRIES) {
  const src = path.join(ROOT, entry);
  if (!fs.existsSync(src)) continue; // skip optional entries
  copyRecursive(src, path.join(DIST, entry));
  copied++;
}

console.log(`[build] dist/ ready — copied ${copied} entries.`);
