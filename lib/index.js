/**
 * dsh-plugin-conflict-audit — cordis 插件外壳
 *
 * 两种模式：
 *   static  —— 读磁盘源码与清单（CLI 也能跑）
 *   runtime —— 通过 ctx 读取当前进程的真实状态：已注册工具 id、服务是否存在、
 *              loader 条目与 fiber 状态
 *   both    —— 默认。运行时数据用于校正静态结论（消除误报、补上盲区）
 *
 * ── 纪律（都是踩坑踩出来的）──
 * ① 只 inject ['tools']。绝不声明不存在的服务 —— 那会让 fiber 永久 pending。
 * ② 激活阶段不做同步重活、不 await。审计读上千文件（~200ms），放到 setTimeout 里。
 * ③ 所有运行时逻辑包 try/catch。插件抛异常会连累宿主启动。
 * ④ 运行时采集全部防御式读取：任何一步失败只记录，不影响其它步骤。
 * ⑤ 输出里的可选字段**必须条件展开**，显式 undefined 会被宿主的 lossless-JSON 校验拒绝。
 */

import path from 'node:path';
import os from 'node:os';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { audit } from '../audit.mjs';

export const name = 'dsh-plugin-conflict-audit';

/** 硬依赖：工具注册表。除此之外不声明任何东西。 */
export const inject = ['tools'];

// ── 环境探测 ──
const ENV_PROFILE = process.env.DSH_PROFILE ?? 'desktop';
const ENV_DSH_HOME = process.env.DSH_HOME ?? null;

function fallbackHome() {
  if (ENV_DSH_HOME !== null) {
    return path.basename(ENV_DSH_HOME) === '.dsh'
      ? path.dirname(ENV_DSH_HOME)
      : os.homedir();
  }
  return os.homedir();
}

function auditArgs(cfg = {}, profileOverride) {
  return {
    home: cfg.home ?? fallbackHome(),
    dshHome: cfg.dshHome ?? ENV_DSH_HOME ?? path.join(cfg.home ?? fallbackHome(), '.dsh'),
    profile: profileOverride ?? cfg.profile ?? ENV_PROFILE,
    json: false,
    verbose: false,
  };
}

/** 服务存在性候选名（取自 2026-11-23 在 DSH 0.2.2-rc.1 上的实测清单） */
const SERVICE_CANDIDATES = [
  'tools', 'webServer', 'llm', 'agents', 'sessionQuery', 'sessions', 'storage',
  'skills', 'jobs', 'commands', 'attachments', 'timer', 'hmr', 'sandbox',
  'approval', 'credentials', 'systemPrompt', 'tokenMeter', 'subprocess',
  'shellEnv', 'schedule', 'workspaceRegistry', 'loader',
  // 常见但实测不存在的，一并探测以便给出确定结论
  'httpServer', 'subagent', 'config', 'workspace', 'console', 'logger',
  'agentInstructions', 'sessionProjection', 'planMode', 'goal',
  'tuiPanels', 'slots', 'locale', 'remote',
];

const msg = (e) => (e instanceof Error ? e.message : String(e));

// ─────────────────────────── 运行时采集 ───────────────────────────

/**
 * Cordis FiberState 的运行时镜像（const enum 没有运行时对象，只能自己映射）。
 * 这是读 fiber 状态下最关键的一点：`fiber.state` 是**数字**，不是字符串。
 */
const FIBER_PHASE = {
  0: 'pending', 1: 'loading', 2: 'active', 3: 'failed', 4: null, 5: 'unloading',
};

/** 防御式取属性：任何形状都不抛 */
function rd(target, key) {
  if (target === null || typeof target !== 'object') return undefined;
  try { return target[key]; } catch { return undefined; }
}

/** cordis 的 inject 可以是数组或对象，统一成字符串数组 */
function injectNames(value) {
  if (Array.isArray(value)) return value.filter((n) => typeof n === 'string');
  if (value !== null && typeof value === 'object') return Object.keys(value);
  return [];
}

function shortError(e) {
  if (e === undefined || e === null) return undefined;
  try {
    const s = e instanceof Error ? e.message : String(e);
    return s.length > 300 ? s.slice(0, 300) + '…' : s;
  } catch { return '<unprintable>'; }
}

