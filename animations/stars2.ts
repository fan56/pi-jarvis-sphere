/**
 * think 场景插件:星形交错重叠(随机不连续重复的双形状叠加动画)
 *
 * 与 stars 的核心区别:同一时刻恒定有 2 个形状叠加(交错重叠生成)。
 *   生命周期 = cycleFrames(cf),第二个形状在第一个的 50% 处开始生成,
 *   spawn 间隔 = spawnEvery = round(cf/2)(cf=160 -> 80 帧)。
 * 每个形状独立走与 stars 相同的三段生命周期:
 *   绘制段 [0, 0.40*cf)   边逐条出现 + 半径 0.45→1.0 放大
 *   保持段 [0.40*cf, 0.85*cf)  满边,半径 1.0
 *   收缩段 [0.85*cf, cf)   满边,半径 1.0→0.45 缩回
 * 时序(ss=1 为例):clock=0 生成形状 A;clock=80(A 生命周期 50%)生成 B;
 *   clock=160(A 已缩至最小被移除)生成 C;此后每 80 帧补一个 -> 任意时刻恰好
 *   一个处于后 50%(收缩/保持后半段)、一个处于前 50%(绘制/保持前半段),视觉
 *   「旧形缩小与新形长出交错衔接」,恒定 2 个形状叠加。
 *
 * 形状顺序:随机挑 SHAPES 下标,但不允许与上一次连续重复(prevIdx 记忆;
 * SHAPES.length=7>1 保证重挑循环必然退出)。洗牌式均匀分布不是必须的。
 *
 * 状态来源与推进:
 *   - clock(全局帧计数器) / actives(活跃形状数组,元素 {idx, inCycle}) / prevIdx
 *       -> 闭包持有;render 内 clock += speedScale,每个 active 的 inCycle += speedScale
 *   - spin(旋转相位,两形状共用 -> 同步旋转,视觉整齐) -> 闭包持有
 *       spin -= starSpeed * speedScale
 *   - breath(中心点呼吸相位) -> 闭包持有
 *       breath += breathSpeed * speedScale
 *   - 减速协议与 stars 一致:speedScale=0 时 clock/inCycle/spin/breath 全部冻结,
 *       两帧输出严格相同(无随机引入差异,spawn 判定也因 clock 冻结而不再触发)。
 *   - spawn 判定用 clock >= nextSpawn(nextSpawn 每次成功 spawn 后 += spawnEvery),
 *     而非 clock % spawnEvery === 0:小数 speedScale 下 clock 未必恰好是 spawnEvery
 *     的整数倍(取模永不命中),推进式判定在小数步进下同样稳定每 spawnEvery 帧触发。
 *   - 固定逆时针旋转(盲文点阵 y 向下,spin 递减=视觉逆时针);starSpeed=每帧旋转弧度。
 *
 * 参数说明:cycleFrames=每形状周期帧数(取整,≥1 自动防护畸形配置);starStep=跳点覆盖
 *   (-1=用表值,正整数对 n 取模);breathSpeed=中心点呼吸角速度(默认 0.04)。
 */
import { lineDot, makeCodes, setDot, toLines } from "../lib/braille.ts";
import type {
	AnimationFactory,
	AnimationHost,
	Grid,
	SceneParams,
} from "../lib/types.ts";

interface Stars2Defaults extends SceneParams {
	starSpeed: number;
	cycleFrames: number;
	starSize: number;
	starStep: number;
	breathSpeed: number;
}

const DEFAULTS: Stars2Defaults = {
	starSpeed: 0.02, // 每帧旋转弧度(正值=逆时针,×speedScale)
	cycleFrames: 160, // 每个形状的总周期帧数(绘制段 40% + 保持段 45% + 收缩段 15%)
	starSize: 0.82, // 顶点半径相对球半径 R 的比例(×周期内 rvScale)
	starStep: -1, // -1=用 SHAPES 表的 step;正整数则覆盖所有形状的跳点(调试用)
	breathSpeed: 0.04, // 中心点呼吸角速度:2π/0.04 ≈ 157 帧 ≈ 2.6s 一个呼吸周期
};

/** 形状表:{n, step} 表示从顶点 k 连到 (k+step) mod n 的多芒星(与 stars 共用同一张表) */
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

/** 活跃形状实例:idx=SHAPES 下标,inCycle=帧单位已画进度(生命周期内相位) */
interface ActiveShape {
	idx: number;
	inCycle: number;
}

