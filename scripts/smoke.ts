/**
 * headless 冒烟测试:不依赖 pi 运行时,直接驱动动画插件与场景配置层。
 *
 * 运行: node scripts/run.mjs scripts/smoke.ts   (走 pi 自带 jiti)
 *   或: npx jiti scripts/smoke.ts                (回退方案)
 *
 * 5 组断言(全部为真实代码,无注释占位):
 *   [1] 注册表完备:每个 SCENE_IDS 的 DEFAULT_SCENES 动画 id 都在注册表
 *   [2] 三动画 × 四场景全组合渲染 60 帧不抛错且形状正确
 *   [3] 减速标量:speedScale=0 时 orbital 两帧严格相同 / flow-field 两帧近似相同
 *   [4] 配置合并:缺场景/未知 id -> 默认兜底;params 覆盖生效(含渲染层面确定性验证)
 *   [5] 实例隔离:think/working 两个 refract 实例粒子状态独立(种子随机,字节级对照)
 */
import { computeGrid } from "../lib/geometry.ts";
import { SCENE_IDS } from "../lib/types.ts";
import type { AnimationHost, SceneId } from "../lib/types.ts";
import {
	DEFAULT_SCENES,
	mergeSceneParams,
	resolveSceneAnimation,
	sanitizeScenesConfig,
} from "../lib/scenes.ts";
import type { ScenesConfig } from "../lib/scenes.ts";
import { getAnimationFactory } from "../animations/registry.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string): void {
	if (cond) {
		passed++;
	} else {
		failed++;
		failures.push(msg);
		console.error("  ✗ " + msg);
	}
}

const GRID = computeGrid(14);

function hostFor(
	scene: SceneId,
	overrides: Partial<AnimationHost> = {},
): AnimationHost {
	return {
		scene,
		frame: 0,
		phase: 0,
		speedScale: 1,
		flowDir: "cw",
		speaking: false,
		params: {},
		...overrides,
	};
}

/** 逐字符差异计数 */
function cellsDiff(a: string[], b: string[]): number {
	let diff = 0;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const la = a[i] ?? "";
		const lb = b[i] ?? "";
		for (let j = 0; j < Math.max(la.length, lb.length); j++) {
			if ((la[j] ?? "") !== (lb[j] ?? "")) diff++;
		}
	}
	return diff;
}

/** 形状正确:行数=rows、每行宽=w、盲文码位>=0x2800 */
function shapeOk(lines: string[]): boolean {
	if (lines.length !== GRID.rows) return false;
	for (const line of lines) {
		if (line.length !== GRID.w) return false;
		for (const ch of line) {
			if (ch.charCodeAt(0) < 0x2800) return false;
		}
	}
	return true;
}

// ─────────────────────────────────────────────────────────────
// [1] 注册表完备
// ─────────────────────────────────────────────────────────────
console.log("[1] 注册表完备:DEFAULT_SCENES 的每个动画 id 都已注册");
{
	const registryKeys = new Set<string>();
	// 通过 getAnimationFactory 探测注册表实际键(与 hasAnimation 一致)
	for (const scene of SCENE_IDS) {
		const id = DEFAULT_SCENES[scene];
		registryKeys.add(id);
	}
	for (const id of registryKeys) {
		assert(
			getAnimationFactory(id) !== undefined,
			`DEFAULT_SCENES 引用的 "${id}" 已注册`,
		);
	}
	// 每个默认 id 都必须能被 hasAnimation 确认
	for (const scene of SCENE_IDS) {
		assert(
			resolveSceneAnimation({}, scene) === DEFAULT_SCENES[scene],
			`空配置下场景 ${scene} 解析到默认 ${DEFAULT_SCENES[scene]}`,
		);
	}
}

// ─────────────────────────────────────────────────────────────
// [2] 三动画 × 四场景全组合,各渲染 60 帧,形状正确
// ─────────────────────────────────────────────────────────────
console.log(
	"[2] 3 动画 × 4 场景 = 12 组合,各渲染 60 帧(通过 config 指定 scenes[scene].animation)",
);
{
	const ALL_IDS = [...new Set(SCENE_IDS.map((s) => DEFAULT_SCENES[s]))];
	for (const id of ALL_IDS) {
		for (const scene of SCENE_IDS) {
			const scenes: ScenesConfig = {
				[scene]: { animation: id, params: {} },
			};
			const resolved = resolveSceneAnimation(scenes, scene);
			assert(
				resolved === id,
				`config 指定 ${scene}.animation="${id}" -> resolve 得 "${resolved}"`,
			);
			const factory = getAnimationFactory(resolved)!;
			const plugin = factory();
			const params = mergeSceneParams(scenes, scene, plugin.defaults ?? {});
			let ok = true;
			let firstBad: string | null = null;
			for (let f = 0; f < 60; f++) {
				const host = hostFor(scene, {
					frame: f,
					params,
					flowDir: f % 2 === 0 ? "cw" : "ccw",
				});
				const lines = plugin.render(GRID, host);
				if (!shapeOk(lines)) {
					ok = false;
					firstBad = `frame ${f}: rows=${lines.length}(期望 ${GRID.rows}) 宽=${lines[0]?.length}(期望 ${GRID.w})`;
					break;
				}
			}
			assert(
				ok,
				`组合 ${id} × ${scene} 连续 60 帧渲染形状正确${firstBad ? " — " + firstBad : ""}`,
			);
		}
	}
}

