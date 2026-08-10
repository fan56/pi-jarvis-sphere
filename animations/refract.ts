/**
 * think/working 场景插件:折射粒子(圆内运动,边界反射+内部随机折射,折线连成光线/闪电感)
 *
 * 原 index.ts 的 renderRefract/spawnRefract/stepRefract + RefractParticle/REFRACT_COUNT 搬移。
 * 状态来源替换(渲染算法逐行对照原代码):
 *   - refractParticles   -> 闭包持有
 *   - refractSpeed       -> host.params.refractSpeed
 *   - REFRACT_COUNT      -> host.params.refractCount
 *   - velFactor(减速)    -> host.speedScale
 *   - flowDir 忽略(折射粒子无旋转方向概念)
 *
 * 同一 factory 可给 think/working 各建一个独立实例(各持一份粒子数组)。
 */
import { lineDot, makeCodes, toLines } from "../lib/braille.ts";
import type {
	AnimationFactory,
	AnimationHost,
	Grid,
	SceneParams,
} from "../lib/types.ts";

interface RefractParticle {
	px: number;
	py: number; // 当前位置(dot 网格坐标)
	vx: number;
	vy: number; // 单位方向向量
	pts: number[]; // 折射点 flat 坐标 [x0,y0,x1,y1,...]
	bounces: number; // 已折射次数
	maxBounces: number; // 3-6 随机
}

interface RefractDefaults extends SceneParams {
	refractSpeed: number;
	refractCount: number;
}

const DEFAULTS: RefractDefaults = {
	refractSpeed: 1.04, // 原 this.refractSpeed 的初始值(applyFieldParams 设置)
	refractCount: 16, // 原 REFRACT_COUNT
};

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

export const refract: AnimationFactory = () => {
	// 插件自持折射粒子状态(取代原 this.refractParticles)
	const particles: RefractParticle[] = [];

	return {
		id: "refract",
		defaults: DEFAULTS,
		render(grid: Grid, host: AnimationHost): string[] {
			const { w, rows, dotCols, dotRows, cx, cy, R } = grid;

			// 首次初始化折射粒子
			if (particles.length === 0) {
				const count = host.params.refractCount ?? DEFAULTS.refractCount;
				for (let i = 0; i < count; i++) {
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
					particles.push(p);
				}
			}

			// 减速 ease-out:refractSpeed × speedScale(原 velFactor)
			const speed =
				(host.params.refractSpeed ?? DEFAULTS.refractSpeed) * host.speedScale;

			// 推进粒子
			for (const p of particles) stepRefract(p, cx, cy, R, speed);

			// 渲染折线:连接所有折射点 + 最后折射点到当前位置
			const codes = makeCodes(rows * w);
			for (const p of particles) {
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

			return toLines(codes, grid);
		},
	};
};
