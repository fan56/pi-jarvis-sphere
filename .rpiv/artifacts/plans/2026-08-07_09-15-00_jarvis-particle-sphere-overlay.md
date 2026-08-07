---
date: 2026-08-07T09:15:00+0800
author: fliu56
commit: 42f618b
branch: main
repository: pi-jarvis-sphere (new pi extension; cwd vcc-repo is unrelated)
topic: "Jarvis particle-sphere floating overlay for pi agent, synced to TTS playback"
tags: [plan, pi-extension, tui-overlay, tts, animation, lifecycle]
status: ready
parent: .rpiv/artifacts/research/2026-08-07_08-42-54_pi-jarvis-particle-sphere.md
phase_count: 2
phases:
  - { n: 1, title: "TTS play/stop signal (mimo edit)", files: ["~/.pi/agent/extensions/pi-ext-tts-mimo/index.ts"], depends_on: [] }
  - { n: 2, title: "Jarvis sphere extension (new)", files: ["~/.pi/agent/extensions/pi-jarvis-sphere/index.ts"], depends_on: [1] }
unresolved_phase_count: 0
last_updated: 2026-08-07T09:15:00+0800
last_updated_by: fliu56
---

# Jarvis Particle-Sphere Floating Overlay — Implementation Plan

## Overview
A new pi extension `pi-jarvis-sphere` renders an animated **braille particle sphere** in a **non-capturing bottom-right overlay**. It subscribes to `pi.events` `tts:started`/`tts:stopped` (emitted by a tiny additive change to the existing `pi-ext-tts-mimo` TTS extension) and animates: idle "breathing" (~10 FPS) when silent, intensifying to a ~30 FPS pulse while TTS speaks (so it looks like it's talking). `/jarvis` toggles it on/off (default on), persisted to `config.json`. V2 (external window) is deferred.

## Requirements
- Floating sphere visible in pi's terminal (not an external window). — *user: "浮动窗口,里面是个粒子球"*
- Animate while TTS plays speech, looking like it's talking. — *user: "tts 播放语音的时候,这个粒子球有一些动画效果,看起来像是在说话"*
- Integrate with the existing TTS ("we already have it" = `pi-ext-tts-mimo`).
- Toggleable; default always-on. — *user decision (animation behavior)*
- Bottom-right placement, clear of the top-right sidebar / think-panel. — *user decision (placement)*
- Must not capture keyboard, must not break sub-agent sessions, must clean up on session end. — *research lifecycle findings*

## Current State Analysis
- **pi has no built-in TTS.** Existing TTS = user extension `~/.pi/agent/extensions/pi-ext-tts-mimo/index.ts`. It tracks playback only in a module-private `currentPlayer` (`:79`) and `stopPlayback()` (`:82-86`); exposes **no** play/stop signal. `playAudio`/`stopPlayback` are module-level (no `pi` in scope) — so the edit captures `pi.events` into a module var.
- **Overlay surface exists**: `ctx.ui.custom(factory, {overlay:true, overlayOptions, onHandle})` (`dist/core/extensions/types.d.ts:117-127`). `OverlayOptions` (`@earendil-works/pi-tui/dist/tui.d.ts:76-102`): `anchor`, `width`, `maxHeight`, `offsetX/Y`, `row/col`, `margin`, `visible(tw,th)`, `nonCapturing`. `OverlayHandle`: `hide()`, `setHidden(bool)`, `isHidden()`, `focus()`, `unfocus()`, `isFocused()`.
- **`EventBus.on` returns the unsubscribe fn** (`dist/core/event-bus.d.ts:1-5`: `on(channel, handler): () => void`) — there is **no** `off()`. Handlers are typed `(data: unknown) => void`; payloads cast at the registration boundary.
- **Lifecycle**: `session_start` (`types.d.ts:858`) and `session_shutdown` (`:864`) are registerable; `ExtensionContext` has both `.ui` (`:211`) and `.mode` (`:213`). Sub-agent "print" sessions also fire these — guard `ctx.mode === "tui"`.

### Key Discoveries
- **Proven mount pattern** = `@aiwayds/pi-sidebar-panel/extensions/index.ts`: `pi.on("session_start", …)` with `if (ctx?.mode !== "tui") return;` guard → unsub-then-rebind `pi.events` listeners → `ctx.ui.custom(factory, {overlay:true, overlayOptions:{…,nonCapturing:true,visible:…}, onHandle:h=>{handle=h;h.unfocus()}})` (`index.ts:668,701-716,784-836`); teardown in `pi.on("session_shutdown", …)` (`:740`) via `stopSidebar()` = dispose component + `handle.hide()` + call captured `done()` + null state.
- **`Component` interface** (`tui.d.ts:10`): `render(width): string[]`, optional `handleInput`, `invalidate()`, optional `wantsKeyRelease`. Animation = `setInterval(()=>{ tick(); tui.requestRender(); }, ms)` cleared in `dispose()` (see `examples/extensions/doom-overlay/doom-component.ts:60-78` — 35 FPS sustained).
- **Braille** = `U+2800` + 8-dot bitmask per cell (2 col × 4 row dots); terminal-agnostic, cheap, diffs cleanly. `Image` component is NOT viable (text fallback on tmux/VSCode).
- **opencode virtual pet** = unmerged PR #24935 ("terminal pet companion with CAVA audio visualizer"): audio→animation-rate coupling + JSON-driven frames. Our case is simpler — TTS gives clean start/stop signals, no audio sampling needed.
- **Mimo is additive-only** to edit: it never touched session_shutdown (orphaned-afplay bug pre-exists, out of scope to fix here beyond the emit).

## Desired End State
```text
# In pi TUI, bottom-right corner (clear of the top-right sidebar):
#
#   · ·●· ·          <- braille particle sphere, idle breathing (~10 FPS)
#  · ●●●●● ·
#   · ●●● ·
#
# When pi-ext-tts-mimo speaks (tts:started): sphere pulses faster/denser (~30 FPS)
#   ●●●●●●●●         <- looks like it's talking
#  ●●●●●●●●●●
#   ●●●●●●●●
#
# /jarvis  -> toggles on/off (default on), persisted to config.json
# Typing/keys unaffected (nonCapturing); sub-agent sessions spawn no second sphere.
```
Consumer code shape (the extension's own surface):
```ts
export default function (pi: ExtensionAPI) {
  pi.registerCommand("jarvis", { handler: async (_args, ctx) => { /* toggle */ } });
  pi.on("session_start",  (_e, ctx) => { if (ctx.mode !== "tui" && config.enabled) startSphere(pi, ctx); });
  pi.on("session_shutdown",(_e, ctx) => { if (ctx.mode !== "tui") stopSphere(); });
}
```

## What We're NOT Doing
- **V2 external window** (own WebSocket/HTTP server + browser, real 3D WebGL sphere) — deferred per user decision.
- **Audio-level sampling** (CAVA-style amplitude → animation) — overkill; TTS start/stop is a clean signal.
- **Multiple pet states / sprites** (walk/sleep/eat…) — V1 is idle-breathing + speaking-pulse only.
- **Color / true-color / 3D** — braille monochrome only.
- **Fixing mimo's missing `session_shutdown`** (orphaned-afplay bug) — out of scope; the emit edit is additive and does not change playback behavior.
- **Touching the sidebar/think-panel extensions** — only choosing `bottom-right` to avoid them.

## Decisions

### D1 — V1 = in-terminal overlay (deferred external window)
**Evidence**: pi is a terminal TUI; no socket in `dist/modes/rpc/`; `custom()` returns `undefined` in RPC (`rpc-mode.js:151-153`). External live window needs the extension to spawn its own server+browser.
**Decision**: V1 = `custom({overlay:true})` non-capturing braille overlay; V2 external window deferred. *(user decision, research checkpoint)*

### D2 — Two extensions, coordinate over pi.events
**Evidence**: sphere (TUI-scoped, session-scoped overlay) and TTS (headless child-process) have asymmetric lifetimes/failure modes; `pi.events` is the proven cross-extension signal path (pi-subagents→sidebar, `pi-sidebar-panel/index.ts:701-716`).
**Decision**: new `pi-jarvis-sphere` extension + additive emit edit to `pi-ext-tts-mimo`. Coordinate via `pi.events` `tts:started`/`tts:stopped` + a `globalThis.__piTtsPlaying` last-state flag (initial-state cache for mount time).

### D3 — Animation: toggleable, default always-on (idle breathing → speaking pulse)
**Evidence**: idle frames are I/O-free but still cost a diff pass (`tui.js:1114-1120`); 30 FPS speaking / 10 FPS idle is sustainable (doom-overlay sustains 35 FPS, `doom-component.ts:75`).
**Decision**: `/jarvis` toggles; **default on**. Idle = ~10 FPS breathing (advance/render every 3rd 33ms tick); speaking = ~30 FPS pulse (every tick, larger amplitude/freq/density). Toggled off = `stopSphere()` (dispose + hide). *(user decision)*

### D4 — Placement: bottom-right
**Evidence**: sidebar = `anchor:"top-right"` width 38 (`~/.pi/agent/settings.json`); think-panel reads sidebar layout.
**Decision**: `anchor:"bottom-right"`, `width:14`, `maxHeight:9`, `margin:{bottom:1,right:1}`, `visible:(tw,th)=>tw>=60 && th>=16`. *(user decision)*

### D5 — Signal API: `EventBus.on` returns unsub (no `off`)
**Evidence**: `dist/core/event-bus.d.ts:1-5` — `on(channel, handler): () => void`; handlers typed `(data: unknown) => void`.
**Decision**: capture unsub fns into an array; unsub-then-rebind in `startSphere` (handles `/reload` leak + re-enable); unbind in `stopSphere`.

### D6 — Consolidate proposed Phase 2+3 into one new-file phase
**Evidence**: the sphere extension is a single new file. Splitting it (component vs wiring) across phases creates an unloadable intermediate (no `default export` until the wiring phase) and forces awkward code-fence splicing.
**Decision**: **Phase 1** = MODIFY mimo (signal); **Phase 2** = NEW complete `pi-jarvis-sphere/index.ts` (component + factory + lifecycle + `/jarvis`). Two phases total (was three).

## Phase 1: TTS play/stop signal (mimo edit)

### Overview
Depends on: nothing (foundation). Purely additive: `pi-ext-tts-mimo` emits `pi.events` `tts:started`/`tts:stopped` and sets `globalThis.__piTtsPlaying`. No change to playback behavior.

### Changes Required:

#### 1. ~/.pi/agent/extensions/pi-ext-tts-mimo/index.ts
**File**: `~/.pi/agent/extensions/pi-ext-tts-mimo/index.ts`
**Changes**: MODIFY — add module-level `ttsEvents` + `emitTtsState()`; capture `pi.events` in a TUI-guarded `session_start` handler; emit started/stopped at play/stop hook points (identity-guarded).

```ts
// === A. module-level, immediately after `let currentPlayer: ChildProcess | null = null;` ===
// 让其他扩展(如 pi-jarvis-sphere)能感知 TTS 播放状态
let ttsEvents: { emit: (channel: string, data: unknown) => void } | null = null;

/** 发出 TTS 播放状态信号 + 同步 globalThis 标志(供其他扩展读取初始态) */
function emitTtsState(playing: boolean): void {
  (globalThis as any).__piTtsPlaying = playing;
  ttsEvents?.emit(
    playing ? "tts:started" : "tts:stopped",
    playing ? { source: "mimo" } : undefined,
  );
}

// === B. stopPlayback() — emit stopped only when a player was actually killed ===
function stopPlayback(): boolean {
  if (currentPlayer) {
    currentPlayer.kill("SIGTERM");
    currentPlayer = null;
    emitTtsState(false);
    return true;
  }
  return false;
}

// === C. factory start — 在 TUI 会话的 session_start 里捕获 events bus ===
//   不在工厂顶层捕获:子 agent 的 "print" 会话会以自己的 EventBus 重跑工厂,
//   而 jiti 缓存了模块,顶层 `ttsEvents = pi.events` 会被指向子 agent 的 bus,
//   导致 TUI 里的 jarvis 监听器收不到信号。只在真实 TUI 会话捕获,确保始终是 TUI bus。
export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui") ttsEvents = pi.events;
  });

// === D. playAudio() — emit started once we've committed to playback ===
  // (inside playAudio, immediately after `writeFileSync(tmpFile, audioBuffer);`)
  writeFileSync(tmpFile, audioBuffer);
  emitTtsState(true);

// === E. playAudio() exit callbacks — emit stopped (identity-guarded) ===
  //   每个 execFile 先存到局部 child 再赋给 currentPlayer;回调里只有当
  //   `currentPlayer === child`(该进程仍是当前播放进程)才 emit stopped + 置空。
  //   否则第二次播放抢占第一个时,被杀进程的回调会在新 tts:started 之后误发
  //   tts:stopped,让 jarvis 球在仍说话时掉回 idle。(顺带修掉原有的 currentPlayer 误清。)
  // darwin afplay callback:
  const childD = execFile("afplay", [tmpFile], (err) => {
    if (err && err.signal !== "SIGTERM") console.error("afplay error:", err);
    if (currentPlayer === childD) {
      currentPlayer = null;
      emitTtsState(false);
    }
    cleanup(tmpFile);
  });
  currentPlayer = childD;
  // linux paplay/aplay callback:
  const childL = execFile(player, [tmpFile], (err) => {
    if (err && err.signal !== "SIGTERM") console.error(`${player} error:`, err);
    if (currentPlayer === childL) {
      currentPlayer = null;
      emitTtsState(false);
    }
    cleanup(tmpFile);
  });
  currentPlayer = childL;
  // win32 powershell callback:
  const childW = execFile("powershell.exe", ["-NoProfile", "-Command", `…`], (err) => {
    if (err && err.signal !== "SIGTERM") console.error("PowerShell playback error:", err);
    if (currentPlayer === childW) {
      currentPlayer = null;
      emitTtsState(false);
    }
    cleanup(tmpFile);
  });
  currentPlayer = childW;
  // playAudio() catch block:
  } catch (error) {
    console.error("Audio playback failed:", error);
    currentPlayer = null;
    emitTtsState(false);
    cleanup(tmpFile);
  }
```

### Success Criteria:

#### Automated Verification:
- [ ] `grep -c "emitTtsState" ~/.pi/agent/extensions/pi-ext-tts-mimo/index.ts` returns >= 7
- [ ] `grep -c "__piTtsPlaying" ~/.pi/agent/extensions/pi-ext-tts-mimo/index.ts` returns >= 1
- [ ] `grep -c "ttsEvents = pi.events" ~/.pi/agent/extensions/pi-ext-tts-mimo/index.ts` returns 1
- [ ] `grep -c "session_shutdown" ~/.pi/agent/extensions/pi-ext-tts-mimo/index.ts` returns 0 (edit stays additive — no session_shutdown handler; orphaned-afplay behavior unchanged)

#### Manual Verification:
- [ ] `/reload` pi; run `/tts`, enable; ask pi a short question — no errors in console; TTS still plays normally
- [ ] Trigger rapid re-speech (two quick assistant turns) — sphere does NOT drop to idle mid-speech (stale-callback identity guard)
- [ ] Dispatch a sub-agent, then have pi speak — sphere still reacts (ttsEvents re-captured to TUI bus, not the sub-agent bus)
- [ ] End a session while TTS is mid-playback — pre-existing orphaned-afplay behavior unchanged (no new session_shutdown kill)
- [ ] (after Phase 2) sphere reacts — confirms the emits reach a subscriber

## Phase 2: Jarvis sphere extension (new)

### Overview
Depends on: Phase 1 (the `tts:started`/`tts:stopped` signal). NEW complete extension file: braille particle-sphere `Component` + default factory + lifecycle (`session_start` mount, `session_shutdown` teardown) + `/jarvis` toggle + `config.json` persistence.

### Changes Required:

#### 1. ~/.pi/agent/extensions/pi-jarvis-sphere/index.ts
**File**: `~/.pi/agent/extensions/pi-jarvis-sphere/index.ts`
**Changes**: NEW — complete extension.

```ts
/**
 * Jarvis 粒子球浮层 for Pi
 *
 * 一个 nonCapturing 浮动 overlay,渲染盲文粒子球。监听 pi.events 的
 * tts:started / tts:stopped(由 pi-ext-tts-mimo 发出):
 *   - 默认常驻:静默时 ~10FPS 轻微呼吸,TTS 说话时 ~30FPS 脉冲(像在说话)。
 *   - /jarvis 命令切换开关;状态持久化到 config.json。
 *
 * 依赖:pi-ext-tts-mimo 已加入 tts:started/stopped 信号(本计划 Phase 1)。
 * 范式参照:@aiwayds/pi-sidebar-panel/extensions/index.ts
 *   (session_start 挂浮层、pi.events 订阅、session_shutdown 清理)。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";

const CONFIG_FILE = join(__dirname, "config.json");
// overlay 列宽;盲文每格 2 点列 => 28 点宽,与 7 行(28 点高)配成方形球
const WIDTH = 14;

interface JarvisConfig {
  enabled: boolean;
}
const DEFAULT_CONFIG: JarvisConfig = { enabled: true };
const config: JarvisConfig = { ...DEFAULT_CONFIG };

function loadConfig(): void {
  try {
    if (existsSync(CONFIG_FILE)) {
      const data = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      config.enabled = data.enabled ?? DEFAULT_CONFIG.enabled;
    }
  } catch {
    // 配置缺失/损坏 => 用默认值
  }
}
loadConfig();

// ---------------------------------------------------------------------------
// 盲文粒子球组件
// ---------------------------------------------------------------------------

// 每个 cell = 2 列 × 4 行点阵;Unicode 盲文码位掩码 [行][列]
const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];
const BRAILLE_BASE = 0x2800;

// 每个点的稳定噪声:同一个 (dx,dy) 每帧哈希值不变,避免逐帧随机抖动
function dotHash(x: number, y: number): number {
  let h = (x * 73856093) ^ (y * 19349663);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

class JarvisSphereComponent implements Component {
  private tui: TUI;
  private interval: ReturnType<typeof setInterval> | null = null;
  private phase = 0;
  private frame = 0;
  speaking = false;

  constructor(tui: TUI) {
    this.tui = tui;
    // ~30FPS 基础节拍;空闲时每 3 帧才推进+重绘(=> ~10FPS),省 CPU
    this.interval = setInterval(() => this.tick(), 33);
  }

  /** TTS 开始/停止时调用,切换"说话/呼吸"两种动画 */
  setSpeaking(v: boolean): void {
    if (this.speaking !== v) {
      this.speaking = v;
      this.frame = 0;
      this.tui.requestRender();
    }
  }

  private tick(): void {
    this.frame++;
    const every = this.speaking ? 1 : 3; // 说话 ~30FPS / 空闲 ~10FPS
    if (this.frame % every === 0) {
      this.phase += this.speaking ? 0.45 : 0.16;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const w = Math.max(6, width);
    const rows = Math.max(4, Math.round(w / 2)); // 点阵近似方形
    const dotCols = w * 2;
    const dotRows = rows * 4;
    const cx = dotCols / 2;
    const cy = dotRows / 2;
    const baseR = Math.min(dotCols, dotRows) / 2 - 0.5;

    // 说话时:呼吸幅度/频率更大、粒子更密
    const amp = this.speaking ? 0.18 : 0.07;
    const freq = this.speaking ? 1.0 : 0.5;
    const density = this.speaking ? 0.62 : 0.42;
    const R = baseR * (1 + amp * Math.sin(this.phase * freq));
    const coreR = baseR * 0.45;

    const lines: string[] = [];
    for (let row = 0; row < rows; row++) {
      let line = "";
      for (let col = 0; col < w; col++) {
        let code = BRAILLE_BASE;
        for (let dr = 0; dr < 4; dr++) {
          for (let dc = 0; dc < 2; dc++) {
            const dx = col * 2 + dc;
            const dy = row * 4 + dr;
            const ddx = dx - cx;
            const ddy = dy - cy;
            const dist = Math.sqrt(ddx * ddx + ddy * ddy);
            let on = false;
            if (dist <= coreR) {
              on = true; // 实心核
            } else if (dist <= R) {
              // 粒子光晕:越靠外越稀疏 + 固定噪声
              const edge = (dist - coreR) / (R - coreR);
              on = dotHash(dx, dy) < density * (1 - edge * 0.6);
            }
            if (on) code |= BRAILLE_BITS[dr][dc];
          }
        }
        line += String.fromCharCode(code);
      }
      lines.push(line);
    }
    return lines;
  }

  invalidate(): void {}

  dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

// ---------------------------------------------------------------------------
// 扩展装配 + 生命周期(参照 pi-sidebar-panel)
// ---------------------------------------------------------------------------

let handle: OverlayHandle | null = null;
let sphere: JarvisSphereComponent | null = null;
let sphereDone: (() => void) | null = null;
let eventUnsubs: Array<() => void> = [];

function unbindEvents(): void {
  eventUnsubs.forEach((fn) => {
    try {
      fn();
    } catch {
      // 监听挂在已销毁的 bus 上 => 忽略
    }
  });
  eventUnsubs = [];
}

function startSphere(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  if (handle || sphere) return; // 幂等:已挂载

  // 先解绑旧监听(防 /reload 或重复 start 泄漏),再绑定
  unbindEvents();
  eventUnsubs = [
    pi.events.on(
      "tts:started",
      (() => {
        sphere?.setSpeaking(true);
      }) as (data: unknown) => void,
    ),
    pi.events.on(
      "tts:stopped",
      (() => {
        sphere?.setSpeaking(false);
      }) as (data: unknown) => void,
    ),
  ];

  ctx.ui.custom(
    (tui: TUI, _theme: unknown, _kb: unknown, done: (result: unknown) => void) => {
      sphereDone = done as () => void;
      sphere = new JarvisSphereComponent(tui);
      return sphere;
    },
    {
      overlay: true,
      overlayOptions: {
        width: WIDTH,
        maxHeight: 9,
        anchor: "bottom-right",
        margin: { bottom: 1, right: 1 },
        nonCapturing: true,
        visible: (tw: number, th: number) => tw >= 60 && th >= 16,
      },
      onHandle: (h: OverlayHandle) => {
        handle = h;
        h.unfocus();
      },
    },
  );

  // 用 globalThis 标志校正初始态(挂载时 TTS 可能已在播放)
  if ((globalThis as any).__piTtsPlaying) sphere?.setSpeaking(true);
}

function stopSphere(): void {
  unbindEvents();
  sphere?.dispose();
  sphere = null;
  if (handle) {
    try {
      handle.hide();
    } catch {
      // handle 已失效 => 忽略
    }
    handle = null;
  }
  if (sphereDone) {
    try {
      sphereDone();
    } catch {
      // 忽略
    }
    sphereDone = null;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("jarvis", {
    description: "Jarvis 粒子球: 切换显示/隐藏(默认开启)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Jarvis 粒子球需要交互(TUI)模式", "info");
        return;
      }
      config.enabled = !config.enabled;
      try {
        writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
      } catch {
        // 持久化失败不影响本次切换
      }
      if (config.enabled) {
        startSphere(pi, ctx);
        ctx.ui.notify("Jarvis 粒子球已开启", "info");
      } else {
        stopSphere();
        ctx.ui.notify("Jarvis 粒子球已关闭", "info");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    // 子 agent 的 "print" 会话也会触发 session_start;只处理真实 TUI 会话
    if (ctx?.mode !== "tui") return;
    // 进程内会话切换(/new /resume)会卸下框架浮层,但模块状态(handle/sphere/
    // 定时器)在 jiti 缓存里存活 -> 幂等守卫会提前 return,球永不再挂载且旧 33ms
    // 定时器继续空转。先 stopSphere 清理旧状态(参照 sidebar 的 resetSidebarState),
    // 再按 config 决定是否重新挂载。
    stopSphere();
    if (config.enabled) startSphere(pi, ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    // 只在真实 TUI 会话 teardown 时清理
    if (ctx?.mode !== "tui") return;
    stopSphere();
  });
}
```

### Success Criteria:

#### Automated Verification:
- [ ] `grep -c "implements Component" ~/.pi/agent/extensions/pi-jarvis-sphere/index.ts` returns 1
- [ ] `grep -c "overlay: true" ~/.pi/agent/extensions/pi-jarvis-sphere/index.ts` returns 1
- [ ] `grep -c "nonCapturing: true" ~/.pi/agent/extensions/pi-jarvis-sphere/index.ts` returns 1
- [ ] `grep -c "tts:started" ~/.pi/agent/extensions/pi-jarvis-sphere/index.ts` returns >= 1
- [ ] `grep -c "session_start\|session_shutdown" ~/.pi/agent/extensions/pi-jarvis-sphere/index.ts` returns >= 2

#### Manual Verification:
- [ ] `/reload` pi — sphere appears bottom-right, idle breathing animation; no console errors
- [ ] `/tts` on; ask pi a question — sphere pulses faster/denser while TTS speaks, returns to breathing after
- [ ] `/jarvis` toggles sphere off then on; `config.json` reflects state; survives `/reload`
- [ ] Sphere does NOT capture keyboard — typing/editing works while it is visible
- [ ] Dispatching a sub-agent (Agent tool) does NOT spawn a second sphere (mode guard)

## Ordering Constraints
- **Phase 1 before Phase 2 functionally** (Phase 2 subscribes to the signal Phase 1 emits), but they edit **different files** so they may be applied in parallel; the sphere simply won't animate until mimo is also patched.
- **Phase 2 is one atomic file** — must land whole (no intermediate unloadable state).
- No whole-repo build/test (these are jiti-loaded `.ts` extensions with no build step); verification is grep assertions + manual `/reload`.

## Verification Notes
- **No build step**: pi loads extension `.ts` via jiti at runtime. There is no `tsc`/`npm test` for extensions. Automated checks are grep assertions (deterministic, exit-code-based); real validation is manual `/reload` + visual.
- **`/reload` is the load test**: `/reload` re-discovers extensions (`dist/core/package-manager.js:373-439`) and re-runs factories + `session_start`. A syntax/import error surfaces as a load failure at `/reload`.
- **Mode guard is load-bearing**: sub-agent "print" sessions re-run the factory and fire `session_start`/`session_shutdown` — without `ctx.mode !== "tui" return;` a sub-agent would null the live sphere handle (`pi-sidebar-panel/index.ts:668-686` documents this exact regression).
- **EventBus has no `off()`**: `on()` returns the unsub fn (`event-bus.d.ts:1-5`). Handlers are `(data: unknown) => void`; payloads cast at registration (`pi-sidebar-panel/index.ts:701-716`).
- **`hide()` is permanent**: after `/jarvis` off (stopSphere → hide), re-on must re-mount via `custom()` (mirrors sidebar `startSidebar`). `setHidden()` would be an alternative for a temporary hide, but hide+remount matches the toggle semantics cleanly.
- **Precedent lesson**: `/reload` reuses the bus and leaks stale listeners — always unsub-then-rebind (`pi-sidebar-panel/index.ts:690-700`).

## Performance Considerations
- Render loop runs only while the sphere is mounted. Idle costs ~10 `requestRender`/s (each a line-diff that writes nothing when unchanged → effectively free terminal I/O, a few µs CPU). Speaking costs ~30/s. Negligible vs. the sidebar's 5s interval or doom's 35 FPS.
- `dotHash` is a fixed per-point noise (not `Math.random`) → no per-frame allocation jitter, stable visual.
- Toggled off → interval cleared (`dispose`) → zero cost.

## Migration Notes
None. New extension + additive edit. No schema/data migration. If the user wants the old behavior (no sphere), `/jarvis` off persists `enabled:false` to `config.json`; or remove the extension dir.

## Pattern References
- `~/.pi/agent/npm/node_modules/@aiwayds/pi-sidebar-panel/extensions/index.ts:668-740,784-866` — **primary template**: session_start mount + mode guard + unsub-then-rebind events + `ctx.ui.custom({overlay,overlayOptions:{nonCapturing,visible},onHandle})` + session_shutdown teardown (stop = dispose + hide + done + null).
- `examples/extensions/doom-overlay/doom-component.ts:13-90` — `Component` shape + `setInterval(()=>{tick();tui.requestRender()},1000/35)` + `dispose()` clears interval.
- `examples/extensions/doom-overlay/index.ts:52-72` — `ctx.ui.custom(factory, {overlay:true, overlayOptions})` call shape.
- `dist/core/event-bus.d.ts:1-5` — `EventBus.on` returns unsub fn.
- `~/.pi/agent/extensions/pi-ext-tts-mimo/index.ts:79,82-86,194-232,403-423` — TTS pipeline + emit hook points (Phase 1).

## Developer Context
**Q (窗口形态): 粒子球放哪?** A: 先做终端浮层,再升级(V1 in-terminal, V2 external window). *(research checkpoint m0045)*
**Q (动画行为): 静默时怎么表现?** A: 可切换,默认常驻(空闲呼吸 ~10FPS,TTS 时脉冲 ~30FPS). *(blueprint checkpoint)*
**Q (球的位置): 钉哪?** A: 右下角,避开右上角 sidebar/think-panel. *(blueprint checkpoint)*
**Q (opencode 宠物): 找实现做参考?** A: opencode 无内置宠物;参考未合并 PR #24935(audio→动画耦合 + JSON 帧). 我们用 TTS start/stop 更简单. *(m0062/m0063)*
**Q (设计+拆解): 批准?** A: 批准,开始生成. *(m0085)*
**Note (D6)**: 原拟 3 阶段(信号/组件/装配),合并组件+装配为单新文件 Phase 2,避免中间无 default export 的不可加载态 + 代码块拼接.

## Plan Review (Step 8)

_Independent post-finalization review (2× slice-verifier + artifact-code-reviewer + artifact-coverage-reviewer). 0 blockers, 5 concerns — all triaged **applied**._

| source | plan-loc | codebase-loc | severity | dimension | finding | recommendation | resolution |
| --- | --- | --- | --- | --- | --- | --- | --- |
| slice-ver P1 | Phase 1 §1 (Edit E) | pi-ext-tts-mimo/index.ts:205-226 | concern | atomicity/signal-integrity | Stale-callback race: a preempted player's async callback emits a spurious `tts:stopped` after the new `tts:started` → sphere idles mid-speech | identity-guard callbacks (`const child = execFile(...)` + `if (currentPlayer === child)`) | applied — Edit E rewritten with childD/childL/childW identity guards |
| slice-ver P2 | Phase 2 AV (grep) | <n/a> | concern | atomicity/self-gate | `grep -c "tts:started" returns 1` fails — 3 matches (2 doc-comments + 1 subscription) | relax criterion to `>= 1` | applied — criterion now `>= 1` |
| code-reviewer | Phase 1 §1 (Edit C) | pi-sidebar-panel/index.ts:684-685 | concern | codebase-fit | `ttsEvents = pi.events` in factory gets repointed to the sub-agent bus on sub-agent factory re-run (jiti cache) → TUI jarvis listeners go deaf after the first sub-agent | capture in a `ctx.mode==="tui"`-guarded `session_start` (mirror sidebar) | applied — Edit C now captures via a TUI-guarded session_start handler |
| code-reviewer | Phase 2 (session_start) | pi-sidebar-panel/index.ts:842 | concern | code-quality | idempotency guard `if (handle \|\| sphere) return` has no stale-state reset on session_start → in-process session switch leaves an orphaned interval + a sphere that never remounts | defensive reset (`stopSphere`) before `startSphere` on session_start (mirror `resetSidebarState`) | applied — session_start now calls `stopSphere()` before `startSphere()` |
| coverage-reviewer | Phase 1 (AV) | <n/a> | concern | verification-coverage | "mimo additive-only / no session_shutdown" had no Success Criteria assertion | add `grep -c "session_shutdown" returns 0` + a manual orphaned-afplay step | applied — Phase 1 AV + Manual bullets added |

## Plan History
- Phase 1: TTS play/stop signal (mimo edit) — approved as generated; revised (Step 9): identity-guarded callbacks + TUI-guarded session_start capture + additive-only criteria
- Phase 2: Jarvis sphere extension (new) — approved as generated (consolidated from proposed phases 2+3); revised (Step 9): session_start stale-state reset + relaxed grep gate

## References
- Research: `.rpiv/artifacts/research/2026-08-07_08-42-54_pi-jarvis-particle-sphere.md`
- opencode pet: PR #24935 "feat(tui): add terminal pet companion with CAVA audio visualizer" (github.com/anomalyco/opencode, unmerged)