/**
 * 读 loader 的条目树（每个插件一行），带 fiber 状态。
 *
 * 关键事实（DSH 0.2.2-rc.1 实测）：
 *   - `loader.entries()` 返回**可迭代对象**（不是普通对象，容易被误判成空）
 *   - `entry.fiber.state` 是数字：0 pending / 1 loading / 2 active / 3 failed / 5 unloading
 *   - `entry.fiber._error` 存失败原因
 *   - `entry.options.name` 是模块名，`entry.options.inject` 是声明的依赖
 */
function collectEntries(ctx) {
  const out = { entries: [], note: null };
  let loader;
  try { loader = ctx.get('loader'); } catch { loader = undefined; }
  if (loader === undefined || typeof loader.entries !== 'function') {
    out.note = 'loader.entries() 不可用：该组合（headless / SDK）没有条目树';
    return out;
  }

  let iterable;
  try { iterable = loader.entries(); } catch (e) { out.note = `loader.entries() 抛错: ${shortError(e)}`; return out; }
  if (iterable === null || typeof iterable !== 'object') {
    out.note = 'loader.entries() 返回值不是可迭代对象';
    return out;
  }

  try {
    for (const entry of iterable) {
      if (out.entries.length >= 400) break;
      const fiber = rd(entry, 'fiber');
      const opts = rd(entry, 'options') ?? {};
      const state = rd(fiber, 'state');
      const phase = typeof state === 'number' ? (FIBER_PHASE[state] ?? null) : null;
      const inject = injectNames(rd(fiber, 'inject') ?? rd(opts, 'inject'));

      const missing = [];
      for (const svc of inject) {
        try { if (ctx.get(svc) === undefined) missing.push(svc); } catch { /* 忽略 */ }
      }

      const rec = {
        phase,
        disabled: rd(entry, 'disabled') === true,
        group: rd(opts, 'group') === true,
        inject,
        missingInject: missing,
      };
      const id = rd(entry, 'id');
      if (typeof id === 'string') rec.id = id;
      const mod = rd(opts, 'name');
      if (typeof mod === 'string') rec.name = mod;
      const err = shortError(rd(fiber, '_error'));
      if (err !== undefined) rec.errorText = err;
      out.entries.push(rec);
    }
  } catch (e) {
    out.note = `遍历 loader.entries() 失败: ${shortError(e)}`;
  }
  return out;
}

/** 读服务实现表，拿到「哪个服务由哪个插件提供」 */
function collectServiceOwners(ctx) {
  const owners = [];
  try {
    const store = rd(rd(ctx, 'reflect'), 'store');
    if (store === null || typeof store !== 'object') return owners;
    for (const key of Reflect.ownKeys(store)) {
      const impl = (() => { try { return store[key]; } catch { return undefined; } })();
      const name = rd(impl, 'name');
      if (typeof name !== 'string') continue;
      const fiber = rd(impl, 'fiber');
      const owner = rd(rd(fiber, 'runtime'), 'name') ?? rd(fiber, 'name') ?? rd(rd(fiber, 'entry'), 'id') ?? 'root';
      owners.push({ service: name, owner: typeof owner === 'string' ? owner : 'root' });
    }
  } catch { /* 忽略 */ }
  return owners;
}

/**
 * 兜底方案：从 loader 树里收集「组合后的插件行」。
 *
 * 实测结构（DSH 0.2.2-rc.1）：
 *   loader.root            → EntryGroup { ctx, tree, data }
 *   entry.subgroup         → EntryGroup
 *   entry.subgroup.data    → 213 个组合行，每行 { id, name, disabled?, config? }
 *
 * 仅当 `loader.entries()` 不可用（或为空）时用；它没有 fiber 状态。
 */
