# 三个 composer 座位为什么看不见 —— 诊断笔记

> 诊断对象：`conversation.hero.modeActions` / `conversation.input.accessory` / `conversation.composer.dock`
> 权威依据：已安装的 DSH Desktop `app.asar`
> 版本锚点：`@deepseek-ai/dsh-client-ui-conversation` = **0.1.5-rc.1**
> 结论先行，逐条带「文件:行」。

---

## 0. 结论先行

| 座位 | 归类 | 一句话原因 |
| --- | --- | --- |
| `conversation.hero.modeActions` | **(A) 根本没注册上** | 该槽位名在 DSH 0.1.5 里**不存在**（全 asar 21817 文件 0 匹配）。 |
| `conversation.input.accessory` | **(A) 根本没注册上** | 同上，槽位名**不存在**（0 匹配）。 |
| `conversation.composer.dock` | **(A) 注册不上 + (B) 逻辑上永不可达** | 名字**存在**，但插件 `inject` 时该槽位尚未声明；**即便声明了，插件的 `blank===true` 守卫与 DSH 只在 `variant==="composer"`（即非空白）时渲染该槽位，互相矛盾，该座位是死座位。** |

**最关键的一条：`ctx.slots.inject(name, cb)` 对未声明的名字不报错、不警告，它会永远等一个永远不会到来的声明。** 所以这三个座位是静默失败 —— 这正是"上一轮 `data-dsh-sidebar-*` 0 匹配"事故的同型问题，也解释了为什么运行时日志里一条错误都没有。

---

## 1. `inject` 的静默语义（三个座位共同的失败放大器）

DSH 自带的 slots 服务把 `inject` 的契约写得很清楚：

- `app.asar!/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js:1347`
  ```
  signature: "inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void",
  ```
- 同处描述（`client.js:1348`）：
  > "Install an effect for each declaration lifetime of a slot. **The callback runs synchronously when the declaration already exists; otherwise it runs inside the declaring `register()` call after the declaration is committed.** Only collapse disposes the effect and a later declaration runs it again."
- `throws` 字段（`client.js:1355`）只列了「槽位**已声明**时 callback setup 同步失败」，**没有**「名字不存在」这一项。

对照注册侧的硬校验（**这条才是会抛错的**）：

- `app.asar!/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js:79`
  ```js
  register(options, component) {
      const rec = this.records.get(options.name);
      if (!rec?.spec) throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`);
  ```

所以形状是：

```
inject(不存在的名字)  → 静默等待，永不回调，不报错
   └─ 所以 register(不存在的名字) 那一步根本不会被执行 → 连上面那句 throw 都到不了
```

**注意任务纪律要求的区分**：这里「注册被调用」与「真的渲染出来」是两件事。插件确实**调用了** `ctx.slots.inject(...)`（代码在），但 callback 从未执行，所以 `ctx.slots.register(...)` **从未被调用**。合理解释：插件 `apply` 外层有 `try/catch`（`dsh-miniapp/lib/client.js:6190-6338`），但此处连 catch 都不会触发，因为没有任何东西抛错。

运行时侧印证：`~/Library/Application Support/DSH Desktop/logs/host/dsh-2026-09-11.log:73,75` 只有 host 半边的两条日志（`tools registered` / `routes registered`），**没有** `client half failed to load`（该字符串在插件 `client.js:6341` 只由 catch 打印），也全库 grep 无 `is not declared` / `slot "` 任何命中。

---

## 2. 逐座位证据

### 2.1 `conversation.hero.modeActions` —— (A) 名字不存在

**权威声明：不存在。**

对 `app.asar` 全归档（21817 个可读条目）做正则 `modeActions` 扫描：**0 命中**。

DSH 0.1.5 实际声明的 hero 座位只有三个，全部 `kind: "single"` + `scope: "root"`：

- `app.asar!/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js:16634-16650`（children 表）
  ```js
  "conversation.hero.brand.mark":    { kind: "single", scope: "root" },
  "conversation.hero.workspace":     { kind: "single", scope: "root" },
  "conversation.hero.agentPreset":   { kind: "single", scope: "root" },
  ```
