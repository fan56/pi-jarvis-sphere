/**
 * 场景 -> 动画 配置解析层
 *
 * config.json 的 scenes 是用户的"插件目录":每个场景可选动画 id + 参数覆盖。
 * 本层负责:
 *   - resolveSceneAnimation:取场景应挂的动画 id(未配置/未知 id -> 默认兜底)
 *   - mergeSceneParams:defaults 兜底 + config.params 覆盖 -> 只收有限 number
 *   - sanitizeScenesConfig:loadConfig 时清洗原始 JSON -> 只留合法覆盖项
 *
 * 注意:resolveSceneAnimation 需要 hasAnimation(来自 animations/registry.ts),
 * 这是本单文件扩展里唯一跨越 lib -> animations 的边界,刻意为之。
 */
import { hasAnimation } from "../animations/registry.ts";
import type { SceneId, SceneParams } from "./types.ts";
import { SCENE_IDS } from "./types.ts";

/** 出厂默认:每个场景挂哪个动画(未配置/配错时的兜底) */
export const DEFAULT_SCENES: Record<SceneId, string> = {
	idle: "flow-field",
	think: "refract",
	tool: "orbital",
	working: "refract",
};

export interface SceneConfig {
	/** 可选:缺省时 resolveSceneAnimation 用 DEFAULT_SCENES 兜底 */
	animation?: string;
	params: Record<string, number>;
}

export type ScenesConfig = Partial<Record<SceneId, SceneConfig>>;

/** 解析场景动画 id:配置缺失或 id 未注册 -> 默认兜底 */
export function resolveSceneAnimation(
	scenes: ScenesConfig,
	scene: SceneId,
): string {
	const id = scenes[scene]?.animation;
	if (typeof id === "string" && hasAnimation(id)) return id;
	return DEFAULT_SCENES[scene];
}

/** 合并场景参数:defaults 兜底,config.params 覆盖(只收有限 number) */
export function mergeSceneParams(
	scenes: ScenesConfig,
	scene: SceneId,
	defaults: SceneParams,
): Readonly<SceneParams> {
	const out: SceneParams = { ...defaults };
	const cfg = scenes[scene]?.params;
	if (cfg && typeof cfg === "object") {
		for (const k of Object.keys(cfg)) {
			const v = cfg[k];
			if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
		}
	}
	return out;
}

/** 清洗 config.json 的 scenes 原始值 -> 只保留合法覆盖项(动画 id 为 string,参数只收有限 number) */
export function sanitizeScenesConfig(raw: unknown): ScenesConfig {
	const out: ScenesConfig = {};
	if (!raw || typeof raw !== "object") return out;
	const src = raw as Record<string, unknown>;
	for (const scene of SCENE_IDS) {
		const s = src[scene];
		if (!s || typeof s !== "object") continue;
		const entry = s as Record<string, unknown>;
		const animation =
			typeof entry.animation === "string" ? entry.animation : undefined;
		const params: Record<string, number> = {};
		const p = entry.params;
		if (p && typeof p === "object") {
			for (const k of Object.keys(p)) {
				const v = (p as Record<string, unknown>)[k];
				if (typeof v === "number" && Number.isFinite(v)) params[k] = v;
			}
		}
		if (animation !== undefined || Object.keys(params).length > 0) {
			out[scene] = {
				...(animation !== undefined ? { animation } : {}),
				params,
			};
		}
	}
	return out;
}
