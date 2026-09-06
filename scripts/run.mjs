#!/usr/bin/env node
/**
 * 零安装 runner:定位 jiti,用它加载并执行 TS 脚本。
 *
 * 用法: node scripts/run.mjs scripts/smoke.ts [args...]
 *
 * 定位顺序:
 *   1. 环境变量 JITI_PATH(绝对路径到 jiti 的 lib/jiti.mjs)
 *   2. 本仓 node_modules 里的 jiti(CI / npm install 后)
 *   3. pi 自带 jiti 的固定路径(本机零安装)
 * 找不到则报错并提示回退方案(npm install --no-save jiti 后 npx jiti)。
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const PI_JITI =
	"/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

let jitiUrl = null;
const CANDIDATES = [];
if (process.env.JITI_PATH) CANDIDATES.push(process.env.JITI_PATH);
// 物理路径探测:不经 require.resolve,避免 jiti 包 exports 拦截子路径
// (CI 上 jiti/lib/jiti.mjs 不是可解析的导出入口,但文件就在那里)。
const nodeModulesJiti = path.join(ROOT, "node_modules", "jiti", "lib", "jiti.mjs");
if (fs.existsSync(nodeModulesJiti)) CANDIDATES.push(nodeModulesJiti);
CANDIDATES.push(PI_JITI);

for (const c of CANDIDATES) {
	try {
		await import(c); // 探测能否加载
		jitiUrl = c;
		break;
	} catch {
		// 继续尝试下一个候选
	}
}
if (!jitiUrl) {
	console.error(
		"run.mjs: 找不到 pi 自带 jiti。\n" +
			"  可设 JITI_PATH 指向 jiti 的 lib/jiti.mjs;或回退:\n" +
			"  cd pi-jarvis-sphere && npm install --no-save jiti && npx jiti scripts/smoke.ts",
	);
	process.exit(1);
}

const target = process.argv[2];
if (!target) {
	console.error("run.mjs: 用法 node scripts/run.mjs <target.ts> [args...]");
	process.exit(1);
}
const absTarget = path.resolve(ROOT, target);

const mod = await import(jitiUrl);
const createJiti = mod.createJiti ?? mod.default;
if (typeof createJiti !== "function") {
	console.error("run.mjs: jiti 未导出 createJiti", Object.keys(mod));
	process.exit(1);
}

const jiti = createJiti(absTarget, { moduleCache: false });
await jiti.import(absTarget);