- 渲染处：`client.js:14636`（`brand.mark`）、`client.js:14887`（`workspace`）、`client.js:14902`（`agentPreset`）。

**没有 `modeActions`。** 真实存在的 `conversation.hero.*` 全集就是上面三个。

**插件注册侧证据：**
- `dsh-miniapp/lib/client.js:3898` —— `hero: "conversation.hero.modeActions"`
- `dsh-miniapp/lib/client.js:6216-6224` —— `ctx.slots.inject(COMPOSER_SLOTS.hero, ...)` + `register({name: COMPOSER_SLOTS.hero, ...})`

注册条件：`MiniAppStandardModeAction`（`client.js:5311-5322`）在 `props.session` 或 `props.sessionId` 缺失时 `return null`（**注意：这个组件自己并不检查 `blank`**，注释 `client.js:5310` 明说「hero 只在空白会话里存在，所以这里不需要再判一次」—— 这条假设本身也依赖 hero 座位名正确，而它不正确）。

**归类依据：** 名字在 0.1.5 已不存在 → 属于 (A)。与 `data-dsh-sidebar-*` 事故同型。

### 2.2 `conversation.input.accessory` —— (A) 名字不存在

**权威声明：不存在。**

全归档正则 `conversation\.input\.accessory` 扫描：**0 命中**。

DSH 0.1.5 实际的输入区座位（`client.js:16716-16746` children 表）：
```js
"conversation.input.attachments": { kind: "single", scope: "session-maybe" },
"conversation.input.overlay":     { kind: "list",   scope: "session" },
"conversation.input.left":        { kind: "list",   scope: "session" },
"conversation.input.plan":        { kind: "single", scope: "session" },
"conversation.input.right":       { kind: "list",   scope: "session" },
"conversation.input.model":       { kind: "single", scope: "session" },
"conversation.composer.dock":     { kind: "list",   scope: "session" },   // ← 见 2.3
```

渲染处（都在 `InputBar` 内）：
- `client.js:16179` → `conversation.input.left`（渲染条件：`input === undefined || sessionId === undefined ? null : ...`）
- `client.js:16184` → `conversation.input.right`
- `client.js:16077` → `conversation.input.overlay`

**注意一个易混点**：`InputBar` 的 props 里确实有一个形参叫 `accessory`（`client.js:15807`），但它是**组件内部形参名**，不是槽位名；全 asar 内不存在 `conversation.input.accessory` 这个**槽位键**。

**插件注册侧证据：**
- `dsh-miniapp/lib/client.js:3899` —— `accessory: "conversation.input.accessory"`
- `dsh-miniapp/lib/client.js:6226-6234` —— inject + register
- 守卫：`MiniAppStandardInputAccessory`（`client.js:5304-5308`）—— `props.session == null || props.session.blank !== true` 时 `return null`

**归类依据：** 名字不存在 → (A)。

### 2.3 `conversation.composer.dock` —— (A) 注册不上 **且** (B) 逻辑上永不可达

这个座位名字**是真的存在**，但有两个独立的致命问题，叠在一起。

**权威声明：存在。**
- `app.asar!/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js:16745-16748`
  ```js
  "conversation.composer.dock": {
      kind: "list",
      scope: "session"
  },
  ```
  即：**存在**、`kind: "list"`、`scope: "session"`。
- 声明者：`registerComposerBar()`，座位挂在 `conversation.composer.bar` 之下（`client.js:16718-16748`）。
- 实际渲染处：`client.js:16260`

**问题一 —— 声明晚于注入（→ 注册不上）：**

`conversation.composer.dock` 这个声明**不是**启动期就在的。它由 `registerComposerBar()` 产生，而 `registerComposerBar` 由 `conversation.session` 的渲染路径按需调用（`conversation.composer.bar` 本身声明于 `client.js:16626`，属于 `registerConversationRoot()` 的 children 表；而 `dock` 属于 `registerComposerBar()` 的 children 表）。二者是**两个不同的声明批次**：`dock` 在 `composer.bar` 第一次被 register 时才由 children 表带出来。

