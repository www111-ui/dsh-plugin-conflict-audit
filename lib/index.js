/**
 * dsh-plugin-conflict-audit — cordis 插件外壳
 *
 * 它只做两件事：
 *   1. 注册 plugin_conflict_audit 工具，让 agent 随时能查冲突
 *   2. 开机后延迟执行一次自检，发现硬冲突就写一条 console.warn
 *
 * ── 刻意遵守的三条纪律（都是在别的插件上踩坑踩出来的）──
 *
 * ① 只 inject ['tools']。
 *    绝不 inject 不存在的服务名 —— 那会让 fiber 永久 pending，插件"装了但没反应"、
 *    不报错不退出，是最难查的失败模式。
 *
 * ② 激活阶段绝不做同步重活，也绝不 await。
 *    审计要读上千个文件（~200ms）。放在 apply() 里会拖慢启动；
 *    改成 setTimeout 延迟执行 + unref，出错只吞掉记日志。
 *
 * ③ 所有运行时逻辑包在 try/catch 里。
 *    插件抛异常会连累宿主启动。宁可这个工具返回错误，也不能让 harness 起不来。
 *
 * 审计逻辑本身在 ../audit.mjs —— 与 CLI 共用同一份实现，
 * 避免"脚本和插件两套代码各自漂移"。
 */

import path from 'node:path';
import os from 'node:os';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { audit } from '../audit.mjs';

export const name = 'dsh-plugin-conflict-audit';

/** 硬依赖：工具注册表。除此之外不声明任何东西。 */
export const inject = ['tools'];

// ── 环境探测：优先用宿主给的环境变量，退化到默认值 ──
const ENV_PROFILE = process.env.DSH_PROFILE ?? 'desktop';
const ENV_DSH_HOME = process.env.DSH_HOME ?? null;

