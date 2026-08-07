---
date: 2026-08-07T08:42:54+0800
author: fliu56
commit: 42f618b
branch: main
repository: pi-jarvis-sphere (new pi extension; cwd vcc-repo is unrelated)
topic: "Jarvis particle-sphere floating overlay for pi agent, synced to TTS playback"
tags: [research, pi-extension, tui-overlay, tts, animation, lifecycle]
status: ready
last_updated: 2026-08-07T08:42:54+0800
last_updated_by: fliu56
---

# Research: Jarvis particle-sphere floating overlay for pi agent, synced to TTS playback

## Research Question
The user wants to build a "Jarvis" for the pi agent: a floating window containing an animated particle sphere (粒子球). It integrates with pi's existing TTS ("we already have it"). When the TTS plays speech, the particle sphere animates so it looks like it's talking. **Where must it live, how does it observe TTS play/stop, and how is it rendered?**

> ⚠️ The research target is the **pi coding agent itself** (npm package `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/`), NOT the cwd `vcc-repo`. All pi-core paths below are relative to that install root unless prefixed with `~`. User files are absolute under `~/.pi/agent/`.

## Summary
- **Pi has NO built-in TTS.** The "existing TTS" is the user's own extension `~/.pi/agent/extensions/pi-ext-tts-mimo/index.ts` (MiMo chat-completions → `afplay`/`paplay`). It tracks playback only in a module-private `currentPlayer` (`index.ts:79`) and exposes **no play/stop signal** to anything else.
- **Decision (developer, this session): V1 = in-terminal floating overlay; V2 (future) = external window.** Pi is a terminal TUI app with **no real desktop floating-window surface** (`dist/modes/rpc/` has no socket; `docs/windows.md` is Windows-OS; `docs/tmux.md` is only extended-key forwarding). A "floating window" inside pi = a `custom({overlay:true})` non-capturing overlay (`dist/core/extensions/types.d.ts:117-127`).
- **The overlay is renderable and proven**: the `doom-overlay` example sustains 35 FPS half-block animation (`examples/extensions/doom-overlay/doom-component.ts:71-80`); braille-dot particles are cheaper than that and terminal-agnostic. `OverlayHandle.setHidden()` can be driven by TTS start/stop **without** re-invoking `custom()` (the entry stays mounted; hidden overlays skip `render()` entirely).
- **Coordination**: V1's sphere extension listens to `pi.events` `tts:started`/`tts:stopped` emitted from a tiny addition to the mimo extension's `playAudio()`/`stopPlayback()` + a `globalThis.__piTtsPlaying` last-state flag (so it renders correct initial state on mount).
- **Lifecycle**: start the render interval in `session_start` (guarded `ctx.mode==="tui"`, idempotent), tear it down in `session_shutdown` for all reasons (`quit|reload|new|resume|fork`). Mirror the sidebar's `resetSidebarState()`/`stopSidebar()` pattern. (Note: mimo currently lacks `session_shutdown` → orphaned `afplay` is a pre-existing bug we should not inherit.)

## Detailed Findings

### The existing TTS pipeline (what we must observe)
File: `~/.pi/agent/extensions/pi-ext-tts-mimo/index.ts`
- Trigger: `agent_end` handler (`index.ts:403-423`) guarded by `if (!state.enabled) return;` (`:404`); pulls the assistant message via `ctx.sessionManager.getBranch()` (`:406`) — deliberately ignores `event.messages` to read the persisted leaf.
- `extractText()` (`:244-252`) filters content blocks to `type==="text"`, joins, trims; clamps `<10` chars (`:414`), truncates to 2000 (`:416-417`).
- `synthesizeSpeech()` (`:142-192`) POSTs to `MIMO_API_BASE + "/chat/completions"` (`:21`, `:155`) with body `{model, messages, audio:{format:"wav",voice}}` (`:160-167`); key from `~/.pi/agent/auth.json` `auth.Mimo.key` or `auth["xiaomi-token-plan-cn"].key` (`:24-36`); extracts base64 `choices[0].message.audio.data` (`:176-178`).
- `playAudio()` (`:194-232`): calls `stopPlayback()` first (`:196`), writes tmp WAV, spawns `afplay` (darwin `:205`), `paplay`/`aplay` (linux `:211-212`), powershell (win32 `:218-225`). Child stored in `currentPlayer` (`:79`); exec callback nulls it + deletes tmp (`:206-208`/`:213-215`/`:223-225`).
- `stopPlayback()` (`:82-86`): `currentPlayer.kill("SIGTERM")`, nulls, returns bool. Exposed only via `/tts stop` (`:260-265`).
- Config persisted to `config.json` (`:73`, `:121`): `{"enabled":false,"model":"mimo-v2.5-tts","voice":"茉莉","style":"用自然流畅的语气说"}`.
- **No pi-core speech signal exists**: the only `audio` token in `dist/` is `dist/core/model-config.js:34` (OpenRouter `max_price.audio` price field).