插件的 `inject` 若是抢在那一批声明之前跑的，就会挂起等待。这本身在契约上「合法」（inject 就是为等待设计的），只要声明后来真的发生，callback 就会补跑。所以**单凭这一点还不能断定 (A)** —— 真正把 (A) 坐实的是下一节：**这次声明永远不会发生**，因为父级 `composer.bar` 在 hero 里是 `variant: "hero"`，而 `dock` 的渲染被 `variant === "composer"` 硬关掉（但那只是渲染条件，不阻止声明）……

—— 这里必须诚实标注**静态证据的边界**：仅凭静态代码，我无法排除「`dock` 的声明最终确实发生、于是 inject 补跑、register 成功」这条路径。**能确证的、且足以解释用户现象的是问题二。**

**问题二 —— 插件的守卫与 DSH 的渲染条件互相矛盾（→ 死座位）：**

DSH 侧，三行代码构成一个硬结论：

1. `client.js:14869`
   ```js
   const hero = sessionId === void 0 || shellPhase === "blank" && (openState === "open" || summaryBlank === true);
   ```
2. `client.js:14906-14907` —— `hero` 直接决定那个 `variant` prop：
   ```js
   const inputBar = renderSlot("conversation.composer.bar", {
       variant: hero ? "hero" : "composer",
   ```
3. `client.js:16260` —— `dock` 只在 `variant === "composer"` 时渲染：
   ```js
   variant === "composer" && input !== void 0 && sessionId !== void 0 ? renderSlot("conversation.composer.dock", {}) : null
   ```

串起来：

```
会话是空白 (blank)  →  hero === true  →  variant === "hero"  →  client.js:16260 条件为假  →  dock 不渲染
```

而插件的守卫（`dsh-miniapp/lib/client.js:5260`）要求**恰好相反**：

```js
if (props.session === undefined || props.session === null || props.session.blank !== true) return null;
```

```
非空白  →  插件 return null（自己关掉）
空白    →  DSH 根本不渲染这个槽位（139/16260 那个三元为假）
```

**两个条件的交集是空集。** 该座位在任何会话状态下都不可能可见 —— 这是一个**可证明的死座位**，不是「条件苛刻」。

**插件注册侧证据汇总：**
- 槽位名常量：`dsh-miniapp/lib/client.js:3900`
- inject + register：`dsh-miniapp/lib/client.js:6236-6244`
- 可见性守卫：`dsh-miniapp/lib/client.js:5256-5262`（`MiniAppStandardComposerDock`，判空 → 非空白即 `return null` → 才渲染 `MiniAppTemplatePanel`）

**归类依据：**
- 问题一（声明时序）→ 倾向 (A)，但**静态证据不足以定论**，已标注。
- 问题二（守卫矛盾）→ 确定 (B)：注册即便成功，可见条件在数学上永不可满足。

**顺带推翻插件自身的文档与测试**（它们是"插件以为的契约"，不是权威）：
- `dsh-miniapp/docs/design.zh-CN.md:80` 声称「在**空白会话**的输入框上多两个座位：输入框上方一枚「小程序」chip，输入框下方一条（面板）」—— 与 `client.js:16260` 直接冲突。
- `dsh-miniapp/test/client.test.mjs:656` 的测试名与断言（`:662-663`, `:693-694`）把 `blank === true` 当作"应该出现"的条件来测。
  该测试只调用组件函数、断言返回值非 null，**从未校验槽位名是否在 DSH 里真实存在、也从未校验宿主的渲染条件** —— 所以它全绿，而功能在真机上不存在。**这正说明：插件单侧测试无法证明座位可见。**

---

## 3. 为什么"一条错误都没有"

用户看不到任何东西，日志里也没有任何抱怨，这是**设计使然**，不是巧合：

