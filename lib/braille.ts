/**
 * 盲文渲染原语:点阵 → Unicode 盲文字符
 *
 * 原 index.ts 里内联在 renderField/renderRefract/renderOrbital 中的
 * BRAILLE_BITS/BRAILLE_BASE/setDot/lineDot + 逐行拼 String.fromCharCode,
 * 收敛为纯函数供所有动画插件共用。算法逐行对照原代码,零改动。
 */
import type { Grid } from "./types.ts";

// 盲文点阵位掩码:[行(0-3)][列(0-1)],Unicode Braille 点序与点阵坐标映射
export const BRAILLE_BITS = [
	[0x01, 0x08],
	[0x02, 0x10],
	[0x04, 0x20],
	[0x40, 0x80],
];
export const BRAILLE_BASE = 0x2800;

/** 建一张全部为"空格盲文"(0x2800)的码位表(行数 × 列数) */
export function makeCodes(count: number): number[] {
	return new Array(count).fill(BRAILLE_BASE);
}

/** 在码位表上点一个点(点阵坐标 px,py;越界忽略) */
export function setDot(
	codes: number[],
	w: number,
	dotCols: number,
	dotRows: number,
	px: number,
	py: number,
): void {
	const dx = Math.round(px);
	const dy = Math.round(py);
	if (dx < 0 || dy < 0 || dx >= dotCols || dy >= dotRows) return;
	const col = Math.floor(dx / 2);
	const row = Math.floor(dy / 4);
	codes[row * w + col] |= BRAILLE_BITS[dy % 4][dx % 2];
}

// Bresenham 画线:在盲文 codes 数组上画 (x0,y0)->(x1,y1) 线段
export function lineDot(
	codes: number[],
	w: number,
	dotCols: number,
	dotRows: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
): void {
	let x = Math.round(x0),
		y = Math.round(y0);
	const ex = Math.round(x1),
		ey = Math.round(y1);
	const adx = Math.abs(ex - x),
		ady = Math.abs(ey - y);
	const sx = x < ex ? 1 : -1,
		sy = y < ey ? 1 : -1;
	let err = adx - ady;
	while (true) {
		if (x >= 0 && y >= 0 && x < dotCols && y < dotRows) {
			codes[(y >> 2) * w + (x >> 1)] |= BRAILLE_BITS[y & 3][x & 1];
		}
		if (x === ex && y === ey) break;
		const e2 = 2 * err;
		if (e2 > -ady) {
			err -= ady;
			x += sx;
		}
		if (e2 < adx) {
			err += adx;
			y += sy;
		}
	}
}

/** 码位表 → 盲文行(行数 = grid.rows,每行宽 = grid.w) */
export function toLines(
	codes: number[],
	grid: Pick<Grid, "rows" | "w">,
): string[] {
	const lines: string[] = [];
	for (let row = 0; row < grid.rows; row++) {
		let line = "";
		for (let col = 0; col < grid.w; col++)
			line += String.fromCharCode(codes[row * grid.w + col]);
		lines.push(line);
	}
	return lines;
}
