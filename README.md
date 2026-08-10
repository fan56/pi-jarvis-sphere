# pi-jarvis-sphere 🜄

[English](README.md) | [中文](README.zh.md)

**Jarvis particle sphere for the [pi](https://github.com/earendil-works/pi-coding-agent) agent** — a particle-sphere overlay floating in the bottom-right corner of your pi terminal. It shifts color and animation with pi's live state — amber refraction while thinking, yellow clockwise particle ring during tool calls, cyan refraction while streaming the answer, and a denser pulse while TTS speaks — like a little assistant that's alive. Sub-agent activity (via [pi-subagents](https://github.com/tintinweb/pi-subagents)) also animates the sphere as the tool state.

![demo](demo.svg)

*Simulated four-state animation (SMIL SVG, generated from the actual render code — flow field / refraction / orbital particle ring)*

## ✨ Features

- **Four-state animation**, color = state:

  | State | Color | Animation |
  | --- | --- | --- |
  | Idle | green `#00e676` | curl noise flow field (slow) + center water ripple |
  | Thinking | amber `#ffab00` | particle refraction (slow polylines, boundary bounce + internal random refraction) |
  | Tool call | yellow `#ffeb3b` | uniform particle ring, **clockwise** — center hollow, 4 layers × 20 dots (80 particles), differential rotation: inner slower, outer faster |
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

## 🧩 Plugin Architecture

Each animation lives in its own plugin file (closure-owned particle state) behind a unified interface; **the scene → animation mapping is driven by `config.json` — swap animations by editing config, no code changes**.

```
animations/          # animation plugins (new animation = new file + one registry line)
  flow-field.ts      # flow field + water ripple (idle default)
  refract.ts         # refraction particles (think/working default; separate instance per scene)
  orbital.ts         # orbital particle ring (tool default)
  registry.ts        # id -> factory registry
lib/                 # shared layer: types / grid geometry / braille primitives / noise / scene config
config.json          # your editable "plugin catalog"
```

The `scenes` field of `config.json` controls which animation each scene mounts and its parameters:

```json
{
  "enabled": true,
  "scenes": {
    "idle":    { "animation": "flow-field", "params": { "fieldSpeed": 0.06, "dir": 1, "fieldCount": 120, "fieldScroll": 0.02 } },
    "think":   { "animation": "refract",    "params": { "refractSpeed": 1.04, "refractCount": 16 } },
    "tool":    { "animation": "orbital",    "params": { "spinSpeed": 0.15, "dir": 1 } },
    "working": { "animation": "refract",    "params": { "refractSpeed": 1.04, "refractCount": 16 } }
  }
}
```

**Example — plug the "particle ring" (orbital) into the think scene:** change one line of `config.json`:

```json
"think": { "animation": "orbital", "params": { "spinSpeed": 0.15, "dir": 1 } },
```

Then `/reload` in pi. Missing params fall back to each plugin's `defaults`; `dir` controls rotation (`1` = clockwise / `-1` = counter-clockwise).

> Note: think and working are independent animation slots — you can mount different animations per scene; the same animation in multiple scenes holds separate particle instances (no interference).

## 🧪 Development & Debugging

- After editing, `/reload` in pi hot-reloads (jiti runs `.ts` directly — no build step).
- Syntax check: `node -e "…typescript.transpileModule…"` (no tsc build).
- To test: dispatch a `sleep N` sub-agent to observe the sub-agent/tool state (yellow · clockwise vortex); a normal Q&A to observe the think state (amber · refraction).

## 🗺️ Roadmap

- [ ] V2: standalone external window (extension spins up a local WebSocket + browser, real 3D WebGL particle sphere)
- [ ] Think-level color ramp (off→max thermal gradient; once implemented, later superseded by the four-state colors)
