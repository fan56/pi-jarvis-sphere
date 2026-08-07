/**
 * Jarvis 粒子球浮层 for Pi
 *
 * 一个 nonCapturing 浮动 overlay,渲染盲文粒子球。三种状态,固定颜色:
 *   - idle(绿): 径向球 + 中心水波纹,静默时 ~10FPS,说话时 ~30FPS 脉冲。
 *   - think(红): 逆时针均匀粒子流(微分转速:内慢外快),LLM 思考时。
 *   - tool (黄): 顺时针均匀粒子流(微分转速:内慢外快),工具调用时。
 *
 * 状态结束后:粒子流在 1s 内线性减速回 idle;期间若有新事件(think/tool)
 * 直接跳到新状态,跳过减速动画。
 *
 * 信号源:
 *   - TTS: pi-ext-tts-mimo 发出的 pi.events "tts:started"/"tts:stopped"
 *   - think: pi.on("message_update") assistantMessageEvent.type
 *   - tool:  pi.on("tool_execution_start"/"tool_execution_end")
 *   - 安全网: pi.on("agent_end")(结束事件丢失时也走减速)
 *
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

// 三态固定色(用户选定):idle 绿 / think 红 / tool 黄
const IDLE_COLOR: [number, number, number] = [0x00, 0xe6, 0x76];
const THINK_COLOR: [number, number, number] = [0xff, 0x3d, 0x00];
const TOOL_COLOR: [number, number, number] = [0xff, 0xeb, 0x3b];

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

// 每个点的稳定噪声:同一个 (dx,dy) 哈希值不变,避免逐帧随机抖动
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
	// 三态: idle(绿/水波纹) | think(红/逆时针流) | tool(黄/顺时针流)
	private state: "idle" | "think" | "tool" = "idle";
	// 粒子流方向: none(静止) | cw | ccw | decel(1s 内线性减速)
	private flow: "none" | "cw" | "ccw" | "decel" = "none";
	private spin = 0; // 粒子流累计角度(rad)
	private decelStart = 0; // 减速开始时间戳(ms)
	private decelDir = 1; // 减速前的旋转方向(1=顺时针, -1=逆时针)
	private readonly SPIN_SPEED = 0.15; // 满速每 tick 角度增量(≈0.72 转/s;远低于 16 点距 22.5°,避免混叠,方向可辨)

	constructor(tui: TUI) {
		this.tui = tui;
		// ~30FPS 基础节拍;idle 时每 3 帧才推进+重绘(=> ~10FPS),省 CPU
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

	/** LLM 开始思考 -> 逆时针红色粒子流 */
	onThinkingStart(): void {
		if (this.state === "think") return;
		this.state = "think";
		this.flow = "ccw";
		this.decelStart = 0;
		console.log("[jarvis] thinking start -> ccw (red)");
		this.tui.requestRender();
	}

	/** 工具调用开始 -> 顺时针黄色粒子流 */
	onToolStart(): void {
		if (this.state === "tool") return;
		this.state = "tool";
		this.flow = "cw";
		this.decelStart = 0;
		console.log("[jarvis] tool start -> cw (yellow)");
		this.tui.requestRender();
	}

	/** LLM 结束思考 -> 1s 内减速回 idle */
	onThinkingEnd(): void {
		if (this.state === "think") this.beginDecel();
	}

	/** 工具调用结束 -> 1s 内减速回 idle */
	onToolEnd(): void {
		if (this.state === "tool") this.beginDecel();
	}

	/** 异常安全网(agent_end):若仍在流动(结束事件丢失)也走减速收尾 */
	abortThinking(): void {
		if (this.state !== "idle" && (this.flow === "cw" || this.flow === "ccw")) {
			this.beginDecel();
		}
	}

	private beginDecel(): void {
		this.decelDir = this.flow === "ccw" ? -1 : 1;
		this.flow = "decel";
		this.decelStart = Date.now();
		console.log("[jarvis] state end -> decel (1s)");
		this.tui.requestRender();
	}

	private tick(): void {
		this.frame++;
		const now = Date.now();

		// 减速:1s 内速度线性降到 0,然后回 idle
		if (this.flow === "decel") {
			const velFactor = 1 - (now - this.decelStart) / 1000;
			if (velFactor <= 0) {
				this.state = "idle";
				this.flow = "none";
				this.decelStart = 0;
				console.log("[jarvis] decel -> idle (green)");
			} else {
				this.spin += this.SPIN_SPEED * this.decelDir * velFactor;
			}
			this.tui.requestRender();
			return;
		}

		// 粒子流:y 轴向下的屏幕坐标里,角度递增 = 顺时针
		if (this.flow === "cw" || this.flow === "ccw") {
			this.spin += this.flow === "cw" ? this.SPIN_SPEED : -this.SPIN_SPEED;
			this.tui.requestRender();
			return;
		}

		// idle:水波纹 + 呼吸,按帧率节流(说话 30FPS / 空闲 10FPS)
		const every = this.speaking ? 1 : 3;
		if (this.frame % every === 0) {
			this.phase += this.speaking ? 0.45 : 0.16;
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const [r, g, b] =
			this.state === "idle"
				? IDLE_COLOR
				: this.state === "think"
					? THINK_COLOR
					: TOOL_COLOR;
		const open = `\x1b[38;2;${r};${g};${b}m`;
		const close = "\x1b[0m";
		const raw =
			this.state === "idle"
				? this.renderRadial(width)
				: this.renderVortex(width);
		return raw.map((line) => `${open}${line}${close}`);
	}

	/** idle 态:径向盲文球 —— 中心水波纹(波峰环向外扩散)+ 外围稀疏粒子光晕 */
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
						// 水波纹:波峰环从中心向外扩散(phase 推进 => dist 更大的环点亮)
						const wave = Math.sin(dist * 1.2 - this.phase * 2.0);
						let on = false;
						if (dist <= coreR) {
							on = wave > 0.3; // 中心:水波纹环(取代实心核,有动画)
						} else if (dist <= R) {
							// 外围:粒子光晕(越靠外越稀疏)+ 波纹微调
							const edge = (dist - coreR) / (R - coreR);
							on =
								dotHash(dx, dy) < density * (1 - edge * 0.6) &&
								wave > -0.15;
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

	/** think/tool 态:漩涡(ARMS 条螺旋臂绕中心旋转),方向由 flow 决定 */
	private renderVortex(width: number): string[] {
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

		// 漩涡:9 条螺旋臂从内半径旋向外缘,中心留空;整幅绕中心刚体旋转。
		// 臂的旋向跟随旋转方向(拖尾臂):顺时针旋转时臂逆时针外卷,逆时针旋转时反之。
		const R_in = R * 0.35; // 中心留空
		const R_out = R * 0.95;
		const ARMS = 9;
		const SWEEP = 0.55; // 每条臂角程 ≈31.5°(< 40° 臂间距,臂不重叠)
		// 拖尾臂方向:顺时针(spin 增大)外卷用 -1,逆时针用 +1;减速沿用减速前方向
		const dir = this.flow === "cw" ? -1 : this.flow === "ccw" ? 1 : -this.decelDir;
		for (let i = 0; i < ARMS; i++) {
			const phi0 = (i / ARMS) * 2 * Math.PI + this.spin;
			for (let r = R_in; r <= R_out; r += 0.9) {
				const a = phi0 + dir * SWEEP * ((r - R_in) / (R_out - R_in));
				setDot(cx + r * Math.cos(a), cy + r * Math.sin(a));
			}
		}

		const lines: string[] = [];
		for (let row = 0; row < rows; row++) {
			let line = "";
			for (let col = 0; col < w; col++)
				line += String.fromCharCode(codes[row * w + col]);
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
		pi.events.on("tts:started", (() => {
			sphere?.setSpeaking(true);
		}) as (data: unknown) => void),
		pi.events.on("tts:stopped", (() => {
			sphere?.setSpeaking(false);
		}) as (data: unknown) => void),
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

	// thinking 信号:think = 逆时针红流。引用模块级 sphere,未挂载时为 null 自动 no-op。
	pi.on("message_update", (event: any, ctx: any) => {
		if (ctx?.mode !== "tui") return;
		const t = event?.assistantMessageEvent?.type;
		if (t === "thinking_start") sphere?.onThinkingStart();
		else if (t === "thinking_end") sphere?.onThinkingEnd();
	});

	// 工具调用信号:tool = 顺时针黄流
	pi.on("tool_execution_start", (_event: any, ctx: any) => {
		if (ctx?.mode !== "tui") return;
		sphere?.onToolStart();
	});
	pi.on("tool_execution_end", (_event: any, ctx: any) => {
		if (ctx?.mode !== "tui") return;
		sphere?.onToolEnd();
	});

	// 异常安全网:agent 结束若仍在流动(thinking/tool 结束事件丢失)则减速回 idle
	pi.on("agent_end", (_event: any, ctx: any) => {
		if (ctx?.mode !== "tui") return;
		sphere?.abortThinking();
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