function collectRows(loader, maxRows = 400) {
  const rows = [];
  const seen = new WeakSet();

  const harvest = (node) => {
    let sg;
    try { sg = node?.subgroup; } catch { return; }
    if (sg === null || typeof sg !== 'object') return;
    let data;
    try { data = sg.data; } catch { return; }
    if (!Array.isArray(data)) return;

    for (const r of data) {
      if (rows.length >= maxRows) return;
      const rec = {};
      try { if (typeof r?.id === 'string') rec.id = r.id; } catch { /* 忽略 */ }
      try { if (typeof r?.name === 'string') rec.name = r.name; } catch { /* 忽略 */ }
      try { if (typeof r?.disabled === 'boolean') rec.disabled = r.disabled; } catch { /* 忽略 */ }
      if (Object.keys(rec).length > 0) rows.push(rec);
    }
  };

  const visit = (node, depth) => {
    if (node === null || typeof node !== 'object' || depth > 5) return;
    if (seen.has(node)) return;
    seen.add(node);

    harvest(node);

    let kids;
    try { kids = node.data; } catch { kids = undefined; }
    if (Array.isArray(kids)) for (const k of kids) visit(k, depth + 1);
  };

  try {
    visit(loader.root, 0);
  } catch { /* 忽略 */ }

  // 兜底：loader.store 里的顶层条目也试着 harvest 一遍
  try {
    const store = loader.store;
    if (store !== null && typeof store === 'object') {
      for (const v of Object.values(store)) visit(v, 0);
    }
  } catch { /* 忽略 */ }

  return rows;
}

/** 采集当前进程的真实状态。绝不抛异常。 */
function collectRuntime(ctx) {
  const rt = {
    ok: false,
    liveTools: [],
    servicesPresent: [],
    servicesAbsent: [],
    rows: [],
    entries: [],
    serviceOwners: [],
    errors: [],
  };

  // ① 已注册工具 id
  try {
    const tools = ctx.get('tools');
    if (tools !== undefined && typeof tools.definitions === 'function') {
      const defs = tools.definitions();
      if (Array.isArray(defs)) {
        rt.liveTools = defs
          .map((d) => { try { return d?.name; } catch { return undefined; } })
          .filter((n) => typeof n === 'string');
      }
    } else {
      rt.errors.push('tools.definitions() 不可用');
    }
  } catch (e) { rt.errors.push(`tools: ${msg(e)}`); }

  // ② 服务存在性
  for (const svc of SERVICE_CANDIDATES) {
    try {
      if (ctx.get(svc) === undefined) rt.servicesAbsent.push(svc);
      else rt.servicesPresent.push(svc);
    } catch (e) { rt.errors.push(`ctx.get(${svc}): ${msg(e)}`); }
  }

  // ③ loader 条目 + fiber 状态（首选 loader.entries()）
  try {
    const loader = ctx.get('loader');
    if (loader !== undefined) {
      const { entries, note } = collectEntries(ctx);
      rt.entries = entries;
      if (note !== null) rt.errors.push(note);
      rt.serviceOwners = collectServiceOwners(ctx);
      // 组合行始终采集：row id 是判定「悬空覆盖」的唯一可靠依据
      rt.rows = collectRows(loader);
    } else {
      rt.errors.push('loader 不可用');
    }
  } catch (e) { rt.errors.push(`loader: ${msg(e)}`); }

  rt.ok = rt.errors.length === 0;
  return rt;
}

/**
 * 用运行时事实校正静态结论。
 * 返回新的 findings 数组（不改入参）。
 */
