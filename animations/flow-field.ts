/**
 * idle 场景插件:curl noise 流场粒子 + 中心水波纹
 *
 * 原 index.ts 的 renderField/ensureParticles/stepParticles 搬移。
 * 状态来源替换(仅此而已,渲染算法逐行对照原代码):
 *   - particles          -> 闭包持有
 *   - fieldSpeed/Count/Scroll -> host.params.fieldSpeed/fieldCount/fieldScroll
 *   - fieldDir           -> host.flowDir 换算 ±1(cw=+1 / ccw=-1 / none=0)
 *   - frame / phase      -> host.frame / host.phase
 *   - flow==="decel" 的 ease-out(velFactor/decelStart/decelDir)
 *                           -> host.speedScale(速度乘上去) + host.flowDir(方向冻结)
 *   - 水波纹原判断 state==="idle" 的分支删除:插件只挂 idle,恒画
 */
import { BRAILLE_BASE, BRAILLE_BITS, setDot, toLines } from "../lib/braille.ts";
import { curl2D } from "../lib/noise.ts";
import type {
	AnimationFactory,
	AnimationHost,
	Grid,
	SceneParams,
} from "../lib/types.ts";

interface Particle {
	x: number;
	y: number;
	age: number;
	life: number;
}

interface FlowFieldDefaults extends SceneParams {
	fieldSpeed: number;
	dir: number;
	fieldCount: number;
	fieldScroll: number;
}

const DEFAULTS: FlowFieldDefaults = {
	fieldSpeed: 0.06, // 每帧位移倍数(原 applyFieldParams("idle") 的值)
	dir: 1, // 旋转方向:1=cw, -1=ccw, 0=冻结
	fieldCount: 120, // 粒子数
	fieldScroll: 0.02, // 噪声场每帧平移量
};

/** host.flowDir -> 速度方向 ±1 */
function dirSign(host: AnimationHost): number {
	if (host.flowDir === "ccw") return -1;
	if (host.flowDir === "cw") return 1;
	return 0;
}

export const flowField: AnimationFactory = () => {
	// 插件自持粒子状态(取代原 this.particles)
	const particles: Particle[] = [];

	/** 初始化/调节粒子数:首次在圆内均匀分布;后续按 targetN 增减 */
	function ensureParticles(
		cx: number,
		cy: number,
		R: number,
		targetN: number,
	): void {
		if (particles.length === 0) {
			for (let i = 0; i < targetN; i++) {
				// 圆内均匀随机分布(√rand 保证面积均匀)
				const r0 = Math.sqrt(Math.random()) * R * 0.9;
				const a0 = Math.random() * 6.2831853;
				particles.push({
					x: cx + r0 * Math.cos(a0),
					y: cy + r0 * Math.sin(a0),
					age: Math.random() * 100,
					life: 80 + Math.random() * 80,
				});
			}
		} else if (particles.length < targetN) {
			// 不足:追加圆内随机位置粒子
			for (let i = particles.length; i < targetN; i++) {
				const r1 = Math.sqrt(Math.random()) * R * 0.85;
				const a1 = Math.random() * 6.2831853;
				particles.push({
					x: cx + r1 * Math.cos(a1),
					y: cy + r1 * Math.sin(a1),
					age: 0,
					life: 80 + Math.random() * 80,
				});
			}
		} else if (particles.length > targetN) {
			// 多余:截断(简化;视觉影响小,粒子为稀疏点)
			particles.length = targetN;
		}
	}

	/** 推进粒子一步:沿 curl noise 流场位移,超界/寿终重生 */
	function stepParticles(
		cx: number,
		cy: number,
		R: number,
		host: AnimationHost,
	): void {
		const delta = 0.8;
		const t = host.frame;
		const fieldScroll = host.params.fieldScroll ?? DEFAULTS.fieldScroll;
		const scrollX = t * fieldScroll;
		const scrollY = t * fieldScroll * 0.7;
		const noiseScale = 0.15;

		// 减速 ease-out:speedScale 衰减速度,flowDir 保持方向(原 decel 分支)
		const fieldSpeed = host.params.fieldSpeed ?? DEFAULTS.fieldSpeed;
		const speed = fieldSpeed * host.speedScale;
		const dir = dirSign(host);

		for (const p of particles) {
			const nx = (p.x - cx) * noiseScale + scrollX;
			const ny = (p.y - cy) * noiseScale + scrollY;
			const [vx, vy] = curl2D(nx, ny, delta);
			p.x += vx * speed * dir;
			p.y += vy * speed * dir;
			p.age++;
			// 圆边界:粒子超出半径 R 或寿终则重生
			const dx2 = p.x - cx,
				dy2 = p.y - cy;
			if (dx2 * dx2 + dy2 * dy2 > R * R || p.age > p.life) {
				const r2 = Math.sqrt(Math.random()) * R * 0.85;
				const a2 = Math.random() * 6.2831853;
				p.x = cx + r2 * Math.cos(a2);
				p.y = cy + r2 * Math.sin(a2);
				p.age = 0;
				p.life = 80 + Math.random() * 80;
			}
		}
	}

	return {
		id: "flow-field",
		defaults: DEFAULTS,
		render(grid: Grid, host: AnimationHost): string[] {
			const { w, rows, dotCols, dotRows, cx, cy, R } = grid;
			const fieldCount = host.params.fieldCount ?? DEFAULTS.fieldCount;

			ensureParticles(cx, cy, R, fieldCount);
			stepParticles(cx, cy, R, host);

			const codes: number[] = new Array(rows * w).fill(BRAILLE_BASE);

			// 粒子:生命周期 sin 渐变(首尾淡出,中间最亮);fade > 0.3 才画
			for (const p of particles) {
				const fade = Math.sin((p.age / p.life) * Math.PI);
				if (fade > 0.3) setDot(codes, w, dotCols, dotRows, p.x, p.y);
			}

			// 中心微弱水波纹(插件只挂 idle,恒画;原 state==="idle" 分支删除)
			const coreR = R * 0.4;
			for (let row = 0; row < rows; row++) {
				for (let col = 0; col < w; col++) {
					for (let dr = 0; dr < 4; dr++) {
						for (let dc = 0; dc < 2; dc++) {
							const dx = col * 2 + dc,
								dy = row * 4 + dr;
							const dist = Math.hypot(dx - cx, dy - cy);
							if (dist <= coreR) {
								const wave = Math.sin(dist * 1.5 - host.phase * 2.0);
								if (wave > 0.4) codes[row * w + col] |= BRAILLE_BITS[dr][dc];
							}
						}
					}
				}
			}

			return toLines(codes, grid);
		},
	};
};
