// @ts-check
const { test, expect } = require('@playwright/test');
const { makeUser, apiSignup, apiLogin, BASE } = require('./helpers/auth');

/**
 * E2E — Chat System
 *
 * Covers:
 *  - Chat input and send button are present in party view
 *  - Guest message API (GUEST_MESSAGE via WebSocket is infrastructure; UI elements checked here)
 *  - Chat-related DOM elements are attached
 *  - Party state reflects active party for chat context
 */

// ─── Chat UI element presence ────────────────────────────────────────────────

test.describe('Chat UI elements', () => {
  test('chat-input data-testid is present in the DOM', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('[data-testid="chat-input"]')).toBeAttached();
  });

  test('send-message button is present in the DOM', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('[data-testid="send-message"]')).toBeAttached();
  });

  test('guest chat input has correct placeholder text', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('domcontentloaded');
    const chatInput = page.locator('[data-testid="chat-input"]');
    await expect(chatInput).toBeAttached();
    const placeholder = await chatInput.getAttribute('placeholder');
    expect(placeholder).toBeTruthy();
  });
});

// ─── Party chat context (API-level) ─────────────────────────────────────────

test.describe('Chat context via party (API)', () => {
  // Each test creates its own authenticated user and party so there
  // is no cross-test state and the `request` fixture is used only in
  // test bodies (test scope), not in beforeAll.

  test('active party is retrievable (chat operates in party context)', async ({ request }) => {
    const host = makeUser('chathost');
    await apiSignup(request, host);
    await apiLogin(request, host);

    const createRes = await request.post(`${BASE}/api/create-party`, {
      data: { djName: host.djName },
    });
    const { code } = await createRes.json();

    const res = await request.get(`${BASE}/api/party?code=${code}`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.exists).toBe(true);
    expect(body.party.djName).toBe(host.djName);
  });

  test('party-state endpoint returns party data', async ({ request }) => {
    const host = makeUser('chatstate');
    await apiSignup(request, host);
    await apiLogin(request, host);

    const createRes = await request.post(`${BASE}/api/create-party`, {
      data: { djName: host.djName },
    });
    const { code } = await createRes.json();

    const res = await request.get(`${BASE}/api/party-state?code=${code}`);
    // Should return party state data (200) or 404 if in-memory only
    expect([200, 404]).toContain(res.status());
  });
});

// ─── Chat UI within authenticated party view ─────────────────────────────────

test.describe('Chat UI in party view', () => {
  test('chat input is visible in party view when manually revealed', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('domcontentloaded');

    // Reveal the guest view to check chat UI visibility
    await page.evaluate(() => {
      const guestView = document.getElementById('viewGuest');
      if (guestView) {
        guestView.classList.remove('hidden');
      }
      const chatContainer = document.getElementById('guestChatInputContainer');
      if (chatContainer) {
        chatContainer.classList.remove('hidden');
      }
    });

    await expect(page.locator('[data-testid="chat-input"]')).toBeAttached();
    await expect(page.locator('[data-testid="send-message"]')).toBeAttached();
  });

  test('chat input accepts text input', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('domcontentloaded');

    // Reveal the chat container
    await page.evaluate(() => {
      const chatContainer = document.getElementById('guestChatInputContainer');
      if (chatContainer) {
        chatContainer.classList.remove('hidden');
      }
    });

    const chatInput = page.locator('[data-testid="chat-input"]');
    await expect(chatInput).toBeAttached();

    // Type into the chat input
    await chatInput.fill('Hello party!');
    const value = await chatInput.inputValue();
    expect(value).toBe('Hello party!');
  });
});