1. `inject` 对未知名字静默等待（`client-runner/lib/client.js:1347-1356`）。
2. `register` 的硬校验（`ui-slots/lib/index.js:79`）**根本执行不到**，因为它的 callback 从未被触发。
3. 插件的 `try/catch`（`client.js:6190-6338`）覆盖 `apply`，但此处无异常可捕。
4. 结果：三个座位无声消失，而 host 半边照常工作（`logs/host/dsh-2026-09-11.log:73,75`）。

对照 `client.js:6330-6333` 里插件作者自己写下的一条注释（关于 `priority: -10`）：
> "少了这一行，我们的登记会排在人家后面、永远轮不到渲染 —— 而且**不会报错**"

作者已经踩过一次"静默失败"，这次是同一个坑的另一个入口。

---

## 4. 关于「真实运行时行为」—— 诚实声明

**未做真实运行时验证。**

我尝试过，但三条路都不通，逐条说明，不以静态证据冒充运行时证据：

1. **DevTools / CDP**：`lsof -nP -iTCP -sTCP:LISTEN` 显示 DSH 的 renderer 只监听 `127.0.0.1:56327`、`*:56332`、`127.0.0.1:43120`，**没有** 9222/9229 之类的调试端口。无法 attach 到页面求值 `window.__DSH__` 或枚举 slot registry。
   - 已确认 DSH Desktop **正在运行**：主进程 pid 96103，renderer pid 96229（`--app-path=.../app.asar`）。
2. **GUI 观察**：`screen_observe(window="DSH Desktop")` 失败 —— `cua-driver ENOENT`，`~/.cua-driver` 下只有 `packages` 目录、无可用二进制，`CUA_DRIVER_BIN` 未设置。
3. **CLI**：`which dsh` 无结果，无法另起一个 `dsh web` 做独立复现。

因此**所有"座位不可见"的结论均来自静态证据**（asar 源码 + 插件源码）。**但请注意静态证据在本例中的强度**：
- 2.1 / 2.2 是**名字在整个归档里 0 命中**（21817 文件穷举）—— 这是存在性否证，静态即定论。
- 2.3 是**两个条件交集为空**的纯逻辑推导，三个文件行号已给出 —— 静态即定论。
- 真正需要运行时才能确认的是**问题一（声明时序）** 是否单独构成失败，已明确标注为不确定。

版本匹配度：插件的目标版本就是 0.1.5，已安装的 `dsh-client-ui-conversation` 正是 `0.1.5-rc.1` —— 所以这不是"插件写给了别的版本"的错位问题，是**对着同一个 0.1.5 写错了槽位名**。

---

## 5. 给用户的最小确认步骤

> 以下步骤**不需要**用户读代码或开 DevTools，纯界面观察。可直接转达。
> 建议按顺序做，每条都能独立印证一个结论。

**S0（基线，先确认插件真的装载了）**
打开 DSH Desktop 设置面板，看右侧是否有一颗**「小程序」**按钮。
- 说明：这颗来自 `sidebar.footer.action` 座位（`dsh-miniapp/lib/client.js:6246-6254`），**该槽位名在 0.1.5 里真实存在**，所以它是本插件当前**唯一确认能显示的座位**。
- 若连它都看不到 → 插件整体没加载，本诊断的前提需要重估（回话我）。

**S1（验证 2.1 —— hero chip 不存在）**
新建一个**全新空白会话**，看输入框**上方**（hero 区域、与「工作区」选择器同一行附近）是否有一枚「小程序」模式 chip。
- 预期：**没有**。该槽位名 `conversation.hero.modeActions` 在 0.1.5 中不存在，与是否空白会话无关。
- 对照：同一行应该能看到 DSH 自带的**工作区选择器**和**代理预设**控件（那两个槽位真实存在，`client.js:14887`、`14902`）。

**S2（验证 2.2 —— 输入框旁的 chip 不存在）**
在同一个空白会话里，看输入框**左侧 / 右侧**（附件按钮、模型选择器那一排）是否多出一格「小程序」。
- 预期：**没有**。`conversation.input.accessory` 不存在。

