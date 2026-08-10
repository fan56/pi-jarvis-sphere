/**
 * think 场景插件:星形序列(循环手绘 7 个正多边形/多芒星,逐边绘制 + 自旋)
 *
 * 形状序列(固定):三角形 → 四边形 → 五芒星 → 六芒星 → 七芒星 → 八芒星 → 九芒星,
 * 循环往复。每个形状一个周期(cycleFrames = cf),分三段(形状切换连续衔接):
 *   绘制段 [0, 0.40*cf)   边逐条出现 + 半径 0.45→1.0 放大
 *   保持段 [0.40*cf, 0.85*cf)  满边,半径 1.0
 *   收缩段 [0.85*cf, cf)   满边,半径 1.0→0.45 缩回
 * 切换瞬间:上一形状已缩至 0.45,新形状从同一大小 0 边开始长出 -> 视觉连续「旧形缩小、新形同尺寸长出」。
 * 中心点呼吸:球心 2×2 点簇随 breath 正弦脉动(1→4 点周期点亮)。
 *
 * 状态来源与推进:
 *   - progress(帧单位累计绘制进度,跨形状累计驱动序列循环) -> 闭包持有
 *       render 内 progress += host.speedScale
 *   - spin(旋转相位) -> 闭包持有
 *       spin -= starSpeed * host.speedScale
 *   - breath(中心点呼吸相位) -> 闭包持有
 *       breath += breathSpeed * host.speedScale
 *   - 减速协议与 orbital 一致:speedScale=0 时完全冻结,两帧输出严格相同(无随机)。
 *   - 固定逆时针旋转(盲文点阵 y 向下,spin 递减=视觉逆时针);starSpeed=每帧旋转弧度(正值=逆时针),config 可配。
 *
 * 参数说明:cycleFrames=每形状周期帧数(取整,≥1 自动防护畸形配置);starStep=跳点覆盖(-1=用表值,正整数对 n 取模);
 *   breathSpeed=中心点呼吸角速度(默认 0.04,即约 2.6s 一个呼吸周期)。
 */
import { lineDot, makeCodes, setDot, toLines } from "../lib/braille.ts";
import type {
	AnimationFactory,
	AnimationHost,
	Grid,
	SceneParams,
} from "../lib/types.ts";

interface StarsDefaults extends SceneParams {
	starSpeed: number;
	cycleFrames: number;
	starSize: number;
	starStep: number;
	breathSpeed: number;
}

const DEFAULTS: StarsDefaults = {
	starSpeed: 0.02, // 每帧旋转弧度(正值=逆时针,×speedScale)
	cycleFrames: 160, // 每个形状的总周期帧数(绘制段 40% + 保持段 45% + 收缩段 15%)
	starSize: 0.82, // 顶点半径相对球半径 R 的比例(×周期内 rvScale)
	starStep: -1, // -1=用 SHAPES 表的 step;正整数则覆盖所有形状的跳点(调试用)
	breathSpeed: 0.04, // 中心点呼吸角速度:2π/0.04 ≈ 157 帧 ≈ 2.6s 一个呼吸周期
};

/** 形状表(固定顺序):{n, step} 表示从顶点 k 连到 (k+step) mod n 的多芒星 */
const SHAPES: ReadonlyArray<{ n: number; step: number }> = [
	{ n: 3, step: 1 }, // 三角形
	{ n: 4, step: 1 }, // 四边形(正方形)
	{ n: 5, step: 2 }, // 五芒星 {5/2}
	{ n: 6, step: 2 }, // 六芒星 {6/2}(大卫之星:两个交错等边三角形)
	{ n: 7, step: 2 }, // 七芒星 {7/2}
	{ n: 8, step: 3 }, // 八芒星 {8/3}
	{ n: 9, step: 2 }, // 九芒星 {9/2}
];

/** 最大公约数 */
function gcd(a: number, b: number): number {
	while (b !== 0) {
		const t = b;
		b = a % b;
		a = t;
	}
	return a;
}

/**
 * 星形展开:把 {n, step} 多芒星展开为有序边列表(顺序即绘制顺序)。
 * 顶点 0..n-1 等角分布;连接规则为从 k 连到 (k+step) mod n。
 * 当 d = gcd(n, step) > 1 时退化为 d 条独立回路(如 {6/2} 是两条三角形回路):
 * 对每个 start in 0..d-1,沿 i = (i+step)%n 走回 start 收集该回路顶点索引,
 * 回路内相邻顶点(含首尾)构成一条边;多条回路的边按回路先后拼接。
 * 返回 edges:[a0, b0, a1, b1, ...](顶点索引对,总边数恒等于 n)。
 */
function expandEdges(n: number, step: number): number[] {
	const d = gcd(n, step);
	const edges: number[] = [];
	for (let start = 0; start < d; start++) {
		const circuit: number[] = [];
		let i = start;
		do {
			circuit.push(i);
			i = (i + step) % n;
		} while (i !== start);
		for (let k = 0; k < circuit.length; k++) {
			edges.push(circuit[k], circuit[(k + 1) % circuit.length]);
		}
	}
	return edges;
}

