/**
 * tool 场景插件:轨道粒子流(等角分布 + 微分转速:内慢外快,中心留空)
 *
 * 原 index.ts 的 renderOrbital 搬移,状态来源替换:
 *   - spin          -> 闭包持有
 *   - SPIN_SPEED    -> host.params.spinSpeed
 *   - 原 tick() 里 spin += SPIN_SPEED*decelDir*(1-tt)^2 的推进移进 render:
 *       spin += dirSign(host.flowDir) * spinSpeed * host.speedScale
 *   - 方向由 host.flowDir 换算 ±1(cw=+1 / ccw=-1 / none=0)
 */
import { BRAILLE_BASE, setDot, toLines } from "../lib/braille.ts";
import type {
	AnimationFactory,
	AnimationHost,
	Grid,
	SceneParams,
} from "../lib/types.ts";

interface OrbitalDefaults extends SceneParams {
	spinSpeed: number;
	dir: number;
}

const DEFAULTS: OrbitalDefaults = {
	spinSpeed: 0.15, // 原 SPIN_SPEED(applyFieldParams("tool") 后为 0.15)
	dir: 1, // 旋转方向:1=cw, -1=ccw, 0=冻结
};

/** host.flowDir -> 旋转方向 ±1 */
function dirSign(host: AnimationHost): number {
	if (host.flowDir === "ccw") return -1;
	if (host.flowDir === "cw") return 1;
	return 0;
}

export const orbital: AnimationFactory = () => {
	// 插件自持相位(取代原 this.spin);每次 render 推进,减速由 speedScale 缩放
	let spin = 0;

	return {
		id: "orbital",
		defaults: DEFAULTS,
		render(grid: Grid, host: AnimationHost): string[] {
			const { w, rows, dotCols, dotRows, cx, cy, R } = grid;

			// 推进(原 tick 逻辑移入 render):spin += dirSign * spinSpeed * speedScale
			spin +=
				dirSign(host) *
				(host.params.spinSpeed ?? DEFAULTS.spinSpeed) *
				host.speedScale;

			const codes: number[] = new Array(rows * w).fill(BRAILLE_BASE);

			// 均匀粒子流:4 层等间距半径,每层 23 个等角分布点;中心留空。
			// 角速度 = spin × (r/R):靠内慢、靠外快(微分旋转);方向由 spin 累计方向决定。
			const R_in = R * 0.55;
			const R_out = R * 0.95;
			const LAYERS = 4;
			const PER_LAYER = 23;
			const GAP = 3; // 缺口:每层去掉连续 GAP 个角度(≈47°),打破对称,旋转方向一眼可辨(4层×20点=80粒子)
			for (let l = 0; l < LAYERS; l++) {
				const r = R_in + ((R_out - R_in) * l) / (LAYERS - 1);
				for (let k = 0; k < PER_LAYER - GAP; k++) {
					const a = (k / PER_LAYER) * 2 * Math.PI + spin * (r / R);
					setDot(
						codes,
						w,
						dotCols,
						dotRows,
						cx + r * Math.cos(a),
						cy + r * Math.sin(a),
					);
				}
			}

			return toLines(codes, grid);
		},
	};
};