// ─────────────────────────────────────────────────────────────
// [3] 减速标量:speedScale=0 冻结运动
// ─────────────────────────────────────────────────────────────
console.log(
	"[3] 减速标量:speedScale=0 时 orbital 两帧严格相同,flow-field 两帧近似相同",
);
{
	// orbital:无随机,spin 不推进 -> 严格相同
	const orbFactory = getAnimationFactory("orbital")!;
	const orb = orbFactory();
	const orbParams = mergeSceneParams({}, "tool", orb.defaults ?? {});
	const orb0 = orb.render(
		GRID,
		hostFor("tool", { frame: 0, params: orbParams, speedScale: 0 }),
	);
	const orb1 = orb.render(
		GRID,
		hostFor("tool", { frame: 1, params: orbParams, speedScale: 0 }),
	);
	assert(
		cellsDiff(orb0, orb1) === 0,
		"orbital speedScale=0 连续两帧输出严格相同(spin 冻结)",
	);

	// flow-field:speed=0 时粒子不位移;唯一漂移是 p.age 递增导致个别粒子
	// 跨过 fade>0.3 的显隐阈值(忠实于原 stepParticles 无条件 age++),故容差
	const ffFactory = getAnimationFactory("flow-field")!;
	const ff = ffFactory();
	const ffParams = mergeSceneParams({}, "idle", ff.defaults ?? {});
	const a0 = ff.render(
		GRID,
		hostFor("idle", { frame: 0, params: ffParams, speedScale: 0 }),
	);
	const a1 = ff.render(
		GRID,
		hostFor("idle", { frame: 1, params: ffParams, speedScale: 0 }),
	);
	const ffDiff = cellsDiff(a0, a1);
	assert(
		ffDiff <= 10,
		`flow-field speedScale=0 连续两帧近似相同(差异格子=${ffDiff} ≤ 10)`,
	);
}

// ─────────────────────────────────────────────────────────────
// [4] 配置合并:缺场景/未知 id -> 默认兜底;params 覆盖生效
// ─────────────────────────────────────────────────────────────
console.log("[4] 配置合并:缺场景/未知 id -> 默认兜底;params 覆盖生效");
{
	// 4a:缺场景 -> 默认
	assert(
		resolveSceneAnimation({}, "think") === "refract",
		"缺场景 think -> 默认 refract",
	);
	assert(
		resolveSceneAnimation({}, "idle") === "flow-field",
		"缺场景 idle -> 默认 flow-field",
	);
	assert(
		resolveSceneAnimation({}, "working") === "refract",
		"缺场景 working -> 默认 refract",
	);
	assert(
		resolveSceneAnimation({}, "tool") === "orbital",
		"缺场景 tool -> 默认 orbital",
	);

	// 4b:未知 animation id -> 默认兜底
	const unknown: ScenesConfig = {
		think: { animation: "no-such-anim", params: {} },
	};
	assert(
		resolveSceneAnimation(unknown, "think") === "refract",
		"未知 animation id -> 默认 refract",
	);

	// 4c:params 覆盖生效(合并结果断言)
	const ffFactory = getAnimationFactory("flow-field")!;
	const scenes: ScenesConfig = {
		idle: {
			animation: "flow-field",
			params: { fieldSpeed: 0.5, fieldCount: 40 },
		},
	};
	const merged = mergeSceneParams(scenes, "idle", ffFactory().defaults ?? {});
	assert(
		merged.fieldSpeed === 0.5,
		`fieldSpeed 覆盖生效(=0.5,得 ${merged.fieldSpeed})`,
	);
	assert(
		merged.fieldCount === 40,
		`fieldCount 覆盖生效(=40,得 ${merged.fieldCount})`,
	);
	assert(
		merged.fieldScroll === 0.02,
		`未覆盖项 fieldScroll 用 defaults 兜底(=0.02,得 ${merged.fieldScroll})`,
	);

	// 4d:params 覆盖流入渲染(确定性验证)——orbital 无随机,spinSpeed 直接影响旋转相位
	const orbFactory = getAnimationFactory("orbital")!;
	const scenesSlow: ScenesConfig = {
		tool: { animation: "orbital", params: { spinSpeed: 0.1 } },
	};
	const scenesFast: ScenesConfig = {
		tool: { animation: "orbital", params: { spinSpeed: 0.3 } },
	};
	const slowParams = mergeSceneParams(
		scenesSlow,
		"tool",
		orbFactory().defaults ?? {},
	);
	const fastParams = mergeSceneParams(
		scenesFast,
		"tool",
		orbFactory().defaults ?? {},
	);
	assert(
		slowParams.spinSpeed === 0.1,
		`spinSpeed 覆盖生效(=0.1,得 ${slowParams.spinSpeed})`,
	);
	assert(
		slowParams.dir === 1,
		`未覆盖项 dir 用 defaults 兜底(=1,得 ${slowParams.dir})`,
	);
	const pSlow = orbFactory();
	const pFast = orbFactory();
	for (let f = 0; f < 30; f++) {
		pSlow.render(GRID, hostFor("tool", { frame: f, params: slowParams }));
		pFast.render(GRID, hostFor("tool", { frame: f, params: fastParams }));
	}
	const outSlow = pSlow.render(
		GRID,
		hostFor("tool", { frame: 30, params: slowParams }),
	);
	const outFast = pFast.render(
		GRID,
		hostFor("tool", { frame: 30, params: fastParams }),
	);
	assert(
		cellsDiff(outSlow, outFast) > 0,
		"spinSpeed 0.1 vs 0.3 渲染结果不同(参数确实流入渲染)",
	);

	// 4e:sanitize 只收合法覆盖项(动画为 string,参数只收有限 number)
	const dirty: unknown = {
		idle: {
			animation: "flow-field",
			params: { fieldSpeed: 0.9, fieldCount: "120", junk: NaN, dir: -1 },
		},
		think: { animation: "nope" },
	};
	const clean = sanitizeScenesConfig(dirty);
	assert(clean.idle?.animation === "flow-field", "sanitize 保留合法 animation");
	assert(
		clean.idle?.params.fieldSpeed === 0.9,
		`sanitize 保留合法 number(fieldSpeed=0.9)`,
	);
	assert(
		!("fieldCount" in (clean.idle?.params ?? {})),
		"sanitize 丢弃非 number(fieldCount 是字符串)",
	);
	assert(!("junk" in (clean.idle?.params ?? {})), "sanitize 丢弃 NaN");
	assert(clean.idle?.params.dir === -1, "sanitize 保留负值有限 number(dir=-1)");
	assert(
		clean.think?.animation === "nope",
		"sanitize 保留未知 animation id(由 resolve 兜底)",
	);
}