function mergeRuntime(result, rt) {
  const out = [];
  const liveSet = new Set(rt.liveTools);
  const present = new Set(rt.servicesPresent);
  const providedByPlugins = new Set();
  for (const p of result.plugins) for (const s of p.provides) providedByPlugins.add(s);

  const measured = rt.servicesPresent.length > 0;
  // 关键门控：只有真的读到了注册表，才允许用「不在表里」去推翻静态结论。
  // 拿不到运行时数据时保持原判 —— 否则会把真冲突降级成 WARN（测试踩到过）。
  const haveLiveRegistry = rt.liveTools.length > 0;

  for (const f of result.findings) {
    // ── 服务依赖：有实测数据时以实测为准，丢弃旧的启发式结论 ──
    if (f.code === 'I_SERVICE_UNVERIFIED') {
      const m = /"([^"]+)"/.exec(f.title);
      const svc = m?.[1];
      if (measured && svc !== undefined) {
        if (present.has(svc) || providedByPlugins.has(svc)) {
          continue; // 实测存在 → 不报
        }
        out.push({
          level: 'ERROR',
          code: 'E_SERVICE_MISSING',
          title: `运行时确认服务不存在: "${svc}"`,
          detail: `${f.detail ?? ''} —— 实测 ctx.get("${svc}") 返回 undefined 且无插件提供。` +
            '这会导致 fiber 永久 pending、插件静默不工作。',
          confidence: 'exact',
        });
        continue;
      }
      // 无实测数据 → 保留原提示但降级说明
      out.push(f);
      continue;
    }

    // ── 静态工具撞车：用运行时注册表判定真假 ──
    if (f.code === 'E_TOOL_COLLISION') {
      const m = /: (.+)$/.exec(f.title);
      const toolName = m?.[1]?.trim();
      if (toolName !== undefined && haveLiveRegistry) {
        if (liveSet.has(toolName)) {
          out.push({
            ...f,
            detail: `${f.detail ?? ''} —— 运行时确认：该工具 id 确实已注册，冲突真实存在。`,
          });
        } else {
          out.push({
            level: 'WARN',
            code: 'W_STATIC_ONLY_COLLISION',
            title: `静态检出工具重名但运行时未注册: ${toolName}`,
            detail: `${f.detail ?? ''} —— 但实测工具注册表里没有 "${toolName}"。` +
              '可能两个都未生效，或名字是运行时拼接/作用域内注册。低置信，建议人工核对。',
            confidence: 'heuristic',
          });
        }
        continue;
      }
      out.push(f);
      continue;
    }

    out.push(f);
  }

  // ── 新增：插件工具是否真的注册上了 ──
  if (rt.liveTools.length > 0) {
    for (const p of result.plugins) {
      if (p.tools.length === 0) continue;
      const hits = p.tools.filter((t) => liveSet.has(t.name));
      if (hits.length === 0) {
        out.push({
          level: 'WARN',
          code: 'W_PLUGIN_TOOLS_NOT_LIVE',
          title: `${p.name}: 静态发现的 ${p.tools.length} 个工具一个都没注册`,
          detail: '该插件的工具可能按 agent 作用域注册、或未激活、或 activator 失败。' +
            '依赖它的话请实际调一次确认。',
          confidence: 'exact',
        });
      } else if (hits.length < p.tools.length) {
        out.push({
          level: 'INFO',
          code: 'I_PARTIAL_LIVE',
          title: `${p.name}: ${p.tools.length} 个工具里 ${hits.length} 个已注册`,
          detail: '差额通常是作用域注册（按 agent 预设挂载）或代码里未被调用的定义。',
          confidence: 'exact',
        });
      }
    }

    // 注册表里有、但没有任何插件在静态侧声称拥有的工具（通常是核心工具）
    const claimed = new Set();
    for (const p of result.plugins) for (const t of p.tools) claimed.add(t.name);
    const untracked = rt.liveTools.filter((n) => !claimed.has(n));
    if (untracked.length > 0) {
      out.push({
        level: 'INFO',
        code: 'I_UNTRACKED_LIVE_TOOLS',
        title: `运行时注册了 ${untracked.length} 个静态侧未记录的工具`,
        detail: '多为宿主核心工具（如 working_directory），也可能是动态命名的插件工具。' +
          `清单: ${untracked.slice(0, 40).join(', ')}${untracked.length > 40 ? ' …' : ''}`,
        confidence: 'exact',
      });
    }
  }

  // ── 新增：fiber 状态（按插件维度，这是「装了没反应」最直接的判据）──
  if (rt.entries.length > 0) {
    const staticNames = new Set(result.plugins.map((p) => p.name));

    /** 把一条异常条目转成 finding */
    const badEntryFinding = (entry, matchedPluginName) => {
      const label = matchedPluginName ?? entry.name ?? entry.id ?? '(匿名条目)';
      const missing = Array.isArray(entry.missingInject) ? entry.missingInject : [];
      const suffix = matchedPluginName === undefined ? '（不在当前 profile 的 bundle 列表里）' : '';

      if (entry.phase === 'failed') {
        return {
          level: 'ERROR',
          code: 'E_FIBER_FAILED',
          title: `${label}: fiber failed —— 启动失败，插件不会工作`,
          detail: (entry.errorText !== undefined ? `错误: ${entry.errorText}` : '未留下错误信息。') + suffix,
          confidence: 'exact',
        };
      }
      if (missing.length > 0) {
        return {
          level: 'ERROR',
          code: 'E_FIBER_PENDING_MISSING',
          title: `${label}: 永远 pending —— 缺依赖服务 [${missing.join(', ')}]`,
          detail: 'fiber 停在 pending 且这些服务无人提供：插件不报错、不退出、就是不工作。' +
            '这是「装了没反应」最常见的原因。' + suffix,
          confidence: 'exact',
        };
      }
      return {
        level: 'WARN',
        code: 'W_FIBER_PENDING',
        title: `${label}: fiber 停在 pending`,
        detail: '依赖服务都在但仍未激活 —— 可能是加载顺序或内部 await 卡住。' + suffix,
        confidence: 'exact',
      };
    };

    for (const e of rt.entries) {
      if (e.phase !== 'failed' && e.phase !== 'pending') continue;
      if (e.group === true) continue; // 分组容器本身不是插件
      const name = typeof e.name === 'string' ? e.name : undefined;
      // 只报「当前 profile 的插件」以及匿名/未匹配的异常条目；
      // 未匹配的若来自核心 bundle 也无害，但既然异常就还是报出来（分级已按严重度）。
      out.push(badEntryFinding(e, name !== undefined && staticNames.has(name) ? name : undefined));
    }
  }

  // ── 新增：悬空覆盖（你 patch 里的 row id 在组合结果里不存在）──
  // 这一项 doctor 也做，但它靠 node_modules 推断「哪些 row 存在」，
  // 读不到打包进 app.asar 的内置 bundle 就会把内置行判成孤行（实测 7/8 假阳性）。
  // 我们改用运行时组合行 + 条目 id，内置 bundle 的行同样可见。
  if (rt.rows.length > 0 || rt.entries.length > 0) {
    const knownIds = new Set();
    for (const r of rt.rows) if (typeof r.id === 'string') knownIds.add(r.id);
    for (const e of rt.entries) if (typeof e.id === 'string') knownIds.add(e.id);

    const overrides = Array.isArray(result.meta?.userPatchOverrides) ? result.meta.userPatchOverrides : [];
    const dangling = overrides.filter((id) => !knownIds.has(id));
    if (dangling.length > 0) {
      out.push({
        level: 'WARN',
        code: 'W_DANGLING_OVERRIDE',
        title: `cordis.patch.yml 里 ${dangling.length} 条覆盖指向不存在的 row`,
        detail: `运行时组合结果里找不到这些 id：${dangling.join(', ')}。` +
          '覆盖只对已存在的 row 生效 —— 命中不到就是空操作：你以为改了配置，实际什么都没发生，也不会报错。',
        confidence: 'exact',
      });
    }
  }

  // ── 兜底：只有组合行时，报告被禁用的行 ──
  const disabledRows = rt.rows.filter((r) => r.disabled === true);
  if (disabledRows.length > 0) {
    out.push({
      level: 'INFO',
      code: 'I_DISABLED_ROWS',
      title: `组合层里有 ${disabledRows.length} 行被禁用`,
      detail: '这些行在最终组合结果里是 disabled 的（可能来自 bundle patch 或你的 cordis.patch.yml）。清单: ' +
        disabledRows.slice(0, 25).map((r) => r.id ?? r.name ?? '?').join(', ') +
        (disabledRows.length > 25 ? ' …' : ''),
      confidence: 'exact',
    });
  }

  // 修复建议在 compact() 里统一附加（static 模式也能拿到）
  return out;
}

