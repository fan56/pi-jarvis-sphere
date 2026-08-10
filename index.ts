/**
 * Jarvis 粒子球浮层 for Pi
 *
 * 一个 nonCapturing 浮动 overlay,渲染盲文粒子球。四种状态,颜色随主题自适应:
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
 * 跳过减速动画。
 *
 * 动画插件化:每个动画(流场/折射/轨道)是独立插件(animations/*.ts),通过统一
 * AnimationPlugin 接口暴露(闭包持有自己的粒子状态);宿主(本文件)瘦身为状态机 +
 * 槽位调度器,场景 -> 动画由 config.json 的 scenes 映射驱动(改配置即换动画,
 * think/working 为独立动画槽位)。新增动画 = 新建 animations/xxx.ts + registry 登记一行。
 * 换动画 = 改 config.json 的 scenes[scene].animation,不用碰代码。
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

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { computeGrid } from "./lib/geometry.ts";
import type {
	AnimationHost,
	AnimationPlugin,
	FlowDir,
	Grid,
	SceneId,
	SceneParams,
} from "./lib/types.ts";
import {
	DEFAULT_SCENES,
	mergeSceneParams,
	resolveSceneAnimation,
	sanitizeScenesConfig,
} from "./lib/scenes.ts";
import type { ScenesConfig } from "./lib/scenes.ts";
import { getAnimationFactory } from "./animations/registry.ts";

// 用户配置优先(npm 包安装后可编辑):~/.pi/agent/pi-jarvis-sphere.json
// 不存在时回退包内默认 config.json(只读,升级不丢用户配置)
const AGENT_DIR = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const USER_CONFIG_FILE = join(AGENT_DIR, "pi-jarvis-sphere.json");
const PACKAGE_CONFIG_FILE = join(__dirname, "config.json");
const CONFIG_FILE = USER_CONFIG_FILE; // 写入目标始终是用户目录
// overlay 列宽;盲文每格 2 点列 => 28 点宽,与 7 行(28 点高)配成方形球
const WIDTH = 14;

// 双调色板:dark(默认,高饱和亮色)/ light(深色变体,保证白底对比度)
// 四态: idle 绿 / think 红 / tool 黄 / working 青
const DARK_PALETTE = {
	idle: [0x00, 0xe6, 0x76], // 绿
	think: [0xff, 0xab, 0x00], // 琥珀
	tool: [0xff, 0xeb, 0x3b], // 黄
	working: [0x00, 0xe5, 0xff], // 青
};
// light 主题:中明度高饱和(深浊色在浅底上像灰点,色相丢失;鲜亮色对比度 3:1+ 且一眼可辨)
const LIGHT_PALETTE = {
	idle: [0x00, 0x96, 0x5a], // 鲜绿
	think: [0xe8, 0x53, 0x0a], // 鲜橙
	tool: [0xa8, 0x84, 0x00], // 金黄
	working: [0x00, 0x8a, 0xa3], // 鲜青
};

// 判断当前主题是否为 light:内置主题看 name;自定义主题解析背景色亮度
function isLightTheme(theme: Theme): boolean {
	if (theme.name === "light") return true;
	if (theme.name === "dark") return false;
	// 自定义主题:解析 selectedBg 的 ANSI truecolor 前缀
	try {
		const ansi = theme.getBgAnsi("selectedBg");
		const m = ansi.match(/\x1b\[48;2;(\d+);(\d+);(\d+)m/);
		if (m) {
			const lum =
				(0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) /
				255;
			return lum > 0.5;
		}
	} catch {
		// 主题未初始化等 => 默认 dark
	}
	return false;
}

// 解析 "#rgb" / "#rrggbb" 十六进制颜色 => [r,g,b] 0-255;失败返回 null
function hexToRgb(hex: string): [number, number, number] | null {
	const m = hex.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
	if (!m) return null;
	const h = m[1];
	if (h.length === 3) {
		return [
			parseInt(h[0] + h[0], 16),
			parseInt(h[1] + h[1], 16),
			parseInt(h[2] + h[2], 16),
		];
	}
	return [
		parseInt(h.slice(0, 2), 16),
		parseInt(h.slice(2, 4), 16),
		parseInt(h.slice(4, 6), 16),
	];
}

// 相对亮度(0-1,WCAG 线性化):0.2126R + 0.7152G + 0.0722B
function relLum(hex: string): number {
	const rgb = hexToRgb(hex);
	if (!rgb) return 0;
	const weights = [0.2126, 0.7152, 0.0722];
	let lum = 0;
	for (let i = 0; i < 3; i++) {
		let c = rgb[i] / 255;
		c = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		lum += weights[i] * c;
	}
	return lum;
}

// 四态调色板类型:每态 [r,g,b] 0-255
// 从当前主题 JSON 的 vars 提取四态颜色:success→idle、warning→think、
// accent→tool、link→working。统一解析:先读 colors[slot],以 "#" 开头则直接用,
// 否则视为 vars 键名取值;取不到再试 vars[slot] 本身。resolve 变参依次尝试候选槽位
// (link 缺失时用内置主题的 blue/teal 兜底)。四色任一最终为 null => 整体 null(调用方回退)。
// 浅色背景(relLum(bg) > 0.5)下把四色各通道乘 0.55 压暗(保色相,满足"要很深")。
type Palette = {
	idle: [number, number, number];
	think: [number, number, number];
	tool: [number, number, number];
	working: [number, number, number];
};

// 主题文件缓存:sourcePath + mtime 命中则直接返回同一对象引用。
// 目的:1) tick 轮询里 palette !== prev 引用比较在主题未变时恢复为 false,避免
//    每 500ms 无条件 requestRender;2) 避免每 500ms 同步读盘。
// 仅缓存成功结果;解析失败(return null)时同步清空,防止缓存旧值。

let themeCachePath: string | null = null;
let themeCacheMtime = 0;
let themeCacheResult: Palette | null = null;

function readThemePalette(theme: Theme): Palette | null {
	if (!theme.sourcePath) return null; // 无 sourcePath 不进缓存(缓存键是 path 字符串)
	try {
		const st = statSync(theme.sourcePath);
		if (themeCachePath === theme.sourcePath && themeCacheMtime === st.mtimeMs) {
			return themeCacheResult;
		}
		themeCachePath = theme.sourcePath;
		themeCacheMtime = st.mtimeMs;
	} catch {
		// stat 失败(文件被删等)=> 走正常解析,失败回退
	}

	let parsed: {
		vars?: Record<string, string>;
		colors?: Record<string, string>;
	};
	try {
		parsed = JSON.parse(readFileSync(theme.sourcePath, "utf8"));
	} catch {
		themeCacheResult = null;
		return null;
	}
	// JSON 合法但非对象(如文本 "null"/数字/字符串)=> 无 vars/colors 可读,整体回退
	if (!parsed || typeof parsed !== "object") {
		themeCacheResult = null;
		return null;
	}
	const vars = parsed.vars ?? {};
	const colors = parsed.colors ?? {};

	// 统一解析:colors[slot] => (#hex 直接用 | vars 键名) => vars[slot] 兜底;
	// 变参依次尝试多个候选槽位,返回第一个成功的 hex。所有取值都用
	// typeof === "string" 守卫,防止 JSON 里混入 null/数字/对象时 .startsWith 抛 TypeError。
	const resolve = (...slots: string[]): string | null => {
		for (const slot of slots) {
			const direct = colors[slot];
			if (typeof direct === "string") {
				if (direct.startsWith("#")) {
					if (hexToRgb(direct)) return direct;
				} else {
					// 非 # 开头 => 视为 vars 键名,取 vars[direct]
					const viaVar = vars[direct];
					if (
						typeof viaVar === "string" &&
						viaVar.startsWith("#") &&
						hexToRgb(viaVar)
					) {
						return viaVar;
					}
				}
			}
			const fallback = vars[slot];
			if (
				typeof fallback === "string" &&
				fallback.startsWith("#") &&
				hexToRgb(fallback)
			) {
				return fallback;
			}
		}
		return null;
	};

	const hexes: Record<"idle" | "think" | "tool" | "working", string | null> = {
		idle: resolve("success"),
		think: resolve("warning"),
		tool: resolve("accent"),
		working: resolve("link", "blue", "teal", "accent"), // link 缺失 => 内置主题 blue/teal 兜底,再不行才 accent
	};
	const out: Palette = {
		idle: [0, 0, 0],
		think: [0, 0, 0],
		tool: [0, 0, 0],
		working: [0, 0, 0],
	};
	for (const key of Object.keys(hexes) as Array<
		"idle" | "think" | "tool" | "working"
	>) {
		const hex = hexes[key];
		if (!hex) {
			themeCacheResult = null;
			return null;
		}
		const rgb = hexToRgb(hex);
		if (!rgb) {
			themeCacheResult = null;
			return null;
		}
		out[key] = rgb;
	}

	// 背景色:同法解析 bg,没有则用 selectedBg 兜底,都没有 => 默认黑
	const bg = resolve("bg", "selectedBg") ?? "#000000";

	// 浅底压暗:各通道乘 0.55 取整,保色相
	if (relLum(bg) > 0.5) {
		for (const key of Object.keys(out) as Array<
			"idle" | "think" | "tool" | "working"
		>) {
			const [r, g, b] = out[key];
			out[key] = [
				Math.round(r * 0.55),
				Math.round(g * 0.55),
				Math.round(b * 0.55),
			];
		}
	}

	const result: Palette = { ...out };
	themeCacheResult = result;
	return result;
}

interface JarvisConfig {
	enabled: boolean;
	/** 场景 -> 动画 覆盖项(config.json 只存覆盖,缺省走 DEFAULT_SCENES 兜底) */
	scenes: ScenesConfig;
}
const DEFAULT_CONFIG: JarvisConfig = { enabled: true, scenes: {} };
const config: JarvisConfig = { enabled: true, scenes: {} };