// ─────────────────────────────────────────────────────────────
// [5] 实例隔离:think/working 两个 refract 实例粒子状态独立
// ─────────────────────────────────────────────────────────────
console.log(
	"[5] 实例隔离:think/working 两个 refract 实例粒子状态独立(种子随机 + 字节级对照)",
);
{
	// 种子化 Math.random,使同参数渲染字节级可复现
	const realRandom = Math.random;
	const makeRng = (seed: number): (() => number) => {
		let s = seed >>> 0;
		return () => {
			s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
			return s / 4294967296;
		};
	};
	try {
		const factory = getAnimationFactory("refract")!;
		const thinkParams = mergeSceneParams({}, "think", factory().defaults ?? {});
		const workParams = mergeSceneParams(
			{},
			"working",
			factory().defaults ?? {},
		);

		// 隔离实验:think 疯狂推进,working 不动
		Math.random = makeRng(1);
		const pWorkI = factory();
		const pThinkI = factory();
		pWorkI.render(GRID, hostFor("working", { frame: 0, params: workParams })); // working 初始化(seed1 流)
		Math.random = makeRng(999);
		for (let f = 1; f <= 300; f++) {
			pThinkI.render(GRID, hostFor("think", { frame: f, params: thinkParams })); // think 推进 300 帧
		}
		Math.random = makeRng(2);
		const workStep1Isolated = pWorkI
			.render(GRID, hostFor("working", { frame: 1, params: workParams }))
			.join("");

		// 对照实验:相同随机流,但完全没有 think 推进
		Math.random = makeRng(1);
		const pWorkC = factory();
		pWorkC.render(GRID, hostFor("working", { frame: 0, params: workParams })); // 初始化(seed1 流)
		Math.random = makeRng(2);
		const workStep1Control = pWorkC
			.render(GRID, hostFor("working", { frame: 1, params: workParams }))
			.join("");

		assert(
			workStep1Isolated === workStep1Control,
			"think 推进 300 帧后,working 实例输出与零推进对照字节级一致(闭包粒子数组独立)",
		);

		// 反证:think 实例自身确实在持续变化(排除"两个都没动"的假阳性)
		const thinkA = pThinkI
			.render(GRID, hostFor("think", { frame: 301, params: thinkParams }))
			.join("");
		const thinkB = pThinkI
			.render(GRID, hostFor("think", { frame: 302, params: thinkParams }))
			.join("");
		assert(
			thinkA !== thinkB,
			"think 实例持续渲染时输出在变化(非冻结,隔离不是因双方静止)",
		);
	} finally {
		Math.random = realRandom;
	}
}

// ─────────────────────────────────────────────────────────────
console.log(
	`\nsmoke: ${passed} 通过, ${failed} 失败${failed ? "\n  " + failures.join("\n  ") : ""}`,
);
if (failed > 0) process.exit(1);
console.log("smoke: 全部断言通过 ✅");
