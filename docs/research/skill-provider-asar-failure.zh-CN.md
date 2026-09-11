# filesystem skill provider 被整条跳过 —— 根因与影响面

> 现场证据：`~/Library/Application Support/DSH Desktop/logs/host/dsh-2026-09-11.log`
> 版本锚点：`@deepseek-ai/dsh-skill-filesystem` / `dsh-skill` / `dsh-fs-local` 均随 `0.1.5-rc.1` 发布
> 全程只读：未改 DSH 安装目录、未改 dsh-miniapp 仓库（本笔记除外）

---

## 0. 结论先行

| 问题 | 结论 |
|---|---|
| **根因** | `dsh-fs-local` 用 `stat(path, {bigint:true})` 拿 BigInt 统计，再执行 **`Number(info.mode & 511n)`**。Electron 的 asar shim 对归档内路径返回的 `mode` 是 **Number**，`Number & BigInt` 直接抛 `Cannot mix BigInt and other types`。**`dsh-fs-local/lib/index.js:226`（`probe`）与 `:241`（`probeNoFollow`）**。 |
| **影响面** | **整条 provider 被跳过，所有 root 一起丢**。`skill-filesystem` 的 `list()` 里那个单层循环（`dsh-skill-filesystem/lib/index.js:104`）**没有 per-root 隔离**：只要最后一个 bundled root 抛错，整个 `list()` 就抛出，注册表捕获后把 provider 整个丢弃（`dsh-skill/lib/index.js:349-357`）。**用户 `~/.agents/skills` 下 45 个技能（全部含 SKILL.md）因此一直取不到。** |
| **是否只影响打包版** | **只有 Desktop 打包版（asar 场景）中招**。判据：错误只在 asar 内路径出现；源码 checkout 下同一路径是普通目录，Electron 不会走 asar shim。**此项未能实测**（见 §5）。 |
| **触发时机** | 首次 `14:03:03`，**早于 dsh-miniapp 安装**（该插件首次加载是 `14:32:04`）→ **与本轮插件改动无关，是既有故障**。全日志共 **761 次**。 |
| **与 create-miniapp 的关系** | 我们的技能走**内存注册（runtime provider）**，在 `listLayerCandidates` 里排在 filesystem 之前、且独立于它（`dsh-skill/lib/index.js:342-347`），所以**本轮功能不受本故障影响**。本故障的独立价值是：**用户其余 45 个技能可能一直取不到**。 |

⚠️ **队长给的计数是 671，实测为 761**（含 15:26 重启后新增）；重启前的数字未单独复核，但结论方向不变。另：日志里出现的是**同一条消息、同一个路径**，无第二种变体 —— 全日志仅这**一个** root 报错。

---

## 1. 根因：逐步定位到那一行

### 1.1 调用链

```
skill-filesystem provider.list()
  └─ discoverRoot(root)                        dsh-skill-filesystem/lib/index.js:582
       └─ listSkillRootEntries(root, ctx)      :584
            └─ listSkillRootEntriesFromFileSystem(root, fs)   :618 → :621
                 ├─ fs.resolve(path)           :630
                 └─ fs.listDir(target)         :631
                      └─ dsh-fs-local listDir  dsh-fs-local/lib/index.js:807
                           └─ listDirectory()  :270
                                ├─ probe(targetKey)          :275  ← 抛错点在这里
                                └─ readdir(targetKey, ...)   :284
```

### 1.2 抛错的那一行

`probe()` 全文（`app.asar!/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js:221-232`）：

```js
async function probe(absolutePath) {
	const info = await probeStats(absolutePath, (path) => stat(path, { bigint: true }));
	if (!info) return null;
	return {
		version: versionOf(info),
		mode: Number(info.mode & 511n),      // ← :226  抛错点
		type: pathType(info),
		size: Number(info.size)
	};
}
```

同型代码在 `probeNoFollow()`（`:236-244`）的 **`:241`**：