function loadConfig(): void {
	try {
		// 优先读用户配置;缺失则回退包内默认(只读源)
		const src = existsSync(USER_CONFIG_FILE)
			? USER_CONFIG_FILE
			: PACKAGE_CONFIG_FILE;
		if (existsSync(src)) {
			const data = JSON.parse(readFileSync(src, "utf-8"));
			config.enabled = data.enabled ?? DEFAULT_CONFIG.enabled;
			// 只收合法覆盖项:动画 id 为 string,参数只收有限 number(sanitizeScenesConfig)
			config.scenes = sanitizeScenesConfig(data.scenes);
		}
	} catch {
		// 配置缺失/损坏 => 用默认值
	}
}
loadConfig();

// ---------------------------------------------------------------------------
// 盲文粒子球组件(宿主)
// ---------------------------------------------------------------------------

// 场景 -> 旋转方向:由该场景合并后的 params.dir 换算(-1=ccw / 1=cw / 其他=none)
function flowDirFromParams(params: Readonly<SceneParams>): FlowDir {
	const dir = params.dir;
	if (dir === -1) return "ccw";
	if (dir === 1) return "cw";
	return "none";
}

interface Slot {
	plugin: AnimationPlugin;
}

/** 兜底插件:factory 抛错或未注册时渲染空帧,不让异常冒泡崩 TUI 渲染管线 */
function makeEmptyPlugin(): AnimationPlugin {
	return {
		id: "__empty__",
		render(grid: Grid, _host: AnimationHost): string[] {
			return new Array(grid.rows).fill(" ".repeat(grid.w));
		},
	};
}