/**
 * 按 code 生成可直接执行的修复建议。
 * 原则：只给「能照做」的，给不出就不给 —— 凑数的建议比没有更糟。
 */
function fixFor(f) {
  const serviceInTitle = /\[([^\]]+)\]/.exec(f.title ?? '')?.[1];
  switch (f.code) {
    case 'E_TOOL_COLLISION':
      return '冲突无法共存，二选一。保留更专用的那个，停用另一个：\n'
        + '  plugin_manager set_bundle { target: "<要停用的包名>", enabled: false }\n'
        + '停用前先备份 profile 的 cordis.patch.yml。';

    case 'E_PATCH_ROW_COLLISION':
      return '两个插件插入了同一个 row id，整行配置会互相覆盖。\n'
        + '  · 能给上游提 PR 的话：让其中一方换一个 row id（cordis.patch.yml 的 insert 项）\n'
        + '  · 临时规避：停用其中一个插件（plugin_manager set_bundle enabled:false）';

    case 'W_DANGLING_OVERRIDE':
      return '覆盖只对已存在的 row 生效，命中不到就是空操作：\n'
        + '  · 如果这行本该存在：确认插入它的 bundle 已启用（dsh.profile.bundles 里有）\n'
        + '  · 如果确实不需要：从 cordis.patch.yml 里删掉那段 "- id: ..."';

    case 'E_SERVICE_MISSING':
      return `服务 "${serviceInTitle ?? '?'}" 不存在，插件会卡在 pending：\n`
        + `  · 装上提供 "${serviceInTitle ?? '?'}" 的插件，或\n`
        + '  · 联系插件作者确认服务名是否拼写错误 / 是否已被上游改名';

    case 'E_FIBER_PENDING_MISSING':
      return `这个插件在等 "${serviceInTitle ?? '?'}"：\n`
        + `  · 装上提供它的插件；或\n`
        + '  · 若该功能非必需，从该插件的 inject 里去掉它（需作者改，或本地 patch）\n'
        + '  · 临时处理：停用这个插件，它会一直占着一个 pending fiber';

    case 'E_FIBER_FAILED':
      return '启动失败的插件不会工作。看 detail 里的原始错误：\n'
        + '  · 报 "already registered" 通常是工具/服务撞车 → 对照本报告的工具撞车项\n'
        + '  · 报 module not found → 依赖没装上，重装该插件\n'
        + '  · 无法判断时：停用它，看问题是否消失（二分法定位）';

    case 'W_PLUGIN_TOOLS_NOT_LIVE':
      return '这些工具很可能按 agent 预设作用域注册（不是 bug）：\n'
        + '  · 验证：在对应预设下实际调一次该工具\n'
        + '  · 若确实调不到，再看该插件的 fiber 状态是否 pending/failed';

    case 'W_COMPAT_UNLISTED':
      return '插件声明的 DSH 版本不含你当前版本。实测优先：\n'
        + '  · 先查 npm 有没有更新版本（作者可能已跟上）\n'
        + '  · 没有新版：升级 DSH 前先跑一遍本工具，别盲升';

    default:
      return undefined;
  }
}

