# dsh-config-audit

DSH 插件冲突审计。一份逻辑，两种用法：

- **CLI**：`node audit.mjs` —— 装/卸插件前后手动跑
- **插件**：`plugin_conflict_audit` 工具 + 开机自检 —— 让 agent 随时能查

两者共用 `audit.mjs` 里的同一份实现，不存在"脚本和插件各自漂移"。

## 安装

从 npm：

```bash
dsh plugin --profile web add dsh-plugin-conflict-audit
```

直接从 GitHub 安装（尚未发布 npm 时用这条）：

```bash
dsh plugin --profile web add github:www111-ui/dsh-plugin-conflict-audit
```

装完**重启 harness** 生效。之后会出现 `plugin_conflict_audit` 工具，并在启动后 4 秒自动跑一次自检。

不想装插件、只想跑一次检查：

```bash
git clone https://github.com/www111-ui/dsh-plugin-conflict-audit.git
cd dsh-plugin-conflict-audit
node audit.mjs
```

## 为什么需要它

DSH 插件冲突大多不是「报错」，而是**静默失效**：

| 冲突类型 | 表面现象 | 实际原因 |
| --- | --- | --- |
| 工具名撞车 | 工具还在，但行为不对 | 注册表覆盖式，先注册者静默消失 |
| inject 声明不存在的服务 | 插件"装了但没反应" | cordis fiber 永久 pending，不报错不退出 |
| patch 行 id 撞车 | 配置莫名丢失 | 整行 config 互相覆盖 |
| 路由前缀重叠 | 某个接口 404 / 返回别人的数据 | webServer 后注册者覆盖 |

这些都不会在安装时被拦住 —— dsh-market 的冒烟验证只检查「新插件自己的工具能不能调起来」，**不做跨插件命名空间检测**。

## 安全承诺

本脚本是**严格只读**的：

- 只用 `fs.readFileSync` / `fs.readdirSync` / `fs.statSync` / `fs.existsSync`
- 不写、不删、不建目录
- 不联网、不起子进程
- **不 import / require 任何被测插件**（不执行被测代码）
- 每次运行结束会自我扫描源码，确认没有出现写操作 / 子进程 / 网络 API

已验证：运行前后对 `~/.dsh/profiles/desktop` 与 `~/.dsh/skills` 做全量
`(路径, 大小, mtime)` 快照对比，**0 文件变动**。

## 用法一：CLI

```bash
NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe

$NODE audit.mjs                 # 审计默认 profile
$NODE audit.mjs --json          # 机器可读
$NODE audit.mjs --verbose       # 显示跳过明细
$NODE audit.mjs --profile xyz   # 指定 profile
```

退出码：`0` 干净 · `2` 发现硬冲突 · `1` 脚本自身出错

## 用法二：插件

已安装为 `link:D:/DeepSeekWorkspace/dsh-config-audit`，profile `desktop` 的 bundle 列表末尾。

```
plugin_conflict_audit                      # agent 直接调
  profile           可选，默认取 DSH_PROFILE
  includeInfo       是否含 INFO（默认 true）
  includeInventory  是否附带插件清单（默认 false，省 token）
```

输出里还会带 `bootAt`（上次开机自检完成时间）与 `bootError`（自检失败原因，成功时不出现）。
宿主侧看不到 console 时，这两个字段是判断"自检到底跑没跑"的唯一途径。
注意它们是**条件展开**的可选字段 —— 显式 `undefined` 过不了宿主的 lossless-JSON 输出校验。

### 示例输出

正常：

```
✓ 无硬冲突 (WARN 2 · INFO 9)
profile desktop · DSH 0.2.2-rc.1 · 12 个可扫描插件
! [W_COMPAT_UNLISTED] dsh-blender@0.2.4: 兼容声明不含当前 DSH 0.2.2-rc.1
    声明 "0.2.0-rc.2 || 0.2.1-alpha.1 || 0.2.1-alpha.2"。插件仍可能正常工作（实测优先），但这是未验证组合。
! [W_DYNAMIC_TOOL_NAMES] dsh-ops: 工具名是运行时拼接的，静态扫描只能列出字面量
    命中迹象: publicToolName( —— 该插件真实工具数可能远多于上面列出的 0 个。
上次开机自检: 2026-11-22T04:33:08.583Z
```

撞车时：

```
✗ 2 个硬冲突 (WARN 0 · INFO 0)
✗ [E_TOOL_COLLISION] 工具名撞车: clash_tool
    plugin-a(high) + plugin-b(high) —— 注册表覆盖式，后加载者赢，另一个静默消失。
✗ [E_PATCH_ROW_COLLISION] 两个插件插入同一 patch 行 id: shared-row
    plugin-a + plugin-b
```

**开机自检**：激活后延迟 4 秒跑一次，发现硬冲突写一条 `console.warn`
（形如 `[conflict-audit] 发现 N 个插件冲突：...`）。可配置：

```yaml
- id: conflict-audit
  config:
    startupSelfCheck: false   # 关掉自检
    startupDelayMs: 4000      # 延迟
    profile: desktop          # 覆盖 profile 名
```

### 改了代码怎么生效（不用重启 app）

`link:` 安装的插件修改后，宿主里跑的还是旧的 ESM 模块缓存 —— 直接调工具会是旧行为。
**不用重启整个 app**，把 bundle 停用再启用即可强制 cordis 重新构层并重新 import：

```
plugin_manager set_bundle { target: "dsh-plugin-conflict-audit", enabled: false }
plugin_manager set_bundle { target: "dsh-plugin-conflict-audit", enabled: true }
```

实测有效：修改后工具清单从错误的 2 个变成正确的 1 个，`bootAt` 也随之更新。

