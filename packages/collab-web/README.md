# @oh-my-pi/collab-web

The page a person opens from Oz's "Watch or steer live" button: a live Oz run in the browser, with the transcript, tool calls, subagents, and (with a steer link) a composer that prompts, answers or interrupts the run. Built on [the collab protocol](../../docs/collab.md).

## Design directions

`src/directions/` holds several designs of the same page, built for the owner to compare. Each is a `Direction` (`types.ts`): its own tokens for light and dark and an `App` that renders the shared `GuestSnapshot`. The shell (`app.tsx`) owns the connection, the link and the actions; a direction never touches the socket, codec or URL fragment. `kit/` is shared: tool classification, diff parsing, markdown/code/diff views, steering rules, words. `theme-seam.ts` is the customer theme: a fixed set of validated overrides (`accent`, `accent-ink`, `surface`, `ink`, `radius`, `font-ui`, name, logo, default mode) laid over a direction's tokens.

```sh
# the real Oz run (last turn replays live), stress content, gallery's fixed room
bun scripts/mock-host.ts --port 4766 --dev-room --session /path/to/oz-session.jsonl --stress
bun run gallery                     # http://localhost:4767/src/gallery
# one direction directly: http://localhost:4767/?direction=claude#<link printed by the mock host>
bun scripts/shots.ts claude         # screenshots via the shared Chromium on :9223
```

`?direction=`, `?mode=`, `?theme=harbour` and `?preview=waiting|reconnecting|ended` work in dev and gallery builds only. `bun run build` swaps in `registry.prod.ts` and `selection.prod.ts`: classic alone, query ignored. In a steer composer against the mock host, `/ask`, `/ask text` and `/end` raise a question or end the session for you.

## Quick start

```sh
# dev server (Bun HTML dev server with HMR)
bun run dev

# offline demo: local relay + scripted mock host; prints a ws://localhost link
bun run mock-host
```

Host a session from any omp instance (`/collab`, or `/collab ws://localhost:7466` to use the mock relay), then paste the printed link into the connect screen. Deep links work too: `http://localhost:3000/#<roomId>.<key>` auto-connects on load.

## Build & deploy

```sh
bun run build   # static site in dist/
```

`dist/` is a fully static SPA — host it anywhere. JS/CSS bundles are content-hashed; favicons, `manifest.webmanifest` and `robots.txt` come from `public/` and are emitted at the site root under stable names. A join page carries a room key, so it is `noindex` and sends no referrer, and it loads no third-party script. Two runtime requirements:

- **Secure context**: room keys are unwrapped with WebCrypto (`crypto.subtle`), which browsers expose only on `https://` or `localhost`.
- **Relay reachability**: the client connects straight to the relay over WebSocket (`wss://` for anything that isn't localhost). The default relay is `wss://my.omp.sh`; bare `<roomId>.<key>` links resolve against it (legacy `<roomId>#<key>` and `%23`-mangled links still parse).

The room key never leaves the URL fragment — it is not sent to the relay or any server.

## Architecture

- `src/lib/` — vendored wire codec (`codec.ts` AES-256-GCM, `link.ts` envelope + link grammar), `socket.ts` reconnecting relay socket, `client.ts` guest session store (`GuestClient` + immutable snapshots for `useSyncExternalStore`). Shared protocol shapes come from `@oh-my-pi/pi-wire`.
- `src/components/` — `transcript/` (entries, markdown, tool cards), `agents/` (panel + transcript drawer), `shell/` (connect screen, header, composer, banners, toasts).
- `src/tool-render/` — per-tool React renderers shared with coding-agent HTML session exports: one view per built-in tool, common `ToolView` chrome, theme-adaptive `tv-` design tokens, and an `<omp-tool-view>` web-component wrapper. The `ToolRenderHost` seam lets hosts wire agent-id chips to a sub-session view (drawer here, sidebar navigation in exports).
- `scripts/` — `local-relay.ts` (content-blind relay on `Bun.serve`), `mock-host.ts` + `fixture.ts` (scripted host for offline dev), `build-export-viewer.ts` (bundles the tool/trace renderers, React, export shell and styles into a content-addressed JS file under `packages/coding-agent/export-assets/`; release CI publishes it to `build.stencil.so`).

The package is intentionally standalone — no dependency on `@oh-my-pi/pi-coding-agent` at runtime or type level. Wire-shape drift is prevented by consuming the same `@oh-my-pi/pi-wire` contracts as the host, with sealed-frame interop still covered by `test/codec.test.ts`.
