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

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// 热力阶梯:think level 越高颜色越"热"(用户选定方案)
const LEVEL_COLOR: Record<ThinkingLevel, [number, number, number]> = {
  off:     [0x55, 0x55, 0x55],
  minimal: [0x4f, 0xc3, 0xf7],
  low:     [0x00, 0xe5, 0xff],
  medium:  [0x76, 0xff, 0x03],
  high:    [0xff, 0xeb, 0x3b],
  xhigh:   [0xff, 0x98, 0x00],
  max:     [0xff, 0x3d, 0x00],
};

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
  private thinkLevel: ThinkingLevel = "off";
  // thinking 环形动画状态机:none(呼吸/脉冲) | cw(顺时针环转) | pause(停) | ccw(逆时针)
  private thinkingPhase: "none" | "cw" | "pause" | "ccw" = "none";
  private spin = 0; // 环形粒子的累计角度(弧度)
  private phaseDeadline = 0; // 当前 phase 的结束时间戳(ms)
  private readonly SPIN_SPEED = 0.35; // 每个节拍(≈30FPS)的角度增量

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

  /** think level 变化时调用 -> 更新球体颜色 */
  setThinkLevel(level: ThinkingLevel): void {
    if (this.thinkLevel !== level) {
      this.thinkLevel = level;
      this.tui.requestRender();
    }
  }

  /** LLM 开始思考:顺时针环形运动 */
  onThinkingStart(): void {
    this.thinkingPhase = "cw";
    this.tui.requestRender();
  }

  /** LLM 结束思考:先停 0.5s,再逆时针 0.7s,然后回到呼吸/脉冲态 */
  onThinkingEnd(): void {
    this.thinkingPhase = "pause";
    this.phaseDeadline = Date.now() + 500;
    this.tui.requestRender();
  }

  private tick(): void {
    this.frame++;
    const now = Date.now();

    // 结束思考后的过渡:pause 0.5s -> ccw 0.7s -> none
    if (this.thinkingPhase === "pause" && now >= this.phaseDeadline) {
      this.thinkingPhase = "ccw";
      this.phaseDeadline = now + 700;
    } else if (this.thinkingPhase === "ccw" && now >= this.phaseDeadline) {
      this.thinkingPhase = "none";
    }

    const orbital = this.thinkingPhase !== "none";
    if (orbital) {
      // y 轴向下的屏幕坐标里,角度递增 = 顺时针
      if (this.thinkingPhase === "cw") this.spin += this.SPIN_SPEED;
      else if (this.thinkingPhase === "ccw") this.spin -= this.SPIN_SPEED;
      // pause:spin 不变(粒子保持位置)
      this.tui.requestRender();
    } else {
      const every = this.speaking ? 1 : 3; // 说话 ~30FPS / 空闲 ~10FPS
      if (this.frame % every === 0) {
        this.phase += this.speaking ? 0.45 : 0.16;
        this.tui.requestRender();
      }
    }
  }

  render(width: number): string[] {
    const [r, g, b] = LEVEL_COLOR[this.thinkLevel] ?? LEVEL_COLOR.off;
    const open = `\x1b[38;2;${r};${g};${b}m`;
    const close = "\x1b[0m";
    const raw =
      this.thinkingPhase !== "none" ? this.renderOrbital(width) : this.renderRadial(width);
    return raw.map((line) => `${open}${line}${close}`);
  }

  /** 呼吸/说话态:径向盲文球(原 render 逻辑),返回未着色行 */
  private renderRadial(width: number): string[] {
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

  /** thinking 状态:粒子绕环运动(cw/pause/ccw 由 spin 决定方向) */
  private renderOrbital(width: number): string[] {
    const w = Math.max(8, width);
    const rows = Math.max(4, Math.round(w / 2));
    const dotCols = w * 2;
    const dotRows = rows * 4;
    const cx = dotCols / 2;
    const cy = dotRows / 2;
    const R = Math.min(dotCols, dotRows) / 2 - 1;

    const codes: number[] = new Array(rows * w).fill(BRAILLE_BASE);
    const setDot = (px: number, py: number) => {
      const dx = Math.round(px);
      const dy = Math.round(py);
      if (dx < 0 || dy < 0 || dx >= dotCols || dy >= dotRows) return;
      const col = Math.floor(dx / 2);
      const row = Math.floor(dy / 4);
      codes[row * w + col] |= BRAILLE_BITS[dy % 4][dx % 2];
    };

    // 微弱中心点
    setDot(cx, cy);
    // 环形粒子:每个粒子按 (基础角 + spin) 定位
    const N = Math.max(10, Math.round(R * 2.4));
    for (let i = 0; i < N; i++) {
      const a = (i * 2 * Math.PI) / N + this.spin;
      setDot(cx + R * Math.cos(a), cy + R * Math.sin(a));
    }

    const lines: string[] = [];
    for (let row = 0; row < rows; row++) {
      let line = "";
      for (let col = 0; col < w; col++) line += String.fromCharCode(codes[row * w + col]);
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
    (tui: TUI) => {
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

  // 挂载时同步当前 think level
  const lvl = (ctx as any)?.thinkingLevel ?? pi.getThinkingLevel?.() ?? "off";
  sphere?.setThinkLevel(lvl as ThinkingLevel);
}

function stopSphere(): void {
  unbindEvents();
  sphere?.dispose();
  sphere = null;
  // 注意:不调用 custom() 的 done() 回调。框架的 close()→tui.hideOverlay() 会
  // 弹出 overlayStack 栈顶(不一定是本球),若此时有别的浮层(如 /tts 对话框)在
  // 上方,会误关那个浮层。handle.hide() 已按身份从栈中移除本球,dispose 已清定时器,
  // 这就是完整的清理;custom() 的 Promise 无人 await,留着不 resolve 无副作用。
  if (handle) {
    try {
      handle.hide();
    } catch {
      // handle 已失效 => 忽略
    }
    handle = null;
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

  // thinking 信号(参照 pi-think-panel / pi-powerline-footer)。引用模块级 sphere,未挂载时为 null 自动 no-op。
  pi.on("message_update", (event: any, ctx: any) => {
    if (ctx?.mode !== "tui") return;
    const t = event?.assistantMessageEvent?.type;
    if (t === "thinking_start") sphere?.onThinkingStart();
    else if (t === "thinking_end") sphere?.onThinkingEnd();
  });

  pi.on("thinking_level_select", (event: any, ctx: any) => {
    if (ctx?.mode !== "tui") return;
    sphere?.setThinkLevel(event?.level ?? "off");
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
