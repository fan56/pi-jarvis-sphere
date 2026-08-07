/**
 * Jarvis 粒子球浮层 for Pi
 *
 * 一个 nonCapturing 浮动 overlay,渲染盲文粒子球。四种状态,固定颜色:
 *   - idle(绿): curl noise 慢流场 + 中心水波纹,静默 ~10FPS,说话 ~30FPS 脉冲。
 *   - think(红): curl noise 逆时针涡流(高速),LLM 思考时。
 *   - tool (黄): curl noise 顺时针涡流(高速),工具调用时。
 *   - working(青): curl noise 顺时针涡流(更高速),模型流式输出答案时。
 *
 * 渲染核心:curl noise 流场驱动持久化粒子。curl noise 是无散度(divergence-
 * free)速度场,粒子沿 noise 等高线形成长而扭转的流线,永不收敛到一点,产生
 * 流体涡旋感。粒子在圆盘内重生,生命周期 sin 渐变(首尾淡出)。
 *
 * 状态结束后:粒子流在 1s 内 ease-out 减速回 idle(agent_end 收尾)或 working
 * (think/tool 结束、模型接着输出答案);期间若有新事件直接跳到新状态,
 * 跳过减速动画。状态切换时只调 field 参数(fieldSpeed/fieldDir/fieldCount/
 * fieldScroll),不重建粒子,保证平滑过渡。
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

// 四态固定色(用户选定):idle 绿 / think 红 / tool 黄 / working 青
const IDLE_COLOR: [number, number, number] = [0x00, 0xe6, 0x76];
const THINK_COLOR: [number, number, number] = [0xff, 0xab, 0x00];
const TOOL_COLOR: [number, number, number] = [0xff, 0xeb, 0x3b];
const WORKING_COLOR: [number, number, number] = [0x00, 0xe5, 0xff];

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

// --- curl noise 流场:整数哈希 -> 值噪声 -> 无散度速度场 ---

// 整数格点哈希 -> [0,1)
function hash2(x: number, y: number): number {
	let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
	h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
	return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

// 2D 值噪声:整数格点 smoothstep 双线性插值,返回 [0,1)
function valueNoise(x: number, y: number): number {
	const xi = Math.floor(x), yi = Math.floor(y);
	const xf = x - xi, yf = y - yi;
	const u = xf * xf * (3 - 2 * xf);
	const v = yf * yf * (3 - 2 * yf);
	const a = hash2(xi, yi);
	const b = hash2(xi + 1, yi);
	const c = hash2(xi, yi + 1);
	const d = hash2(xi + 1, yi + 1);
	return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// 2D curl of scalar noise -> divergence-free 速度场 [vx, vy]
// 梯度 (dX,dY) 旋转 90° = (dY, -dX)
function curl2D(x: number, y: number, delta: number): [number, number] {
	const dX = (valueNoise(x + delta, y) - valueNoise(x - delta, y)) / (2 * delta);
	const dY = (valueNoise(x, y + delta) - valueNoise(x, y - delta)) / (2 * delta);
	return [dY, -dX];
}

// 流场粒子:dot 网格连续坐标 + 生命周期
interface Particle {
	x: number; y: number;
	age: number; life: number;
}

class JarvisSphereComponent implements Component {
	private tui: TUI;
	private interval: ReturnType<typeof setInterval> | null = null;
	private phase = 0;
	private frame = 0;
	speaking = false;
	// 四态: idle(绿/水波纹) | think(红/逆时针流) | tool(黄/顺时针流) | working(青/顺时针流)
	private state: "idle" | "think" | "tool" | "working" = "idle";
	// 粒子流方向: none(静止/idle) | cw | ccw | decel(1s 内 ease-out 减速)
	private flow: "none" | "cw" | "ccw" | "decel" = "none";
	private decelStart = 0; // 减速开始时间戳(ms)
	private decelTarget: "idle" | "working" = "idle"; // 减速结束后的目标态
	private decelDir = 1; // 减速前的流场方向(记忆 fieldDir,减速期间保持)
	// curl noise 流场粒子系统(持久化,状态切换时只调参不重建)
	private particles: Particle[] = [];
	private fieldSpeed = 0.06; // 粒子位移系数(每 step)
	private fieldDir = 1; // 1=顺时针(curl 正方向), -1=逆时针
	private fieldCount = 85; // 目标粒子数
	private fieldScroll = 0.02; // 噪声场平移速度(流场演变,避免静态)

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

	/** LLM 开始思考 -> 逆时针红色涡流 */
	onThinkingStart(): void {
		if (this.state === "think") return;
		this.applyFieldParams("think");
		this.state = "think";
		this.flow = "ccw";
		this.decelStart = 0;
		this.tui.requestRender();
	}

	/** 工具调用开始 -> 顺时针黄色涡流 */
	onToolStart(): void {
		if (this.state === "tool") return;
		this.applyFieldParams("tool");
		this.state = "tool";
		this.flow = "cw";
		this.decelStart = 0;
		this.tui.requestRender();
	}

	/** 答案流开始(text_delta 首帧) -> 顺时针青色涡流;幂等:仅在状态切换时生效 */
	onTextDelta(): void {
		// 减速中:跳过剩余减速直接跳 working(established rule:新事件直达新状态);
		// 非减速:仅当已处于活跃的 think/tool/working 流时才 no-op。
		if (this.flow !== "decel") {
			if (
				this.state === "think" ||
				this.state === "tool" ||
				this.state === "working"
			)
				return;
		}
		this.applyFieldParams("working");
		this.state = "working";
		this.flow = "cw";
		this.decelStart = 0;
		this.tui.requestRender();
	}

	/** LLM 结束思考 -> 1s 内减速;结束后模型流式输出答案 -> working(青/顺时针) */
	onThinkingEnd(): void {
		if (this.state === "think") this.beginDecel("working");
	}

	/** 工具调用结束 -> 1s 内减速;结束后模型流式输出答案 -> working(青/顺时针) */
	onToolEnd(): void {
		if (this.state === "tool") this.beginDecel("working");
	}

	/** 异常安全网(agent_end):若仍在流动(结束事件丢失)也走减速收尾回 idle */
	abortThinking(): void {
		if (this.state === "idle") return;
		if (this.flow === "decel") {
			// 减速中(think/tool 结束的 1s 窗口内):把落点改回 idle,避免落到 working 永转
			this.decelTarget = "idle";
			return;
		}
		this.beginDecel("idle");
	}

	private beginDecel(target: "idle" | "working" = "idle"): void {
		this.decelTarget = target;
		this.decelDir = this.fieldDir; // 记忆当前流场方向,减速期间保持
		this.flow = "decel";
		this.decelStart = Date.now();
		this.tui.requestRender();
	}

	private tick(): void {
		this.frame++;
		const now = Date.now();

		// 减速:1s 内 ease-out 速度降到 0,然后落到 decelTarget(idle 或 working)。
		// 粒子 step 在 renderField 里用 fieldSpeed * velFactor * decelDir 推进。
		if (this.flow === "decel") {
			const tt = (now - this.decelStart) / 1000;
			if (tt >= 1) {
				this.applyFieldParams(this.decelTarget);
				this.state = this.decelTarget;
				if (this.decelTarget === "working") this.flow = "cw";
				else this.flow = "none";
				this.decelStart = 0;
			}
			this.tui.requestRender();
			return;
		}

		// 粒子流(think/tool/working):stepParticles 在 renderField 里推进,
		// tick 只负责请求重绘(30FPS)。
		if (this.flow === "cw" || this.flow === "ccw") {
			this.tui.requestRender();
			return;
		}

		// idle:水波纹 + 慢流场,按帧率节流(说话 30FPS / 空闲 10FPS)
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
					: this.state === "tool"
						? TOOL_COLOR
						: WORKING_COLOR;
		const open = `\x1b[38;2;${r};${g};${b}m`;
		const close = "\x1b[0m";
		const raw = this.renderField(width);
		return raw.map((line) => `${open}${line}${close}`);
	}

	/** 四态流场参数(状态切换时调用,不重建粒子,保证平滑过渡) */
	private applyFieldParams(s: "idle" | "think" | "tool" | "working"): void {
		switch (s) {
			case "idle":
				this.fieldSpeed = 0.06; this.fieldDir = 1; this.fieldCount = 85; this.fieldScroll = 0.02;
				break;
			case "think":
				this.fieldSpeed = 0.22; this.fieldDir = -1; this.fieldCount = 85; this.fieldScroll = 0.05;
				break;
			case "tool":
				this.fieldSpeed = 0.22; this.fieldDir = 1; this.fieldCount = 85; this.fieldScroll = 0.05;
				break;
			case "working":
				this.fieldSpeed = 0.30; this.fieldDir = 1; this.fieldCount = 85; this.fieldScroll = 0.08;
				break;
		}
	}

	/** 初始化/调节粒子数:首次用 Fibonacci spiral 均匀分布;后续按 targetN 增减 */
	private ensureParticles(cx: number, cy: number, R: number, targetN: number): void {
		if (this.particles.length === 0) {
			for (let i = 0; i < targetN; i++) {
				const r = Math.sqrt((i + 0.5) / targetN) * R * 0.9;
				const a = i * 2.39996323; // golden angle
				this.particles.push({
					x: cx + r * Math.cos(a),
					y: cy + r * Math.sin(a),
					age: Math.random() * 100,
					life: 80 + Math.random() * 80,
				});
			}
		} else if (this.particles.length < targetN) {
			// 不足:追加随机位置粒子
			for (let i = this.particles.length; i < targetN; i++) {
				const a = Math.random() * Math.PI * 2;
				const rr = Math.sqrt(Math.random()) * R * 0.85;
				this.particles.push({
					x: cx + rr * Math.cos(a),
					y: cy + rr * Math.sin(a),
					age: 0,
					life: 80 + Math.random() * 80,
				});
			}
		} else if (this.particles.length > targetN) {
			// 多余:截断(简化;视觉影响小,粒子为稀疏点)
			this.particles.length = targetN;
		}
	}

	/** 推进粒子一步:沿 curl noise 流场位移,超界/寿终重生 */
	private stepParticles(cx: number, cy: number, R: number): void {
		const delta = 0.8;
		const t = this.frame;
		const scrollX = t * this.fieldScroll;
		const scrollY = t * this.fieldScroll * 0.7;
		const noiseScale = 0.15;

		// 减速期间:ease-out 速度衰减,方向保持 decelDir
		let speed = this.fieldSpeed;
		let dir = this.fieldDir;
		if (this.flow === "decel") {
			const now = Date.now();
			const tt = (now - this.decelStart) / 1000;
			const velFactor = Math.max(0, (1 - tt) ** 2);
			speed = this.fieldSpeed * velFactor;
			dir = this.decelDir;
		}

		for (const p of this.particles) {
			const nx = (p.x - cx) * noiseScale + scrollX;
			const ny = (p.y - cy) * noiseScale + scrollY;
			const [vx, vy] = curl2D(nx, ny, delta);
			p.x += vx * speed * dir;
			p.y += vy * speed * dir;
			p.age++;
			const dx = p.x - cx, dy = p.y - cy;
			if (dx * dx + dy * dy > R * R || p.age > p.life) {
				const a = Math.random() * Math.PI * 2;
				const rr = Math.sqrt(Math.random()) * R * 0.85;
				p.x = cx + rr * Math.cos(a);
				p.y = cy + rr * Math.sin(a);
				p.age = 0;
				p.life = 80 + Math.random() * 80;
			}
		}
	}

	/** 统一流场渲染:粒子点 + idle 态中心水波纹 */
	private renderField(width: number): string[] {
		const w = Math.max(6, width);
		const rows = Math.max(4, Math.round(w / 2));
		const dotCols = w * 2;
		const dotRows = rows * 4;
		const cx = dotCols / 2;
		const cy = dotRows / 2;
		const R = Math.min(dotCols, dotRows) / 2 - 1;

		this.ensureParticles(cx, cy, R, this.fieldCount);
		this.stepParticles(cx, cy, R);

		const codes: number[] = new Array(rows * w).fill(BRAILLE_BASE);
		const setDot = (px: number, py: number) => {
			const dx = Math.round(px);
			const dy = Math.round(py);
			if (dx < 0 || dy < 0 || dx >= dotCols || dy >= dotRows) return;
			const col = Math.floor(dx / 2);
			const row = Math.floor(dy / 4);
			codes[row * w + col] |= BRAILLE_BITS[dy % 4][dx % 2];
		};

		// 粒子:生命周期 sin 渐变(首尾淡出,中间最亮);fade > 0.3 才画
		for (const p of this.particles) {
			const fade = Math.sin((p.age / p.life) * Math.PI);
			if (fade > 0.3) setDot(p.x, p.y);
		}

		// idle 态额外画中心微弱水波纹(保留 idle 标识感)
		if (this.state === "idle") {
			const coreR = R * 0.4;
			for (let row = 0; row < rows; row++) {
				for (let col = 0; col < w; col++) {
					for (let dr = 0; dr < 4; dr++) {
						for (let dc = 0; dc < 2; dc++) {
							const dx = col * 2 + dc, dy = row * 4 + dr;
							const dist = Math.hypot(dx - cx, dy - cy);
							if (dist <= coreR) {
								const wave = Math.sin(dist * 1.5 - this.phase * 2.0);
								if (wave > 0.4) codes[row * w + col] |= BRAILLE_BITS[dr][dc];
							}
						}
					}
				}
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
		else if (t === "text_delta") sphere?.onTextDelta();
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
