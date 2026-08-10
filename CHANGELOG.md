# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-08-10

First public release. A particle-sphere overlay for the pi agent that shifts
color and animation with the agent's live state — plus a plugin architecture
where the scene → animation mapping is driven entirely by `config.json`.

### Added

- **Particle sphere overlay** for the pi terminal (bottom-right, `nonCapturing`,
  toggleable via `/jarvis`), lifecycle-safe on session start/shutdown and `/reload`.
- **Four-state animation**, color = state:
  - Idle — green curl-noise flow field + center water ripple.
  - Think — amber star shapes: 7-shape loop (triangle → square → pentagram →
    hexagram → heptagram → octagram → enneagram), hand-drawn edge-by-edge,
    fixed counter-clockwise rotation.
  - Tool — yellow uniform particle ring, clockwise, center hollow
    (4 layers × 20 dots = 80 particles, differential rotation: inner slower,
    outer faster).
  - Working — cyan clockwise orbital particle flow (same animation as tool).
- **Wind-down**: 1-second ease-out deceleration after think/tool/working ends,
  then back to idle.
- **TTS sync**: pulses denser and faster while [pi-ext-tts-mimo] plays speech
  (idle 10 FPS → 30 FPS while speaking).
- **Sub-agent activity** (via pi-subagents): reuses the tool animation on
  `subagents:started` / `subagents:completed` / `subagents:failed`.
- **Stars animation enhancements**:
  - Shape-switch hand-off transitions — each cycle split into three phases
    (draw 40% edge-by-edge + scale 0.45→1.0, hold 45%, shrink 15%), so a new
    shape grows from the old one's radius with continuous visuals.
  - Center breathing — 2×2 dot cluster at the sphere center pulses 1→4 dots on
    a sine phase (`breathSpeed`, default 0.04 ≈ one breath per 2.6 s).
  - Fixed counter-clockwise rotation, independent of the config `dir` flow.
- **Plugin architecture** (`animations/` + `lib/`): each animation is a plugin
  behind a unified interface; new animation = new file + one registry line;
  swap animations by editing `config.json`, no code changes.
- **Preview assets**: `demo.svg` (four-state simulation from the actual render
  code) and `stars-preview.svg` (7 shapes + center breathing dots).
- **Smoke tests**: `scripts/smoke.ts` — 66 assertions covering shape-sequence
  looping, drawing progress, speed-freeze deceleration, param override,
  7-shape completeness, instance isolation, and center-point presence.

### Changed

- Think-state color: `#FF3D00` → `#FF1744` → `#FFAB00` (bright amber, more
  visible on dark backgrounds).
- Tool-state animation: swirl/anti-swirl experiments reverted in favor of the
  uniform clockwise orbital particle ring; particle count tuned
  39 → 63 → 80 (4 layers × 20 dots).
- demo.svg regenerated to match the real frame rate and tool state.
- README rewritten: English main + new Chinese version (`README.zh.md`).

### Fixed

- Particle flow rotation direction became unreadable (aliasing + symmetry) —
  fixed so spin direction reads clearly.
- Swirl arm direction now follows the rotation direction (trailing arms).
- `agent_end` safety net for thinking; deduplicated redraws during pause.
- Working state not stopping after the stream ended.
- demo.svg tool state rendered as orbital particle flow (80 particles);
  render refactored into advance → render two phases.

### Removed

- `.rpiv/artifacts` planning artifacts from the repository (added to
  `.gitignore`); source video `pi-javise.mov` excluded via `.gitignore`.

[pi-ext-tts-mimo]: https://github.com/fan56/pi-ext-tts-mimo
[Unreleased]: https://github.com/fan56/pi-jarvis-sphere/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/fan56/pi-jarvis-sphere/releases/tag/v1.0.0
