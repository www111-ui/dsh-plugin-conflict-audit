#!/usr/bin/env node
/**
 * dsh-config-audit — DSH 插件冲突静态审计
 *
 * 设计目标：在你按下"重启 harness"之前，把冲突摊开来看。
 *
 * ============================ 安全约束 ============================
 * 本脚本是严格只读的。它：
 *   - 只调用 fs.readFileSync / fs.readdirSync / fs.statSync / fs.existsSync
 *   - 不写任何文件、不删任何文件、不创建目录
 *   - 不发起任何网络请求
 *   - 不启动任何子进程
 *   - 不 import / require 任何插件代码（不执行被测对象）
 * 脚本末尾会自我审计：扫描自身源码确认没有出现危险 API。
 * =================================================================
 *
 * 用法：
 *   node audit.mjs                    # 审计默认 profile
 *   node audit.mjs --profile desktop
 *   node audit.mjs --json             # 机器可读输出
 *   node audit.mjs --verbose          # 显示被跳过的文件
 *
 * 退出码：0 = 无冲突 / 2 = 发现冲突 / 1 = 脚本自身出错
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ───────────────────────────── 可调阈值 ─────────────────────────────
const MAX_FILE_BYTES = 1_500_000;   // 超过则跳过（防止读进打包产物）
// 上限只统计"待解析的代码/技能文件"，不统计 README、二进制、字体等。
// 实测 dsh-ops 有 1114 个文件，原上限 600 会让它被静默截断 → 漏报工具。
const MAX_FILES_PER_PLUGIN = 6000;
const MAX_WALK_DEPTH = 8;           // 目录遍历深度上限
const ROUTE_OVERLAP_SEGMENTS = 2;   // 路由按前 N 段判重叠

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.pnpm', '.cache', 'coverage',
  'test', 'tests', '__tests__', '__mocks__', 'dist-test',
  // 明显不含工具定义的目录
  'docs', 'doc', 'licenses', 'locale', 'locales', 'native',
  'prompts', 'presets', 'assets', 'images', 'img',
]);

/** 只有这些才算"待解析文件"，避免上限被 README / 二进制吃掉 */
const SCAN_EXTS = /\.(m?js|cjs|ts|mts|cts)$/i;

// 观察得到的核心服务名（非权威，仅用于降低误报）。
// 不在这个集合、也没有任何插件 provide 的服务 → 标 INFO 让人确认。
const KNOWN_CORE_SERVICES = new Set([
  'tools', 'webServer', 'httpServer', 'llm', 'agents', 'sessionQuery',
  'storage', 'subagent', 'skills', 'jobs', 'config', 'commands',
  'attachments', 'workspace', 'workspaceRegistry', 'sessions', 'timer',
  'hmr', 'console', 'logger', 'effect', 'sandbox', 'approval', 'credentials',
  'systemPrompt', 'agentInstructions', 'sessionProjection', 'tokenMeter',
  'subprocess', 'shellEnv', 'planMode', 'goal', 'schedule', 'skills',
]);

// ───────────────────────────── 终端着色 ─────────────────────────────
const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const c = (code) => (s) => (NO_COLOR ? String(s) : `\x1b[${code}m${s}\x1b[0m`);
const red = c('31'), yellow = c('33'), green = c('32'),
      cyan = c('36'), dim = c('2'), bold = c('1');

// ───────────────────────────── 参数解析 ─────────────────────────────
function parseArgs(argv) {
  const out = { profile: 'desktop', json: false, verbose: false, home: os.homedir() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--profile') out.profile = argv[++i];
    else if (a === '--home') out.home = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('用法: node audit.mjs [--profile <name>] [--json] [--verbose]');
      process.exit(0);
    }
  }
  return out;
}

// ───────────────────────────── 只读工具函数 ─────────────────────────────
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readHead(file, bytes = 4096) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** 只读目录遍历；返回绝对路径数组。不跟随符号链接，避免环。
 *  `want(name)` 决定哪些文件计入配额与结果。 */
function walk(dir, opts = {}) {
  const { maxDepth = MAX_WALK_DEPTH, maxFiles = MAX_FILES_PER_PLUGIN,
          want = () => true } = opts;
  const files = [];
  const skipped = [];
  let capped = false;
  const stack = [[dir, 0]];

  while (stack.length > 0) {
    const [cur, depth] = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (files.length >= maxFiles) { capped = true; break; }
      const full = path.join(cur, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        if (depth + 1 > maxDepth) { skipped.push(`深度超限 ${full}`); continue; }
        stack.push([full, depth + 1]);
      } else if (ent.isFile()) {
        if (!want(ent.name)) { skipped.push(`非代码 ${ent.name}`); continue; }
        files.push(full);
      }
    }
    if (capped) break;
  }
  return { files, skipped, capped };
}

// ───────────────────────────── 提取器 ─────────────────────────────

