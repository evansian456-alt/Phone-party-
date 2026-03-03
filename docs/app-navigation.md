# App Navigation Flow

This document describes the screen-flow and routing behaviour of the Phone Party SPA.

## Screens (HTML sections)

| View ID | Route | Auth | Description |
|---|---|---|---|
| `viewLanding` | `/` | Public | Landing/marketing page with Get Started & Log In CTAs |
| `viewLogin` | `/login` | Logged-out only | Email + password login form |
| `viewSignup` | `/signup` | Logged-out only | Registration form (email, password, DJ name) |
| `viewCompleteProfile` | *(transient)* | Logged-in | First-time profile completion (DJ name) |
| `viewAuthHome` | `/home` | Logged-in | **Main hub** — Create Party / Join Party after authentication |
| `viewParty` | `/party/:code` | Logged-in | Live party room (host controls + guest list) |
| `viewGuest` | *(deep-linked)* | Any | Guest listening view |
| `viewChooseTier` | *(inline flow)* | Any | Tier/plan selector |
| `viewAccountCreation` | *(inline flow)* | Any | New account setup wizard |
| `viewProfile` | `/account` | Logged-in | User profile, stats, DJ rank |
| `viewUpgradeHub` | *(modal-like)* | Any | Upgrade / subscription options |
| `viewPayment` | *(inline flow)* | Any | Payment processing |

## State Storage

| Key | Store | Contents |
|---|---|---|
| `syncSpeakerGuestSession` | localStorage | `{ partyCode, guestId, nickname, joinedAt }` — auto-reconnect data |
| `lastPartyCode` | localStorage | Last party code joined (for pre-filling join form) |
| `lastGuestName` | localStorage | Last nickname used (for pre-filling join form) |
| `audioUnlocked` | localStorage + sessionStorage | Whether the user has unlocked audio playback |
| `CURRENT_USER_KEY` (`syncspeaker_current_user`) | localStorage | Cached user data from `/api/me` |
| `monetization_${email}` | localStorage | Owned visual packs, titles, subscription status |
| `partyPass_${code}` | localStorage | Active Party Pass state for the current party |

Auth tokens are stored in **HTTP-only cookies** by the backend.  The frontend does **not** hold the raw JWT.

## Navigation Flows

### Logged-out entry (`/`)
1. Browser opens `/`
2. `initAuthFlow()` calls `GET /api/me` → `401`
3. `showLanding()` is called → shows `viewLanding`
4. URL remains `/` (router sets it via `replaceState`)

### Login
1. User taps **LOG IN** on landing → `showView('viewLogin')`
2. Fills credentials → `handleLogin()` → `POST /api/auth/login`
3. On success → `initAuthFlow()` is called again
4. `GET /api/me` now returns `200` with user data
5. If `profileCompleted=true` → router navigates to `/home`, shows `viewAuthHome`
6. If `profileCompleted=false` → shows `viewCompleteProfile`

### After login (profile already complete)
1. `viewAuthHome` is shown
2. Header icons appear (connection indicator, profile, upgrade, etc.)
3. URL is `/home`
4. Browser Back → router `popstate` handler → resolves to `/home` for logged-in user

### Register / New user
1. User taps **GET STARTED FREE** → `showView('viewSignup')`
2. Fills form → `handleSignup()` → `POST /api/auth/signup`
3. On success → `initAuthFlow()` → profile not yet completed → `viewCompleteProfile`
4. User enters DJ name → `POST /api/complete-profile`
5. On success → navigate `/home`, show `viewAuthHome`

### Join/Create party
1. From `viewAuthHome`, user taps **CREATE PARTY** or **JOIN PARTY**
2. The relevant form section inside `viewAuthHome` expands
3. After successful creation/join:
   - Host → `showParty()` → `viewParty`, URL `/party/:code`
   - Guest → `showGuest()` → `viewGuest`

### Inside party (`/party/:code`)
- URL is `/party/XXXXXX` (pushed via `navigate()` in `showParty()`)
- Page refresh: router resolves `/party/XXXXXX` → `viewParty` (for logged-in users)
- Leaving party → `showHome()` or `showLanding()` based on auth state

### Logout
1. User clicks logout button in profile or header
2. `handleLogout()` → `POST /api/auth/logout` → clears cookie
3. Router navigates to `/` → `showLanding()`
4. Header icons hidden

## Router (`router.js`)

The app uses a lightweight History API router (no framework):

- **`navigate(path, opts)`** — calls `history.pushState` / `replaceState`
- **`resolvePath(path, isAuthenticated)`** — pure function, returns `{ path, view, params }` after applying guards
- **`checkGuard(route, isAuthenticated)`** — pure function, returns `{ allowed, redirect }`
- **`initRouter(onNavigate, getAuthState)`** — wires up `window.addEventListener('popstate', ...)`

### Auth guard rules
| Route | Rule |
|---|---|
| `/` | Public; if logged-in → redirect to `/home` |
| `/login`, `/signup` | Logged-out only; if logged-in → redirect to `/home` |
| `/home`, `/party/:code`, `/account` | Logged-in only; if logged-out → redirect to `/` |

## Official App Sync

- **Host only** (PARTY_PASS / PRO tier): Platform selector + track URL/ID input + "Sync Track" button
- **Guests**: When host syncs a track, guests see a "Now synced" panel with platform name, track ref, and "Open in App" deep-link button
- **FREE tier**: Official App Sync UI hidden entirely
- Compliance text always shown when the section is visible
