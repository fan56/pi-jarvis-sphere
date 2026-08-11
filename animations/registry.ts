/**
 * 动画插件静态注册表:id -> factory
 *
 * 新增动画 = 新建 animations/xxx.ts + 在此登记一行。
 * 场景通过 config.json 的 scenes[scene].animation 引用这里的 id。
 */
import type { AnimationFactory } from "../lib/types.ts";
import { flowField } from "./flow-field.ts";
import { refract } from "./refract.ts";
import { orbital } from "./orbital.ts";
import { stars } from "./stars.ts";
import { stars2 } from "./stars2.ts";

export const ANIMATION_REGISTRY: Readonly<Record<string, AnimationFactory>> = {
	"flow-field": flowField,
	refract: refract,
	orbital: orbital,
	stars: stars,
	stars2: stars2,
};

/** 该 id 是否有已注册的动画 */
export function hasAnimation(id: string): boolean {
	return id in ANIMATION_REGISTRY;
}

/** 取工厂;未注册返回 undefined */
export function getAnimationFactory(id: string): AnimationFactory | undefined {
	return ANIMATION_REGISTRY[id];
}
