# 发布到 DSH Market 指南

> 面向本项目（`dsh-plugin-conflict-audit`）的实际操作手册。
> 收录规则来自 [dsh-market README](https://github.com/2BingLing/dsh-market)（master 分支），
> 不是推测 —— 下面每条机制都能在那份文档里找到原文。

---

## 0. 先纠正一个常见误解

**DSH Market 不是 npm 市场，它扫的是 GitHub 仓库。**

市场索引 `plugins.json` 里的每条记录 `id` 是 `owner/repo` 格式，`fullName`、`stars`、`pushedAt` 全部来自 GitHub API。
npm 发布**不是必需的** —— 它只影响用户安装时用哪条命令（`dsh plugin add <包名>` vs `github:owner/repo`）。

搞清这点很重要，因为它决定了最小可行路径：**建个公开 GitHub 仓库 + 打一个 topic，就够了。**

---

## 1. 收录机制（原文事实）

每天 **06:00** 自动管道跑一次：

```
GitHub Actions（每日 06:00 自动收录 + 部署）
  └─ collector（Node，并发 10，24h 缓存）
       ├─ 扫描数据源：
       │    ├─ topic 扫描：dsh-plugin / dsh / deepseek-harness-plugin / dsh-bundle / dsh-skill
       │    ├─ awesome 列表 ×2
       │    ├─ dsh-external 组织
       │    └─ 本仓库提交插件 issue（label: submission / 标题「[提交插件]」）
       ├─ 收录条件（全部满足才收录）：
       │    1. 不是 fork / archived / 官方本体
       │    2. 特征检测通过：根目录有 SKILL.md
       │       或 skills/ 目录含 SKILL.md
       │       或 dsh.profile / cordis.patch.yml 等 cordis 标记
       │       或 package.json 依赖含 cordis 关键字
       │    3. 无 stars / 评分门槛 —— 检测通过即收录
       └─ DeepSeek 增量中文化 → data/plugins.json → 部署
```

### 对号入座：我们靠哪条过特征检测

| 条件 | 我们的情况 |
| --- | --- |
| 不是 fork / archived / 官方 | ✅ 全新仓库 |
| **`cordis.patch.yml` 存在** | ✅ **命中，这就是我们的入场券** |
| `package.json` 有 `dsh.bundle.patch` | ✅ 额外加强 |
| stars 门槛 | 无门槛，0 star 也收 |

**结论：只要仓库公开、有 `cordis.patch.yml`、不是 fork，就会自动被收。**

---

## 2. 三条路线

| 路线 | 工作量 | 用户安装方式 | 适合 |
| --- | --- | --- | --- |
| **A. 只建 GitHub 仓库 + 打 topic** | 最小 | `github:owner/repo` | 想先被收录、验证反应 |
| **B. A + npm 发布** | 中 | `dsh plugin add <包名>` | 长期维护、要显得专业 |
| **C. 主动提 issue** | 小，可叠加在 A/B 上 | 同上 | 想加快收录（次日 06:00 前就能排进队列） |

推荐：**A → 次日确认收录 → 再补 B**。先跑通收录链路，别一上来卡在 npm 登录上。

---

## 3. 发布前检查清单

| # | 项目 | 现状 | 需要做什么 |
| --- | --- | --- | --- |
| 1 | `cordis.patch.yml` 存在且有效 | ✅ 已就绪 | — |
| 2 | `package.json` 的 `dsh.bundle.patch` | ✅ 已就绪 | — |
| 3 | `private` 字段移除 | ✅ 已移除 | — |
| 4 | `repository` / `homepage` / `bugs` | ⚠️ 占位符 | **填你的 GitHub 用户名** |
| 5 | `author` | ⚠️ 占位符 | 填名字 |
| 6 | `LICENSE` 文件 | ⚠️ 占位符 | 改版权人 |
| 7 | `dsh.compatibility.dsh` | ✅ 已声明 `>=0.2.2-rc.1 <0.3.0-0` | 以后扩大测试范围再放宽 |
| 8 | README 含可解析的安装命令 | ✅ 已加 | — |
| 9 | README 有示例输出 | ✅ 已加 | — |
| 10 | 测试全绿 | ✅ 57 项 | — |
| 11 | `.gitignore` | ✅ 已加 | — |
| 12 | GitHub 仓库公开 | ❌ 未建 | 见步骤 1 |
| 13 | 打 `dsh-plugin` topic | ❌ 未打 | 见步骤 2 |

### 需要你填的占位符（共 4 处）

统一替换 `TODO-GITHUB-USER` 和 `TODO: 你的名字`：

| 文件 | 占位符 |
| --- | --- |
| `package.json` | `TODO-GITHUB-USER`（3 处）、`TODO: 你的名字 <you@example.com>` |
| `README.md` | `TODO-GITHUB-USER`（2 处） |
| `LICENSE` | `TODO: 你的名字` |

替换完自查：

```bash
grep -rn "TODO" package.json README.md LICENSE
```

预期无输出。

---

## 4. 步骤 1：建仓库并首次推送

### 4.1 在 GitHub 网页建空仓库

- 仓库名：`dsh-plugin-conflict-audit`
- 可见性：**Public**（私有仓库不会被收录）
- **不要**勾选 "Add a README / .gitignore / license"（我们本地已有，勾了会冲突）

### 4.2 本地初始化并推送

本机 git 可用（`git version 2.56.0.windows.4.niugit`），但**没有 gh CLI**，所以走 https 推送：

```bash
cd D:/DeepSeekWorkspace/dsh-config-audit

git init -b main
git add .
git commit -m "feat: DSH plugin conflict audit (tool + startup self-check)"

git remote add origin https://github.com/<你的用户名>/dsh-plugin-conflict-audit.git
git push -u origin main
```

推送时会要求认证。https 方式需要 **Personal Access Token** 当密码（GitHub 已不支持账号密码）：

- 生成：GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → `repo` 权限
- 用户名填你的 GitHub 用户名，密码粘贴 token

推送前先确认要提交的内容对不对：

```bash
git status --short
```

`.gitignore` 已排除 `node_modules/`、`shots/`、`test/fixture/`、`report.txt`、`*.bak-*`。
应该看到的是源码 + 测试 + 文档，**不应该有** `node_modules` 或截图目录。

---

## 5. 步骤 2：打 topic（最关键的一步）

仓库页面 → 右上角齿轮（About 区块）→ **Topics** → 输入：

```
dsh-plugin
```

可同时加：`deepseek-harness`、`cordis`、`diagnostics`

**为什么这是关键**：collector 的 scan 源里 topic 扫描是主力。不打 topic 就得等 issue 提交，或者永远不被发现。

⚠️ **打 topic ≠ 被收录**。topic 只是进入候选池；还要过特征检测（我们有 `cordis.patch.yml`，稳过）。

---

## 6. 步骤 3（可选）：发布到 npm

不发布也能被收录，但发布后安装命令更短、更像正经包。

### 6.1 登录

本机没有 npm 在 PATH 里，用 DSH 便携运行时的 pnpm：

```bash
NODE=C:/Users/qq188/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe
PNPM=C:/Users/qq188/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs

"$NODE" "$PNPM" login
```

按提示输入 npm 用户名 / 密码 / 邮箱 OTP。成功后 `~/.npmrc` 会出现 token。

> 也可以直接在 `~/.npmrc` 写 `//registry.npmjs.org/:_authToken=<token>`，避免交互。

### 6.2 先干跑，确认打包内容

```bash
"$NODE" "$PNPM" pack --dry-run
```

核对 `files` 白名单命中的文件：应该是 `lib/`、`audit.mjs`、`cordis.patch.yml`、`README.md`、`LICENSE`。
**不应该**包含 `test/`、`shots/`、`node_modules/`。

### 6.3 发布

```bash
"$NODE" "$PNPM" publish --access public --no-git-checks
```

> `--no-git-checks`：pnpm 默认要求工作区干净且已推送。首次发布若遇阻可加。

### 6.4 发布后回填安装命令

包名是 `dsh-plugin-conflict-audit`（未加 scope，直接可用）。README 里 npm 那条命令已经写好了，无需改动。

### 6.5 以后更新版本

```bash
# 语义化版本：修 bug → patch，加功能 → minor
"$NODE" "$PNPM" version patch --no-git-checks
git push --follow-tags
"$NODE" "$PNPM" publish --access public --no-git-checks
```

---

## 7. 步骤 4：提交收录（可选，但推荐）

如果不想等到明天 06:00 的自动扫描，可以主动提：

**[提交插件 issue 模板](https://github.com/2BingLing/dsh-market/issues/new?template=submit_plugin.md)**

填写：
- 仓库地址：`https://github.com/<你的用户名>/dsh-plugin-conflict-audit`
- 插件类型：cordis 插件
- 一句话简介

**额外加分**：issue 里附上「作者自述简介」—— 它会显示在市场详情页的「作者自述」专区（带作者标识），比自动生成的中文简介更有温度。

自述建议写清三件事：**解决什么痛点、怎么用、有什么局限**（诚实写局限反而加分，写清楚「动态命名插件扫不到」这种）。

### 提交后会发生什么

```
提交 issue → 次日 06:00 管道提取仓库 → 特征检测
  ├─ 通过 → 收录进市场 → 自动回复 issue（✅ + 次日更新说明 + 徽章指引）→ 自动关闭
  └─ 未通过 → 不收录（可重新打开 issue 问原因）
```

---

## 8. 步骤 5：验证收录

管道每天 06:00 跑，所以最早**次日**才能查到。

### 方式一：市场面板搜索

DSH 侧边栏 → 插件市场 → 搜索 `conflict` 或 `冲突`。

### 方式二：Web 站

<https://dsh.market/> 搜索。

### 方式三：直接查索引（最准）

```bash
NODE=C:/Users/qq188/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe

"$NODE" -e "
const https=require('https');
https.get('https://2bingling.github.io/dsh-market/plugins.json',r=>{
  let s='';r.on('data',d=>s+=d).on('end',()=>{
    const j=JSON.parse(s);
    const hit=j.plugins.find(p=>/conflict-audit/i.test(p.fullName||''));
    console.log(hit ? JSON.stringify(hit,null,2) : '未收录（还没跑到 / 未通过检测）');
  });
});
"
```

索引约 12.5 MB，只跑一次没问题。

### 已收录的插件长什么样

参照 `dsh-cad` 的真实条目结构：

```json
{
  "id": "owner/repo",
  "type": "cordis-plugin",
  "name": "包名",
  "fullName": "owner/repo",
  "descriptionZh": "自动生成的中文简介",
  "tags": ["dsh-plugin", "..."],
  "stars": 0,
  "pushedAt": "...",
  "installMethod": "pnpm-profile",
  "installCommands": ["dsh plugin --profile web add <包名>"],
  "dshCompat": { "status": "compatible", "local": "0.2.2-rc.1" }
}
```

---

## 9. 收录之后

### 挂收录徽章

市场提供了徽章，放 README 顶部让用户一眼认出：

```markdown
[![已收录](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-zh.svg)](https://dsh.market/)
[![高分精选](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-top-rated.svg)](https://dsh.market/)
```

**高分精选需要实用评分 ≥ 80**。当前新插件大概不会到（没有 stars / fork）。

### 修正数据

评分、描述、安装命令有误 → 提 [`[数据修正]` issue](https://github.com/2BingLing/dsh-market/issues/new?template=data_fix.md)，支持作者自述 / 简介 / 安装命令，次日自动应用。想清空自述写 `作者自述：无`。

---

## 10. 评分机制与提分方向

五维加权（几何平均，借鉴 StarRadar）：

| 维度 | 权重 | 含义 | 我们能做的 |
| --- | --- | --- | --- |
| 维护活跃 | 30% | 近 90 天提交 + issue 健康度 | 持续小步提交，别发完就放着 |
| 实用度 | 25% | README / 文档 / 示例完整度 | ✅ 已有示例输出、检查项表、局限说明 |
| 生态热度 | 20% | stars 对数归一化 + fork 参与率 | 需要时间，靠被别人发现 |
| 便捷度 | 15% | 安装步骤清晰 + 无需额外配置 | ✅ 一条命令、零配置 |
| 信号密度 | 10% | license / topics / description / README | ✅ 都有；**别忘打 topics** |

**性价比最高的一步：打完 topics、写好 README 示例**（信号密度 + 实用度，共 35% 权重，且不依赖别人）。

---

## 11. 常见坑

| 坑 | 后果 | 避免 |
| --- | --- | --- |
| 仓库是 **private** | 永远不收录 | 建仓时就选 Public |
| 忘记打 `dsh-plugin` topic | 不会进入候选池 | 步骤 2 别跳过 |
| 仓库是 **fork** | 明确不收录 | 新建仓库，别 fork 别人的再改 |
| `private: true` 还在 package.json | `pnpm publish` 直接失败 | 已移除 |
| README 安装命令写在行内代码 | collector 解析不到 → `installCommands` 为空 | 必须放**围栏代码块**里，已处理 |
| 以为发 npm 就会被收录 | 市场不看 npm | 只认 GitHub |
| 打了 topic 就以为完事 | 还要过特征检测 | 我们有 `cordis.patch.yml`，稳过 |
| 当天提交当天查 | 查不到，误以为失败 | 管道每天 06:00，最早次日 |
| `dsh.compatibility.dsh` 写得过宽 | 别人装了不能跑，差评 | 只声明测过的范围 |

---

## 12. 撤销 / 回滚

- **下架仓库**：把仓库改成 private 或 archived，下次管道会移除
- **npm 撤回**：`pnpm unpublish dsh-plugin-conflict-audit@0.1.0 --force`（24 小时内可撤；之后只能弃用版本）
- **本地卸载**：`plugin_manager set_bundle { target: "dsh-plugin-conflict-audit", enabled: false }`

---

## 附：本机环境速查

| 工具 | 路径 / 状态 |
| --- | --- |
| node | `C:/Users/qq188/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`（v24.21.0） |
| pnpm | `.../dependencies/pnpm/bin/pnpm.cjs`（用 `"$NODE" "$PNPM"` 调用） |
| git | ✅ `2.56.0.windows.4.niugit` |
| gh CLI | ❌ 未安装 → 建仓库走网页 |
| npm | ❌ 不在 PATH，用 pnpm 代替 |
| npm 登录 | ❌ 无 `~/.npmrc`，需先 `pnpm login` |