export const stars: AnimationFactory = () => {
	// 插件自持状态:progress=帧单位累计绘制进度(跨形状累计,驱动序列循环);
	// spin=旋转相位;breath=中心点呼吸相位。每次 render 推进,减速由 speedScale 缩放。
	let progress = 0;
	let spin = 0;
	let breath = 0;

	return {
		id: "stars",
		defaults: DEFAULTS,
		render(grid: Grid, host: AnimationHost): string[] {
			const { w, rows, dotCols, dotRows, cx, cy, R } = grid;

			// 推进(减速协议:progress / spin / breath 都乘 host.speedScale,speedScale=0 完全冻结)
			progress += host.speedScale;
			spin -= (host.params.starSpeed ?? DEFAULTS.starSpeed) * host.speedScale;
			breath +=
				(host.params.breathSpeed ?? DEFAULTS.breathSpeed) * host.speedScale;

			// 当前形状与周期内相位(cf:每形状周期帧数,取整并保证 ≥1,防畸形 config 除零/NaN)
			const cf = Math.max(
				1,
				Math.floor(host.params.cycleFrames ?? DEFAULTS.cycleFrames),
			);
			const idx = Math.floor(progress / cf) % SHAPES.length;
			const inCycle = progress - Math.floor(progress / cf) * cf;
			const shape = SHAPES[idx];

			// 跳点覆盖:starStep 为正则替换 shape.step(对 n 取模,防越界自环;同样走 gcd 展开)
			const starStep = host.params.starStep ?? DEFAULTS.starStep;
			const step = starStep > 0 ? starStep % shape.n : shape.step;
			const edges = expandEdges(shape.n, step);

			// 周期三段衔接:绘制段 [0, .40cf) 边逐条 + 半径放大;
			// 保持段 [.40cf, .85cf) 满边,半径 1.0;
			// 收缩段 [.85cf, cf) 满边,半径缩回。直接 if/else 分段,避免 off-by-one。
			const drawEnd = cf * 0.4;
			const holdEnd = cf * 0.85;
			let visibleEdges: number;
			let rvScale: number;
			if (inCycle < drawEnd) {
				const frac = inCycle / drawEnd; // [0,1)
				// 边逐条出现(至少 1 条:切换瞬间不产生空帧闪烁),同时半径 0.45→1.0 放大
				visibleEdges = Math.min(
					shape.n,
					Math.max(1, Math.ceil(frac * shape.n)),
				);
				rvScale = 0.45 + 0.55 * frac;
			} else if (inCycle < holdEnd) {
				// 保持段:满边,半径 1.0
				visibleEdges = shape.n;
				rvScale = 1.0;
			} else {
				// 收缩段:边保持 n 条,半径 1.0→0.45 缩回(切换瞬间旧形已缩到最小,新形同尺寸长出)
				const t = (inCycle - holdEnd) / (cf - holdEnd); // [0,1)
				visibleEdges = shape.n;
				rvScale = 1.0 - 0.55 * t;
			}

			// 顶点坐标:等角分布在外接圆上(Rv = R * starSize * rvScale,随三段缩放)
			const Rv = R * (host.params.starSize ?? DEFAULTS.starSize) * rvScale;
			const pts: number[] = [];
			for (let k = 0; k < shape.n; k++) {
				const a = spin + (k / shape.n) * 2 * Math.PI;
				pts.push(cx + Rv * Math.cos(a), cy + Rv * Math.sin(a));
			}

			// 渲染:逐条连线(只画前 visibleEdges 条,edges 总边数恒等于 n)
			const codes = makeCodes(rows * w);
			const drawCount = Math.min(visibleEdges, edges.length / 2);
			for (let e = 0; e < drawCount; e++) {
				lineDot(
					codes,
					w,
					dotCols,
					dotRows,
					pts[edges[e * 2] * 2],
					pts[edges[e * 2] * 2 + 1],
					pts[edges[e * 2 + 1] * 2],
					pts[edges[e * 2 + 1] * 2 + 1],
				);
			}

			// 中心点呼吸:球心 2×2 点簇,点亮数量随正弦脉动(1→4 点)。
			// cx,cy 为点阵浮点坐标,setDot 内部 round;越界自动忽略,安全。
			const count = 1 + Math.round(3 * (0.5 - 0.5 * Math.cos(breath)));
			if (count >= 1) setDot(codes, w, dotCols, dotRows, cx, cy);
			if (count >= 2) setDot(codes, w, dotCols, dotRows, cx + 1, cy);
			if (count >= 3) setDot(codes, w, dotCols, dotRows, cx, cy + 1);
			if (count >= 4) setDot(codes, w, dotCols, dotRows, cx + 1, cy + 1);

			return toLines(codes, grid);
		},
	};
};