/** ~/.dsh 的**父目录**；只有 DSH_HOME 未设置时才用到 */
function fallbackHome() {
  if (ENV_DSH_HOME !== null) {
    // 若 DSH_HOME 恰好形如 <home>/.dsh，其父目录就是 home
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

/** 结果瘦身：只留工具需要的字段，避免把上百条 INFO 全塞给模型 */
function compact(result, { includeInfo, includeInventory }) {
  const keep = (f) => (includeInfo ? true : f.level !== 'INFO');
  const findings = result.findings
    .filter(keep)
    .map((f) => ({
      level: f.level,
      code: f.code,
      title: f.title,
      detail: f.detail,
      confidence: f.confidence,
    }));

  const count = (lvl) => result.findings.filter((f) => f.level === lvl).length;

  return {
    ok: count('ERROR') === 0,
    error: count('ERROR'),
    warn: count('WARN'),
    info: count('INFO'),
    profile: result.meta.profile,
    dshVersion: result.meta.dshVersion,
    pluginCount: result.meta.pluginCount,
    findings,
    // 必须条件展开。写成 `inventory: x ? [...] : undefined` 会在关闭清单时
    // 塞进一个显式 undefined，宿主的 lossless-JSON 输出校验会直接拒绝整个结果。
    ...(includeInventory
      ? {
          inventory: result.plugins.map((p) => ({
            name: p.name,
            version: p.version,
            toolCount: p.tools.length,
            toolsDynamic: p.toolsDynamic,
            scanned: p.scanned,
            skills: p.skills.length,
          })),
        }
      : {}),
  };
}

/** 开机自检的共享状态（工具可回读，省一次重扫） */
const boot = { at: null, snapshot: null, error: null };

export function apply(ctx, config = {}) {
  const cfg = config ?? {};

  // ── 1. 注册工具 ──
  try {
    const tool = defineTool({
      name: 'plugin_conflict_audit',
      description:
        '审计 DSH 已加载插件的冲突：工具名撞车、patch 行 id 撞车、路由前缀重叠、技能重名、' +
        '服务依赖缺失、版本兼容声明脱节。严格只读（不写文件、不联网、不起子进程、不执行插件代码）。' +
        '装/卸插件后跑一次，或在插件"装了但没反应"时用来定位。',
      parameters: {
        profile: {
          type: 'string',
          description: `要审计的 profile 名；默认取环境变量 DSH_PROFILE（当前 ${ENV_PROFILE}）。`,
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
            ok: { type: 'boolean', required: true, description: '是否没有硬冲突' },
            error: { type: 'number', required: true },
            warn: { type: 'number', required: true },
            info: { type: 'number', required: true },
            profile: { type: 'string', required: true },
            dshVersion: { type: 'string', required: true },
            pluginCount: { type: 'number', required: true },
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
            bootAt: {
              type: 'string',
              description: '上一次开机自检完成的时间（ISO）；不存在表示自检还没跑或已关闭。',
            },
            bootError: {
              type: 'string',
              description: '上一次开机自检失败的原因；成功时不存在。',
            },
          },
        },
        render: (_args, value) => {
          const head = value.ok
            ? `✓ 无硬冲突 (WARN ${value.warn} · INFO ${value.info})`
            : `✗ ${value.error} 个硬冲突 (WARN ${value.warn} · INFO ${value.info})`;
          const lines = [
            head,
            `profile ${value.profile} · DSH ${value.dshVersion} · ${value.pluginCount} 个可扫描插件`,
          ];
          for (const f of value.findings) {
            const mark = f.level === 'ERROR' ? '✗' : f.level === 'WARN' ? '!' : '·';
            lines.push(`${mark} [${f.code}] ${f.title}`);
            if (f.detail) lines.push(`    ${f.detail}`);
          }
          if (value.bootAt !== undefined) {
            lines.push(`上次开机自检: ${value.bootAt}`);
          }
          if (value.bootError !== undefined) {
            lines.push(`上次自检失败: ${value.bootError}`);
          }
          if (Array.isArray(value.inventory) && value.inventory.length > 0) {
            lines.push('— 插件清单 —');
            for (const p of value.inventory) {
              const dyn = p.toolsDynamic ? ' (动态命名)' : '';
              lines.push(`  ${p.name}${p.version ? '@' + p.version : ''}: ${p.toolCount} 工具${dyn}`);
            }
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      async execute(args = {}) {
        // 可选字段必须条件展开：显式 undefined 过不了宿主的 lossless-JSON 输出校验
        const bootFields = {
          ...(boot.at === null ? {} : { bootAt: boot.at }),
          ...(boot.error === null ? {} : { bootError: boot.error }),
        };

        try {
          const result = audit(auditArgs(cfg, args.profile));
          return {
            ...compact(result, {
              includeInfo: args.includeInfo !== false,
              includeInventory: args.includeInventory === true,
            }),
            ...bootFields,
          };
        } catch (err) {
          // 审计自身出错也要给出可用信息，而不是抛一个空栈给模型。
          // 若开机自检曾成功过，退回那份快照 —— 总比什么都没有强。
          if (boot.snapshot !== null) {
            return {
              ...boot.snapshot,
              findings: [
                {
                  level: 'WARN',
                  code: 'W_STALE_BOOT_SNAPSHOT',
                  title: `实时审计失败，返回 ${boot.at} 的开机快照`,
                  detail: err instanceof Error ? err.message : String(err),
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
    // 注册失败不能连累宿主启动
    console.warn('[conflict-audit] 工具注册失败:', err instanceof Error ? err.message : err);
  }

  // ── 2. 开机自检：延迟、非阻塞、失败静默 ──
  if (cfg.startupSelfCheck !== false) {
    const delay = Math.max(0, Number(cfg.startupDelayMs ?? 4000));
    try {
      ctx.effect(() => {
        const timer = setTimeout(() => {
          try {
            const result = audit(auditArgs(cfg));
            boot.at = new Date().toISOString();
            boot.snapshot = compact(result, { includeInfo: false, includeInventory: false });
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
            boot.error = err instanceof Error ? err.message : String(err);
            console.warn('[conflict-audit] 自检失败（已忽略，不影响宿主）:', boot.error);
          }
        }, delay);
        // 不阻止进程退出
        if (typeof timer.unref === 'function') timer.unref();
        return () => clearTimeout(timer);
      }, 'conflict-audit: startup self-check');
    } catch (err) {
      console.warn('[conflict-audit] 自检未能挂载:', err instanceof Error ? err.message : err);
    }
  }
}
