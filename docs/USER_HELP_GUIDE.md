# Phone Party User Help Guide

**Everything you need to know to use Phone Party**

Welcome to Phone Party! This guide will help you get started and make the most of your party experience.

---

## 🚀 Quick Start

### For Party Hosts (DJs)

1. **Create a Party**
   - Click "Host Party" on the landing page
   - Choose your tier (Free, Party Pass, or Pro Monthly)
   - Share the party code with your guests

2. **Add Music**
   - Click "Queue Track" or press `Q`
   - Enter the track name
   - Your queue will update automatically

3. **Control Playback**
   - Press `Space` to play/pause
   - Press `N` to skip to next track
   - Press `M` to mute/unmute

4. **End Your Party**
   - Click "End Party" or press `Esc`
   - Confirm when prompted

### For Guests

1. **Join a Party**
   - Click "Join Party" on the landing page
   - Enter the 6-digit party code from your host
   - Your device will sync automatically

2. **Send Reactions**
   - Tap emoji buttons to send reactions to the DJ
   - Your reactions appear on the DJ's screen in real-time

3. **Chat with DJ** (Party Pass/Pro Monthly parties only)
   - Type your message in the text field
   - Messages auto-disappear after 12 seconds

4. **Leave the Party**
   - Click "Leave Party" to exit

---

## 📱 Device Setup

### Before You Start

- **Connect to WiFi** or use a mobile hotspot for best results
- **Allow audio permissions** when prompted
- **Keep your device charged** (parties can last 2-8 hours)

### WiFi vs Mobile Data

| Connection | Sync Quality | Battery Life | Recommended |
|------------|--------------|--------------|-------------|
| WiFi | ⭐⭐⭐⭐⭐ Excellent | ⭐⭐⭐⭐ Good | ✅ Yes |
| Mobile Hotspot | ⭐⭐⭐⭐ Very Good | ⭐⭐⭐ Fair | ✅ Yes (for host) |
| Mobile Data | ⭐⭐⭐ Good | ⭐⭐ Poor | ⚠️ Backup only |

---

## 🎵 Music Sources

Phone Party **syncs playback across devices** but doesn't provide music. You need to provide your own music from:

- **Local Files**: Music stored on your device
- **Spotify**: Use Spotify web player in another tab
- **YouTube**: Use YouTube in another tab
- **Apple Music**: Use Apple Music web player
- **Any other source** that plays in your browser

**How it works**: The DJ queues tracks by name, and all devices play their local copy in perfect sync.

---

## 🎹 Keyboard Shortcuts (DJ Mode)

| Shortcut | Action |
|----------|--------|
| `Space` | Play/Pause |
| `N` | Next Track |
| `M` | Mute/Unmute |
| `Q` | Queue Track |
| `Esc` | End Party (with confirmation) |

**Note**: Shortcuts only work when you're the DJ (party host).

For more details, see **[docs/KEYBOARD_SHORTCUTS.md](docs/KEYBOARD_SHORTCUTS.md)**.

---

## 💎 Pricing Tiers

### Free Plan

**Perfect for**: Small gatherings with 2 people

- ✅ Up to 2 phones
- ✅ Basic features
- ✅ Music sync
- ❌ Includes ads

**Price**: Free forever

---

### Party Pass 🎉

**Perfect for**: One-time parties with friends

- ✅ Up to 4 phones
- ✅ 2-hour session (single-use)
- ✅ Chat + emoji reactions
- ✅ DJ quick message buttons
- ✅ Guest quick replies
- ✅ Auto party prompts
- ✅ **Party-wide unlock** (all guests get Party Pass features)

**Price**: £3.99 (one-time purchase)

---

### Pro Monthly

**Perfect for**: Regular party hosts and DJs

- ✅ Up to 10 phones
- ✅ Unlimited parties
- ✅ No ads ever
- ✅ Pro DJ mode with visualizers
- ✅ Guest reactions & messaging
- ✅ Up Next queue system
- ✅ Priority sync stability
- ✅ Quality override warnings
- ✅ Speaker support
- ✅ Cancel anytime

**Price**: £9.99/month

---

## 🔧 Troubleshooting

### Music isn't playing

**Solution**:
1. Check that music is playing in your music source (Spotify, YouTube, etc.)
2. Check device volume is not muted
3. Press `Space` to ensure playback isn't paused
4. Refresh the page and rejoin the party

---

