/**
 * Jarvis 粒子球浮层 for Pi
 *
 * 一个 nonCapturing 浮动 overlay,渲染盲文粒子球。四种状态,固定颜色:
 *   - idle(绿): curl noise 慢流场 + 中心水波纹,静默 ~10FPS,说话 ~30FPS 脉冲。
 *   - think(红): 粒子折射(慢速折线,边界反射+内部随机折射),LLM 思考时。
 *   - tool (黄): 顺时针均匀粒子流(等角分布,中心留空,微分转速:内慢外快),工具调用时。
 *   - working(青): 粒子折射(快速折线),模型流式输出答案时。
 *
 * 渲染核心:idle 用 curl noise 流场驱动持久化粒子(curl noise 是无散度
 * (divergence-free)速度场,粒子沿 noise 等高线形成长而扭转的流线,永不收敛
 * 到一点,产生流体涡旋感;粒子在圆内重生,生命周期 sin 渐变(首尾淡出))。
 * think/working 用粒子折射:粒子在圆内线性运动,遇边界反射、小概率内部
 * 随机折射,折射点连成折线(光线折射/闪电感),3-6 次折射后重生。
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
 *   - subagent: pi.events "subagents:started"/"subagents:completed"/"subagents:failed"
 *     (pi-subagents 在父会话 bus 上 emit,复用 tool 动画)
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
	const xi = Math.floor(x),
		yi = Math.floor(y);
	const xf = x - xi,
		yf = y - yi;
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
	const dX =
		(valueNoise(x + delta, y) - valueNoise(x - delta, y)) / (2 * delta);
	const dY =
		(valueNoise(x, y + delta) - valueNoise(x, y - delta)) / (2 * delta);
	return [dY, -dX];
}

// 流场粒子:dot 网格连续坐标 + 生命周期
interface Particle {
	x: number;
	y: number;
	age: number;
	life: number;
}

// --- 折射粒子:圆内运动,边界反射+内部随机折射,折线连成光线感(think/working) ---

interface RefractParticle {
	px: number;
	py: number; // 当前位置(dot 网格坐标)
	vx: number;
	vy: number; // 单位方向向量
	pts: number[]; // 折射点 flat 坐标 [x0,y0,x1,y1,...]
	bounces: number; // 已折射次数
	maxBounces: number; // 3-6 随机
}

const REFRACT_COUNT = 16;

// 生成/重生折射粒子:圆内随机位置 + 随机单位方向,折线点重置
function spawnRefract(
	p: RefractParticle,
	cx: number,
	cy: number,
	R: number,
): void {
	// 圆内均匀随机位置(√rand 保证面积均匀)
	const a = Math.random() * 6.2831853;
	const r = Math.sqrt(Math.random()) * R * 0.6;
	p.px = cx + r * Math.cos(a);
	p.py = cy + r * Math.sin(a);
	const d = Math.random() * 6.2831853;
	p.vx = Math.cos(d);
	p.vy = Math.sin(d);
	p.pts = [p.px, p.py];
	p.bounces = 0;
	p.maxBounces = 3 + ((Math.random() * 4) | 0); // 3,4,5,6
}

// 推进折射粒子一步:线性位移;出界 => 圆边界反射;小概率 => 内部随机折射
function stepRefract(
	p: RefractParticle,
	cx: number,
	cy: number,
	R: number,
	speed: number,
): void {
	p.px += p.vx * speed;
	p.py += p.vy * speed;
	// 圆边界反射:法线 = (粒子-圆心).normalize
	const dx = p.px - cx,
		dy = p.py - cy;
	const d2 = dx * dx + dy * dy;
	if (d2 > R * R) {
		const d = Math.sqrt(d2);
		const nx = dx / d,
			ny = dy / d;
		const dot = p.vx * nx + p.vy * ny;
		p.vx -= 2 * dot * nx;
		p.vy -= 2 * dot * ny;
		p.px = cx + nx * R * 0.97;
		p.py = cy + ny * R * 0.97;
		p.pts.push(p.px, p.py);
		p.bounces++;
		if (p.bounces >= p.maxBounces) spawnRefract(p, cx, cy, R);
	} else if (Math.random() < 0.02) {
		// 随机内部折射:±~70° 偏转
		const ang = (Math.random() - 0.5) * 2.4;
		const c = Math.cos(ang),
			s = Math.sin(ang);
		const nvx = p.vx * c - p.vy * s;
		const nvy = p.vx * s + p.vy * c;
		p.vx = nvx;
		p.vy = nvy;
		p.pts.push(p.px, p.py);
		p.bounces++;
		if (p.bounces >= p.maxBounces) spawnRefract(p, cx, cy, R);
	}
}

// Bresenham 画线:在盲文 codes 数组上画 (x0,y0)->(x1,y1) 线段
function lineDot(
	codes: number[],
	w: number,
	dotCols: number,
	dotRows: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
): void {
	let x = Math.round(x0),
		y = Math.round(y0);
	const ex = Math.round(x1),
		ey = Math.round(y1);
	const adx = Math.abs(ex - x),
		ady = Math.abs(ey - y);
	const sx = x < ex ? 1 : -1,
		sy = y < ey ? 1 : -1;
	let err = adx - ady;
	while (true) {
		if (x >= 0 && y >= 0 && x < dotCols && y < dotRows) {
			codes[(y >> 2) * w + (x >> 1)] |= BRAILLE_BITS[y & 3][x & 1];
		}
		if (x === ex && y === ey) break;
		const e2 = 2 * err;
		if (e2 > -ady) {
			err -= ady;
			x += sx;
		}
		if (e2 < adx) {
			err += adx;
			y += sy;
		}
	}
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
	private spin = 0; // 轨道粒子流累计角度(rad),tool 态用
	private readonly SPIN_SPEED = 0.15; // 满速每 tick 角度增量(≈0.72 转/s;远低于 16 点距 22.5°,避免混叠,方向可辨)
	private decelStart = 0; // 减速开始时间戳(ms)
	private decelTarget: "idle" | "working" = "idle"; // 减速结束后的目标态
	private decelDir = 1; // 减速前的流场方向(记忆 fieldDir,减速期间保持)
	// curl noise 流场粒子系统(持久化,状态切换时只调参不重建)
	private particles: Particle[] = [];
	private fieldSpeed = 0.06; // 粒子位移系数(每 step)
	private fieldDir = 1; // 1=顺时针(curl 正方向), -1=逆时针
	private fieldCount = 120; // 目标粒子数
	private fieldScroll = 0.02; // 噪声场平移速度(流场演变,避免静态)
	// 折射粒子系统(think/working 态):圆内运动,边界反射+内部随机折射,折线渲染
	private refractParticles: RefractParticle[] = [];
	private refractSpeed = 1.04; // 折射位移系数
	private velFactor = 1; // 减速 ease-out 系数(1=全速,0=停止),renderRefract 用

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

	/** 工具调用开始 -> 顺时针黄色粒子流 */
	onToolStart(): void {
		if (this.state === "tool") return;
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
		if (this.flow === "decel") return; // 已在减速中,不重启(双信号防抖: tool_execution_end + subagents:completed)
		this.decelTarget = target;
		this.decelDir = this.flow === "ccw" ? -1 : 1; // 记忆当前旋转方向,减速期间保持
		this.flow = "decel";
		this.decelStart = Date.now();
		this.tui.requestRender();
	}

	private tick(): void {
		this.frame++;
		const now = Date.now();

		// 减速:1s 内 ease-out 速度降到 0,然后落到 decelTarget(idle 或 working)。
		if (this.flow === "decel") {
			const tt = (now - this.decelStart) / 1000;
			if (tt >= 1) {
				this.applyFieldParams(this.decelTarget);
				this.state = this.decelTarget;
				if (this.decelTarget === "working") this.flow = "cw";
				else this.flow = "none";
				this.decelStart = 0;
			} else {
				// 轨道粒子流(tool):减速期间 spin 也减速推进(ease-out)
				this.spin += this.SPIN_SPEED * this.decelDir * (1 - tt) ** 2;
			}
			this.tui.requestRender();
			return;
		}

		// 粒子流(think/tool/working):tool 轨道推进 spin;折射态(think/working)
		// tick 只负责请求重绘(30FPS),粒子在 renderRefract 里推进。
		if (this.flow === "cw" || this.flow === "ccw") {
			this.spin += this.flow === "cw" ? this.SPIN_SPEED : -this.SPIN_SPEED;
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
		// tool -> 轨道粒子流(顺时针,中心留空,内慢外快);think/working -> 折射;idle -> curl noise 流场
		const raw =
			this.state === "tool"
				? this.renderOrbital(width)
				: this.state === "think" || this.state === "working"
					? this.renderRefract(width)
					: this.renderField(width);
		return raw.map((line) => `${open}${line}${close}`);
	}

	/** 四态流场参数(状态切换时调用,不重建粒子,保证平滑过渡) */
	private applyFieldParams(s: "idle" | "think" | "tool" | "working"): void {
		switch (s) {
			case "idle":
				this.fieldSpeed = 0.06;
				this.fieldDir = 1;
				this.fieldCount = 120;
				this.fieldScroll = 0.02;
				break;
			case "think":
				this.refractSpeed = 1.04; // 折射
				break;
			case "working":
				this.refractSpeed = 1.04; // 快速折射
				break;
		}
	}

	/** tool 态:均匀粒子流(等角分布 + 微分转速:内慢外快,中心留空),方向由 flow 决定 */
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

		// 均匀粒子流:3 层等间距半径,每层 16 个等角分布点;中心留空。
		// 角速度 = spin × (r/R):靠内慢、靠外快(微分旋转);方向由 spin 累计方向决定。
		const R_in = R * 0.55;
		const R_out = R * 0.95;
		const LAYERS = 3;
		const PER_LAYER = 16;
		const GAP = 3; // 缺口:每层去掉连续 GAP 个角度(≈67°),打破对称,旋转方向一眼可辨
		for (let l = 0; l < LAYERS; l++) {
			const r = R_in + ((R_out - R_in) * l) / (LAYERS - 1);
			for (let k = 0; k < PER_LAYER - GAP; k++) {
				const a = (k / PER_LAYER) * 2 * Math.PI + this.spin * (r / R);
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

	/** 初始化/调节粒子数:首次在圆内均匀分布;后续按 targetN 增减 */	private ensureParticles(
		cx: number,
		cy: number,
		R: number,
		targetN: number,
	): void {
		if (this.particles.length === 0) {
			for (let i = 0; i < targetN; i++) {
				// 圆内均匀随机分布(√rand 保证面积均匀)
				const r0 = Math.sqrt(Math.random()) * R * 0.9;
				const a0 = Math.random() * 6.2831853;
				this.particles.push({
					x: cx + r0 * Math.cos(a0),
					y: cy + r0 * Math.sin(a0),
					age: Math.random() * 100,
					life: 80 + Math.random() * 80,
				});
			}
		} else if (this.particles.length < targetN) {
			// 不足:追加圆内随机位置粒子
			for (let i = this.particles.length; i < targetN; i++) {
				const r1 = Math.sqrt(Math.random()) * R * 0.85;
				const a1 = Math.random() * 6.2831853;
				this.particles.push({
					x: cx + r1 * Math.cos(a1),
					y: cy + r1 * Math.sin(a1),
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
			// 圆边界:粒子超出半径 R 或寿终则重生
			const dx2 = p.x - cx,
				dy2 = p.y - cy;
			if (dx2 * dx2 + dy2 * dy2 > R * R || p.age > p.life) {
				const r2 = Math.sqrt(Math.random()) * R * 0.85;
				const a2 = Math.random() * 6.2831853;
				p.x = cx + r2 * Math.cos(a2);
				p.y = cy + r2 * Math.sin(a2);
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
							const dx = col * 2 + dc,
								dy = row * 4 + dr;
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

	/** 折射粒子渲染:圆内运动,边界反射+内部随机折射,折线连成光线/闪电感 */
	private renderRefract(width: number): string[] {
		const w = Math.max(6, width);
		const rows = Math.max(4, Math.round(w / 2));
		const dotCols = w * 2;
		const dotRows = rows * 4;
		const cx = dotCols / 2;
		const cy = dotRows / 2;
		const R = Math.min(dotCols, dotRows) / 2 - 1;

		// 首次初始化折射粒子
		if (this.refractParticles.length === 0) {
			for (let i = 0; i < REFRACT_COUNT; i++) {
				const p: RefractParticle = {
					px: 0,
					py: 0,
					vx: 0,
					vy: 0,
					pts: [],
					bounces: 0,
					maxBounces: 3,
				};
				spawnRefract(p, cx, cy, R);
				this.refractParticles.push(p);
			}
		}

		// 减速 ease-out 系数(与 stepParticles 同逻辑),renderRefract 用
		if (this.flow === "decel") {
			const tt = (Date.now() - this.decelStart) / 1000;
			this.velFactor = Math.max(0, (1 - tt) ** 2);
		} else {
			this.velFactor = 1;
		}

		// 推进粒子
		const speed = this.refractSpeed * this.velFactor;
		for (const p of this.refractParticles) stepRefract(p, cx, cy, R, speed);

		// 渲染折线:连接所有折射点 + 最后折射点到当前位置
		const codes: number[] = new Array(rows * w).fill(BRAILLE_BASE);
		for (const p of this.refractParticles) {
			for (let i = 0; i < p.pts.length - 2; i += 2) {
				lineDot(
					codes,
					w,
					dotCols,
					dotRows,
					p.pts[i],
					p.pts[i + 1],
					p.pts[i + 2],
					p.pts[i + 3],
				);
			}
			const last = p.pts.length - 2;
			if (last >= 0)
				lineDot(
					codes,
					w,
					dotCols,
					dotRows,
					p.pts[last],
					p.pts[last + 1],
					p.px,
					p.py,
				);
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
		// sub-agent 信号(pi-subagents 在父会话 bus 上 emit):复用 tool 动画
		pi.events.on("subagents:started", (() => {
			sphere?.onToolStart();
		}) as (data: unknown) => void),
		pi.events.on("subagents:completed", (() => {
			sphere?.onToolEnd();
		}) as (data: unknown) => void),
		pi.events.on("subagents:failed", (() => {
			sphere?.onToolEnd();
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
