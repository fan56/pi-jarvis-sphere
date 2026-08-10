/**
 * 动画插件化核心类型
 *
 * 场景(state)与动画(plugin)解耦:
 *   - SceneId = 状态机四态(与事件 API 的 state 一一对应)
 *   - AnimationPlugin = 一个可渲染的动画(闭包持有自己的粒子状态)
 *   - AnimationHost = 宿主(renderer)每帧注入的上下文,插件只读
 *   - SceneParams = 每场景的可调参数(配置驱动,缺省用插件 defaults 兜底)
 *
 * 插件契约:render(grid, host) -> string[](原始盲文行,不含 ANSI)。
 * 渲染所需的一切(帧号、相位、速度标量、旋转方向、参数)都从 host 读取,
 * 插件自身除粒子状态外不持有任何可配置数据。
 */

export type SceneId = "idle" | "think" | "tool" | "working";
export type FlowDir = "none" | "cw" | "ccw";
export const SCENE_IDS: readonly SceneId[] = [
	"idle",
	"think",
	"tool",
	"working",
];

/** 场景可调参数:有限 number 键值对(0/负值/任意小数都合法) */
export interface SceneParams {
	[key: string]: number | undefined;
}

/** 宿主每帧注入的渲染上下文(只读) */
export interface AnimationHost {
	scene: SceneId;
	frame: number; // 宿主全局帧号(每 tick +1,驱动噪声场平移等)
	phase: number; // 宿主全局相位(idle 系水波纹用)
	speedScale: number; // 0..1;1=全速,减速期 (1-tt)^2
	flowDir: FlowDir; // 旋转方向;减速期冻结为减速前的方向
	speaking: boolean; // TTS 说话中(idle 加速脉冲)
	params: Readonly<SceneParams>;
}

/** 盲文网格几何(computeGrid(width) 一次性算好,所有插件共用) */
export interface Grid {
	w: number; // 盲文字符列数
	rows: number; // 盲文字符行数
	dotCols: number; // 点阵列宽(每字符 2 点列)
	dotRows: number; // 点阵行高(每字符 4 点行)
	cx: number; // 圆心 x(点阵坐标)
	cy: number; // 圆心 y(点阵坐标)
	R: number; // 球半径(点距)
}

/** 可选生命周期钩子:slot 建/销毁时各调用一次 */
export interface AnimationLifecycle {
	activate?(host: AnimationHost): void;
	deactivate?(host: AnimationHost): void;
}

export interface AnimationPlugin extends AnimationLifecycle {
	readonly id: string;
	/** 该动画的默认参数(mergeSceneParams 的兜底层,也是 config 缺省时的值) */
	readonly defaults?: SceneParams;
	/** 渲染一帧;返回原始盲文行(不含 ANSI),行数=grid.rows、每行宽=grid.w */
	render(grid: Grid, host: AnimationHost): string[];
}

/** 工厂:每次调用返回一个独立插件实例(每个场景槽位各持一份,状态互不干扰) */
export type AnimationFactory = () => AnimationPlugin;