**S3（验证 2.3 —— 模板面板是死座位）**
1. 先在空白会话里试着点 S1/S2 的 chip —— 点不到，因为不存在，所以"进入模式"这个前提动作无法完成。
2. 换个方式：随便发一句话让会话**非空白**，看输入框**下方**是否出现模板面板。
- 预期：**没有**。非空白时插件自己 `return null`（`client.js:5260`）；空白时 DSH 不渲染该槽位（`client.js:16260`，只见于 `variant === "composer"`）。
- 反过来再验证一次：**清空/新建会话回到空白态**，输入框下方同样**不会有**面板。

**S4（反证 —— 确认"静默失败"而非"功能被禁用"）**
设置里找有没有「小程序模式」之类的开关；打开/关闭它，观察 S1–S3 是否有任何变化。
- 预期：**毫无变化**。因为问题出在注册阶段（座位名对不上），任何运行时开关都影响不到它。
- 若某个开关能改变现象 → 我的归类需要修正（回话我）。

---

## 6. 残余不确定性

1. **问题一的时序无法静态定论**（见 2.3）：`conversation.composer.dock` 的声明是否终会发生、`inject` 是否最终补跑成功，需要运行时枚举 slot registry（如 `slots.snapshot()`）才能确证。
   *但即使补跑成功，问题二的空交集依然使该座位不可见* —— 所以这不影响最终归类。
2. **未观察真实 DOM**：以上均为源码级推理，未取得任何一张真机截图或 DOM 快照。若用户按 S1–S4 复核后与预期不符，应以实测为准并回话我。
3. **`conversation.composer.bar` 之外是否有其它声明者**：我只确认了 `composer.bar` 这一个父级（`client.js:16626`、`16718`）。若存在我未发现的第二声明路径，2.3 问题一的推理需重估（问题二不受影响，因为它只依赖 `client.js:14869/14906/16260` 三行）。
4. **`priority` 遮蔽未纳入**：`dock` 是 `list` 槽位、按 `id` 分格，理论上存在被更高 `priority` 遮蔽的可能（`ui-slots/lib/index.js:181-190` 的 `entriesOfSlot`）。但既然它根本渲染不到（`client.js:16260`），这条对当前现象无影响，未展开。
5. **未核对 host 半边**：本任务只诊断客户端座位。host 侧工具注册正常（日志 `:73`），不在范围内。

---

## 附：本次使用的只读取证命令

```bash
# 抽取 asar 内单文件（/tmp/asarcat.js：readUInt32LE(12) 取 header 长度，数据基址 = 16 + headerSize）
node /tmp/asarcat.js "/Applications/DSH Desktop.app/Contents/Resources/app.asar" \
  "node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js" > /tmp/conv.js
node /tmp/asarcat.js "/Applications/DSH Desktop.app/Contents/Resources/app.asar" \
  "node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js" > /tmp/slots.js
node /tmp/asarcat.js "/Applications/DSH Desktop.app/Contents/Resources/app.asar" \
  "node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js" > /tmp/runner.js

# 按正则搜 asar 内某类文件
node /tmp/asargrep.js "/Applications/DSH Desktop.app/Contents/Resources/app.asar" \
  'conversation\.hero\.modeActions|conversation\.input\.accessory|conversation\.composer\.dock'
```

枚举 0.1.5 真实存在的 `conversation.*` 槽位名（用于对照）：

```
conversation.approval.detail          conversation.input.attachments
conversation.chat.commandview         conversation.input.dock
conversation.chat.node                conversation.input.left
conversation.chat.turnTail            conversation.input.model
conversation.composer                 conversation.input.overlay
conversation.composer.bar             conversation.input.plan
conversation.composer.dock            conversation.input.right
conversation.hero.agentPreset         conversation.message.images
conversation.hero.brand.mark          conversation.session
conversation.hero.workspace           conversation.session.header
conversation.hero.workspace.directoryFlow   conversation.session.header.actions
conversation.trajectory.images        conversation.session.header.corner
conversation.view                     conversation.session.header.lineage
                                      conversation.session.header.utilities
```

**→ `conversation.hero.modeActions` 与 `conversation.input.accessory` 不在其中。**
