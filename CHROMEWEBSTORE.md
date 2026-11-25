# Chrome Web Store Listing — Audio Player

> Last Updated: 2026-11-25

## Store Listing

**Extension Name**: Audio Player

**Short Description**: FFmpeg-based audio player that supports a wide range of audio codecs

**Detailed Description**:

Audio Player opens local audio and video files in a compact, dedicated player with wide codec support.

Build a playlist by dropping files into the player or using Browse. Play media links from the right-click menu, control playback with keyboard shortcuts, seek and skip, adjust volume, repeat, shuffle, and optionally remember recent tracks for the next launch.

Your preferences and remembered playlist stay on your device. Local files are read only after you grant access, and network media is fetched only from addresses you choose.

Visit the project homepage for documentation, updates, and support.

**Category**: Productivity

**Single Purpose**: Play local files and user-selected media links with broad codec support.

**Primary Language**: English

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon | 128×128 PNG | ✅ Ready | `v2/data/icons/128.png` |
| Screenshot 1 | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 2 | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 3 | 1280×800 or 640×400 | ⬜ Not created | |
| Small Promo Tile | 440×280 | ⬜ Not created | |

### Screenshot Notes

Show the compact player with playback controls, then the extended playlist view with several tracks and the context menu.

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `storage` | permissions | Saves volume, skip length, window layout, and track-history preferences locally. |
| `contextMenus` | permissions | Adds the right-click actions for playing selected media links and changing player preferences. |
| `*://*/*` | host_permissions | Fetches network media from addresses the user chooses to play or prefetch. Media hosts are not restricted to a fixed list. |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No off-device collection.

The extension stores preferences and user-selected track names, URLs, or local file handles locally. It fetches media only from addresses the user chooses. No analytics, telemetry, or developer-controlled server receives playlist or browsing data.

### Data Use Certification

- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL**: [TODO: host and confirm a publicly accessible policy URL before submission]

A policy must explain local preference and playlist storage, permission-gated local file access, user-initiated media requests, retention controls, and a contact method.

## Distribution

**Visibility**: Public
**Regions**: All regions

## Developer Info

**Publisher Name**: [TODO: confirm publisher name]

**Contact Email**: [TODO: confirm public contact email]

**Support URL**: https://github.com/chandler-stimson/audio-player/issues

**Homepage URL**: https://webextension.org/listing/audio-player.html

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 0.2.7 | 2026-11-25 | Keep Previous available for restarting the first or only readable track, including restored and shortened playlists. | Draft |

## Review Notes

### Known Issues / Limitations

- Store screenshots, publisher details, contact email, and the public privacy-policy URL still need confirmation before submission.
- The manifest version remains unchanged until release preparation.

### Rejection History

None recorded.