```js
async function probeNoFollow(absolutePath) {
	const info = await probeStats(absolutePath, (path) => lstat(path, { bigint: true }));
	if (!info) return null;
	return {
		version: versionOf(info),
		mode: Number(info.mode & 511n),      // ← :241
		type: pathLinkType(info),
		size: Number(info.size)
	};
}
```

两个函数都用 `{ bigint: true }`（`:222`、`:237`）拿统计。**`info.mode & 511n` 是 BigInt 与 BigInt 的位与 —— 前提是 `info.mode` 真的是 BigInt。**

### 1.3 为什么 asar 下 `mode` 不是 BigInt

Electron 用自己编译进二进制（非 JS）的 asar shim 拦截 `fs.stat`/`lstat`。对**归档内**路径，它不转发给内核，而是**手工拼一个 stats 对象**。该对象的 `mode` 是普通 Number（在真实文件系统上 `mode` 由 `statx` 给出，BigInt 模式下来自 BigInt 字段；shim 走的是自己构造的路径）。

于是 `Number & 511n` 变成 **Number & BigInt**：

```
> 33188 & 511n
TypeError: Cannot mix BigInt and other types, use explicit conversions
```

**已验证**（本机 node 直接跑该表达式）：

```
case A: mode 是 BigInt  → Number(33188n & 511n) = 420        ✅
case B: mode 是 Number  → TypeError: Cannot mix BigInt and other types, use explicit conversions  ❌ 复现日志原文
```

补充两点排除性结论（避免误判到别处）：

- **不是模板字符串的问题。** `versionOf()`（`:143-145`）用反引号拼 `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` —— 实测模板字符串**即使混用 BigInt/Number 也不抛错**，所以抛错点不在 version 拼接。
- **不是 `size` 的问题。** `Number(info.size)`（`:228`、`:243`）对 Number 是恒等、对 BigInt 合法；比较运算 `BigInt > Number` 也不抛（实测 `4096n > 1000` 与 `4096 > 1000n` 均正常）。**唯一的抛错点是 `& 511n`。**

### 1.4 错误是怎么变成"cannot list"的

`probe()` 的异常在 `listDirectory` 的 try 里被翻译（`dsh-fs-local/lib/index.js:274-277`）:

```js
try {
    info = await probe(target.targetKey);
} catch (error) {
    throw listingIoError(target.displayPath, error);
}
```

`listingIoError`（`:246-252`）走最后一条兜底分支：

```js
return new FsError(`cannot list "${displayPath}": ${errorMessage(error)}`, "FS_IO_ERROR", { cause: error });
```

这就是日志里 `FsError: cannot list "...": Cannot mix BigInt and other types, use explicit conversions` 的来源 —— 错误码是 **`FS_IO_ERROR`**，`cause` 才是那个 TypeError。

---

## 2. 影响面：整条 provider 被丢，45 个技能一起丢

这是本任务最重要的一条。**结论：是"整条 provider 被跳过"，不是"只有某一个 root 失败"。**

### 2.1 三层证据

**第一层 —— 注册表按 provider 粒度捕获异常**（`app.asar!/node_modules/@deepseek-ai/dsh-skill/lib/index.js:349-357`）：

```js
try {
    output = await waitWithAbort(provider.list(options), options.signal);
} catch (error) {
    if (options.signal?.aborted === true) throw toError(options.signal.reason);
    cacheable = false;
    this.ctx.logger.warn(`skill provider "${provider.name}" skipped: ${errorMessage(error)}`);   // ← :355 日志原文
}
if (output === void 0) continue;      // ← output 未赋值 → 整个 provider 的候选全部不进入 candidates
```

`list()` 抛出 → `output` 保持 `undefined` → `continue` → **这个 provider 一个候选都不贡献**。日志里 `"filesystem" skipped` 正是这一行。