function compact(result, { includeInfo, includeInventory }, runtime, mode) {
  const keep = (f) => (includeInfo ? true : f.level !== 'INFO');
  const findings = result.findings
    .filter(keep)
    .map((f) => {
      const fix = fixFor(f);
      return {
        level: f.level,
        code: f.code,
        title: f.title,
        detail: f.detail,
        confidence: f.confidence,
        ...(fix === undefined ? {} : { fix }),
      };
    });

  const count = (lvl) => result.findings.filter((f) => f.level === lvl).length;

  const out = {
    ok: count('ERROR') === 0,
    error: count('ERROR'),
    warn: count('WARN'),
    info: count('INFO'),
    profile: result.meta.profile,
    dshVersion: result.meta.dshVersion,
    pluginCount: result.meta.pluginCount,
    mode,
    findings,
  };

  if (includeInventory) {
    out.inventory = result.plugins.map((p) => ({
      name: p.name,
      version: p.version,
      toolCount: p.tools.length,
      toolsDynamic: p.toolsDynamic,
      scanned: p.scanned,
      skills: p.skills.length,
    }));
  }

  // 运行时字段：全部条件展开，绝不出现显式 undefined
  if (runtime !== null) {
    out.runtimeOk = runtime.ok;
    out.liveToolCount = runtime.liveTools.length;
    out.rowCount = runtime.rows.length;
    out.entryCount = runtime.entries.length;
    out.fiberFailed = runtime.entries.filter((e) => e.phase === 'failed').length;
    out.fiberPending = runtime.entries.filter((e) => e.phase === 'pending').length;
    out.measuredServicesPresent = runtime.servicesPresent;
    out.measuredServicesAbsent = runtime.servicesAbsent;
    out.rows = runtime.rows;
    if (runtime.errors.length > 0) out.runtimeErrors = runtime.errors;
  }

  return out;
}

/** 开机自检的共享状态（工具可回读） */
const boot = { at: null, snapshot: null, error: null };

