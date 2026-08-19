# Abyss Bridge (XenForo addon)

XF-side counterpart to the `XenForoBridgeService` / `XenForoController` in the Abyss API. Handles:

- The browser-side **link flow** (`GET /abyss/link/start`) — proves XF identity to Abyss via a short-lived HS256 JWT.
- The server-to-server **thread creation API** (`POST /api/abyss/threads`) — Abyss posts a chat-range digest to a forum, mixing "real" posts (as linked XF users) and "ghost" posts (as a configured service user, with the original Abyss display name + avatar shown inline).

## Requirements

- XenForo 2.2.0+
- PHP 7.4+
- A XenForo API key with super-user scope (created in Admin CP → Setup → API keys).
- A dedicated XF user account to author **ghost** posts (a regular user account; messages from unlinked Abyss authors are posted as this user with their original name/avatar shown in the post body).

## Install

1. Copy `src/addons/Abyss/Bridge/` into your XF install at `src/addons/Abyss/Bridge/`.
2. Admin CP → **Add-ons** → install **Abyss Bridge**. The option group, three options, routes, and phrases are imported automatically from `_data/*.xml`.
3. Set the three options in Admin CP → **Setup → Options → Abyss Bridge**:
   - **Shared secret** — must match `XENFORO_SHARED_SECRET` on the Abyss server.
   - **Abyss API base URL** — full origin of the Abyss API, e.g. `https://abyss.example.com`. Only `return_url`s under this host are accepted in the link flow.
   - **Ghost user ID** — the XF user ID that ghost posts are authored as.
4. Admin CP → Setup → API keys → create a **Super user** key. Set it as `XENFORO_ADMIN_API_KEY` on the Abyss server.

## Abyss-side env vars (must match)

```
XENFORO_BASE_URL=https://forum.example.com
XENFORO_ADMIN_API_KEY=<super-user key from Admin CP>
XENFORO_SHARED_SECRET=<same string as the "Shared secret" option above>
```

## What the endpoints do

### `GET /abyss/link/start?nonce=N&return_url=R`

- If the visitor isn't logged in, bounces through XF's login with this URL as the post-login redirect.
- Validates `return_url` is on the configured Abyss host.
- Signs an HS256 JWT with claims:
  `iss=xenforo`, `aud=abyss`, `sub=<xf user id>`, `abyss_link_nonce=<N>`, `xf_username=<name>`, `nbf`, `exp` (5 min TTL).
- Redirects to `R?token=<jwt>`. Abyss's `LinkCallback` verifies the JWT against the same shared secret and creates the `XenForoConnection` record.

### `POST /api/abyss/threads`

Headers: `XF-Api-Key: <super-user key>`

Body:

```json
{
  "node_id": 12,
  "title": "Cool thread",
  "posts": [
    { "mode": "real",  "xf_user_id": 42, "bbcode": "First message..." },
    { "mode": "ghost", "abyss_user_id": "abc-123",
      "display_name": "Alice",
      "avatar_url": "https://abyss.example.com/uploads/a.png",
      "bbcode": "..." }
  ]
}
```

Returns `{ "thread_id": 1234, "url": "https://forum.example.com/threads/cool-thread.1234/" }`.

The first post becomes the thread OP. Ghost posts are authored by the configured ghost user with a small BBCode header showing the original Abyss author's name (and avatar, if provided).

### `GET /abyss-shoutbox`

The iframe target for the embeddable shoutbox. Embed it in any XF template:

```html
<iframe src="{{ link('abyss-shoutbox') }}" class="abyssShoutbox"
        style="width:100%;height:480px;border:0;border-radius:8px"></iframe>
```

- For a **logged-in** visitor: mints a short-lived HS256 JWT
  (`iss=xenforo`, `aud=abyss`, `token_use=shoutbox`, `sub=<xf user id>`,
  `xf_username`, `display_name`, `avatar_url`, `xf_is_banned`, `nbf`, `exp`)
  and redirects the iframe to `{abyssBase}/widget.html#token=<jwt>`. The token
  rides in the URL fragment so it never lands in a server access log.
- For a **guest**: redirects to `{abyssBase}/widget.html` with no token; the
  widget renders its own "log in to chat" placeholder.

The Abyss widget reads the token from `location.hash` and exchanges it at
`POST /api/xenforo/shoutbox/session`, which find-or-creates a persistent
forum-backed Abyss user (keyed to the XF user id), confines it to the
dedicated shoutbox server, and issues an Abyss session.

#### Abyss-side setup (one-time)

1. Create a dedicated **Shoutbox** server in Abyss with a single text channel.
   Lock its `@everyone` role to only `ViewChannel + ReadMessageHistory +
   SendMessages + AddReactions` (no management perms) so forum users are
   contained to that one channel.
2. Set two `AppConfigs` rows on the Abyss DB: `ShoutboxServerId` and
   `ShoutboxChannelId` (the GUIDs of that server/channel).
3. Set `SHOUTBOX_FRAME_ANCESTORS=https://forum.example.com` on the Abyss
   server (defaults to `XENFORO_BASE_URL` if unset) so `/widget.html` sends a
   `Content-Security-Policy: frame-ancestors` header allowing the forum to
   frame it.

## Notes / gotchas

- The Abyss client opens `/api/xenforo/link/start` with `?access_token=<jwt>&return=<abyss-client-url>`. The Abyss API forwards to this addon's `/abyss/link/start` with its own `nonce` + a `return_url` pointing back at the Abyss API's `LinkCallback`. Abyss's callback then redirects back to the original Abyss client URL with `?linked=1`.
- The shared secret protects the link JWT only — it is not used by `POST /api/abyss/threads`. That endpoint is protected solely by XF's standard API key auth.
- Routes/options/API endpoints are installed by XF from the `_data/*.xml` files; `Setup.php` is a thin placeholder. If you change any of those XML files, re-run the add-on installer or use `xf:addon-rebuild` to refresh.
- The `actionClaim` reverse-flow stub (`GET /abyss/link/claim`) is included but not wired into anything by default. Extend it if you want the XF account to also persist the Abyss-side identity.

## Layout

```
src/addons/Abyss/Bridge/
├── addon.json
├── Setup.php
├── Util/Jwt.php                    # HS256 sign/verify, no deps
├── Pub/Controller/Link.php         # /abyss/link/start, /abyss/link/claim
├── Pub/Controller/Shoutbox.php     # /abyss-shoutbox (embeddable chat iframe)
├── Api/Controller/Threads.php      # POST /api/abyss/threads
└── _data/
    ├── routes.xml          # public + api routes in one file
    ├── options.xml
    ├── option_groups.xml
    └── phrases.xml         # group/option titles + descriptions
```
