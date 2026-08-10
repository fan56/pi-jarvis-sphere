/**
 * 临时工具:用 stars 动画的真实渲染代码生成 7 形状样例 SVG(stars-preview.svg)
 *
 * 运行: node scripts/run.mjs scripts/gen-stars-preview.ts
 * 用法:对 7 个形状各取一个 hold 中段代表帧,解析盲文码位还原点坐标,输出 SVG。
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeGrid } from "../lib/geometry.ts";
import { stars } from "../animations/stars.ts";
import type { AnimationHost, SceneId } from "../lib/types.ts";

const GRID = computeGrid(14);
const { w, rows, dotCols, dotRows } = GRID;
// 点阵坐标 -> SVG 坐标缩放(demo.svg 同款:点距 R=13,区域 28×28,球心 84,84)
const S = 6;
const CX = 14 * S;
const CY = 14 * S;
const SCALE = 0.82; // starSize 默认
const RR = GRID.R * SCALE * S; // 顶点外接圆半径(SVG)
const SPHERE = GRID.R * S; // 球半径(SVG)

const SHAPES = [
	{ n: 3, step: 1, label: "三角形" },
	{ n: 4, step: 1, label: "四边形" },
	{ n: 5, step: 2, label: "五芒星" },
	{ n: 6, step: 2, label: "六芒星" },
	{ n: 7, step: 2, label: "七芒星" },
	{ n: 8, step: 3, label: "八芒星" },
	{ n: 9, step: 2, label: "九芒星" },
];

// BRAILLE_BITS 反查:字符码位 -> 该字符内的点(行/列)
const BITS: number[][] = [
	[0x01, 0x08],
	[0x02, 0x10],
	[0x04, 0x20],
	[0x40, 0x80],
];

/** 盲文行 -> 点阵坐标数组 */
function dotsOf(lines: string[]): Array<[number, number]> {
	const pts: Array<[number, number]> = [];
	for (let r = 0; r < lines.length; r++) {
		for (let c = 0; c < lines[r].length; c++) {
			const code = lines[r].charCodeAt(c) - 0x2800;
			for (let dy = 0; dy < 4 && code; dy++) {
				for (let dx = 0; dx < 2 && code; dx++) {
					if (code & BITS[dy][dx]) {
						pts.push([c * 2 + dx, r * 4 + dy]);
					}
				}
			}
		}
	}
	return pts;
}

function hostFor(frame: number): AnimationHost {
	return {
		scene: "think" as SceneId,
		frame,
		phase: 0,
		speedScale: 1,
		flowDir: "cw",
		speaking: false,
		params: { starSpeed: 0.02, cycleFrames: 160, starSize: SCALE },
	};
}

// 每个形状:渲染到 hold 中段(progress = k*160 + 90)
const cycleFrames = 160;
const panelW = 168;
const gap = 12;
const labelH = 26;
const W = SHAPES.length * panelW + (SHAPES.length - 1) * gap + 2 * gap;
const H = panelW + labelH + 2 * gap;

const parts: string[] = [];
parts.push(
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
);
parts.push(`  <rect width="${W}" height="${H}" rx="12" fill="#0d1117"/>`);
parts.push(
	`  <g font-family="ui-monospace,SFMono-Regular,Menlo,monospace">`,
);
parts.push(
	`    <text x="26" y="20" font-size="13" fill="#8b949e">pi-jarvis-sphere · think 场景 stars 动画 · 7 shapes (真实渲染)</text>`,
);

SHAPES.forEach((shape, k) => {
	const ox = gap + k * (panelW + gap);
	const plugin = stars();
	// 推进到 hold 中段
	const target = k * cycleFrames + cycleFrames * 0.56;
	let last: string[] = [];
	for (let f = 0; f <= target; f++) last = plugin.render(GRID, hostFor(f));
	const dots = dotsOf(last);

	parts.push(`  <g transform="translate(${ox},${gap + 8})">`);
	// 球(描边参考)
	parts.push(
		`    <circle cx="${CX}" cy="${CY}" r="${SPHERE.toFixed(1)}" fill="rgba(13,17,23,0.85)" stroke="#00e676" stroke-opacity="0.25"/>`,
	);
	// 顶点外接圆(极淡,参考星形边界)
	parts.push(
		`    <circle cx="${CX}" cy="${CY}" r="${RR.toFixed(1)}" fill="none" stroke="#00e676" stroke-opacity="0.08" stroke-dasharray="2 3"/>`,
	);
	// 盲文点
	for (const [px, py] of dots) {
		parts.push(
			`    <circle cx="${(px * S).toFixed(1)}" cy="${(py * S).toFixed(1)}" r="2.52" fill="#00e676"/>`,
		);
	}
	// 标签
	parts.push(
		`    <text x="${CX}" y="${panelW + 14}" font-size="13" fill="#8b949e" text-anchor="middle">${shape.label}</text>`,
	);
	parts.push(`  </g>`);
});

parts.push(`</g>`);
parts.push(`</svg>`);

const out = resolve(process.cwd(), "stars-preview.svg");
writeFileSync(out, parts.join("\n") + "\n");
console.log(`written: ${out} (${parts.length} parts, dots per shape: ${SHAPES.map((s, k) => {
	const plugin = stars();
	const t = k * cycleFrames + cycleFrames * 0.56;
	let l: string[] = [];
	for (let f = 0; f <= t; f++) l = plugin.render(GRID, hostFor(f));
	return `${s.n}:${dotsOf(l).length}`;
}).join(" ")})`);