**第二层 —— provider 内部没有 per-root 隔离**（`app.asar!/node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js:94-110`）：

```js
async list(options) {
    const roots = await this.roots(options.cwd);
    let complete = true;
    try {
        await this.watchManager.observeRoots(roots);     // 注意到：只有 watcher 有 try/catch
    } catch (error) {
        if (this.disposal !== void 0) throw error;
        complete = false;
    }
    const candidates = [];
    for (const root of roots) for (const skill of await discoverRoot(root, this.ctx, this.name)) candidates.push(skill);
    //  ^^^^^^^^^^^^^^^^^^^^^^^^ :104 —— 单条语句，无 try/catch
    return complete ? candidates : { candidates, complete };
}
```

`:104` 是**一条**语句套两层 `for`，`discoverRoot` 的异常直接冒出 `list()`，**已收集的 `candidates` 全部作废**（因为根本走不到 `return`）。对比 `:98-103`：作者**给 watcher 加了 try/catch，却没给发现循环加** —— 这个不对称正是影响面被放大的原因。

**第三层 —— `discoverRoot` 自己也不吞**（`dsh-skill-filesystem/lib/index.js:582-587`）：

```js
async function discoverRoot(root, ctx, provider) {
	const skills = [];
	const entries = await listSkillRootEntries(root, ctx);   // ← :584 直接 await，无 try/catch
```

`listSkillRootEntries` 里确有 try/catch（`:643-652`），但它**只吞"路径不存在"**（`isAbsentSkillPathError`），其余一律 rethrow（`:650`）：

```js
} catch (error) {
    if (isAbsentSkillPathError(error)) return [];
    throw error;                                             // ← :650 我们的 FS_IO_ERROR 从这里穿出
}
```

**三层全无兜底 → 一错全丢。**

### 2.2 哪些 root 受影响

root 清单见 `dsh-skill-filesystem/lib/index.js:151-188`，rank 常量在 `:22-26`：

| Rank | 来源 | 路径 | 是否被本轮故障波及 |
|---|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` | **被丢**（连带） |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` | **被丢**（连带） |
| 300 | `custom` | `Config.customSkillDirs` | **被丢**（连带） |
| 400 | `user-dsh` | `<dshHome>/skills` | **被丢**（连带） |
| 500 | `user-agents` | `<agentsHome>/skills` | **被丢（这是最痛的一条）** |
| 600 | `bundled` | `bundledSkillDir`（asar 内） | **只有它是"肇事者"** |

**注意循环顺序的细节**：`roots()` 把 `bundled` **追加在最后**（`:182-187`），所以用户 root 实际上**先被扫描了**、候选也已经推进了 `candidates` —— 但异常在 bundled 那一步抛出、`return` 永不执行，**前面所有成果被整个丢弃**。

**这正是"整条跳过"与"单 root 失败"的区别所在**：若作者在 `:104` 给每个 root 包一层 try/catch，用户会**丢掉 2 个内置 cordis 技能、保住自己的 45 个**；现在则是**一起丢**。

### 2.3 用户侧实测计数

```
$ ls ~/.agents/skills | wc -l
45
$ for d in ~/.agents/skills/*/; do [ -f "$d/SKILL.md" ] || echo "missing: $d"; done
（无输出 —— 45 个目录全部含 SKILL.md）
$ ls -d ~/.dsh/skills
ls: /Users/limeng/.dsh/skills: No such file or directory        # user-dsh root 不存在，无影响
```

即：**45 个用户技能（brandkit、lark-* 系列 23 个、crm-*、design-taste-*、ego-browser、officecli、make-dsh-plugin 等）在本故障下一直取不到。**

而肇事者只是这 2 个内置技能（`dsh-agent-presets/presets/cordis/skills/` 下 `cordis-plugin-development`、`editing-cordis-compositions`）。**代价与收益极不对等。**

### 2.4 哪些 provider 不受影响

