/**
 * 把 `worker/sstp-pool/` 下的模块拼成一个单文件 `sstp-pool.js`，再从 `_worker.js` 生成两版产物：
 *
 *   --pool   ：保留 `/*<<WARM_POOL_IMPORT>>*\/` 段（真实出口，线上用这个）
 *   --plain  ：剥掉该段（不预热，行为与上游原版一致；出问题时的回退版）
 *
 * 为什么要拼接：
 *   1. Pages Functions 的 `_worker.js` 会被 wrangler 打包，多层嵌套 import 出问题的概率更高，
 *      合成一个文件后只剩 worker.js + sstp-pool.js 两个模块；
 *   2. 以后想回退，只要用 --plain 出一版，不需要改源码。
 *
 * 用法：
 *   node scripts/build-worker.mjs               # 两种都生成
 *   node scripts/build-worker.mjs --only=pool   # 只生成带池版
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.join(ROOT, 'worker', 'sstp-pool');
const WORKER = path.join(ROOT, '_src', 'cmliu_edgetunnel', '_worker.js');
const OUT_DIR = path.join(ROOT, 'logs', 'build');

const argv = process.argv.slice(2);
const only = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';

const ORDER = ['sstp.js', 'warm.js'];

function stripModuleSyntax(code) {
	return code
		.split('\n')
		.filter((line) => !/^\s*import\s.+from\s+['"].+['"];?\s*$/.test(line))
		.map((line) => line.replace(/^(\s*)export\s+(?=(async\s+)?(function|const|let|class)\b)/, '$1'))
		.join('\n');
}

function buildBundle() {
	const parts = ORDER.map((name) => {
		const file = path.join(SRC_DIR, name);
		if (!fs.existsSync(file)) throw new Error(`缺少模块 ${file}`);
		return `// ===== ${name} =====\n${stripModuleSyntax(fs.readFileSync(file, 'utf8')).trim()}\n`;
	});
	const exportsLine = 'export { sstpAcquire, warmStats };\n';
	const bundle = `/* 本文件由 scripts/build-worker.mjs 生成，不要手改；改 worker/sstp-pool/*.js 后重新构建 */\n${parts.join('\n')}\n${exportsLine}`;
	if (/^\s*import\s.+from/m.test(bundle)) throw new Error('拼接后仍有 import 语句，检查 stripModuleSyntax');
	return bundle;
}

const IMPORT_BLOCK = /\/\*<<WARM_POOL_IMPORT>>\*\/[\s\S]*?\/\*<<\/WARM_POOL_IMPORT>>\*\/\n?/;

function buildWorker(source, { withPool }) {
	if (withPool) {
		if (!IMPORT_BLOCK.test(source)) throw new Error('_worker.js 里找不到 WARM_POOL_IMPORT 标记段');
		return source;
	}
	if (!IMPORT_BLOCK.test(source)) throw new Error('_worker.js 里找不到 WARM_POOL_IMPORT 标记段');
	return source.replace(IMPORT_BLOCK, '');
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const source = fs.readFileSync(WORKER, 'utf8');

if (only !== 'plain') {
	const bundle = buildBundle();
	fs.writeFileSync(path.join(OUT_DIR, 'sstp-pool.js'), bundle, 'utf8');
	fs.writeFileSync(path.join(OUT_DIR, 'worker.pool.js'), buildWorker(source, { withPool: true }), 'utf8');
	console.log(`[build] sstp-pool.js ${(bundle.length / 1024).toFixed(1)} KB`);
	console.log(`[build] worker.pool.js ${(fs.statSync(path.join(OUT_DIR, 'worker.pool.js')).size / 1048576).toFixed(2)} MB`);
}

if (only !== 'pool') {
	const plain = buildWorker(source, { withPool: false });
	if (/takeWarmTunnel|sstpAcquire|SstpPool/.test(plain.split('\n').slice(0, 3).join('\n'))) throw new Error('plain 版头部仍有预热池引用');
	fs.writeFileSync(path.join(OUT_DIR, 'worker.plain.js'), plain, 'utf8');
	console.log(`[build] worker.plain.js ${(plain.length / 1048576).toFixed(2)} MB`);
}