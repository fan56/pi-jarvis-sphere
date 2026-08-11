#!/usr/bin/env node
/**
 * 零依赖语法检查:用全局 typescript 的 transpileModule 逐个转译项目 .ts 文件,
 * 只报告语法级错误(不做类型检查,类型检查见 tsc --noEmit 尽力而为)。
 *
 * 用法: NODE_PATH=/opt/homebrew/lib/node_modules node scripts/check.mjs
 */
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let ts;
try {
	ts = require("typescript");
} catch {
	console.error(
		"check.mjs: 找不到全局 typescript(尝试 NODE_PATH=/opt/homebrew/lib/node_modules)",
	);
	process.exit(1);
}

const ROOT = path.resolve(__dirname, "..");
// 需要语法检查的 .ts 文件:宿主 + lib + animations + smoke 测试
const targets = [
	"index.ts",
	"lib/types.ts",
	"lib/geometry.ts",
	"lib/braille.ts",
	"lib/noise.ts",
	"lib/scenes.ts",
	"animations/registry.ts",
	"animations/flow-field.ts",
	"animations/refract.ts",
	"animations/orbital.ts",
	"animations/stars.ts",
	"animations/stars2.ts",
	"scripts/smoke.ts",
];

let failed = 0;
for (const rel of targets) {
	const abs = path.join(ROOT, rel);
	if (!fs.existsSync(abs)) {
		console.error(`  ✗ ${rel}  (缺失)`);
		failed++;
		continue;
	}
	const src = fs.readFileSync(abs, "utf-8");
	const out = ts.transpileModule(src, {
		fileName: abs,
		reportDiagnostics: true,
		compilerOptions: {
			target: ts.ScriptTarget.ES2020,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
		},
	});
	const diags = (out.diagnostics ?? []).filter(
		(d) => d.category === ts.DiagnosticCategory.Error,
	);
	if (diags.length === 0) {
		console.log(`  ✓ ${rel}`);
	} else {
		failed++;
		console.error(`  ✗ ${rel}`);
		for (const d of diags) {
			const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
			if (d.file && d.start != null) {
				const pos = d.file.getLineAndCharacterOfPosition(d.start);
				console.error(`      ${pos.line + 1}:${pos.character + 1} ${msg}`);
			} else {
				console.error(`      ${msg}`);
			}
		}
	}
}

if (failed > 0) {
	console.error(`\ncheck.mjs: ${failed} 个文件语法错误`);
	process.exit(1);
}
console.log(`\ncheck.mjs: 全部 ${targets.length} 个目标通过(语法级)`);