`dsh-skill/lib/index.js:21` 定义 `RUNTIME_PROVIDER = "runtime"`；`:342-347` 显示 runtime 候选**先于**所有注册 provider 被收集，且列表由注册表直接注入、不经 `list()`：

```js
for (const skill of [...layer.runtime.values()].sort(...)) {
    candidates.push({ candidate: runtimeCandidate(skill), provider: RUNTIME_SKILL_PROVIDER, providerOrder: -1, localOrder: runtimeOrder, layer });
    runtimeOrder += 1;
}
for (const { provider, order } of [...layer.providers.values()]) {   // ← filesystem 在这里，出错只影响自己
```

**→ 我们的 create-miniapp 走 runtime 注册，绕开了这条坏路，本轮功能不受影响。** 另一个注册 provider 是 `skill-badge`，但在 bundle 里被**显式禁用**（`dsh-base/cordis.patch.yml:280-282` 的 `disabled: true`），且它是排名在后的独立 provider —— 二者互不牵连。

---

## 3. 与本轮 create-miniapp 的关系（顺带说明，不跑偏）

- **不影响**：技能正文用 `ctx.skills.register`（host 半边）注册为 **runtime skill**，进入 `layer.runtime`，由上面 `:342` 那段直接注入候选，与 filesystem provider 的成败完全解耦。
- **但有两点要留意**：
  1. **同一个进程里日志会刷屏**：每秒数条 `[W] [skill-registry] ... skipped`，会掩盖真正的新告警。排查本插件问题时应先按 `grep -v 'skill provider'` 过滤。
  2. **`~/.dsh/profiles/desktop/node_modules/dsh-miniapp` 是 symlink**（指向 `/Users/limeng/DSH/dsh-miniapp`），位于**普通文件系统**、不在 asar 内 → 插件自身的技能资源若将来改为**文件系统发现方式**，**不会**踩这个坑。只有 bundled（asar 内）root 会。
- **反向提醒**：如果将来我们想改用"文件系统技能目录"的方式发布 create-miniapp，**必须放在 asar 之外**，或至少不要落在 `bundledSkillDir`。否则会被这条既有故障吞掉。

---

## 4. 修复建议

### 4.1 上游应怎么修（两条，按性价比排序）

**修法 A（最小、最该修）：尊重 BigInt 的两种可能。**

`dsh-fs-local/lib/index.js:226` 与 `:241` 把

```js
mode: Number(info.mode & 511n),
```

改为对"`mode` 可能是 Number"的兼容形式，例如

```js
mode: typeof info.mode === "bigint" ? Number(info.mode & 511n) : Number(info.mode & 511),
```

或者干脆**不请求 BigInt 来取 mode**：`mode` 是低 16 位权限位，BigInt 对它是纯粹的负担。真正需要 BigInt 的只有 `dev`/`ino`/`mtimeNs`/`ctimeNs`（version 字符串），可以两次取值、或统一用 `BigInt(info.mode)` 提升后再与。

**修法 B（结构性、防同类事故）：给 root 扫描加 per-root 隔离。**

`dsh-skill-filesystem/lib/index.js:104` 的

```js
for (const root of roots) for (const skill of await discoverRoot(root, this.ctx, this.name)) candidates.push(skill);
```

应改成逐 root try/catch，单个 root 失败只降级为 `complete = false`（并可发一条 warn），**而不是抛出整个 `list()`**。作者在紧邻的 `:98-103` 已经为 watcher 用了这个模式，说明这是**遗漏而非设计选择**。

**修法 B 的直接收益**：即使将来还有别的 root 出问题，用户最多丢那个 root 的技能，不会一错全丢。

> 建议两条都提。A 治当前症状，B 决定"下次是否还会这样"。

### 4.2 有没有不改 DSH 安装的本地绕法（有，且干净）