### Devices are out of sync

**Symptoms**: Music on one device is ahead/behind others

**Solution**:
1. Wait 2-3 seconds for automatic sync correction
2. If drift persists, tap the "Manual Sync" button (appears when drift >1.5s)
3. Check your internet connection
4. Move closer to your WiFi router

**Why it happens**: Network delays, device performance differences, or background apps.

---

### Can't join party

**Possible Causes**:

**Party Code Not Found**
- Check for typos in the party code
- Ask the host for the correct code
- The party may have ended

**Party Full**
- Free parties are limited to 2 phones
- Party Pass/Pro Monthly allows up to 10 phones
- Host needs to upgrade or someone needs to leave

**Party Expired**
- Free/Party Pass parties last 2 hours
- Pro Monthly parties last 8 hours
- Host needs to create a new party

---

### Guest reactions not working

**Check**:
1. Party must have Party Pass or Pro Monthly tier
2. Guest must be connected to the party
3. Check internet connection
4. Refresh the page

---

### Background audio stops playing

**iOS Safari**:
1. Tap the play button on lock screen
2. Enable "Media Playback" in Settings
3. Keep the tab active in Safari

**Android Chrome**:
1. Enable "Media Playback" notification
2. Use media controls in notification shade

For more details, see **[docs/BACKGROUND_AUDIO.md](docs/BACKGROUND_AUDIO.md)**.

---

## 🎯 Best Practices

### For Hosts

- **Test before the party**: Create a practice party to familiarize yourself
- **Share the code early**: Give guests time to connect
- **Use WiFi**: Mobile hotspot works but drains battery faster
- **Queue tracks in advance**: Keep the music flowing
- **Monitor sync**: Check for sync issues every few tracks

### For Guests

- **Join early**: Connect before music starts to avoid interruptions
- **Stay connected**: Keep Phone Party tab active
- **Don't refresh unnecessarily**: It interrupts your sync
- **Send reactions**: Engage with the DJ to enhance the experience

---

## 📊 Understanding Sync

### How Sync Works

Phone Party uses advanced clock synchronization (similar to NTP) to keep all devices in perfect sync:

1. **Clock Sync**: Devices sync their clocks with the host (±10ms accuracy)
2. **Drift Detection**: Checks sync every 2 seconds
3. **Auto-Correction**: Automatically corrects drift <1.5 seconds
4. **Manual Sync**: Button appears if auto-correction fails

### Sync Quality Indicators

| Drift | Status | Action |
|-------|--------|--------|
| <200ms | Perfect ✅ | None needed |
| 200-800ms | Good ⚡ | Auto-correcting (soft) |
| 800-1500ms | Fair ⚠️ | Auto-correcting (hard) |
| >1500ms | Poor 🔴 | Manual sync required |

For technical details, see **[docs/SYNC_ARCHITECTURE_EXPLAINED.md](docs/SYNC_ARCHITECTURE_EXPLAINED.md)**.

---

## 💬 Getting Support

### Common Questions

See **[FAQ.md](../FAQ.md)** for answers to:
- How does Phone Party work on Android?
- How does it compare to AmpMe?
- Can I use it without an internet connection?
- What about privacy and data collection?

### Report a Bug

1. Check **[GitHub Issues](https://github.com/evansian456-alt/syncspeaker-prototype/issues)** to see if it's already reported
2. If not, open a new issue with:
   - What you were doing
   - What happened
   - What you expected
   - Device and browser info

### Feature Requests

We love feature ideas! Open a **[GitHub Discussion](https://github.com/evansian456-alt/syncspeaker-prototype/discussions)** to share your suggestions.

---

## 📚 Learn More

- **[README.md](../README.md)** - Project overview and technical details
- **[docs/ADD_ONS_USER_GUIDE.md](ADD_ONS_USER_GUIDE.md)** - Complete guide to add-ons
- **[docs/SYNC_ARCHITECTURE_EXPLAINED.md](SYNC_ARCHITECTURE_EXPLAINED.md)** - How sync works
- **[docs/EMOJI_REACTION_SYSTEM.md](EMOJI_REACTION_SYSTEM.md)** - Reaction system details

---

## 🎉 Have Fun!

Phone Party is designed to make your gatherings more fun and engaging. Experiment with features, share reactions, and enjoy the synchronized music experience!

---

**Last Updated**: February 16, 2026  
**Version**: 1.0  
**For**: End users