/**
 * 剥掉 JS 注释（保留字符串字面量与换行，长度不敏感但结构不变）。
 *
 * 为什么必须做：插件常把示例工具定义写进注释或文档块，例如
 *     // 写法 B：{ name: 'xxx', description: 'xxx' }
 * 直接对源码做正则会把这种示例当成真工具，产生幽灵工具名 ——
 * 甚至造成假撞车。本脚本第一版就在自己身上犯了这个错（报了个 "xxx" 工具）。
 *
 * 用状态机而不是正则：字符串里的 `//`（如 https:// 或路由 "/a/b"）不能被误删。
 * 不处理正则字面量里的 `/`（极少见，可接受）。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code';   // code | line | block | sq | dq | tpl

  while (i < n) {
    const ch = src[i];
    const nx = src[i + 1];

    if (state === 'code') {
      if (ch === '/' && nx === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (ch === '/' && nx === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (ch === "'") { state = 'sq'; out += ch; i++; continue; }
      if (ch === '"') { state = 'dq'; out += ch; i++; continue; }
      if (ch === '`') { state = 'tpl'; out += ch; i++; continue; }
      out += ch; i++; continue;
    }
    if (state === 'line') {
      if (ch === '\n') { state = 'code'; out += '\n'; } else { out += ' '; }
      i++; continue;
    }
    if (state === 'block') {
      if (ch === '*' && nx === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += ch === '\n' ? '\n' : ' ';
      i++; continue;
    }
    // 字符串内部：原样保留，只处理转义与终止符
    out += ch;
    if (ch === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
    if ((state === 'sq' && ch === "'") || (state === 'dq' && ch === '"') || (state === 'tpl' && ch === '`')) {
      state = 'code';
    }
    i++;
  }
  return out;
}

/** 工具名提取（两种写法）。返回 [{name, confidence}] */
function extractToolNames(text) {
  const found = new Map();
  const put = (name, confidence) => {
    if (!name || name.length < 2 || name.length > 80) return;
    if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(name)) return;
    // 模板占位符（如 __TOOL___keywords）不是真工具名
    if (/__/.test(name) || /^_/.test(name)) return;
    if (/[%${}]/.test(name)) return;
    const prev = found.get(name);
    if (prev === undefined || prev === 'medium') found.set(name, confidence);
  };

  // 写法 A（主流、高置信）：defineTool({ ... name: 'xxx'
  const reA = /defineTool\s*\(\s*\{[\s\S]{0,700}?\bname\s*:\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(reA)) put(m[1], 'high');

  // 写法 B（中置信）：{ name: 'xxx', description: 'xxx' } 紧邻的对象字面量
  const reB = /(?:^|[({,]\s*)\{\s*name\s*:\s*['"]([^'"]+)['"]\s*,\s*description\s*:\s*['"`]/g;
  for (const m of text.matchAll(reB)) put(m[1], 'medium');

  return [...found.entries()].map(([name, confidence]) => ({ name, confidence }));
}

/** 路由前缀提取（启发式）。仅在提到 webServer 的文件里找。 */
function extractRoutes(text) {
  if (!/webServer|httpServer/.test(text)) return [];
  const out = new Set();
  const re = /\b(?:path|prefix)\s*:\s*['"](\/[^'"]{1,100})['"]/g;
  for (const m of text.matchAll(re)) {
    const raw = m[1].split('?')[0];
    if (raw.length < 2) continue;
    out.add(raw);
  }
  return [...out];
}

/** 声明的服务依赖 / 提供 */
function extractServiceList(text, kind) {
  const out = new Set();
  if (kind === 'inject') {
    const re = /export\s+const\s+inject\s*=\s*\[([\s\S]{0,400}?)\]/g;
    for (const m of text.matchAll(re)) {
      for (const s of m[1].matchAll(/['"]([a-zA-Z_][\w.]*)['"]/g)) out.add(s[1]);
    }
  } else {
    const re = /export\s+const\s+provides?\s*=\s*\[([\s\S]{0,400}?)\]/g;
    for (const m of text.matchAll(re)) {
      for (const s of m[1].matchAll(/['"]([a-zA-Z_][\w.]*)['"]/g)) out.add(s[1]);
    }
    // ctx.provide('x') / ctx.set('x', ...) 也视为提供服务
    for (const m of text.matchAll(/ctx\.(?:provide|set)\s*\(\s*['"]([a-zA-Z_][\w.]*)['"]/g)) out.add(m[1]);
  }
  return [...out];
}

/**
 * patch yaml 解析：区分「插入新行」与「覆盖已有行」。
 * 这两者的语义完全不同 —— 用户 patch 覆盖插件插入的行是**设计如此**（配置定制），
 * 把它当冲突报出来就是误报（第一版脚本正是这么错的）。
 *
 *   - insert:            ← 顶级 insert 块
 *       - id: blender-3d    ← 新行 → 插入
 *   - id: agent-default-model  ← 顶级 entry → 覆盖
 */
function parsePatchYaml(yamlText) {
  const inserts = new Set();
  const overrides = new Set();
  if (typeof yamlText !== 'string') return { inserts, overrides };
  let inInsert = false;

  for (const line of yamlText.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;

    if (/^-\s/.test(line)) {           // 顶级条目（无缩进）
      const head = line.match(/^-\s*([A-Za-z_][\w]*)\s*:/);
      inInsert = head !== null && head[1] === 'insert';
      const idm = line.match(/^-\s*id\s*:\s*([A-Za-z0-9_.@/-]+)/);
      if (idm) overrides.add(idm[1]);
      continue;
    }
    if (inInsert) {
      const m = line.match(/^\s+-\s*id\s*:\s*([A-Za-z0-9_.@/-]+)/);
      if (m) inserts.add(m[1]);
    }
  }
  return { inserts, overrides };
}

/** SKILL.md frontmatter 里的 name */
function extractSkillName(head) {
  if (head === null) return null;
  const fm = head.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const m = fm[1].match(/^name\s*:\s*['"]?([^'"\n]+)['"]?\s*$/m);
  return m ? m[1].trim() : null;
}

// ───────────────────────────── 版本比对 ─────────────────────────────
/**
 * 精简 semver：足够判断兼容声明，不追求覆盖全部 npm 语法。
 * 支持：`||` 或、空格 与、>= <= > < = ^ ~、x/* 通配、预发布标签（rc.1 / alpha.2 / -0）。
 */

/** "0.2.2-rc.1" → { nums:[0,2,2], pre:['rc','1'] } */
function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/^v/, '');
  const m = s.match(/^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!m) return null;
  const num = (t) => (t === undefined || t === 'x' || t === '*' ? null : Number(t));
  return {
    nums: [num(m[1]), num(m[2]), num(m[3])],
    pre: m[4] ? m[4].split('.') : [],
  };
}

const isWild = (n) => n === null || n === undefined;

function cmpIdent(a, b) {
  const an = /^\d+$/.test(a), bn = /^\d+$/.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  if (an) return -1;              // 数字标识符优先级低于字母
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 返回 -1 / 0 / 1 */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    const av = isWild(a.nums[i]) ? 0 : a.nums[i];
    const bv = isWild(b.nums[i]) ? 0 : b.nums[i];
    if (av !== bv) return Math.sign(av - bv);
  }
  // 预发布：无 pre 的一方更高（1.0.0 > 1.0.0-rc.1）
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const len = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < len; i++) {
    const ai = a.pre[i], bi = b.pre[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const c = cmpIdent(ai, bi);
    if (c !== 0) return c;
  }
  return 0;
}

/** 单个比较器是否满足 */
function satisfiesComparator(version, op, target) {
  if (target === '*' || target === '') return true;
  const t = parseVersion(target);
  if (t === null) return null;   // 无法解析 → 未知
  const c = compareVersions(version, t);

  switch (op) {
    case '>=': return c >= 0;
    case '>':  return c > 0;
    case '<=': return c <= 0;
    case '<':  return c < 0;
    case '^': {
      if (c < 0) return false;
      // ^0.2.4 → <0.3.0；^1.2.3 → <2.0.0
      const upperMajor = t.nums[0] === 0 ? [0, (t.nums[1] ?? 0) + 1, 0] : [t.nums[0] + 1, 0, 0];
      return compareVersions(version, { nums: upperMajor, pre: [] }) < 0;
    }
    case '~': {
      if (c < 0) return false;
      const upper = [t.nums[0] ?? 0, (t.nums[1] ?? 0) + 1, 0];
      return compareVersions(version, { nums: upper, pre: [] }) < 0;
    }
    default:   // '=' 或裸版本
      if (isWild(t.nums[1]) || isWild(t.nums[2])) {
        // 通配：按已给字段做前缀匹配
        const vp = parseVersion(versionText(version));
        if (vp === null) return null;
        for (let i = 0; i < 3; i++) {
          if (isWild(t.nums[i])) continue;
          if (vp.nums[i] !== t.nums[i]) return false;
        }
        return true;
      }
      return c === 0;
  }
}

function versionText(v) {
  const head = v.nums.map((n) => (n === null ? 'x' : n)).join('.');
  return v.pre.length > 0 ? `${head}-${v.pre.join('.')}` : head;
}

/** 完整范围判断。返回 true / false / null(未知) */
function versionSatisfies(versionStr, rangeStr) {
  if (typeof rangeStr !== 'string' || rangeStr.trim() === '') return null;
  const version = parseVersion(versionStr);
  if (version === null) return null;

  for (const alternative of rangeStr.split('||')) {
    const tokens = alternative.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;

    let all = true, unknown = false;
    for (const token of tokens) {
      const m = token.match(/^(>=|<=|>|<|=|\^|~)?\s*(.+)$/);
      if (m === null) { unknown = true; break; }
      const op = m[1] ?? '=';
      const target = m[2].replace(/^v/, '');
      if (/-0$/.test(target) && op === '<') {
        // "<0.3.0-0" → 严格小于该预发布基线
        const baseline = parseVersion(target);
        if (baseline === null) { unknown = true; break; }
        if (compareVersions(version, baseline) >= 0) { all = false; break; }
        continue;
      }
      const r = satisfiesComparator(version, op, target);
      if (r === null) { unknown = true; break; }
      if (r === false) { all = false; break; }
    }
    if (all && !unknown) return true;
  }
  return false;
}

// ───────────────────────────── 主流程 ─────────────────────────────
function audit(opts) {
  const findings = [];
  const add = (level, code, title, detail, extra = {}) =>
    findings.push({ level, code, title, detail, confidence: extra.confidence ?? 'exact', ...extra });

  // dshHome 优先：宿主可能把 DSH_HOME 指到非 ~/.dsh 的位置
  const dshHome = opts.dshHome ?? path.join(opts.home, '.dsh');
  const profilesDir = path.join(dshHome, 'profiles');
  const profileDir = path.join(profilesDir, opts.profile);
  const skillsDir = path.join(dshHome, 'skills');

  // ── 0. 基本可达性 ──
  if (!isDir(profileDir)) {
    add('ERROR', 'E_PROFILE_MISSING', `profile 目录不存在: ${profileDir}`,
        '检查 --profile 参数或 ~/.dsh/profiles 布局');
    return { findings, plugins: [], meta: {} };
  }

  // ── 1. 当前 DSH 版本 ──
  const runtimeJson = readJson(path.join(dshHome, 'dsh-runtimes',
                                         'dsh-primary-runtime', 'runtime.json'));
  const dshVersion = runtimeJson?.desktopVersion ?? 'unknown';

  // ── 2. profile manifest：谁是"启用"的 ──
  const profilePkg = readJson(path.join(profileDir, 'package.json'));
  if (profilePkg === null) {
    add('ERROR', 'E_PROFILE_MANIFEST', `${path.join(profileDir, 'package.json')} 读不到或非法 JSON`, '');
    return { findings, plugins: [], meta: { dshVersion } };
  }
  const bundles = profilePkg?.dsh?.profile?.bundles ?? [];
  const deps = profilePkg?.dependencies ?? {};

  // 已安装但未启用的依赖（正常现象，只做提示）
  const bundleSet = new Set(bundles);
  for (const depName of Object.keys(deps)) {
    if (!bundleSet.has(depName)) {
      add('INFO', 'I_DISABLED', `依赖已安装但未启用: ${depName}`,
          '不在 dsh.profile.bundles 中 → 不会加载。若这是你主动停用的，忽略即可。');
    }
  }

  // ── 3. 解析每个 bundle 的目录 ──
  const plugins = [];
  for (const name of bundles) {
    let dir = null;

    const depSpec = deps[name];
    if (typeof depSpec === 'string' && depSpec.startsWith('link:')) {
      dir = depSpec.slice('link:'.length);
    } else {
      const candidate = path.join(profileDir, 'node_modules', name);
      if (isDir(candidate)) dir = candidate;
    }

    if (dir === null) {
      add('INFO', 'I_CORE_BUNDLE', `核心 bundle（profile 内无实体）: ${name}`,
          '由宿主自带，跳过静态扫描。');
      continue;
    }
    if (!isDir(dir)) {
      add('ERROR', 'E_BUNDLE_MISSING', `bundle 目录不存在: ${name}`,
          `解析路径 ${dir}；依赖声明为 ${depSpec ?? '(无)'}`);
      continue;
    }

    const pkg = readJson(path.join(dir, 'package.json'));
    if (pkg === null) {
      add('ERROR', 'E_BUNDLE_MANIFEST', `bundle 缺少可解析的 package.json: ${name}`, dir);
      continue;
    }

    const entry = {
      name,
      version: pkg.version ?? null,
      dir,
      pkg,
      tools: [],
      routes: [],
      patchesInserted: [],
      injects: [],
      injectsClient: [],
      injectsInternal: [],
      provides: [],
      patchIds: [],
      patchInserts: [],
      patchOverrides: [],
      skills: [],
      bundlePatch: pkg?.dsh?.bundle?.patch ?? null,
    };

    // ── 3a. dsh.bundle.patch 是否存在 ──
    if (entry.bundlePatch) {
      const patchPath = path.join(dir, entry.bundlePatch);
      if (!isFile(patchPath)) {
        add('ERROR', 'E_PATCH_MISSING', `${name}: dsh.bundle.patch 指向的文件不存在`,
            `声明 ${entry.bundlePatch} → ${patchPath}`);
      } else {
        const text = readText(patchPath);
        if (text !== null) {
          const parsed = parsePatchYaml(text);
          entry.patchInserts = [...parsed.inserts];
          entry.patchOverrides = [...parsed.overrides];
          entry.patchIds = [...new Set([...parsed.inserts, ...parsed.overrides])];
        }
      }
    }

    // ── 3b. 兼容性声明（这是"声明与现实"，不是运行结果）──
    const compatDecl = pkg?.dsh?.compatibility?.dsh ?? pkg?.engines?.dsh;
    if (compatDecl !== undefined) {
      const ok = versionSatisfies(dshVersion, compatDecl);
      if (ok === false) {
        add('WARN', 'W_COMPAT_UNLISTED',
            `${name}@${entry.version}: 兼容声明不含当前 DSH ${dshVersion}`,
            `声明 "${compatDecl}"。插件仍可能正常工作（实测优先），但这是未验证组合 —— 升级 DSH 前先确认。`,
            { confidence: 'exact' });
      }
    }

    // 入口文件：只有它导出的 inject 才代表「插件级」服务依赖。
    // 子模块（如 dsh-ops 的 lib/components/tui/index.js）声明的 inject 是内部组件
    // 的可选依赖，缺失只会让该组件 pending，不应报成插件缺依赖。
    const mainField = pkg.main
      ?? (typeof pkg.exports === 'string' ? pkg.exports : pkg.exports?.['.'])
      ?? 'index.js';
    const mainRel = (typeof mainField === 'string' ? mainField : (mainField?.default ?? 'index.js'))
      .replace(/^\.\//, '');
    const entryFile = path.resolve(dir, mainRel);

    // ── 3c. 扫描自有代码（排除 node_modules）──
    const walkRes = walk(dir, {
      maxDepth: MAX_WALK_DEPTH,
      maxFiles: MAX_FILES_PER_PLUGIN,
      want: (name) => SCAN_EXTS.test(name) || name === 'SKILL.md',
    });
    if (walkRes.capped) {
      add('WARN', 'W_SCAN_CAPPED', `${name}: 扫描文件数触顶 ${MAX_FILES_PER_PLUGIN}`,
          `只解析了部分文件，工具清单可能不完整 —— 该插件的冲突检测结果不可全信。`);
    }
    const toolMap = new Map();
    const routeSet = new Set();
    const injectSet = new Set();        // 服务端 inject（参与服务存在性判定）
    const injectClientSet = new Set();  // 客户端 inject（浏览器侧，服务名空间不同，不参与判定）
    const injectInternalSet = new Set(); // 子组件 inject（可选依赖，只做提示）
    const provideSet = new Set();
    const skillSet = new Set();
    let dynamicHint = null;

    for (const file of walkRes.files) {
      const base = path.basename(file);

      // SKILL.md → 技能名
      if (base === 'SKILL.md') {
        const head = readHead(file, 2048);
        const sname = extractSkillName(head) ?? path.basename(path.dirname(file));
        if (sname) skillSet.add(sname);
        continue;
      }

      if (!/\.(m?js|cjs|ts|mts|cts)$/.test(base)) continue;

      const raw = readText(file);
      if (raw === null) continue;
      // 只对代码匹配：注释里的示例定义不是真工具
      const text = stripComments(raw);

      for (const t of extractToolNames(text)) {
        const prev = toolMap.get(t.name);
        if (prev === undefined || prev === 'medium') toolMap.set(t.name, t.confidence);
      }
      // 动态工具名迹象：前缀拼接（dsh-ops 用 `ops_` + raw）/ 模板化。
      // 注意：路由前缀（`/aurabot/api`）不是工具前缀 —— 必须排除，否则集中误报。
      if (dynamicHint === null) {
        const m = text.match(/(?:export\s+)?const\s+((?:[A-Z_]*TOOL[A-Z_]*PREFIX[A-Z_]*|PREFIX[A-Z_]*TOOL[A-Z_]*))\s*=\s*['"]([^'"]+)['"]/)
               ?? text.match(/\bpublicToolName\s*\(/)
               ?? text.match(/`\$\{[A-Za-z_][\w.]*\}_(?:bash|read|write|grep|glob)\b/);
        if (m !== null && !/['"]\//.test(m[0])) dynamicHint = m[0].slice(0, 60);
      }
      for (const r of extractRoutes(text)) routeSet.add(r);
      // 判断文件属于服务端还是浏览器端。
      // dsh-ops 的 lib/client.js 里 inject 的是 slots / locale / tuiPanels / remote，
      // 这些是浏览器侧服务名，在宿主里根本不存在 —— 混在一起会误报「依赖缺失」。
      const rel = path.relative(dir, file).replace(/\\/g, '/');
      const isClientSide =
        /(^|\/)(client|ui|web|browser)(\/|\.|$)/i.test(rel) ||
        /(^|\/)client\.[cm]?[jt]s$/i.test(rel);

      const injectsHere = extractServiceList(text, 'inject');
      if (path.resolve(file) !== entryFile) {
        // 子组件 inject：单独归类，不参与插件级依赖判定
        for (const s of injectsHere) injectInternalSet.add(s);
      } else if (isClientSide) {
        for (const s of injectsHere) injectClientSet.add(s);
      } else {
        for (const s of injectsHere) injectSet.add(s);
      }
      for (const s of extractServiceList(text, 'provide')) provideSet.add(s);
    }

    entry.tools = [...toolMap.entries()].map(([name, confidence]) => ({ name, confidence }));
    entry.routes = [...routeSet];
    entry.injects = [...injectSet];
    entry.injectsClient = [...injectClientSet];
    entry.injectsInternal = [...injectInternalSet];
    entry.provides = [...provideSet];
    entry.skills = [...skillSet];
    entry.scanned = walkRes.files.length;
    entry.skipped = walkRes.skipped;
    entry.toolsDynamic = dynamicHint !== null;
    entry.dynamicHint = dynamicHint;

    if (entry.toolsDynamic) {
      add('WARN', 'W_DYNAMIC_TOOL_NAMES',
          `${name}: 工具名是运行时拼接的，静态扫描只能列出字面量`,
          `命中迹象: ${dynamicHint} —— 该插件真实工具数可能远多于上面列出的 ` +
          `${entry.tools.length} 个。**此插件的工具名冲突检测结果不可信**，需运行时核对。`);
    }

    plugins.push(entry);
  }

  // ── 4. 全局技能目录 ──
  const globalSkills = new Map();
  if (isDir(skillsDir)) {
    for (const ent of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const f = path.join(skillsDir, ent.name, 'SKILL.md');
      if (!isFile(f)) continue;
      const sname = extractSkillName(readHead(f, 2048)) ?? ent.name;
      globalSkills.set(sname, f);
    }
  }

  // ── 5. 冲突计算 ──
  const byTool = new Map();
  for (const p of plugins) {
    for (const t of p.tools) {
      if (!byTool.has(t.name)) byTool.set(t.name, []);
      byTool.get(t.name).push({ plugin: p.name, confidence: t.confidence });
    }
  }
  for (const [toolName, owners] of byTool) {
    if (owners.length > 1) {
      add('ERROR', 'E_TOOL_COLLISION', `工具名撞车: ${toolName}`,
          `${owners.map((o) => `${o.plugin}(${o.confidence})`).join(' + ')} —— 注册表覆盖式，后加载者赢，另一个静默消失。`,
          { confidence: owners.every((o) => o.confidence === 'high') ? 'high' : 'medium' });
    }
  }

  const byRow = new Map();
  for (const p of plugins) {
    for (const id of p.patchInserts) {
      if (!byRow.has(id)) byRow.set(id, []);
      byRow.get(id).push(p.name);
    }
  }
  // profile 自身的 patch 层
  const userPatch = path.join(profileDir, 'cordis.patch.yml');
  const userPatchParsed = isFile(userPatch)
    ? parsePatchYaml(readText(userPatch) ?? '')
    : { inserts: new Set(), overrides: new Set() };

  // ① 两个插件插入同一个行 id → 真冲突，整行互相覆盖
  for (const [rowId, owners] of byRow) {
    if (owners.length > 1) {
      add('ERROR', 'E_PATCH_ROW_COLLISION', `两个插件插入同一 patch 行 id: ${rowId}`,
          `${owners.join(' + ')} —— 整行配置会互相覆盖。`);
    }
  }

  // ② 两个插件覆盖同一个行 id → 配置互相打架（不一定是错，但需知会）
  const overrideOwners = new Map();
  for (const p of plugins) {
    for (const id of p.patchOverrides) {
      if (!overrideOwners.has(id)) overrideOwners.set(id, []);
      overrideOwners.get(id).push(p.name);
    }
  }
  for (const [rowId, owners] of overrideOwners) {
    if (owners.length > 1) {
      add('WARN', 'W_PATCH_OVERRIDE_FIGHT', `两个插件覆盖同一 patch 行: ${rowId}`,
          `${owners.join(' + ')} —— 同一行的 config 会被后者覆盖，先加载者的定制可能失效。`);
    }
  }

  // ③ 用户 patch 覆盖插件插入的行 → 设计如此，只做 INFO
  for (const id of userPatchParsed.overrides) {
    if (byRow.has(id)) {
      add('INFO', 'I_USER_PATCH_TARGETS', `你的 cordis.patch.yml 定制了插件行: ${id}`,
          `来自 ${byRow.get(id).join(', ')}。这是正常的配置覆盖，不是冲突。`);
    }
  }
  // ④ 用户 patch 自己也插入了某个行 id，且插件也插入了 → 冲突
  for (const id of userPatchParsed.inserts) {
    if (byRow.has(id)) {
      add('ERROR', 'E_PATCH_ROW_COLLISION', `你与插件插入了同一 patch 行 id: ${id}`,
          `${byRow.get(id).join(', ')} + <your cordis.patch.yml> —— 会互相覆盖。`);
    }
  }

  // 路由：按前 N 段判重叠
  const byRoute = new Map();
  for (const p of plugins) {
    for (const r of p.routes) {
      const key = '/' + r.split('/').filter(Boolean).slice(0, ROUTE_OVERLAP_SEGMENTS).join('/');
      if (!byRoute.has(key)) byRoute.set(key, new Map());
      const m = byRoute.get(key);
      if (!m.has(p.name)) m.set(p.name, new Set());
      m.get(key)?.add?.(r);
      m.get(p.name).add(r);
    }
  }
  for (const [key, owners] of byRoute) {
    if (owners.size > 1) {
      const desc = [...owners.entries()].map(([n, set]) => `${n}:[${[...set].join(',')}]`).join('  ');
      add('WARN', 'W_ROUTE_OVERLAP', `路由前缀疑似重叠: ${key}`,
          desc + ' —— 启发式判断：同前缀在 webServer 上后注册者覆盖。请人工确认是否真的撞。',
          { confidence: 'heuristic' });
    }
  }

  // 服务：inject 有、但无人 provide 且不在核心白名单
  const allProvided = new Set();
  for (const p of plugins) for (const s of p.provides) allProvided.add(s);

  const unknownServices = new Map();
  for (const p of plugins) {
    for (const s of p.injects) {
      if (KNOWN_CORE_SERVICES.has(s)) continue;
      if (allProvided.has(s)) continue;
      if (!unknownServices.has(s)) unknownServices.set(s, []);
      unknownServices.get(s).push(p.name);
    }
  }
  for (const [svc, owners] of unknownServices) {
    add('INFO', 'I_SERVICE_UNVERIFIED', `服务依赖无法核实: "${svc}"`,
        `${owners.join(', ')} 声明 inject ["${svc}"]，未见任何插件 provide，也不在已知核心服务名单里。` +
        '注意：核心服务清单是本脚本的观察值、非权威 —— 绝大多数情况下它确实是核心提供的。' +
        '只有当该服务名根本不存在时才有害（会导致 fiber 永久 pending）。属低置信提示。',
        { confidence: 'heuristic' });
  }

  // 技能重名
  const bySkill = new Map();
  for (const [sname, f] of globalSkills) {
    if (!bySkill.has(sname)) bySkill.set(sname, []);
    bySkill.get(sname).push({ source: '~/.dsh/skills', file: f });
  }
  for (const p of plugins) {
    for (const s of p.skills) {
      if (!bySkill.has(s)) bySkill.set(s, []);
      bySkill.get(s).push({ source: `plugin:${p.name}`, file: null });
    }
  }
  for (const [sname, owners] of bySkill) {
    const uniq = new Set(owners.map((o) => o.source));
    if (uniq.size > 1) {
      add('WARN', 'W_SKILL_COLLISION', `技能名重名: ${sname}`,
          [...uniq].join(' + ') + ' —— 后注册者可能覆盖前者。');
    }
  }

  // 同一插件内重复定义
  for (const p of plugins) {
    const seen = new Set();
    const dup = new Set();
    for (const t of p.tools) {
      if (seen.has(t.name)) dup.add(t.name);
      seen.add(t.name);
    }
    if (dup.size > 0) {
      add('WARN', 'W_SELF_DUP', `${p.name} 内部重复定义工具: ${[...dup].join(', ')}`, '');
    }
  }

  return {
    findings,
    plugins,
    meta: {
      profile: opts.profile,
      profileDir,
      dshVersion,
      bundleCount: bundles.length,
      pluginCount: plugins.length,
      globalSkillCount: globalSkills.size,
    },
  };
}

// ───────────────────────────── 自审计 ─────────────────────────────
// #region self-audit-patterns
// 这些是"写操作 / 子进程 / 网络"的特征串。本区块在自扫描时会被整段剔除，
// 否则清单会举报自己。用纯子串匹配，避免正则元字符（如 "unlink(" 的括号）出错。
const FORBIDDEN_APIS = [
  'writeFileSync', 'writeFile(', 'appendFileSync', 'appendFile(',
  'unlinkSync', 'unlink(', 'rmSync', 'rmdirSync', 'mkdirSync',
  'renameSync', 'copyFileSync', 'createWriteStream',
  'child_process', 'execSync', 'spawnSync', 'exec(', 'spawn(', 'fork(',
  'fetch(', 'https.request', 'http.request', 'net.connect', 'WebSocket',
];
// #endregion self-audit-patterns

function selfAudit() {
  const selfPath = fileURLToPath(import.meta.url);
  const raw = readText(selfPath) ?? '';

  // 剔除本区块 + 注释行，只留真正的代码行
  const withoutBlock = raw.replace(
    /\/\/ #region self-audit-patterns[\s\S]*?\/\/ #endregion self-audit-patterns/g, '');
  const codeLines = withoutBlock.split('\n').filter((ln) => {
    const t = ln.trim();
    return t !== '' && !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') || t.startsWith('#'));
  });

  const hits = [];
  for (const api of FORBIDDEN_APIS) {
    if (codeLines.some((ln) => ln.includes(api))) hits.push(api);
  }
  return { selfPath, hits, codeLineCount: codeLines.length };
}

// ───────────────────────────── 报告 ─────────────────────────────
function renderText(result, opts) {
  const { findings, plugins, meta } = result;
  const lines = [];

  lines.push(bold('════════ DSH 插件冲突审计 ════════'));
  lines.push(`${dim('profile')}      ${meta.profile}`);
  lines.push(`${dim('目录')}         ${meta.profileDir}`);
  lines.push(`${dim('DSH 版本')}    ${meta.dshVersion}`);
  lines.push(`${dim('bundle 总数')} ${meta.bundleCount}  ${dim('（可扫描实体')} ${meta.pluginCount}${dim('）')}`);
  lines.push(`${dim('全局技能')}   ${meta.globalSkillCount}`);
  lines.push('');

  const order = { ERROR: 0, WARN: 1, INFO: 2, OK: 3 };
  const sorted = [...findings].sort((a, b) => order[a.level] - order[b.level]);
  const counts = { ERROR: 0, WARN: 0, INFO: 0 };
  for (const f of sorted) counts[f.level] = (counts[f.level] ?? 0) + 1;

  if (sorted.length === 0) {
    lines.push(green('✓ 未发现冲突'));
  }
  for (const f of sorted) {
    const tag = f.level === 'ERROR' ? red('ERROR') : f.level === 'WARN' ? yellow(' WARN') : cyan(' INFO');
    const conf = f.confidence === 'heuristic' ? dim('[启发式]') : f.confidence === 'medium' ? dim('[中置信]') : '';
    lines.push(`${tag} ${bold(f.title)} ${conf}`);
    if (f.detail) lines.push(`      ${f.detail}`);
    lines.push(dim(`      ${f.code}`));
    lines.push('');
  }

  // 工具清单矩阵
  lines.push(bold('──────── 各插件注册的工具 ────────'));
  for (const p of plugins) {
    const names = p.tools.map((t) => t.name).sort();
    const dyn = p.toolsDynamic ? yellow(' [动态命名·清单不完整]') : '';
    lines.push(`${bold(p.name)}${p.version ? dim('@' + p.version) : ''}  ${dim(`(${names.length} 个工具, 扫描 ${p.scanned} 文件)`)}${dyn}`);
    if (names.length > 0) lines.push('  ' + names.join(', '));
    else if (p.toolsDynamic) lines.push(dim('  （无字面量可提取，工具名由代码生成）'));
    if (p.injects.length > 0) lines.push(dim('  inject: ') + p.injects.join(', '));
    if (p.provides.length > 0) lines.push(dim('  provides: ') + p.provides.join(', '));
    if (p.patchIds.length > 0) lines.push(dim('  patch 行: ') + p.patchIds.join(', '));
    if (p.skills.length > 0) lines.push(dim(`  内置技能: ${p.skills.length} 个`));
    if (opts.verbose && p.skipped.length > 0) {
      lines.push(dim('  跳过: ' + p.skipped.slice(0, 5).join('; ')));
    }
    lines.push('');
  }

  // 汇总
  lines.push(bold('──────── 结论 ────────'));
  const verdict = counts.ERROR > 0
    ? red(`发现 ${counts.ERROR} 个硬冲突`)
    : counts.WARN > 0 ? yellow(`无硬冲突，${counts.WARN} 项需人工确认`) : green('干净');
  lines.push(verdict);
  lines.push(dim(`ERROR ${counts.ERROR} · WARN ${counts.WARN} · INFO ${counts.INFO}`));

  // 安全自证
  const sa = selfAudit();
  lines.push('');
  lines.push(bold('──────── 安全自证 ────────'));
  lines.push(dim('本脚本仅使用 fs 读取 API；未写入、未联网、未起子进程、未执行任何插件代码。'));
  lines.push(dim('自扫描: ') + (sa.hits.length === 0
    ? green('通过 — 源码中未出现写文件/子进程/网络调用')
    : red('发现可疑 API: ' + sa.hits.join(', '))));
  lines.push(dim('源文件: ' + sa.selfPath));

  return lines.join('\n');
}

// ───────────────────────────── 入口 ─────────────────────────────
function main() {
  const opts = parseArgs(process.argv.slice(2));
  let result;
  try {
    result = audit(opts);
  } catch (err) {
    console.error(red('审计脚本自身出错: ') + (err?.stack ?? err));
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderText(result, opts));
  }

  const hasError = result.findings.some((f) => f.level === 'ERROR');
  process.exit(hasError ? 2 : 0);
}

// 供测试导入；作为脚本直接运行时才执行 main()，
// 这样 test/ 下的夹具测试可以复用同一份逻辑，不会有两套实现漂移。
export { audit, versionSatisfies, compareVersions, parsePatchYaml, extractToolNames };

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) main();