**关键前提**：bundle 声明 `skill-filesystem` 时**没有给任何 config**（`dsh-base/cordis.patch.yml:278-279`，只有 `id` 与 `name`）——

```yaml
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
```

而 `bundledSkillDir` 的取值是（`dsh-skill-filesystem/lib/index.js:85`）：

```js
const bundledSkillDir = config.bundledSkillDir ?? (this.includeDefaultRoots ? process.env.DSH_BUNDLED_SKILL_DIR : void 0);
```

**两个可用的钩子：`config.bundledSkillDir` 与 `DSH_BUNDLED_SKILL_DIR` 环境变量。**

#### 绕法 1（推荐，最省事）：把 bundled root 指到 asar 外

在 profile 的 patch 层里给这个 id 加 config。**用户当前该文件是空的**（`~/.dsh/profiles/desktop/cordis.patch.yml` 内容为 `[]`），且 profile 配置了 `"patchReload": "live"`（`~/.dsh/profiles/desktop/package.json`），改完重载即可：

```yaml
- id: skill-filesystem
  config:
    bundledSkillDir: /Users/limeng/DSH/nomifun-desktop-main   # 任意 asar 外的、含 skills 的目录
```

**代价**：失去那 2 个内置 cordis 技能（除非你把它们从 asar 里拷出来放到该目录）。
**收益**：provider 不再抛错 → **45 个用户技能立刻恢复**。

> 若只想"保住内置技能、且不引入错误"，可以把这个目录做成一个**真实目录**，里面放**拷出来的** `cordis-plugin-development/` 与 `editing-cordis-compositions/`（源文件在 `app.asar!/node_modules/@deepseek-ai/dsh-agent-presets/presets/cordis/skills/`，可用本笔记 §7 的 `asarcat.js` 逐个抽出）。这样两者都不丢。

#### 绕法 2（最保守）：摘掉 bundled root

```yaml
- id: skill-filesystem
  config:
    bundledSkillDir: null      # 或让 includeDefaultRoots: false 连带去掉
```

`config.bundledSkillDir === undefined` 时回落到 `DSH_BUNDLED_SKILL_DIR` 环境变量。注意 **`null` 与 `undefined` 语义不同**，直接写 `null` 是否被 zod schema 接受需实测（`dsh-skill-filesystem/lib/index.js:44` 的 schema 是 `z.string().optional()`，**`null` 很可能校验失败**）。**更稳的是用绕法 1 指向一个真实目录。**

⚠️ **不要用 `includeDefaultRoots: false`** —— 它会**连带关掉 user-agents root**（`:172-181` 整段被跳过），用户 45 个技能同样丢，等于没修。

#### 绕法 3：改环境变量（不改任何配置文件）

在启动 DSH Desktop 前设 `DSH_BUNDLED_SKILL_DIR=<asar 外的目录>`。适合 GUI 启动难以注入 env 的场景要另想办法（如 `launchctl setenv`），**一般不如绕法 1 直接**。

### 4.3 修复后如何验证

见 §5 的 S1/S3 —— 核心是：**日志里 `[W] [skill-registry] skill provider "filesystem" skipped` 不再新增**，且技能面板里能看到 `~/.agents/skills` 的技能。

---

## 5. 用户可自行执行的判定步骤

### S1（最快，纯命令）：确认故障在不在、严重程度

```bash
grep -c 'skill provider "filesystem" skipped' \
  "$HOME/Library/Application Support/DSH Desktop/logs/host/dsh-$(date +%Y-%m-%d).log"
```

- 输出 **0** → 本故障当前未触发（或今天还没有日志），改看**最近一个** `dsh-*.log`；全都没命中 → 未中招。
- 输出 **>0** → 已中招。再看**是否有第二种路径**（判断影响面是"整条"还是"单 root"）：

```bash
grep -o 'cannot list "[^"]*"' \
  "$HOME/Library/Application Support/DSH Desktop/logs/host/"dsh-*.log | sort -u
```

