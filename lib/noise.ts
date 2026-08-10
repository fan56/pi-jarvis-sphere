/**
 * curl noise 流场:整数哈希 -> 值噪声 -> 无散度速度场
 *
 * 原 index.ts 纯算法层,逐行搬移零改动。
 */

// 整数格点哈希 -> [0,1)
function hash2(x: number, y: number): number {
	let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
	h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
	return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

// 2D 值噪声:整数格点 smoothstep 双线性插值,返回 [0,1)
function valueNoise(x: number, y: number): number {
	const xi = Math.floor(x),
		yi = Math.floor(y);
	const xf = x - xi,
		yf = y - yi;
	const u = xf * xf * (3 - 2 * xf);
	const v = yf * yf * (3 - 2 * yf);
	const a = hash2(xi, yi);
	const b = hash2(xi + 1, yi);
	const c = hash2(xi, yi + 1);
	const d = hash2(xi + 1, yi + 1);
	return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// 2D curl of scalar noise -> divergence-free 速度场 [vx, vy]
// 梯度 (dX,dY) 旋转 90° = (dY, -dX)
export function curl2D(x: number, y: number, delta: number): [number, number] {
	const dX =
		(valueNoise(x + delta, y) - valueNoise(x - delta, y)) / (2 * delta);
	const dY =
		(valueNoise(x, y + delta) - valueNoise(x, y - delta)) / (2 * delta);
	return [dY, -dX];
}
