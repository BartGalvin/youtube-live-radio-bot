# YouTube live radio bot

A local-first YouTube chat bot and OBS browser overlay for live audio streams.
Station branding, channel names, the optional now-playing adapter, YouTube credentials,
and the database location are runtime configuration, so the tracked project can
be reused without publishing a station's private setup.

The bot does not fetch, relay, decode, or transcode the audio. OBS owns the
actual audio input, which may be Icecast, HLS, a local mixer or sound device,
audio embedded in a video source, or any other input OBS supports.

The bot provides:

- `!song`, `!votes`, `!help`, `!like`, and `!dislike` chat commands
- configurable role requirements for voting
- per-channel, per-playback vote persistence in SQLite
- paid-message and membership alerts for the overlay
- provider-neutral now-playing metadata through an HTTP endpoint
- optional Radio.co metadata polling as one adapter
- automatic discovery of the authorized account's active YouTube broadcast
- a local simulator and control room for testing without YouTube

## Requirements

- Node.js 22.9 or newer
- OBS for production use
- a Google Cloud OAuth client when YouTube integration is enabled

## Local setup

```bash
npm install
cp .env.example .env
npm run dev
```

Open:

- control room: `http://127.0.0.1:8080/control`
- overlay: `http://127.0.0.1:8080/overlay`

The `.env` file is ignored by Git. Put the station-specific configuration and
credentials there. The checked-in `.env.example` is intentionally generic.

Use the control room to start a simulated track, submit chat commands, and show
a paid-message alert. Starting a new playback instance resets the displayed
vote count because votes are attached to that playback, not only to a title.

## Station and channel configuration

One station can expose one or more logical channels:

```dotenv
APP_NAME=Example Radio Bot
BRAND_NAME=Example Radio
CHANNELS=main,secondary
CHANNEL_LABELS=main=Example Radio,secondary=Example Radio Two
DEFAULT_CHANNEL_ID=main
DATABASE_PATH=./data/example-radio.sqlite
```

Channel IDs are internal URL-safe identifiers. Labels are public display names.
The overlay URL can select a channel explicitly:

```text
http://127.0.0.1:8080/overlay?channel=main
```

If the URL omits `channel`, the overlay uses `DEFAULT_CHANNEL_ID`.

## Audio and now-playing inputs

Audio and track metadata are separate inputs. Configure the audio directly in
OBS. The bot only needs metadata so that chat commands, votes, and the overlay
know which playback is active.

The HTTP input is always available and makes no assumptions about the audio
service. Any station automation system or small bridge can update the active
playback:

```bash
curl -X POST http://127.0.0.1:8080/api/now-playing \
  -H 'content-type: application/json' \
  -d '{
    "channelId": "main",
    "id": "playback-12345",
    "artist": "Talking Heads",
    "title": "This Must Be the Place",
    "startedAt": "2026-10-24T16:30:00Z"
  }'
```

The `id` should identify one playback, not just one recording. Replaying a song
later should use a new ID so its votes begin at zero. If the server is exposed
beyond localhost, protect this endpoint with `ADMIN_TOKEN`.

### Radio.co adapter

To have the bot poll Radio.co directly, enable the optional adapter and map logical
channels to public Radio.co station IDs:

```dotenv
NOW_PLAYING_ADAPTER=radioco
NOW_PLAYING_POLL_INTERVAL_MS=10000
RADIOCO_STATIONS=main=s123456789,secondary=sabcdef012
```

Multiple channels may point to the same station ID. The adapter fetches each
shared station once per polling interval and emits channel-specific state.

Adapter implementations live under `src/now-playing/` behind a common
`NowPlayingAdapter` lifecycle. The neutral contract imports no implementation;
`factory.ts` is the composition point, and Radio.co owns its configuration,
normalization, polling, and validation.

## YouTube setup

1. Create a Google Cloud project and enable YouTube Data API v3.
2. Configure the OAuth consent screen. During testing, add the Google account
   that owns the YouTube channel as a test user.
3. Create a Desktop app OAuth client.
4. Put its client ID and client secret in `.env`.
5. Run `npm run youtube:auth`, open the printed URL, and authorize the YouTube
   channel the bot should use.
6. Copy the returned refresh token into `.env`.

Then configure:

```dotenv
YOUTUBE_ENABLED=true
YOUTUBE_CHANNEL_ID=main
YOUTUBE_CLIENT_ID=...
YOUTUBE_CLIENT_SECRET=...
YOUTUBE_REFRESH_TOKEN=...
YOUTUBE_ENABLE_REPLIES=true
```

Leave `YOUTUBE_BROADCAST_ID` empty for normal operation. The bot discovers the
authorized account's active broadcast, so it continues working when the video
ID changes. Set a broadcast ID only if the account can have multiple active live
broadcasts and automatic selection would be ambiguous.

The OAuth app may remain in Google testing mode during development, but testing
refresh tokens can expire. Move the app to the appropriate production or
internal publishing state before depending on it for an unattended 24/7 bot.

## OBS

Add a Browser Source using the overlay URL for the intended channel. Set the
Browser Source dimensions to match the OBS canvas. A browser source on the
shared OBS program canvas appears on every simulcast destination. A
YouTube-only overlay requires a separate scene/output path for YouTube.

## Configuration reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_NAME` | `Live Radio Bot` | Name used by the control page and logs |
| `BRAND_NAME` | `Live Radio` | Public station or network name |
| `HOST` | `127.0.0.1` | HTTP bind address |
| `PORT` | `8080` | HTTP port |
| `DATABASE_PATH` | `./data/live-radio-bot.sqlite` | Persistent SQLite state |
| `SIMULATOR_ENABLED` | `true` | Enable local simulator endpoints |
| `CHANNELS` | `main` | Comma-separated logical channel IDs |
| `CHANNEL_LABELS` | generated from IDs | Comma-separated `channel=label` values |
| `DEFAULT_CHANNEL_ID` | first configured channel | Channel used when omitted |
| `NOW_PLAYING_ADAPTER` | empty | Optional background adapter; currently `radioco` |
| `NOW_PLAYING_POLL_INTERVAL_MS` | `10000` | Polling interval for pull adapters |
| `RADIOCO_STATIONS` | empty | Comma-separated `channel=station` mappings |
| `YOUTUBE_ENABLED` | `false` | Connect to YouTube live chat |
| `YOUTUBE_CHANNEL_ID` | default channel | Logical channel receiving YouTube events |
| `YOUTUBE_BROADCAST_ID` | empty | Optional fixed broadcast selection |
| `YOUTUBE_ENABLE_REPLIES` | `false` | Post command replies into YouTube chat |
| `VOTE_MINIMUM_ROLE` | `member` | `viewer`, `member`, `moderator`, or `owner` |
| `ADMIN_TOKEN` | empty on localhost | Protect state-changing HTTP endpoints |

`ADMIN_TOKEN` is required when `HOST` is not `127.0.0.1` or `localhost`.

## Validation

```bash
npm test
npm run typecheck
npm run build
```

With the service running, `npm run smoke` exercises health, track updates,
votes, channel isolation when multiple channels exist, paid alerts, and the
overlay endpoint.

Copyright (c) 2026 Bartholomew Galvin