- **只有一条、且以 `/app.asar/` 开头** → 就是本故障，**整条 provider 已被跳过**（按 §2），你的用户技能全部取不到。
- 出现**多条不同路径** → 需要逐个判断（本机复核结果：**只有一条**）。

### S2（纯界面）：确认"我的技能到底取没取到"

1. 打开 DSH Desktop，在输入框敲 **`/`** 触发技能菜单（/ 触发器 lexicon 会列出可用技能）。
2. **找一个你确定存在于 `~/.agents/skills` 的名字**，例如 `make-dsh-plugin`、`redesign-existing-projects`、`lark-base`。
3. 在列表里搜这个名字：
   - **搜不到** → 你的用户技能没被取到，与 §2 的结论一致。
   - 搜得到 → 说明本次 `list()` 没被整条丢弃（可能故障已修、或当天未触发），**请回话我，我会修正结论**。

> 建议同时搜 `cordis-plugin-development`（内置 bundled 技能）作对照：本故障下它**同样取不到**（肇事 root 自己也没读成功）。

### S3（确认修复是否生效，做 §4.2 绕法之后）

1. 改完 `cordis.patch.yml`（profile 是 `patchReload: live`，通常无需重启）。
2. 重跑 **S1** 的第一条命令，看**是否还在增长**：
   ```bash
   grep -c 'skill provider "filesystem" skipped' "$HOME/Library/Application Support/DSH Desktop/logs/host/dsh-$(date +%Y-%m-%d).log"
   ```
   记下数字，等 30 秒再跑一次：**数字不再变** → 已止血；**继续涨** → 绕法没生效（多半是 YAML id 写错或路径不存在）。
3. 重跑 **S2**，确认用户技能回来了。

### S4（可选，判断是否只有打包版中招）

若你另有一份 DSH 的**源码 checkout**（非 asar），在其中查同一路径是否存在为**真实目录**：

```bash
ls -la <checkout>/node_modules/@deepseek-ai/dsh-agent-presets/presets/cordis/skills
```

是真实目录 → 该环境下 `stat` 会走内核、`mode` 是真正的 BigInt，**不会**触发。这只能**静态推断**，见 §6。

---

## 6. 残余不确定性

1. **未做真实运行时验证。** 我无法 attach 到运行中的 renderer（无 CDP 端口：`lsof -nP -iTCP -sTCP:LISTEN` 只有 `56327`/`56332`/`43120`），也无法用 GUI 观察（`screen_observe` 返回 `cua-driver ENOENT`），且没有 `dsh` CLI。**因此"45 个技能确实取不到"这一条是静态推演 + 日志推断的结论，未取得运行时清单佐证。** 其可靠度取决于 §2 的三层代码证据（三层我都给了 file:line）；**S2 是最直接的证伪/证实手段，强烈建议执行。**
2. **asar shim 返回 Number `mode` 这一步未能直接观测。** Electron 的 asar shim 编译在二进制里，`strings`/asar 抽取都拿不到 JS 实现。我的依据是**排除法 + 复现**：模板字符串不抛、`size` 相关运算不抛、**`& 511n` 是唯一能给出该精确报文的运算**，且实测 `Number & BigInt` 报文与日志逐字一致。这是**强推断，不是直接观测**。
3. **"只在 Desktop 打包版出现"未实测。** 依据是：错误路径全在 asar 内（`grep -o 'cannot list "[^"]*"'` 全日志只有 asar 路径），且 plain node 访问该路径得到的是 `ENOTDIR`（`ls` 实测 "Not a directory"）而非 BigInt 错 —— 说明出错环节确实与 asar 拦截有关。**没有另一套非打包环境可供对照。**
4. **`DSH_BUNDLED_SKILL_DIR` 的来源未定位到代码。** 它在 asar 与 `app.asar.unpacked` 内均无赋值点，推断由 Electron 主进程（编译进二进制）注入。**这不影响结论**：`config.bundledSkillDir` 优先级更高（`:85` 的 `??`），绕法 1 不依赖环境变量的来源。
5. **绕法 1/2 未实测。** `cordis.patch.yml` 的 id-targeted `config` 覆盖是 bundle 自己的机制（`dsh-base/cordis.patch.yml` 就是这么配 `skill-badge` 的 `disabled: true`），机制本身可靠；但**具体 YAML 是否被接受、`bundledSkillDir` 指向的目录需要什么结构（是含 `SKILL.md` 的子目录，还是含 `skills/` 的父目录）我没有实测**。按 `discoverRoot`（`:582-586`）读代码，它期望的是**直接含技能子目录的那一层**，即与 `presets/cordis/skills` 同构。**建议先按 S3 验证。**
6. **计数差异。** 队长给 671、实测 761（全日志）。差异应来自 15:26 重启后的新增；我**未单独复核"重启前 = 644"**这个数字。
7. **日志轮转**：`logs/host/` 下按天分文件（`dsh-2026-09-11.log`），跨天排查需自己并多个文件。