export const stars2: AnimationFactory = () => {
	// 插件自持状态:clock=全局帧计数器(×speedScale 推进,驱动 spawn 节奏);
	// nextSpawn=下一次 spawn 的 clock 时刻(初始 0 = 首帧生成第一个);
	// actives=活跃形状实例(稳态恒 2 个);prevIdx=上一次随机挑出的形状索引(-1=尚无);
	// spin=旋转相位(两形状共用,同步旋转);breath=中心点呼吸相位。
	let clock = 0;
	let nextSpawn = 0;
	let prevIdx = -1;
	let spin = 0;
	let breath = 0;
	const actives: ActiveShape[] = [];

	return {
		id: "stars2",
		defaults: DEFAULTS,
		render(grid: Grid, host: AnimationHost): string[] {
			const { w, rows, dotCols, dotRows, cx, cy, R } = grid;

			// cf:每形状周期帧数,取整并保证 ≥1(防畸形 config 除零/NaN)
			const cf = Math.max(
				1,
				Math.floor(host.params.cycleFrames ?? DEFAULTS.cycleFrames),
			);
			// spawn 间隔 = 生命周期的一半 -> 第二个在第一个 50% 处开始,恒定 2 个叠加
			const spawnEvery = Math.max(1, Math.round(cf / 2));

			// 推进(减速协议:clock / inCycle / spin / breath 全乘 speedScale,0 完全冻结)
			clock += host.speedScale;
			for (const a of actives) a.inCycle += host.speedScale;
			spin -= (host.params.starSpeed ?? DEFAULTS.starSpeed) * host.speedScale;
			breath +=
				(host.params.breathSpeed ?? DEFAULTS.breathSpeed) * host.speedScale;

			// 移除已走完生命周期的形状(inCycle >= cf)
			for (let i = actives.length - 1; i >= 0; i--) {
				if (actives[i].inCycle >= cf) actives.splice(i, 1);
			}

			// spawn 节奏:nextSpawn 初始 0 -> 首帧(clock=0)生成第一个;
			// 此后 clock 每到达 nextSpawn 补一个(间隔 spawnEvery 帧),稳态恒 2 个叠加。
			// 防御:actives 已有 2 个以上则本轮不 spawn(理论不会发生,移除先行保证稳定)。
			// speedScale=0 时 clock 冻结,nextSpawn 不会前进,不会重复 spawn -> 严格冻结。
			if (actives.length < 2 && clock >= nextSpawn) {
				// 随机挑一个形状,不允许与上一个连续重复(7>1 保证重挑必然退出)
				let idx: number;
				do {
					idx = Math.floor(Math.random() * SHAPES.length);
				} while (idx === prevIdx);
				prevIdx = idx;
				actives.push({ idx, inCycle: 0 });
				nextSpawn += spawnEvery;
			}

			// 渲染:所有活跃形状画进同一张码位表(共用 spin -> 同步旋转,视觉整齐)
			const codes = makeCodes(rows * w);
			const starSize = host.params.starSize ?? DEFAULTS.starSize;
			const starStep = host.params.starStep ?? DEFAULTS.starStep;
			for (const a of actives) {
				const shape = SHAPES[a.idx];

				// 跳点覆盖:starStep 为正则替换 shape.step(对 n 取模,防越界自环;同样走 gcd 展开)
				const step = starStep > 0 ? starStep % shape.n : shape.step;
				const edges = expandEdges(shape.n, step);

				// 周期三段衔接(与 stars 一致):绘制段 [0, .40cf) 边逐条 + 半径放大;
				// 保持段 [.40cf, .85cf) 满边,半径 1.0;
				// 收缩段 [.85cf, cf) 满边,半径缩回。直接 if/else 分段,避免 off-by-one。
				const drawEnd = cf * 0.4;
				const holdEnd = cf * 0.85;
				const inCycle = a.inCycle;
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
				const Rv = R * starSize * rvScale;
				const pts: number[] = [];
				for (let k = 0; k < shape.n; k++) {
					const ang = spin + (k / shape.n) * 2 * Math.PI;
					pts.push(cx + Rv * Math.cos(ang), cy + Rv * Math.sin(ang));
				}

				// 逐条连线(只画前 visibleEdges 条,edges 总边数恒等于 n)
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