### Minimal change to expose a play/stop signal (recommended)
Add `pi.events` emits + a `globalThis` last-state flag at the hook points in `~/.pi/agent/extensions/pi-ext-tts-mimo/index.ts`:
- **started**: after each `currentPlayer = execFile(...)` (`:205`, `:212`, `:219`) → `pi.events.emit("tts:started", {voice, model})` + `(globalThis as any).__piTtsPlaying = true`.
- **stopped**: in the exit callbacks after `currentPlayer = null` (`:207`, `:214`, `:224`) and inside `stopPlayback()` after `kill` (`:84`) → `pi.events.emit("tts:stopped")` + `__piTtsPlaying = false`.
- Why `pi.events` over alternatives: `ctx.ui.setStatus` is one-way display, wiped on reload (`dist/modes/interactive/interactive-mode.js:1518-1533`); bare `globalThis` gives state but no push; a state file is overkill for a live toggle. Use `pi.events` (push) **+** `globalThis` (initial-state cache), mirroring the proven pi-subagents→sidebar signal path.

### Floating overlay capability (where V1 lives)
- Surface: `ExtensionUIContext.custom(factory, {overlay:true, overlayOptions, onHandle})` (`dist/core/extensions/types.d.ts:117-127`).
- `OverlayOptions` (`node_modules/@earendil-works/pi-tui/dist/tui.d.ts:76-102`): `width`/`maxHeight` (`SizeValue`), `anchor` (9-position, `tui.d.ts:60`), `offsetX/offsetY`, `visible(termW,termH)`, **`nonCapturing`** (`tui.d.ts:102`).
- `OverlayHandle` (`tui.d.ts:112-125`): `hide()` (permanent), **`setHidden(bool)`** (temporary, no dispose), `isHidden()`, `unfocus()`.
- `nonCapturing:true` is **mandatory** for a passive sphere: `showOverlay` only focuses when `!options?.nonCapturing && isOverlayVisible(entry)` (`node_modules/@earendil-works/pi-tui/dist/tui.js:299-300`); `getTopmostVisibleOverlay` skips nonCapturing entries (`tui.js:420`). Without it, the sphere steals all keystrokes.
- **`setHidden()` does NOT dispose and does NOT require re-invoking `custom()`** (`tui.js:322-341`); hidden overlays are excluded from compositing so their `render()` isn't even called (`tui.js:404,408-415`) → free CPU while idle. `custom()` re-call would instead *stack* a second overlay (`tui.js:291-294`) — avoid. `onHandle` fires once per `custom()` (`interactive-mode.js:1971`) → store the handle at module scope and toggle via `setHidden`.
- Reference impl: `~/.pi/agent/github/pi-sidebar-panel/extensions/index.ts:766-836` (`custom()` at `:784`; `overlayOptions:{anchor:"top-right",offsetX:-1,offsetY:1,width:38,nonCapturing:true,visible:(w)=>w>=100}` at `:822-832`; `onHandle` stores + unfocus at `:833-836`). External `setHidden` drive precedent: `examples/extensions/overlay-qa-tests.ts:256,899,904`.