---

## 7. 本次使用的只读取证命令

```bash
# 抽取 asar 内单文件（数据基址 = 16 + readUInt32LE(12)）
node /tmp/asarcat.js "/Applications/DSH Desktop.app/Contents/Resources/app.asar" \
  "node_modules/@deepseek-ai/dsh-fs-local/lib/index.js"        > /tmp/fslocal.js
node /tmp/asarcat.js "/Applications/DSH Desktop.app/Contents/Resources/app.asar" \
  "node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js" > /tmp/skillsfs.js
node /tmp/asarcat.js "/Applications/DSH Desktop.app/Contents/Resources/app.asar" \
  "node_modules/@deepseek-ai/dsh-skill/lib/index.js"            > /tmp/skillreg.js
node /tmp/asarcat.js "/Applications/DSH Desktop.app/Contents/Resources/app.asar" \
  "node_modules/@deepseek-ai/dsh-base/cordis.patch.yml"

# 日志取证
L="$HOME/Library/Application Support/DSH Desktop/logs/host/dsh-2026-09-11.log"
grep -c 'skill provider "filesystem" skipped' "$L"                    # 761
grep -o 'cannot list "[^"]*"' "$L" | sort -u                          # 只有 1 条路径

# 复现 BigInt 混用（本机 node，无副作用）
node -e 'try{Number(33188 & 511n)}catch(e){console.log(e.message)}'
# => Cannot mix BigInt and other types, use explicit conversions

# 用户技能清点（只读）
ls ~/.agents/skills | wc -l                                           # 45
find ~/.agents/skills -maxdepth 2 -name SKILL.md | wc -l               # 45
```

### 关键位置速查

| 内容 | 位置 |
|---|---|
| **抛错点** | `app.asar!/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js:226`（`:241` 同型） |
| BigInt stat 调用 | 同上 `:222`、`:237` |
| 错误翻译为 `cannot list` | 同上 `:246-252`（`listingIoError`）、触发于 `:274-277` |
| `listDir` 入口 | 同上 `:807` → `listDirectory` `:270` |
| **无 per-root 隔离** | `app.asar!/node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js:104` |
| 只吞"不存在"的 catch | 同上 `:643-652`（rethrow 于 `:650`） |
| root 清单与 rank | 同上 `:151-188`、`:22-26` |
| `bundledSkillDir` 取值 | 同上 `:85` |
| **整条 provider 跳过** | `app.asar!/node_modules/@deepseek-ai/dsh-skill/lib/index.js:349-357`（日志 `:355`） |
| runtime provider 优先级 | 同上 `:21`、`:342-347` |
| bundle 未配 config | `app.asar!/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:278-279` |
| 绕法落点 | `~/.dsh/profiles/desktop/cordis.patch.yml`（当前为 `[]`） |
