/**
 * 盲文网格几何计算
 *
 * 原 renderOrbital/renderField/renderRefract 各自内联重复这段网格计算
 * (w = max(8|6, width) → rows = max(4, round(w/2)) → 点阵 2×4 每字符)。
 * 宿主以 WIDTH=14 调用,三种原实现产出完全相同的网格(14×7 / 28×28 / R=13),
 * 故收敛为一个纯函数,所有插件共用同一 Grid。
 */
import type { Grid } from "./types.ts";

export function computeGrid(width: number): Grid {
	const w = Math.max(6, width);
	const rows = Math.max(4, Math.round(w / 2));
	const dotCols = w * 2;
	const dotRows = rows * 4;
	return {
		w,
		rows,
		dotCols,
		dotRows,
		cx: dotCols / 2,
		cy: dotRows / 2,
		R: Math.min(dotCols, dotRows) / 2 - 1,
	};
}