### 插件的三条纪律

这三条都是踩坑踩出来的，写在 `lib/index.js` 顶部：

1. **只 `<code>inject ['tools']</code>`** —— 绝不声明不存在的服务。那会让 fiber 永久 pending，插件"装了但没反应"、不报错不退出。
2. **激活阶段不做同步重活、不 await** —— 审计要读上千文件（~200ms），改成 `setTimeout` 延迟 + `unref`。
3. **所有运行时逻辑包 try/catch** —— 插件抛异常会连累宿主启动。宁可工具返回错误，也不能让 harness 起不来。

## 测试

```bash
$NODE test/detector-test.mjs     # 审计逻辑（17 项）
$NODE test/plugin-load-test.mjs  # cordis 外壳（40 项）
```

**这一步不能省。** 审计报告说「0 冲突」时有两种可能：真的干净，或者检测器是哑的。看报告无法区分。

- `detector-test` 造两个夹具：`fixture/conflict/`（故意撞工具名 + 撞 patch 行）必须报 2 个 ERROR；`fixture/clean/` 必须 0 个 ERROR
- `plugin-load-test` 用 stub 顶替宿主的 `@deepseek-ai/dsh-tools`，验证模块初始化、`apply()` 不抛、工具注册、`execute()` 返回合法结构、以及注册失败时降级而非崩溃

## 检查项

| 代码 | 级别 | 含义 |
| --- | --- | --- |
| `E_TOOL_COLLISION` | ERROR | 两个插件注册同名工具 |
| `E_PATCH_ROW_COLLISION` | ERROR | 两个插件插入同一 patch 行 id |
| `E_PROFILE_MISSING` / `E_BUNDLE_MISSING` / `E_PATCH_MISSING` | ERROR | 配置指向了不存在的东西 |
| `W_PATCH_OVERRIDE_FIGHT` | WARN | 两个插件覆盖同一行配置 |
| `W_COMPAT_UNLISTED` | WARN | 插件的兼容声明不含当前 DSH 版本 |
| `W_DYNAMIC_TOOL_NAMES` | WARN | 工具名运行时拼接，静态扫不全 |
| `W_ROUTE_OVERLAP` | WARN | 路由前缀疑似重叠（启发式） |
| `W_SKILL_COLLISION` | WARN | 技能名重名 |
| `W_SCAN_CAPPED` | WARN | 文件数触顶，结果不完整 |
| `I_USER_PATCH_TARGETS` | INFO | 你的 patch 定制了插件行（设计如此，非冲突） |
| `I_DISABLED` | INFO | 已安装但未启用 |
| `I_SERVICE_UNVERIFIED` | INFO | 服务依赖不在已知核心名单（低置信） |

## 已知局限

1. **动态工具名扫不到。** 如 `dsh-ops` 用 `TOOL_PREFIX = 'ops_'` + `publicToolName(raw)` 拼名字，字面量里根本没有 `ops_bash`。这类插件会被标 `W_DYNAMIC_TOOL_NAMES`，其工具清单**不完整、冲突检测不可信**。彻底解决需要读运行时注册表（`ctx.tools` 的枚举 API 未验证）。
2. **核心服务白名单是观察值、非权威。** 宿主包在 `app.asar` 里，读不到权威清单，所以 `I_SERVICE_UNVERIFIED` 只是低置信提示。
3. **路由检测是启发式的。** 只抓 `webServer` 附近 `path:`/`prefix:` 的字符串字面量。
4. **只看静态文件，不看运行时状态。** 实际加载结果还受 fiber 状态、config 求值影响。
5. **改代码后宿主侧要重新加载** —— `link:` 安装不会热替换已加载的 ESM 模块。CLI 新进程能立刻看到新代码，宿主里要停用/启用 bundle 一次（见上文「改了代码怎么生效」）或重启 app，两者会短暂不一致。

## 对照：验证期抓到的真实问题

脚本第一版跑出来是**错的**，这些都在验证期修掉了：

| 错误 | 教训 |
| --- | --- |
| `>=0.1.5-rc.1` 判成不满足 → 5 条假 WARN | 前缀匹配代替不了 semver 范围求值 |
| 用户 patch 覆盖插件行 → 报成 ERROR | 「覆盖已有行」和「插入同一行」语义完全不同，必须分开解析 |
| `dsh-ops` 报 0 个工具（撞 600 文件上限） | 配额要只算代码文件，且触顶必须报警 |
| 把 `'/aurabot/api'` 当成工具前缀 | 路由前缀不是工具前缀，正则要收紧 |
| 注释里的示例定义被算成真工具（自己报了 `xxx` 和 `ghost_*`） | 匹配前必须剥注释 —— 用状态机保留字符串里的 `//` |
| `inventory: undefined` 导致宿主拒绝整个输出（"value is not lossless JSON"） | 可选字段必须条件展开；stub 的 `defineTool` 是恒等函数，**测不出 schema 问题**，所以测试里要自己断言 JSON 往返无损 |
| `blender_scene` vs `blender_scene_info` 判成撞车 | 人类肉眼扫也不可靠 —— 这就是要脚本的原因 |

## 配套 skill

`~/.dsh/skills/dsh-plugin-conflict-audit/SKILL.md`

工具本身不会自己喊你用它 —— 所以配了一个 skill，把**什么时候该查**写进触发条件：
装/卸/停用/升级插件后、插件「装了没反应」时、升级 DSH 前、两个插件重叠要选一个时。

skill 里还固化了处置流程（先诊断后动手、备份、停用优于卸载、按覆盖面而非工具名长度判优劣）
和两个必知坑（`link:` 插件改代码要 toggle bundle、动态命名插件扫不到）。