class JarvisSphereComponent implements Component {
	private tui: TUI;
	private theme: Theme; // 实时代理:任意时刻读 name/getBgAnsi 都是当前主题
	// 四态颜色唯一色源:默认 DARK_PALETTE,syncTheme 时从主题 vars 提取,失败回退亮暗调色板
	// (DARK/LIGHT_PALETTE 推断为 number[],故字段用 number[] 以兼容回退常量)
	private palette: {
		idle: number[];
		think: number[];
		tool: number[];
		working: number[];
	} = DARK_PALETTE;
	private themeCheckAt = 0; // 主题轮询保底:上次检查时间戳(ms)
	private interval: ReturnType<typeof setInterval> | null = null;
	private phase = 0;
	private frame = 0;
	speaking = false;
	// 四态: idle(绿/水波纹) | think(红/折射) | tool(黄/轨道粒子流) | working(青/折射)
	private state: SceneId = "idle";
	// 场景 -> 动画实例(插件槽位):懒建,切走不销毁、切回续帧;同一动画多场景各自独立实例
	private slots = new Map<SceneId, Slot>();
	// 减速过渡:ease-out 1s 后落到 decelTarget;期间状态仍是源场景,方向冻结为 decelFlowDir
	private decelStart = 0; // 减速开始时间戳(ms);0 = 非减速
	private decelTarget: "idle" | "working" = "idle";
	private decelFlowDir: FlowDir = "none"; // 减速前方向,减速期间保持

