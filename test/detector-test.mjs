#!/usr/bin/env node
/**
 * 检测器自测 —— 证明 audit.mjs 真的会报冲突，而不是什么都说"干净"。
 *
 * 为什么必须有这个文件：
 *   审计脚本报出 "0 冲突" 时，有两种可能——
 *     ① 真的干净  ② 检测逻辑是哑的
 *   光看报告无法区分。所以这里造两个夹具 profile：
 *     - fixture/conflict/  ← 故意让两个插件撞工具名 + 撞 patch 行 → 必须报 2 个 ERROR
 *     - fixture/clean/     ← 无重叠 → 必须报 0 个 ERROR
 *   同时对版本比对做断言（第一版脚本把 `>=0.1.5` 判成不满足，正是漏在这里）。
 *
 * 安全说明：测试会在本目录下创建 fixture/，这是测试自身的行为；
 * 被测的 audit.mjs 依然只读。
 *
 * 运行: node test/detector-test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { audit, versionSatisfies } from '../audit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(HERE, 'fixture');

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${extra ? ' — ' + extra : ''}`); }
};

// ───────────────────────── 夹具构造 ─────────────────────────
function writeFileEnsured(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

const PLUGIN_PKG = (name) => JSON.stringify({
  name,
  version: '1.0.0',
  type: 'module',
  main: 'index.js',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2);

const PLUGIN_JS = (toolName) => `
import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = 'fixture';
export const inject = ['tools'];

// 幽灵示例：{ name: 'ghost_line_comment', description: '必须被忽略' }
/* 幽灵示例块：defineTool({ name: 'ghost_block_comment' }) */

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: '${toolName}',
    description: 'fixture tool',
    parameters: {},
    async execute() { return {}; },
  }));
}
`;

function buildFixture(root, { conflict }) {
  const home = path.join(root, '.dsh');
  const profileDir = path.join(home, 'profiles', 'demo');

  writeFileEnsured(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'demo-profile',
    private: true,
    dependencies: { 'plug-a': '*', 'plug-b': '*' },
    dsh: { profile: { bundles: ['plug-a', 'plug-b'] } },
  }, null, 2));

  // plug-a / plug-b：工具名故意相同，patch 行 id 也故意相同
  const aTool = 'clash_tool';
  const bTool = conflict ? 'clash_tool' : 'other_tool';
  const aRow = 'shared-row';
  const bRow = conflict ? 'shared-row' : 'second-row';

  for (const [dir, tool, row] of [['plug-a', aTool, aRow], ['plug-b', bTool, bRow]]) {
    const base = path.join(profileDir, 'node_modules', dir);
    writeFileEnsured(path.join(base, 'package.json'), PLUGIN_PKG(dir));
    writeFileEnsured(path.join(base, 'index.js'), PLUGIN_JS(tool));
    writeFileEnsured(path.join(base, 'cordis.patch.yml'),
      `# fixture\n- insert:\n    - id: ${row}\n      name: '${dir}'\n`);
  }

  return { home: root };   // home 是"假用户主目录"，audit 自己会拼 .dsh/
}

// ───────────────────────── 断言：版本比对 ─────────────────────────
console.log('\n版本比对（第一版在这里全错）');
const vCases = [
  ['0.2.2-rc.1', '>=0.1.5-rc.1', true,   '>= 范围'],
  ['0.2.2-rc.1', '>=0.1.0-rc.6 <0.3.0-0', true, '双界限'],
  ['0.2.2-rc.1', '>=0.1.0-rc.7', true,   'dsh-cad 的声明'],
  ['0.2.2-rc.1', '>=0.2.2-rc.1 <0.2.3-0', true, 'dsh-ops 的声明'],
  ['0.2.2-rc.1', '0.2.0-rc.2 || 0.2.1-alpha.1 || 0.2.1-alpha.2', false, 'dsh-blender 的声明（真不满足）'],
  ['0.2.2-rc.1', '^0.2.0', true,  '插入符'],
  ['0.3.0',      '^0.2.0', false, '插入符上界'],
  ['0.2.2-rc.1', '*', true, '通配'],
  ['1.0.0',      '1.0.0-rc.1', false, '正式版 > 预发布'],
];
for (const [ver, range, want, label] of vCases) {
  const got = versionSatisfies(ver, range);
  ok(got === want, `${label}: ${ver} ~ "${range}" → ${want}`, `实际 ${got}`);
}

// ───────────────────────── 断言：冲突检测 ─────────────────────────
function run(name, conflict) {
  const root = path.join(FIXTURE_ROOT, name);
  fs.rmSync(root, { recursive: true, force: true });
  const { home } = buildFixture(root, { conflict });
  return audit({ home, profile: 'demo', json: false, verbose: false });
}

console.log('\n冲突检测：故意撞车（必须报错）');
{
  const r = run('conflict', true);
  const codes = r.findings.filter((f) => f.level === 'ERROR').map((f) => f.code);
  const toolHit = r.findings.some((f) => f.code === 'E_TOOL_COLLISION' && /clash_tool/.test(f.title));
  const rowHit = r.findings.some((f) => f.code === 'E_PATCH_ROW_COLLISION' && /shared-row/.test(f.title));
  ok(toolHit, '识别出工具名撞车 clash_tool');
  ok(rowHit, '识别出 patch 行 id 撞车 shared-row');
  ok(codes.length === 2, `ERROR 数量恰好 2（实际 ${codes.length}: ${codes.join(',')})`);
}

console.log('\n冲突检测：无撞车（必须干净 —— 防止误报）');
{
  const r = run('clean', false);
  const errors = r.findings.filter((f) => f.level === 'ERROR');
  ok(errors.length === 0, `0 个 ERROR（实际 ${errors.length}${errors.length ? ': ' + errors.map((e) => e.title).join('; ') : ''}）`);
  const tools = r.plugins.flatMap((p) => p.tools.map((t) => t.name)).sort();
  ok(JSON.stringify(tools) === '["clash_tool","other_tool"]',
     `两份夹具工具都提取到了: ${tools.join(', ')}`);
}

console.log('\n注释里的示例不得变成幽灵工具');
{
  const r = run('clean', false);
  const tools = r.plugins.flatMap((p) => p.tools.map((t) => t.name));
  ok(!tools.some((t) => t.startsWith('ghost_')),
     `注释中的示例被正确忽略（实际提取: ${tools.join(', ')}）`);
}

console.log('\n检测器覆盖能力');
{
  const r = run('clean', false);
  const p = r.plugins[0];
  ok(p !== undefined && p.tools.length > 0,
     'defineTool 写法能被解析（否则所有工具检测都是空转）');
  ok(Array.isArray(p?.patchInserts) && p.patchInserts.length === 1,
     'patch insert 能被正确归类为「插入」而非「覆盖」');
}

// ───────────────────────── 收尾 ─────────────────────────
fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
