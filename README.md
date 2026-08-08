# pi-jarvis-sphere 🜄

[English](README.md) | [中文](README.zh.md)

**Jarvis particle sphere for the [pi](https://github.com/earendil-works/pi-coding-agent) agent** — a particle-sphere overlay floating in the bottom-right corner of your pi terminal. It shifts color and animation with pi's live state — amber refraction while thinking, yellow clockwise curl-noise vortex during tool calls, cyan refraction while streaming the answer, and a denser pulse while TTS speaks — like a little assistant that's alive. Sub-agent activity (via [pi-subagents](https://github.com/tintinweb/pi-subagents)) also animates the sphere as the tool state.

## ✨ Features

- **Four-state animation**, color = state:

  | State | Color | Animation |
  | --- | --- | --- |
  | Idle | green `#00e676` | curl noise flow field (slow) + center water ripple |
  | Thinking | amber `#ffab00` | particle refraction (slow polylines, boundary bounce + internal random refraction) |
  | Tool call | yellow `#ffeb3b` | uniform particle ring, **clockwise** — center hollow, 3 layers × 24 dots, differential rotation: inner slower, outer faster |
  | Working (streaming answer) | cyan `#00E5FF` | particle refraction (fast polylines) |
  | Sub-agent | yellow (tool) | sub-agent activity reuses the tool animation via `subagents:started` / `subagents:completed` / `subagents:failed` signals |
  | Wind-down | keeps current color | 1-second ease-out deceleration after thinking/tool/working ends, then back to idle |

- **TTS sync**: when [pi-ext-tts-mimo](https://github.com/fan56/pi-jarvis-sphere) plays speech, the sphere pulses denser and faster, as if talking (idle 10 FPS → 30 FPS while speaking).
- **Direction anchor**: the flow field rotates clockwise/counter-clockwise; deceleration is eased so direction stays readable.
- **Non-intrusive**: a `nonCapturing` overlay — typing and keybindings are completely unaffected.
- **Toggleable**: `/jarvis` toggles it on/off, persisted to `config.json` (on by default).
- **Lifecycle-safe**: mounts on `session_start`, cleans up on `session_shutdown`; sub-agent sessions don't double-mount; `/reload` doesn't leak listeners.

## 📦 Installation

```bash
# 1. Clone into its own directory (same convention as other ~/github pi extensions)
git clone https://github.com/fan56/pi-jarvis-sphere.git ~/github/pi-jarvis-sphere

# 2. Symlink into pi's extension dir (pi auto-discovers ~/.pi/agent/extensions/<name>)
ln -s ~/github/pi-jarvis-sphere ~/.pi/agent/extensions/pi-jarvis-sphere

# 3. /reload inside pi — done
```

> Optional dependency: `pi-ext-tts-mimo` provides the `tts:started` / `tts:stopped` signals so the sphere can react to speech. Without it the sphere still works — just no talking pulse.

## 🎮 Usage

| Command | Effect |
|---|---|
| `/jarvis` | Toggle the sphere on/off (state written to `config.json`) |

`config.json` (in the extension dir, default):

```json
{ "enabled": true }
```

## 🧪 Development & Debugging

- After editing, `/reload` in pi hot-reloads (jiti runs `.ts` directly — no build step).
- Syntax check: `node -e "…typescript.transpileModule…"` (no tsc build).
- To test: dispatch a `sleep N` sub-agent to observe the sub-agent/tool state (yellow · clockwise vortex); a normal Q&A to observe the think state (amber · refraction).

## 🗺️ Roadmap

- [ ] V2: standalone external window (extension spins up a local WebSocket + browser, real 3D WebGL particle sphere)
- [ ] Think-level color ramp (off→max thermal gradient; once implemented, later superseded by the four-state colors)
