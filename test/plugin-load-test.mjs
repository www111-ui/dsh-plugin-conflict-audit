#!/usr/bin/env node
/**
 * 装载测试 —— 在没有宿主的情况下验证插件外壳能不能活。
 *
 * 为什么需要：
 *   detector-test.mjs 只测审计逻辑，不测 cordis 插件外壳。
 *   而插件外壳才是最容易把 harness 搞挂的部分（inject 写错 → fiber 永久 pending；
 *   apply 里抛异常 → 启动失败）。所以在装进 profile 之前，先用 stub 顶替宿主的
 *   `@deepseek-ai/dsh-tools`，把模块初始化 + apply() + tool.execute() 全跑一遍。
 *
 * 它验证：
 *   ① 模块能被 import（没有语法错误、没有顶层副作用崩溃）
 *   ② inject 只声明了真实存在的服务（这里断言不含 'effect' 这类历史坑）
 *   ③ apply() 不会抛异常，且成功注册 plugin_conflict_audit
 *   ④ 工具 execute() 能返回合法结构
 *   ⑤ 注册失败时 apply() 仍然不抛（降级而非崩溃）
 *
 * 运行: node test/plugin-load-test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const STUB_DIR = path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-tools');

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${extra ? ' — ' + extra : ''}`); }
};

// ── 造 / 拆 stub ──
function installStub() {
  fs.mkdirSync(STUB_DIR, { recursive: true });
  fs.writeFileSync(path.join(STUB_DIR, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-tools',
    version: '0.0.0-stub',
    type: 'module',
    main: 'index.js',
  }), 'utf8');
  fs.writeFileSync(path.join(STUB_DIR, 'index.js'),
    'export const defineTool = (def) => def;\n', 'utf8');
}

function removeStub() {
  fs.rmSync(path.join(ROOT, 'node_modules'), { recursive: true, force: true });
}

/** 假 ctx：只实现插件用到的两个面 */
function makeCtx() {
  const registered = [];
  const effects = [];
  return {
    registered,
    effects,
    tools: { register: (t) => { registered.push(t); return () => {}; } },
    effect: (fn, label) => { effects.push({ label, dispose: fn() }); },
  };
}

// ── 开跑 ──
installStub();