	constructor(tui: TUI, theme: Theme) {
		this.tui = tui;
		this.theme = theme;
		this.syncTheme();
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

	/** LLM 开始思考 -> think 场景 */
	onThinkingStart(): void {
		if (this.state === "think") return;
		this.jumpTo("think");
	}

	/** 工具调用开始 -> tool 场景 */
	onToolStart(): void {
		if (this.state === "tool") return;
		this.jumpTo("tool");
	}

	/** 答案流开始(text_delta 首帧) -> working 场景;幂等:仅在状态切换时生效 */
	onTextDelta(): void {
		// 减速中:跳过剩余减速直接跳 working(established rule:新事件直达新状态);
		// 非减速:仅当已处于活跃的 think/tool/working 流时才 no-op。
		if (this.decelStart === 0) {
			if (
				this.state === "think" ||
				this.state === "tool" ||
				this.state === "working"
			)
				return;
		}
		this.jumpTo("working");
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
		if (this.decelStart !== 0) {
			// 减速中(think/tool 结束的 1s 窗口内):把落点改回 idle,避免落到 working 永转
			this.decelTarget = "idle";
			return;
		}
		this.beginDecel("idle");
	}

	/** 直接切场景:取消减速,跳过过渡动画 */
	private jumpTo(scene: SceneId): void {
		this.state = scene;
		this.decelStart = 0;
		this.decelFlowDir = "none";
		this.tui.requestRender();
	}

	private beginDecel(target: "idle" | "working" = "idle"): void {
		if (this.decelStart !== 0) return; // 已在减速中,不重启(双信号防抖: tool_execution_end + subagents:completed)
		this.decelTarget = target;
		// 记忆当前旋转方向(由该场景合并参数换算),减速期间保持
		this.decelFlowDir = flowDirFromParams(this.mergedParams(this.state));
		this.decelStart = Date.now();
		this.tui.requestRender();
	}

	/** 取场景的合并参数:插件 defaults 兜底 + config.scenes[scene].params 覆盖 */
	private mergedParams(scene: SceneId): Readonly<SceneParams> {
		return mergeSceneParams(
			config.scenes,
			scene,
			this.slotFor(scene).plugin.defaults ?? {},
		);
	}

	/** 取场景对应的动画实例(懒建并缓存;未注册/未配置 -> DEFAULT_SCENES 兜底) */
	private slotFor(scene: SceneId): Slot {
		let slot = this.slots.get(scene);
		if (!slot) {
			const id = resolveSceneAnimation(config.scenes, scene);
			let plugin: AnimationPlugin;
			try {
				const factory =
					getAnimationFactory(id) ?? getAnimationFactory(DEFAULT_SCENES[scene]);
				plugin = factory ? factory() : makeEmptyPlugin();
			} catch {
				// 插件初始化异常:渲染空帧,避免崩掉整个浮层
				plugin = makeEmptyPlugin();
			}
			slot = { plugin };
			this.slots.set(scene, slot);
		}
		return slot;
	}

	private tick(): void {
		this.frame++;
		const now = Date.now();

		// 主题轮询保底(双保险):invalidate 是官方路径,这里每 ~500ms 兜底一次,
		// 防止个别主题切换路径漏调 invalidate。
		if (now - this.themeCheckAt >= 500) {
			this.themeCheckAt = now;
			const prev = this.palette;
			this.syncTheme(); // 主题切换时刷新四态调色板(内部处理回退)
			if (this.palette !== prev) {
				this.tui.requestRender();
			}
		}

		// 减速:1s 内 ease-out 速度降到 0,然后落到 decelTarget(idle 或 working)。
		// 期间渲染的仍是源场景动画(speedScale/flowDir 由 render() 按减速态注入)。
		if (this.decelStart !== 0) {
			const tt = (now - this.decelStart) / 1000;
			if (tt >= 1) {
				this.state = this.decelTarget;
				this.decelStart = 0;
				this.decelFlowDir = "none";
			}
			this.tui.requestRender();
			return;
		}

		// 非 idle(think/tool/working):~30FPS 重绘;粒子推进由各插件 render 内部完成
		if (this.state !== "idle") {
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
		const palette = this.palette;
		const [r, g, b] =
			this.state === "idle"
				? palette.idle
				: this.state === "think"
					? palette.think
					: this.state === "tool"
						? palette.tool
						: palette.working;
		const open = `\x1b[38;2;${r};${g};${b}m`;
		const close = "\x1b[0m";

		// 场景 -> 动画插件 -> 原始盲文行;颜色保持场景级(ANSI 包裹留在宿主)
		const slot = this.slotFor(this.state);
		const plugin = slot.plugin;
		const params = mergeSceneParams(
			config.scenes,
			this.state,
			plugin.defaults ?? {},
		);

		// 减速 ease-out 标量 + 方向冻结(非减速:方向由场景参数换算)
		let speedScale = 1;
		let flowDir = flowDirFromParams(params);
		if (this.decelStart !== 0) {
			const tt = (Date.now() - this.decelStart) / 1000;
			speedScale = Math.max(0, (1 - tt) ** 2);
			flowDir = this.decelFlowDir;
		}

		const host: AnimationHost = {
			scene: this.state,
			frame: this.frame,
			phase: this.phase,
			speedScale,
			flowDir,
			speaking: this.speaking,
			params,
		};

		const raw = plugin.render(computeGrid(width), host);
		return raw.map((line) => `${open}${line}${close}`);
	}

	/** 同步主题四态颜色:主题切换时由 invalidate 或 tick 轮询调用;读 vars 失败回退亮暗调色板 */
	private syncTheme(): void {
		const p = readThemePalette(this.theme);
		if (p) {
			this.palette = p;
		} else {
			const light = isLightTheme(this.theme);
			this.palette = light ? LIGHT_PALETTE : DARK_PALETTE;
		}
	}

	invalidate(): void {
		// 主题切换( /settings 选择、setTheme、终端亮暗自动同步、自定义主题热重载)
		// 都会触发 TUI 对所有已挂载组件调 invalidate,这里重新判断亮暗并重绘。
		this.syncTheme();
		this.tui.requestRender();
	}

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
		(tui: TUI, theme: Theme) => {
			sphere = new JarvisSphereComponent(tui, theme);
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
	// 注:此处 sphere 已被顶部守卫收窄为 null(闭包内赋值不参与 CFA),断言回原类型避免 TS never 误报
	if ((globalThis as any).__piTtsPlaying)
		(sphere as JarvisSphereComponent | null)?.setSpeaking(true);
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

	// thinking 信号:think = 折射红流。引用模块级 sphere,未挂载时为 null 自动 no-op。
	pi.on("message_update", (event: any, ctx: any) => {
		if (ctx?.mode !== "tui") return;
		const t = event?.assistantMessageEvent?.type;
		if (t === "thinking_start") sphere?.onThinkingStart();
		else if (t === "thinking_end") sphere?.onThinkingEnd();
		else if (t === "text_delta") sphere?.onTextDelta();
	});

	// 工具调用信号:tool = 轨道黄流
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