### Sphere rendering approach (V1)
- **Braille particles** (`U+2800`–`U+28FF`, 2-col × 4-row dot lattice/cell), terminal-agnostic, 3 bytes/cell, diffs cleanly. Sustain **30 FPS** (`setInterval(…,33)` + `tui.requestRender()`), well under the `MIN_RENDER_INTERVAL_MS=16` ceiling (`tui.js:123,502-546`).
- **NOT** half-block (4× escape bytes, needs true-color we don't need) and **NOT** `Image` frames — `Image` silently degrades to `[Image: …]` text on tmux/VSCode/Alacritty/Windows Terminal (`node_modules/@earendil-works/pi-tui/dist/terminal-image.js:42-48,66-82`) and the built-in component can't animate (width-keyed cache, no data setter, `components/image.js:49-53`).
- Idle frames are I/O-free (`tui.js:1114-1120` no-write branch) but still cost the diff pass → **only run the interval while speaking** (start/stop with the same events that drive `setHidden`). Pulse = `R*(1+0.15*sin(2π f t))` → per-cell braille bitmasks.
- Animation precedents: snake 10 FPS (`examples/extensions/snake.ts:10,91-97`); doom-overlay 35 FPS half-block (`examples/extensions/doom-overlay/doom-component.ts:71-80`); braille titlebar spinner 12.5 FPS via `setTitle` (`~/.pi/agent/extensions/orca-titlebar-spinner.ts:2-12,37-44`).

### Why not an external window in V1
- A `custom()` sphere **cannot cross RPC** — `custom()` returns `undefined` in RPC mode (`dist/modes/rpc/rpc-mode.js:151-153`), `setWidget` is text-only (`:122-134`), `setFooter/setHeader/setEditorComponent` are no-ops (`:136-144,196-198`).
- A **running TUI pi cannot be attached** — `dist/modes/rpc/` ships only `jsonl.js` stdio framing; no socket/websocket server anywhere in `dist/` (`docs/rpc.md:1154-1158`). So an external live window would need the extension to spawn its OWN WS/HTTP server + browser (in-process Node, like mimo uses `execFile`). Reserved for **V2**.

### Cross-extension signaling & lifecycle
- `pi.events` (`dist/core/event-bus.d.ts:1-5`; exposed `events:EventBus` at `dist/core/extensions/types.d.ts:1014-1015`) is **per-loader**: survives `/reload` (same loader/bus, but stale listeners leak — no `EventBusController.clear()` is ever called) but **NOT** session switch (`/new`/`/resume`/`/fork` build a new loader+bus, `dist/core/agent-session-services.js:62-67`). Sub-agent "print" sessions also get their own bus (`pi-subagents/src/agent-runner.ts:635-648`).
- Correct hygiene (mirror sidebar `index.ts:690-719`): subscribe in `session_start` only when `ctx.mode==="tui"`, unsubscribe-then-rebind, unsubscribe in `session_shutdown`. Never bind at factory time.
- `globalThis` keys survive everything in-process (same jiti realm) — use `__piTtsPlaying` as the durable last-state cache.
- `pi.appendEntry("jarvis", {...})` persists to the session JSONL (durability only; one-way, latency-bound, pre-first-assistant-message buffering at `dist/core/session-manager.js:730-741`) — **not** for live animation.

## Code References
- `~/.pi/agent/extensions/pi-ext-tts-mimo/index.ts:79,82-86,194-232,403-423` — currentPlayer, stopPlayback, playAudio, agent_end (emit hook points).
- `dist/core/extensions/types.d.ts:117-127` — `custom({overlay,overlayOptions,onHandle})`.
- `dist/core/extensions/types.d.ts:1014-1015` — `events: EventBus`.
- `node_modules/@earendil-works/pi-tui/dist/tui.d.ts:76-102,112-125` — OverlayOptions, OverlayHandle.
- `node_modules/@earendil-works/pi-tui/dist/tui.js:289-341,404,408-415,1114-1120` — showOverlay/setHidden/hidden-skip/idle-no-write.
- `~/.pi/agent/github/pi-sidebar-panel/extensions/index.ts:766-866` — full custom()+lifecycle precedent.
- `examples/extensions/doom-overlay/doom-component.ts:13-40,71-80` — 35 FPS render loop.
- `dist/core/agent-session-runtime.js:102-113` — session_shutdown teardown ordering.
- `dist/core/extensions/loader.js:111-129,325-341` — jiti module cache (module state survives in-process switches).

## Integration Points
### Inbound References (what drives the sphere)
- `pi.events "tts:started"/"tts:stopped"` — emitted by (modified) mimo; consumed by the sphere extension's `session_start` subscription.
- `globalThis.__piTtsPlaying` — read on mount for initial render state.

### Outbound Dependencies
- `pi.events` EventBus (`dist/core/event-bus.d.ts`), `ExtensionAPI.events` (`types.d.ts:1014-1015`).
- `ctx.ui.custom()` / `tui.requestRender()` / `OverlayHandle.setHidden()` — the overlay surface.
- `pi.on("session_start"/"session_shutdown")` — lifecycle hooks (`docs/extensions.md:431-449,507-514`).

### Infrastructure Wiring
- Extension auto-discovery: drop the new extension dir at `~/.pi/agent/extensions/pi-jarvis-sphere/index.ts` (discovered via `dist/core/package-manager.js:373-439`; `/reload` hot-rebinds via `dist/core/agent-session.js:2052-2071`).
- Coexists with installed overlays `@aiwayds/pi-sidebar-panel@0.1.8` + `pi-think-panel` (`~/.pi/agent/settings.json:22-23`) — both TUI-mode-only; use distinct `anchor`/`offset` to avoid stacking conflicts.

## Architecture Insights
- **Two extensions, not one**: the sphere (TUI-scoped, `ctx.mode==="tui"` guarded, session-scoped overlay) and the TTS (headless child-process concern) have asymmetric lifetimes and failure modes. Bundling them couples a sphere-render bug to speech. Coordinate over `pi.events` (same pattern as pi-subagents→sidebar). The mimo edit is just two emits + a flag.
- **Factory discipline**: never start the render interval/socket in the factory (runs in `--help`/sub-agent print sessions, `docs/extensions.md:220-224`). Defer to `session_start`; idempotent teardown in `session_shutdown`.
- **Mode guard**: every TUI touch (overlay mount, `custom()`) must be `if (ctx.mode !== "tui") return;` — sub-agent sessions re-run factories with `mode:"print"` (`pi-subagents/src/agent-runner.ts:810-825`).

## Precedents & Lessons
2 precedents analyzed.
### Precedent: floating non-capturing overlay
- `pi-sidebar-panel/extensions/index.ts:766-866` — `custom({overlay:true})` + `nonCapturing:true` + `setInterval`/`requestRender` + idempotent `resetSidebarState()`/`stopSidebar()`.
- `examples/extensions/doom-overlay/doom-component.ts` — proves high-FPS overlay animation is real.
- **Takeaway**: copy the sidebar's overlay-options shape + start/stop/idempotent-reset trio exactly.

### Composite Lessons
- `/reload` reuses the bus but leaks stale `pi.events` listeners — always unsubscribe-then-rebind in `session_start` (sidebar `index.ts:690-719`).
- mimo has **no `session_shutdown`** → `afplay` orphans on session switch/reload (`index.ts` has only `stopPlayback()`). The sphere extension must NOT inherit this; and if we edit mimo, adding the shutdown kill is a cheap fix.

## Developer Context
**Q (窗口形态): pi 是终端 TUI,没有真·桌面浮动窗口。粒子球放哪?**
A: **先做终端浮层,再升级。** V1 = `custom({overlay:true})` nonCapturing 浮层 + braille 粒子球,`setHidden`+30FPS 动画,pi.events 驱动;V2(future)= 外部网页/桌面窗。理由:零外部依赖、无孤儿进程、有现成范式(doom-overlay/sidebar)。

## Related Research
- (none — first artifact for this project)

## Open Questions
- **Overlay placement vs sidebar/think-panel**: sidebar is `anchor:"top-right"` width 38; think-panel reads the sidebar's `globalThis` layout key to shrink. The sphere overlay must pick an anchor/offset that doesn't collide (e.g. `top-right` with different offset, or `bottom-right`). Resolve at design/blueprint time once we measure concurrent rendering.
- **Whether to also fix mimo's missing `session_shutdown`** as part of this work, or leave it. Recommend fixing (it's 3 lines) so session switches don't orphan audio.
- **Sphere detail fidelity** (particle count, color, pulse frequency, idle state — fully hidden vs idle-glow) — a design/aesthetic decision for blueprint.