export function apply(ctx, config = {}) {
  const cfg = config ?? {};

  try {
    const tool = defineTool({
      name: 'plugin_conflict_audit',
      description:
        '审计 DSH 插件冲突：工具名撞车、patch 行 id 撞车、路由前缀重叠、技能重名、' +
        '服务依赖缺失、版本兼容脱节。默认同时用运行时数据（真实工具注册表 / 服务存在性 / ' +
        'fiber 状态）校正静态扫描，消除误报。只读：不写文件、不联网、不起子进程、不执行插件代码。',
      parameters: {
        profile: {
          type: 'string',
          description: `要审计的 profile 名；默认取环境变量 DSH_PROFILE（当前 ${ENV_PROFILE}）。`,
        },
        mode: {
          type: 'string',
          description: 'static 只读磁盘；runtime 只用运行时事实；both 两者结合（默认）。',
        },
        includeInfo: {
          type: 'boolean',
          description: '是否包含 INFO 级提示（默认 true）。只看硬冲突可设 false。',
        },
        includeInventory: {
          type: 'boolean',
          description: '是否附带每个插件的工具数量清单（默认 false，输出更省 token）。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            error: { type: 'number', required: true },
            warn: { type: 'number', required: true },
            info: { type: 'number', required: true },
            profile: { type: 'string', required: true },
            dshVersion: { type: 'string', required: true },
            pluginCount: { type: 'number', required: true },
            mode: { type: 'string', required: true },
            findings: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  level: { type: 'string', required: true },
                  code: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  detail: { type: 'string' },
                  confidence: { type: 'string' },
                  fix: { type: 'string' },
                },
              },
            },
            inventory: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  version: { type: 'string' },
                  toolCount: { type: 'number', required: true },
                  toolsDynamic: { type: 'boolean' },
                  scanned: { type: 'number' },
                  skills: { type: 'number' },
                },
              },
            },
            runtimeOk: { type: 'boolean' },
            liveToolCount: { type: 'number' },
            rowCount: { type: 'number' },
            entryCount: { type: 'number' },
            fiberFailed: { type: 'number' },
            fiberPending: { type: 'number' },
            rows: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  disabled: { type: 'boolean' },
                },
              },
            },
            measuredServicesPresent: { type: 'array', items: { type: 'string' } },
            measuredServicesAbsent: { type: 'array', items: { type: 'string' } },
            runtimeErrors: { type: 'array', items: { type: 'string' } },
            bootAt: { type: 'string' },
            bootError: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const head = value.ok
            ? `✓ 无硬冲突 (WARN ${value.warn} · INFO ${value.info})`
            : `✗ ${value.error} 个硬冲突 (WARN ${value.warn} · INFO ${value.info})`;
          const lines = [
            head,
            `profile ${value.profile} · DSH ${value.dshVersion} · ${value.pluginCount} 个可扫描插件 · 模式 ${value.mode}`,
          ];
          if (value.liveToolCount !== undefined) {
            lines.push(`运行时：${value.liveToolCount} 个已注册工具 · ${value.entryCount ?? 0} 个条目` +
              (value.fiberFailed || value.fiberPending ? ` · failed ${value.fiberFailed ?? 0} / pending ${value.fiberPending ?? 0}` : '') +
              (value.runtimeOk === false ? '（采集有错误）' : ''));
          }
          for (const f of value.findings) {
            const mark = f.level === 'ERROR' ? '✗' : f.level === 'WARN' ? '!' : '·';
            lines.push(`${mark} [${f.code}] ${f.title}`);
            if (f.detail) lines.push(`    ${f.detail}`);
            if (f.fix) lines.push(`    ↳ 修复: ${String(f.fix).replace(/\n/g, '\n      ')}`);
          }
          if (value.bootAt !== undefined) lines.push(`上次开机自检: ${value.bootAt}`);
          if (value.bootError !== undefined) lines.push(`上次自检失败: ${value.bootError}`);
          if (Array.isArray(value.inventory) && value.inventory.length > 0) {
            lines.push('— 插件清单 —');
            for (const p of value.inventory) {
              lines.push(`  ${p.name}${p.version ? '@' + p.version : ''}: ${p.toolCount} 工具${p.toolsDynamic ? ' (动态命名)' : ''}`);
            }
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      async execute(args = {}) {
        const bootFields = {
          ...(boot.at === null ? {} : { bootAt: boot.at }),
          ...(boot.error === null ? {} : { bootError: boot.error }),
        };
        const mode = ['static', 'runtime', 'both'].includes(args.mode) ? args.mode : 'both';

        const runStatic = mode !== 'runtime';
        const runRuntime = mode !== 'static';

        try {
          if (!runStatic) {
            // 纯运行时模式：不需要静态结果，构造空壳
            const rt = collectRuntime(ctx);
            const shell = {
              findings: [],
              plugins: [],
              meta: {
                profile: args.profile ?? cfg.profile ?? ENV_PROFILE,
                dshVersion: 'runtime-only',
                pluginCount: 0,
              },
            };
            const merged = mergeRuntime(shell, rt);
            const counts = { ERROR: 0, WARN: 0, INFO: 0 };
            for (const f of merged) counts[f.level] = (counts[f.level] ?? 0) + 1;
            const out = {
              ok: counts.ERROR === 0,
              error: counts.ERROR,
              warn: counts.WARN,
              info: counts.INFO,
              profile: shell.meta.profile,
              dshVersion: shell.meta.dshVersion,
              pluginCount: 0,
              mode,
              findings: merged.map((f) => {
                const fix = fixFor(f);
                return {
                  level: f.level, code: f.code, title: f.title,
                  detail: f.detail, confidence: f.confidence,
                  ...(fix === undefined ? {} : { fix }),
                };
              }),
              runtimeOk: rt.ok,
              liveToolCount: rt.liveTools.length,
              rowCount: rt.rows.length,
              entryCount: rt.entries.length,
              fiberFailed: rt.entries.filter((e) => e.phase === 'failed').length,
              fiberPending: rt.entries.filter((e) => e.phase === 'pending').length,
              rows: rt.rows,
              measuredServicesPresent: rt.servicesPresent,
              measuredServicesAbsent: rt.servicesAbsent,
              ...(rt.errors.length > 0 ? { runtimeErrors: rt.errors } : {}),
              ...bootFields,
            };
            return out;
          }

          const result = audit(auditArgs(cfg, args.profile));
          const rt = runRuntime ? collectRuntime(ctx) : null;
          if (rt !== null) result.findings = mergeRuntime(result, rt);

          return {
            ...compact(result, {
              includeInfo: args.includeInfo !== false,
              includeInventory: args.includeInventory === true,
            }, rt, mode),
            ...bootFields,
          };
        } catch (err) {
          if (boot.snapshot !== null) {
            return {
              ...boot.snapshot,
              findings: [
                {
                  level: 'WARN',
                  code: 'W_STALE_BOOT_SNAPSHOT',
                  title: `实时审计失败，返回 ${boot.at} 的开机快照`,
                  detail: msg(err),
                  confidence: 'exact',
                },
                ...boot.snapshot.findings,
              ],
              ...bootFields,
            };
          }
          return {
            ok: false,
            error: 1,
            warn: 0,
            info: 0,
            profile: args.profile ?? cfg.profile ?? ENV_PROFILE,
            dshVersion: 'unknown',
            pluginCount: 0,
            mode,
            findings: [{
              level: 'ERROR',
              code: 'E_AUDIT_THREW',
              title: '审计脚本自身异常',
              detail: err instanceof Error ? (err.stack ?? err.message) : String(err),
              confidence: 'exact',
            }],
            ...bootFields,
          };
        }
      },
    });

    ctx.tools.register(tool);
  } catch (err) {
    console.warn('[conflict-audit] 工具注册失败:', msg(err));
  }

  // ── 开机自检：延迟、非阻塞、失败静默 ──
  if (cfg.startupSelfCheck !== false) {
    const delay = Math.max(0, Number(cfg.startupDelayMs ?? 4000));
    try {
      ctx.effect(() => {
        const timer = setTimeout(() => {
          try {
            const result = audit(auditArgs(cfg));
            const rt = collectRuntime(ctx);
            result.findings = mergeRuntime(result, rt);
            boot.at = new Date().toISOString();
            boot.snapshot = compact(result, { includeInfo: false, includeInventory: false }, rt, 'both');
            boot.error = null;

            const errors = result.findings.filter((f) => f.level === 'ERROR');
            if (errors.length > 0) {
              console.warn(
                `[conflict-audit] 发现 ${errors.length} 个插件冲突：`,
                errors.map((e) => `${e.code} ${e.title}`).join(' | '),
                '\n运行 plugin_conflict_audit 查看详情。',
              );
            }
          } catch (err) {
            boot.error = msg(err);
            console.warn('[conflict-audit] 自检失败（已忽略，不影响宿主）:', boot.error);
          }
        }, delay);
        if (typeof timer.unref === 'function') timer.unref();
        return () => clearTimeout(timer);
      }, 'conflict-audit: startup self-check');
    } catch (err) {
      console.warn('[conflict-audit] 自检未能挂载:', msg(err));
    }
  }
}