try {
  console.log('\n模块初始化');
  let mod = null;
  try {
    mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href);
    ok(true, 'lib/index.js 可被 import');
  } catch (err) {
    ok(false, 'lib/index.js 可被 import', err.message);
  }

  if (mod !== null) {
    ok(mod.name === 'dsh-plugin-conflict-audit', `导出 name 正确`, `实际 ${mod.name}`);
    ok(typeof mod.apply === 'function', '导出 apply 函数');

    console.log('\ninject 声明（历史坑：写成不存在的服务会让 fiber 永久 pending）');
    const inject = mod.inject ?? [];
    ok(Array.isArray(inject), 'inject 是数组');
    ok(inject.includes('tools'), '包含必需服务 tools');
    for (const bogus of ['effect', 'webServer', 'llm', 'agents']) {
      ok(!inject.includes(bogus), `未声明多余服务 "${bogus}"`);
    }

    console.log('\napply() 正常路径');
    const ctx = makeCtx();
    let threw = null;
    try { mod.apply(ctx, { startupSelfCheck: false }); }
    catch (err) { threw = err; }
    ok(threw === null, 'apply() 不抛异常', threw?.message);
    ok(ctx.registered.length === 1, `注册了 1 个工具（实际 ${ctx.registered.length}）`);
    const tool = ctx.registered[0];
    ok(tool?.name === 'plugin_conflict_audit', '工具名是 plugin_conflict_audit', tool?.name);

    console.log('\n工具 execute()');
    if (tool !== undefined && typeof tool.execute === 'function') {
      let out = null, execErr = null;
      try { out = await tool.execute({ includeInfo: false }); }
      catch (err) { execErr = err; }
      ok(execErr === null, 'execute() 不抛异常', execErr?.message);
      ok(out !== null && typeof out === 'object', '返回对象');
      ok(typeof out?.ok === 'boolean', 'ok 字段是布尔');
      ok(Array.isArray(out?.findings), 'findings 是数组');
      ok(typeof out?.error === 'number' && typeof out?.warn === 'number', 'error/warn 是数字');
      ok(out?.findings.every((f) => f.level !== 'INFO') || out?.findings.length === 0,
         'includeInfo:false 时过滤掉了 INFO');
      // execute 拿不到 profile 时也要有可用输出，不能崩
      ok(typeof out?.profile === 'string' && out.profile.length > 0, `profile 有值: ${out?.profile}`);
      // 自检还没跑过（本节 startupSelfCheck:false 且早于其它 apply）
      ok(out?.bootAt === undefined, '未开自检时不返回 bootAt（可选字段未泄漏 undefined）');
    }

    console.log('\n输出必须是 lossless JSON（宿主硬校验，stub 不校验，所以只能在这里兜）');
    if (tool !== undefined && typeof tool.execute === 'function') {
      const seen = [];
      for (const args of [
        {},
        { includeInfo: false },
        { includeInfo: true, includeInventory: false },
        { includeInfo: false, includeInventory: true },
        { includeInfo: true, includeInventory: true },
      ]) {
        const o = await tool.execute(args);
        const label = JSON.stringify(args);
        // 递归找 undefined：JSON.stringify 会静默丢弃它，而宿主会直接拒绝整个结果
        const undef = [];
        const walk = (v, p) => {
          if (v === undefined) { undef.push(p); return; }
          if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${p}[${i}]`)); return; }
          if (v !== null && typeof v === 'object') {
            for (const [k, x] of Object.entries(v)) walk(x, p === '' ? k : `${p}.${k}`);
          }
        };
        walk(o, '');
        ok(undef.length === 0, `${label} 无 undefined 字段`,
           undef.length ? `泄漏位置: ${undef.slice(0, 5).join(', ')}` : '');

        const roundTrip = JSON.parse(JSON.stringify(o));
        ok(JSON.stringify(roundTrip) === JSON.stringify(o),
           `${label} JSON 往返无损`);
        seen.push(o);
      }
      // inventory 只在显式要求时出现
      ok(seen[2]?.inventory === undefined, 'includeInventory:false 时不出现 inventory 键');
      ok(Array.isArray(seen[3]?.inventory), 'includeInventory:true 时 inventory 是数组');
    }

    console.log('\n开机自检挂载');
    const ctx2 = makeCtx();
    mod.apply(ctx2, { startupSelfCheck: true, startupDelayMs: 10 });
    ok(ctx2.effects.length === 1, `挂载了 1 个 effect（实际 ${ctx2.effects.length}）`);
    ok(typeof ctx2.effects[0]?.dispose === 'function', 'effect 返回了 dispose 函数');
    // 等自检的 setTimeout 跑完（延迟 10ms + 审计耗时）
    await new Promise((r) => setTimeout(r, 1200));
    ok(true, '自检延迟执行未抛异常（异常会被内部吞掉并记日志）');
    ctx2.effects[0].dispose();

    console.log('\n开机自检：能不能真的报警（不只是"不抛异常"）');
    {
      // 造一个必然冲突的 profile：两个插件注册同名工具
      const root = path.join(ROOT, 'test', '.fixture-selfcheck');
      fs.rmSync(root, { recursive: true, force: true });
      const prof = path.join(root, '.dsh', 'profiles', 'demo');
      const mk = (dir, tool, row) => {
        const base = path.join(prof, 'node_modules', dir);
        fs.mkdirSync(base, { recursive: true });
        fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({
          name: dir, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
        }), 'utf8');
        fs.writeFileSync(path.join(base, 'cordis.patch.yml'),
          `- insert:\n    - id: ${row}\n      name: '${dir}'\n`, 'utf8');
        fs.writeFileSync(path.join(base, 'index.js'), `
import { defineTool } from '@deepseek-ai/dsh-tools';
export function apply(ctx) {
  ctx.tools.register(defineTool({ name: '${tool}', description: 'x', parameters: {} }));
}
`, 'utf8');
      };
      fs.mkdirSync(prof, { recursive: true });
      fs.writeFileSync(path.join(prof, 'package.json'), JSON.stringify({
        name: 'demo', dependencies: { 'p-a': '*', 'p-b': '*' },
        dsh: { profile: { bundles: ['p-a', 'p-b'] } },
      }), 'utf8');
      mk('p-a', 'boom_tool', 'row-1');
      mk('p-b', 'boom_tool', 'row-2');

      const warns = [];
      const orig = console.warn;
      console.warn = (...a) => { warns.push(a.map(String).join(' ')); };
      const ctx4 = makeCtx();
      let threw4 = null;
      try {
        mod.apply(ctx4, {
          startupSelfCheck: true, startupDelayMs: 5,
          home: root, dshHome: path.join(root, '.dsh'), profile: 'demo',
        });
      } catch (err) { threw4 = err; }
      await new Promise((r) => setTimeout(r, 600));
      console.warn = orig;
      fs.rmSync(root, { recursive: true, force: true });

      ok(threw4 === null, '自检挂载不抛异常', threw4?.message);
      const alerted = warns.some((w) => w.includes('[conflict-audit]') && w.includes('E_TOOL_COLLISION'));
      ok(alerted, '自检发现冲突并写出 console.warn（含 E_TOOL_COLLISION）',
         `实际告警: ${warns.join(' | ').slice(0, 200) || '(无)'}`);

      // 自检是否真的执行过，通过 bootAt 可观测（宿主 console 看不到，只能这样证）
      const tool4 = ctx4.registered[0];
      const out4 = await tool4.execute({ includeInfo: false });
      ok(typeof out4?.bootAt === 'string' && !Number.isNaN(Date.parse(out4.bootAt)),
         `自检确实执行过，bootAt=${out4?.bootAt ?? '(无)'}`);
      ok(out4?.bootError === undefined, '自检成功时无 bootError');
    }

    console.log('\nfiber 状态检测（构造 pending / failed 条目）');
    {
      const mkCtx = (entries) => {
        const c = {
          registered: [],
          effects: [],
          tools: { register: (t) => { c.registered.push(t); } },
          effect: (fn) => { c.effects.push(fn()); },
          get: (n) => {
            if (n === 'tools') return { definitions: () => [{ name: 'some_tool' }], register() {} };
            if (n === 'loader') return { entries: () => entries };
            return undefined;
          },
        };
        return c;
      };

      // state: 0=pending 2=active 3=failed（cordis FiberState 数字枚举）
      const pendingEntry = {
        id: 'p-fake',
        options: { name: 'dsh-fake-pending', inject: ['ghostService'] },
        fiber: { state: 0 },
      };
      const ctxP = mkCtx([pendingEntry]);
      mod.apply(ctxP, { startupSelfCheck: false });
      const outP = await ctxP.registered[0].execute({ mode: 'runtime', includeInfo: false });
      const codesP = outP.findings.map((f) => f.code);
      ok(codesP.includes('E_FIBER_PENDING_MISSING'),
         'pending + 缺服务 → E_FIBER_PENDING_MISSING', `实际: ${codesP.join(',')}`);
      ok(outP.findings.some((f) => f.code === 'E_FIBER_PENDING_MISSING' && /ghostService/.test(f.title)),
         '提示里带出缺失的服务名');
      ok(outP.fiberPending === 1 && outP.fiberFailed === 0,
         `统计正确 (pending=${outP.fiberPending}, failed=${outP.fiberFailed})`);

      const failedEntry = {
        id: 'f-fake',
        options: { name: 'dsh-fake-failed' },
        fiber: { state: 3, _error: new Error('service "shared" has been registered at A') },
      };
      const ctxF = mkCtx([failedEntry]);
      mod.apply(ctxF, { startupSelfCheck: false });
      const outF = await ctxF.registered[0].execute({ mode: 'runtime', includeInfo: false });
      ok(outF.findings.some((f) => f.code === 'E_FIBER_FAILED'), 'failed → E_FIBER_FAILED');
      ok(outF.findings.some((f) => /registered at A/.test(f.detail ?? '')),
         '失败原因从 fiber._error 带出来');

      // active 不应报
      const ctxA = mkCtx([{ id: 'a-fake', options: { name: 'dsh-fake-active' }, fiber: { state: 2 } }]);
      mod.apply(ctxA, { startupSelfCheck: false });
      const outA = await ctxA.registered[0].execute({ mode: 'runtime', includeInfo: false });
      ok(!outA.findings.some((f) => f.code.startsWith('E_FIBER') || f.code.startsWith('W_FIBER')),
         'active 条目不被误报');
    }

    console.log('\n悬空覆盖检测（patch 覆盖了组合结果里不存在的 row）');
    {
      // 造 profile：user patch 覆盖 row-a（真实存在）和 ghost-row（不存在）
      const root = path.join(ROOT, 'test', '.fixture-dangling');
      fs.rmSync(root, { recursive: true, force: true });
      const prof = path.join(root, '.dsh', 'profiles', 'demo');
      fs.mkdirSync(prof, { recursive: true });
      fs.writeFileSync(path.join(prof, 'package.json'), JSON.stringify({
        name: 'demo-profile', private: true, dependencies: {},
        dsh: { profile: { bundles: [] } },
      }), 'utf8');
      fs.writeFileSync(path.join(prof, 'cordis.patch.yml'),
        '- id: row-a\n  config: {}\n- id: ghost-row\n  config: {}\n', 'utf8');

      const c = {
        registered: [], effects: [],
        tools: { register: (t) => { c.registered.push(t); } },
        effect: (fn) => { c.effects.push(fn()); },
        get: (n) => {
          if (n === 'tools') return { definitions: () => [], register() {} };
          if (n === 'loader') {
            return {
              entries: () => [{ id: 'row-a', options: { name: 'plugin-x' }, fiber: { state: 2 } }],
              root: { data: [{ subgroup: { data: [{ id: 'row-a' }] } }] },
              store: {},
            };
          }
          return undefined;
        },
      };
      mod.apply(c, {
        startupSelfCheck: false,
        home: root, dshHome: path.join(root, '.dsh'), profile: 'demo',
      });
      const outD = await c.registered[0].execute({ mode: 'both', includeInfo: true });
      const dangling = outD.findings.find((f) => f.code === 'W_DANGLING_OVERRIDE');
      ok(dangling !== undefined, '检出 ghost-row 为悬空覆盖',
         `实际 codes: ${outD.findings.map((f) => f.code).join(',')}`);
      ok(/ghost-row/.test(dangling?.detail ?? ''), '提示里点名 ghost-row');
      ok(!/row-a/.test(dangling?.detail ?? ''), '已存在的 row-a 不被误报');
      fs.rmSync(root, { recursive: true, force: true });
    }

    console.log('\n修复建议（fix 字段）');
    {
      const ctx7 = {
        registered: [], effects: [],
        tools: { register: (t) => { ctx7.registered.push(t); } },
        effect: (fn) => { ctx7.effects.push(fn()); },
        get: (n) => {
          if (n === 'tools') return { definitions: () => [], register() {} };
          if (n === 'loader') {
            return {
              entries: () => [{ id: 'x', options: { name: 'dsh-pending-x', inject: ['ghostSvc'] }, fiber: { state: 0 } }],
              root: { data: [] }, store: {},
            };
          }
          return undefined;
        },
      };
      mod.apply(ctx7, { startupSelfCheck: false });
      const out7 = await ctx7.registered[0].execute({ mode: 'runtime', includeInfo: false });
      const pending = out7.findings.find((f) => f.code === 'E_FIBER_PENDING_MISSING');
      ok(pending !== undefined, '找到 pending 发现');
      ok(typeof pending?.fix === 'string' && pending.fix.length > 10,
         'pending 发现带可执行修复建议', pending?.fix?.slice(0, 40));
      ok(/ghostSvc/.test(pending?.fix ?? ''), '修复建议里带出具体服务名');
    }

    console.log('\n故障降级：tools.register 抛异常时');
    const ctx3 = {
      registered: [],
      effects: [],
      tools: { register: () => { throw new Error('registry down'); } },
      effect: (fn) => { ctx3.effects.push(fn()); },
    };
    let threw3 = null;
    const origWarn = console.warn;
    console.warn = () => {};   // 静音预期的告警
    try { mod.apply(ctx3, { startupSelfCheck: false }); }
    catch (err) { threw3 = err; }
    console.warn = origWarn;
    ok(threw3 === null, '注册失败时 apply() 仍不抛（降级而非崩溃）', threw3?.message);
  }
} finally {
  removeStub();
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
