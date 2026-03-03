# App Navigation Flow

## Overview

Phone Party is a single-page application (SPA) that uses the **History API** (`pushState` /
`replaceState`) for navigation. All screen transitions are handled by showing and hiding
`<section>` elements in `index.html` without full page reloads.

A lightweight router in `router.js` enforces auth-gated routes and keeps the browser URL
in sync so that **back/forward navigation** and **deep-link / refresh** work correctly.

---

## Screens (View IDs)

| View ID            | URL Path        | Who can see it                     |
|--------------------|-----------------|-------------------------------------|
| `viewLanding`      | `/`             | Logged-out users only               |
| `viewLogin`        | `/login`        | Logged-out users only               |
| `viewSignup`       | `/signup`       | Logged-out users only               |
| `viewChooseTier`   | *(modal-like)*  | During account creation flow        |
| `viewAccountCreation` | *(modal-like)* | During account creation flow      |
| `viewCompleteProfile` | *(modal-like)* | Logged-in, profile not yet saved  |
| `viewAuthHome`     | `/home`         | Logged-in users — Create or Join hub |
| `viewHome`         | *(internal)*    | Legacy unauthenticated home (still used for the actual create/join forms) |
| `viewParty`        | `/party/:code`  | Active host party session           |
| `viewGuest`        | `/party/:code`  | Active guest party session          |
| `viewPayment`      | *(modal-like)*  | During payment flow                 |
| `viewProfile`      | `/account`      | Logged-in users                     |
| `viewUpgradeHub`   | *(overlay)*     | Logged-in users                     |

---

## Navigation Flows

### Logged-out entry

```
User visits /  →  initAuthFlow() → /api/me returns 401
                  → showLanding()  (URL: /)
```

### Direct deep-link when logged out

```
User visits /home  →  router._renderRoute('/home')
                   →  isLoggedIn() === false
                   →  replaceState('/')  →  showLanding()
```

### Login

```
Landing  →  "Log In" button  →  viewLogin
  →  handleLogin()  →  logIn(email, pwd)  →  success
  →  initAuthFlow()  →  /api/me returns user
  →  navigate('/home', { replace: true })
  →  viewAuthHome + initPartyHomeView()
```

### After login / app refresh while authenticated

```
Any path  →  initAuthFlow() → /api/me returns user
           →  navigate('/home', { replace: true })
           →  viewAuthHome
```

### Signup

```
Landing  →  "Get Started" button  →  viewSignup
  →  handleSignup()  →  success
  →  initAuthFlow()  →  profile not complete?
       yes → viewCompleteProfile
       no  → navigate('/home')
```

### Profile completion

```
viewCompleteProfile  →  form submit  →  /api/complete-profile
  →  success  →  navigate('/home', { replace: true })
  →  viewAuthHome
```

### Join/Create party (from authenticated home hub)

```
viewAuthHome  →  "Create Party" button
  →  showHome()  (opens legacy viewHome with create form)
  →  user fills form + clicks "Start the party"
  →  POST /api/create-party
  →  WS JOIN event  →  showParty()
  →  URL pushed: /party/:code

viewAuthHome  →  "Join Party" button
  →  showHome()  (opens legacy viewHome with join form)
  →  user fills code + name + clicks "Join the vibe"
  →  POST /api/join-party
  →  WS JOIN_ACK  →  showGuest()
  →  URL pushed: /party/:code
```

### Inside a party

```
Host:   viewParty  (URL: /party/:code)
Guest:  viewGuest  (URL: /party/:code)
```

### Back button from party → home

```
Browser back  →  popstate  →  _renderRoute('/home')
              →  isLoggedIn() === true
              →  showView('viewAuthHome') + initPartyHomeView()
```

### Refresh while in party

```
User refreshes /party/ABC123
  →  router._bootRouter()  →  popstate registered
  →  app init: initAuthFlow() → /api/me → user found
  →  router._renderRoute('/party/ABC123')
  →  partyCode = 'ABC123'
  →  state.code = 'ABC123'
  →  showParty()  (restores party screen)
```

### Logout

```
Header "🚪" button  →  handleLogout()
  →  logOut() (clears cookie + localStorage)
  →  headerAuthButtons hidden
  →  navigate('/', { replace: true })
  →  viewLanding
```

---

## State Storage

| Key | Storage | Purpose |
|-----|---------|---------|
| `syncspeaker_current_user` | `localStorage` | Cached user object (email, tier, djName) |
| `syncSpeakerGuestSession` | `localStorage` | Guest session for auto-reconnect |
| `lastPartyCode` | `localStorage` | Last joined party code (for rejoin) |
| `lastGuestName` | `localStorage` | Last guest nickname |
| `audioUnlocked` | `localStorage` + `sessionStorage` | Audio autoplay unlock state |
| `partyPass_<code>` | `localStorage` | Party Pass activation state |

---

## Router Module (`router.js`)

### API

```js
// Navigate to a path (adds to history by default)
navigate('/home');
navigate('/home', { replace: true });  // replaceState

// Internal: render the correct screen for a path
_renderRoute('/party/ABC123');

// Utility helpers (also exported for tests)
_isProtected('/home');         // → true
_partyCodeFromPath('/party/ABC123');  // → 'ABC123'
```

### Route Guards

- **Unauthenticated user → protected path**: forced to `/` (landing)
- **Authenticated user → `/` or `/login`**: redirected to `/home`

---

## Official App Sync (Host-only, paid tiers)

- **FREE**: sync UI hidden completely
- **PARTY_PASS / PRO (host)**: sync UI shown with platform select + track ref input
  - Pasting a YouTube / Spotify / SoundCloud URL **auto-detects** the platform
- **Guests**: receive `OFFICIAL_APP_SYNC` WS event → "Now synced" panel + "Open in App" button
