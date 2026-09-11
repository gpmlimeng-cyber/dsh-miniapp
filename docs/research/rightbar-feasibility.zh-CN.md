# 方案 B 原语可用性核实（动手前）

**任务**：t31。**目的**：把 scout 在 `agent-teams-presentation.zh-CN.md` §3.4 / §6-方案B / §7 里标注的"未取证的推断"，变成**代码证据**或明确的**不可用**。

**本文不写实现代码**，只给证据与结论。

---

## 0. 方法与证据等级（先读这一节）

**校验的是哪棵树**（唯一权威 = 用户机器上正在跑的那一份）：

```
/Applications/DSH Desktop.app/Contents/Resources/app.asar
21820 个条目 / 181,385,565 字节
读通道：fs.readFileSync（进程内）；「全量扫、无 size 上限」
```

**证据读法**：本笔记每条判断都给出「**条目路径 + asar 绝对偏移 + 条目内行号 + 命中数**」。偏移是相对整个 asar 文件的绝对字节位置，可用同一读法复算。

**三条纪律**（本文按它们写）：
1. **存在性判断必须落在"该服务自己的声明条目内"**，而不是"整个 asar 里搜到了"。我们踩过 `workspaces.startSession` 的坑：服务名存在 ≠ 那个方法在那个服务上。第 3 节给出这条纪律的**量化对照**。
2. **每条存在性判断都做反空断言**（把名字改坏必须 0 命中），见第 3.3 节。
3. **区分代码证据与推断**；取不到的写「未取证」，不推测。

**证据等级**：
- **[代码证据]** —— 在 asar 字节里读到，附偏移/行号，可复算。
- **[推断]** —— 从代码证据推出，未直接观察。
- **[未取证]** —— 没有找到证据，明确标注。

---

## 1. 结论速览

| # | 问题 | 结论 | 等级 |
|---|---|---|---|
| ① | `ctx.sidebarRight` 第三方能否拿到 | **能**。经 `ctx.reflect.provide` 提供，第三方用 `inject` 数组取；有活样例 | [代码证据] |
| ② | `sidebarRightTabs.register` 与其签名 | **存在**，签名与 scout 所述**一致**（含 `guide?`） | [代码证据] |
| ③ | `sidebar.right.pane.tab` 是否 keyed 加法路径 | **是**。`kind=keyed / scope=session`，已有 3 个不同 key 并存 | [代码证据] |
| ④ | `openTab/float/dock/isExpanded/toggleExpanded/close/active/focus/split` | **九个全在**该服务自己的类里 | [代码证据] |
| ⑤ | `float(tabId, rect?)` 是否接受自算 rect | **接受，且原样采用**（`rect: s ?? {默认}`）——见 §8.2 | **[实测]** |
| ⑥ | 折叠后 DSH 是否**自动**给展开按钮 | **是**，且与该插件无关（由 DSH 自己的 store 驱动） | [代码证据] |

**对方案 B 的总判断**：**原语可用，方案 B 在"能否做到"这一层成立**。但有两个**必须由产品/实现阶段解决**的点（第 5 节），其中一个仍是 [未取证]。

---

## 2. ① `ctx.sidebarRight` 的服务提供点

**提供点（精确写法）**：

| 服务 | 写法 | 命中数 | 条目 | asar 偏移 | 条目内行号 |
|---|---|---|---|---|---|
| `sidebarRight` | `ctx.reflect.provide("sidebarRight", controller)` | **1** | `node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js` | 32568008 | 第 3676 行 |
| `sidebarRightTabs` | `ctx.reflect.provide("sidebarRightTabs", tabs)` | **1** | 同上 | 32567935 | 第 3674 行 |

**关键结构事实**：两者都**不是** `class X extends Service`（`super(ctx, "sidebarRight")` 命中数 = **0**），而是 `ctx.reflect.provide`。README「维护者工作上下文」一节逐字印证：

> 两个服务（`sidebarRight`、`sidebarRightTabs`）在同一个 effect 内经 `ctx.reflect.provide` 提供并随之拆除

**⇒ 第三方能否取到？能，且有活样例。** `dsh-client-ui-sidebar-documentpreview/lib/client.js` 逐字：

```js
const inject = [
    "slots",
    "locale",
    "sidebarRightTabs",      // ← 第三方 inject 得到该服务
    "remote",
    "remote.workspaceFiles"
];
```

**注意一个细节**：该活样例 inject 的是 **`sidebarRightTabs`**，**不是** `sidebarRight`。全 asar 里 `inject` 数组含 `"sidebarRight"`（非 Tabs）的**只有本包自己**（`ui-chat` 引用的是别处）。

- 我没有找到**第三方 inject `sidebarRight`** 的先例。
- 但两条服务用的是**同一个机制**（同一句 `ctx.reflect.provide`、同一个 effect、README 说"随之拆除"），所以 **`inject: ["sidebarRight"]` 应当同样可用** —— 这是 **[推断]**，不是代码证据。
- **⇒ 建议：实现阶段第一件事就是用一个最小插件 `inject: ["sidebarRight"]` 起一次，确认非 undefined。** 这是唯一还带推断色彩的一环（成本极低）。

> **📌 t33 已实测：见 §8.1 —— `inject: ["sidebarRight"]` 可用（5/5 PASS）。本条由 [推断] 升级为 [实测]。**

---

## 3. ② / ④ 服务的**方法面**

### 3.1 ② `sidebarRightTabs.register` 的签名

服务自己的文件里（`SidebarRightTabRegistry`，asar 偏移 32431041 起、140542 字节的条目内）：

```js
register(definition) {
    const { id, kind } = definition;
    const band = definition.priority ?? DEFAULT_BAND;
    if (this.ids.has(id)) throw new Error(`sidebarRight: tab type id "${id}" is already registered`);
    const held = this.kinds.get(kind);
    if (held !== void 0 && !coexists(held, band)) throw new Error(`sidebarRight: tab kind "${kind}" is already registered (${held.inForce.band})`);
    ...
    * @returns idempotent disposer.
```

**⇒ 与 scout 所述签名一致**：`{ id, kind, patterns?, priority?, canOpen?, title, guide? }`。活样例的实参形状逐字印证：

```js
function textDefinition() {
    return {
        id: TEXTPREVIEW_ID,
        kind: TEXTPREVIEW_KIND,
        patterns: ["dsh-resource://file/**"],
        priority: "fallback",
        canOpen: (address) => parseFileAddress(address)?.scope === "session",
        title: basenameOf
    };
}
```

**两条有用的副作用语义**（来自代码，不是文档）：
- **`id` 重复 → 抛错**（不是静默覆盖）⇒ 我们的 id 冲突会**当场炸**，不会静默顶掉别人。
- **`kind` 冲突受 `coexists(held, band)` 约束** ⇒ kind 不是随便撞的；`priority` 参与共存判定。

### 3.2 ④ 九个方法：都在**该服务自己的类里**

控制器定义：`var SidebarRightController = class { ... }`（该条目内）。逐字取出的方法名：

```
constructor, bind, openResource, openTab, openResourceIn, openTabIn,
closeIn, placeResource, placeTab, place, close, active, isExpanded,
toggleExpanded, focus, split, float, dock, _undo, _redo, mounted,
actionsFor, require
```

任务点名的九个：**`openTab / float / dock / isExpanded / toggleExpanded / close / active / focus / split` —— 全部命中，且都在该类内。**

### 3.3 反空断言：为什么"全局搜到"毫无意义

| 方法 | 全 asar 命中数 | **该类内** |
|---|---|---|
| `openTab(` | 8 | **1** |
| `float(` | 55 | **1** |
| `dock(` | 2 | **1** |
| `isExpanded(` | 2 | **1** |
| `toggleExpanded(` | 6 | **1** |
| `close(` | **1962** | **1** |
| `active(` | 137 | **1** |
| `focus(` | 154 | **1** |
| `split(` | **2522** | **1** |

**⇒ `close(` 在整个 asar 里出现 1962 次、`split(` 2522 次**。如果只用"全局搜到"当判据，这两个几乎必然假阳性。**这正是 `workspaces.startSession` 那类事故的成因**：名字在别的树的别的对象上。本合同要求"落在该服务自己的声明条目内"，**是必要且不可省略的**。

**改坏名字的反空断言（坏名必须 0 命中）**：

```
PASS  reflect.provide("sidebarRightTabs"      好=1   坏=0
PASS  openTab(                                好=8   坏=0
PASS  float(                                  好=55  坏=0
PASS  dock(                                   好=2   坏=0
PASS  isExpanded(                             好=2   坏=0
PASS  toggleExpanded(                         好=6   坏=0
PASS  close(                                  好=1962 坏=0
PASS  focus(                                  好=154 坏=0
PASS  split(                                  好=2522 坏=0
PASS  sidebar.right.pane.tab                  好=33  坏=0
PASS  conversation.session.header.corner      好=8   坏=0
```

> **过程自曝**：我第一版反空断言里 `provide("sidebarRight")` 报 `好=0`，一度让我以为服务名不对。实际是**我的探针字符串转义写错了**（shell 里嵌套引号被吃掉）。改用 `JSON.stringify` 拼 needle 后得到 **1**。**教训与本案同源：探针报错时先怀疑探针。**

---

## 4. ③ 槽位 `sidebar.right.pane.tab` 与"keyed 加法路径"

### 4.1 声明（真源：`dsh-cordis-client-runner` 的槽位目录）

```
sidebar.right.pane.tab             kind=keyed    scope=session
sidebar.right.pane.tab.title       kind=keyed    scope=session
sidebar.right.tab.document         kind=keyed    scope=session
sidebar.right.tab.guide            kind=chain    scope=session
sidebar.right.tab.menu.item        kind=list     scope=session
```

**`sidebar.right.pane.tab` 是 `kind=keyed`、`scope=session`** ⇒ **是加法路径，不是单值替换**。

### 4.2 已有三方**并存**的实证（这是"不顶掉别人"的直接证据）

在 asar 里搜"对 `sidebar.right.pane.tab` 的 register 及其 key"：

| 注册方 | key |
|---|---|
| `dsh-client-ui-sidebar-documentpreview` | `TEXTPREVIEW_ID` |
| `dsh-client-ui-sidebar-files` | `FILES_ID` |
| `dsh-client-ui-sidebar-right`（引导页） | `GUIDE_ID` |

**三个不同的 key 已经同时存在** ⇒ keyed 槽位确实给每个 key 各自一格。**我们的 key 会是第四个**。

⇒ **回答关键问题①：能。** 我们注册的 tab 类型是**新增一格**，不会顶掉 DSH 自己的 Files / 预览 tab。

**活样例的完整注册形状**（`documentpreview`，我们可逐字照抄这个形状）：

```js
ctx.effect(() => ctx.sidebarRightTabs.register(textDefinition()), "…: text type");
ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
    name: "sidebar.right.pane.tab",
    key: TEXTPREVIEW_ID,          // ← 与 register 的 definition.id 同值
    locale: NS,
    store,
    children: { "sidebar.right.tab.document": { kind: "keyed", scope: "session", inject: {...} } },
    inject: (sessionId, actions) => ({ ... })
}, Body)));
```

**⇒ `key` = `definition.id`**（README 第 79 行逐字：「正文——`ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id }, Body)`」）。

---

## 5. 四个关键问题（逐条作答）

### 问①：能否注册一个**新的 tab 类型**（而不是顶掉 Files/预览）？

**能。** [代码证据]
- 槽位 `sidebar.right.pane.tab` 是 `keyed`（4.1）；
- 已有 3 个 key 并存（4.2）；
- `register` 对重复 `id` **抛错**而非覆盖（3.1）⇒ 失败方向安全：我们的 id 若撞车会**立刻报错**，不会静默取代谁。

### 问②：`openTab` 的参数与返回值、能否指定我们的 tab？

**能指定，参数是 `(kind, options?)`。** [代码证据]

```js
openTab(kind, options = {}) {
    const { sessionId, actions } = this.require();
    this.placeTab(sessionId, actions, kind, options);
}
```

- **参数**：第一个是 **`kind`**（对应 `register` 里的 `kind`），第二个是可选 options（`openTabIn` 一族里可见 `{ replaceTab: true }`，见 DSH 自己引导页的 `tab.actions.openTab(entry.kind, { replaceTab: true })`）。
- **返回值**：**无显式 return** ⇒ `undefined`。它是"导航动作"，不是"创建并返回句柄"。
- **⇒ 要打开我们自己的 tab，传我们注册的 `kind`。**

**[未取证]**：`options` 的**完整字段表**未逐一确认（只确认了 `replaceTab`）。实现时若要用别的选项，需另查 `placeTab` / `openTabIn`。（**t33 未变更此项**，仍为未取证。）

### 问③：`float(tabId, rect?)` 是否接受我们自算的 rect？

**签名接受 rect；但"我们算的 rect 是否被最终采用"——[未取证]。** 这是本次核实**唯一未闭合**的技术点。

> **📌 t33 已实测：见 §8.2 —— `rect: s ?? {默认}`，我们传入的 rect 被原样采用。本条由 [未取证] 升级为 [实测]。**

代码（该服务自己的类内）：

```js
float(tabId, rect) {
    const { sessionId, actions } = this.require();
    const layout = this.mounted()?.layout;
    if (layout === void 0 || layout.tabs[tabId] === void 0) return;
    if (findTabPane(layout, tabId).host !== "dock") return;   // ← 只在"停靠态"才生效
    actions.floatTab(sessionId, tabId, rect);
}
```

- **接受 `rect`**：确实透传给了 `actions.floatTab`。
- **一个硬前置**：该 tab 的 pane `host` 必须是 `"dock"`。已浮出的再调 `float()` 会被**静默忽略**（直接 return）。这是有用的：**重复调用是幂等的、不会出错**。
- 下游：`floatTab: (d, sessionId, tabId, rect) => … planFloatTab(state, mint, tabId, rect) …`，`planFloatTab` 属 **dockkit**。

**关于 dockkit**：
- asar 里**没有独立的 `dockkit` 条目**；`planFloatTab` 只在该包的 `lib/client.js` 与前端打包产物 `dsh-web-frontend/dist/assets/index-DuF6ti6g.js` 里出现（**2 处**）。
- scout 说「asar 里 `provide("dock` 0 命中」—— 我复核：**`dockkit` 作为独立包名在 `package.json` / README / 前端产物里出现，但没有可单独取的插件服务条目**。**⇒ 插件侧触达不到 dockkit 内部**，与 scout 结论一致。

**⇒ 结论措辞**：`float()` 的**接口**接受 rect；但 rect 是"我们兜底给定"还是"必须由 dockkit 精算"——**取决 `planFloatTab` 对 rect 的处理（是否用给定值、是否夹取、是否忽略），我没有验证，标 [未取证]**。**实现阶段应先用最小样例传一个矩形，观察浮窗落点是否被尊重。**

> **📌 t33 已给出答案（§8.2）**：`planFloatTab` 的 `rect` 参数写作 `s ?? {默认几何}` ⇒ **传入即原样采用，不夹取、不忽略**；默认只在 `undefined` 时生效。**本条已闭合。**

### 问④：折叠后 DSH 是否**自动**给展开按钮？

**是，自动，且与我们无关。** [代码证据] —— **我们无需自绘角标。**

`dsh-client-ui-sidebar-right` **自己**注册到会话 header 角落：

```js
const disposeExpand = ctx.slots.inject("conversation.session.header.corner", () => ctx.slots.register({
    name: "conversation.session.header.corner",
    locale: NS,
    store
}, ExpandButton));
```

而 `ExpandButton` 的显示条件**只取决于 DSH 自己的 store**，**完全没引用任何插件的 tab**：

```js
function ExpandButton({ sessionId, useStore, actions, t }) {
    if (useStore((state) => state.bySession[sessionId]?.layout.expanded ?? false)) return null;
    return … <button data-sidebar-right-expand … onClick={() => { actions.setExpanded(sessionId, true); }}>
```

**⇒ 只要整列处于折叠态，按钮就在**（`expanded === false` ⇒ 画）。README 第 54 行逐字印证：面板隐藏时它会出现在 `conversation.session.header.corner`，"与 Session 日志控件齐平"。

**⇒ 对产品决策的意义**：**方案 B 不需要自绘角标**。这一条把 scout「折叠后要不要自绘」的悬置问题**关掉了**。

---

## 6. 仍未闭合 / 需要产品决策的点

1. ~~**`float()` 的 rect 语义 —— [未取证]**（问③）。~~ **【t33 已闭合，见 §8.2：rect 被原样采用】**
2. ~~**第三方 `inject: ["sidebarRight"]` 无先例** —— [推断] 可用。~~ **【t33 已闭合，见 §8.1：可用，5/5 PASS】**

> **本节第 1、2 条已由 t33 实测关闭；t33 之后仍存的不确定性统一列在 §8.3。**
3. **产品形态问题（非技术）**：方案 B 意味着"**库**是浮层，而**运行面**之一是右栏 tab" —— 两种形态并存。scout §6 已指出这是产品决策，本轮不判。
4. **`sidebarRight` 是"别人的列"，语义随产品演进** —— 这正是**保留降级/回退**的理由（与 `uiWorkspace` 同一条纪律：它是 DSH 自己的客户端服务，**不是为第三方冻结的契约**）。

---

## 7. 复算方法（给下一位）

1. 用仓库已有的公共件 `test/asar-reader.mjs`（`loadAsar()`）读那棵树 —— **不要**重写读取器，也**不要**用 `statSync` 判存在（`pnpm test` 用的私有 node 的 fs 被包装，会给 `size=0`）。
2. 所有判断写成「`buffer.indexOf(needle)` + `asar.entryAt(offset)` → 断言命中落在**预期条目**内」。
3. 每条再跑一次**坏名**，必须 0 命中。
4. 复算时注意：**先 `JSON.stringify(needle)` 再拼字符串**，否则 shell 转义会静默吃掉引号（本文第 3.3 节的坑）。

---

## 附：本次核实用到的关键偏移速查

| 事实 | asar 偏移 | 条目 |
|---|---|---|
| `reflect.provide("sidebarRightTabs", tabs)` | 32567935 | `dsh-client-ui-sidebar-right/lib/client.js` |
| `reflect.provide("sidebarRight", controller)` | 32568008 | 同上 |
| `conversation.session.header.corner` 注册（展开按钮） | 32570291 | 同上 |
| `sidebar.right.pane.tab` 声明（槽位目录） | —（在 `dsh-cordis-client-runner/lib/client.js`） | 同上 |
| `floatTab` 转发 | 32457098 | 同上 |
| `floatTab`（前端打包产物内的 `planFloatTab`） | 44753952 | `dsh-web-frontend/dist/assets/index-DuF6ti6g.js` |
| 活样例 inject 数组 | — | `dsh-client-ui-sidebar-documentpreview/lib/client.js` |

---

## 8. 实测升级（t33）：两条推断的实测结果

t31 留了两条带推断色彩的地方。本节用**最小可执行探针**把它们升级为实测，或明确标为仍存不确定。**探针全部在 `/tmp/t33/`，未进仓库。**

### 8.1 实测一：第三方插件 `inject: ["sidebarRight"]` —— **实测通过，升级为 [实测]**

**做法**：用 asar 里**真实的 `@deepseek-ai/cordis`**（`node_modules/@deepseek-ai/cordis/lib/index.js`，从同一棵树抽出）复现"提供方 + 消费方"两个插件，逐字照搬生产里的两句提供：

```js
c.reflect.provide('sidebarRight', controller)
c.reflect.provide('sidebarRightTabs', { register: … })
```

消费方用生产同款声明形式 `inject: ['sidebarRight']`。

**命令**：`node /tmp/t33/pkg/test_inject2.mjs`

**输出**：

```
PASS :: ① inject ["sidebarRight"] 后服务非 undefined :: 拿到同一个 controller 对象
PASS :: ② 只读方法可调、不抛错 :: isExpanded()=false active()=null
PASS :: 反空断言：inject 名改坏 → apply 不跑（服务拿不到） :: c.sidebarRightTYPO = UNSET（UNSET = apply 从未执行）
PASS :: 反空断言：ctx.get(坏名) → undefined :: ctx.get("sidebarRightTYPO") = undefined
PASS :: 正对照：ctx.get(好名) → 拿到 :: 同对象

---- 5/5 PASS ----
```

**⇒ 结论：第三方插件 `inject: ["sidebarRight"]` 可用。** t31 的 **[推断] 升级为 [实测]**。

**两条反空断言都做了**（这是本节的关键，证明判据不是恒绿）：
- `inject` 名改坏 → 消费插件的 `apply` **根本不会执行**（依赖永不满足，`got` 保持 `UNSET`）；
- 直接 `ctx.get('sidebarRightTYPO')` → `undefined`，而同名好键 → 同一个对象。

**一个重要的使用语义（实测中发现，写进给下游）**：cordis 的 `ctx.plugin(...)` 返回 **`Fiber`（可 await）**，插件是**异步激活**的。**必须 `await` 它**，否则服务尚未注册、`ctx.get(...)` 返回 `undefined`。
> 我第一版探针就没 await，得到 `null`/`UNSET`，一度像"服务不可用"。**这又是一次"探针报错先怀疑探针"** —— 与第 3.3 节的转义坑同类。

**边界（仍存的不确定性，见 8.3）**：本实测是在**真实 cordis + 真实声明形式**下做的，但消费方是**探针插件**而非真实第三方包；"真实第三方包 + 真实 web 宿主"这一次没有跑（原因见 8.3）。

### 8.2 实测二：`float(tabId, rect)` 的 rect 语义 —— **实测通过，升级为 [实测]**

**问题**：我们自算的 rect 会被尊重，还是会被 dockkit 忽略/覆盖？

**证据链（三段，全部读同一棵树的字节）**：

1. `sidebarRight.float(tabId, rect)` 把 rect **透传**下去：
   ```js
   float(tabId, rect) {
       const { sessionId, actions } = this.require();
       const layout = this.mounted()?.layout;
       if (layout === void 0 || layout.tabs[tabId] === void 0) return;
       if (findTabPane(layout, tabId).host !== "dock") return;   // ← 硬前置
       actions.floatTab(sessionId, tabId, rect);
   }
   ```
2. `floatTab` 把 rect 继续交给 dockkit：
   ```js
   floatTab: (d, sessionId, tabId, rect) => {
       d.bySession = seat(d, sessionId, (s) => advance(s, (state, mint) => planFloatTab(state, mint, tabId, rect).ops, seed));
   }
   ```
3. **`planFloatTab` 的真实现**（`dsh-web-frontend/dist/assets/index-DuF6ti6g.js`，绝对偏移 **44732235**，逐字）：
   ```js
   function ou(t,r,i,s){const c=t.floats.length*Kv,u=r("float");return{ops:[{type:"float",tabId:i,newPaneId:u,rect:s??{x:Wc.x+c,y:Wc.y+c,width:Lo.width,height:Lo.height}}],paneId:u}}
   ```
   即 `rect: s ?? {默认几何}` —— **`s`（我们传入的 rect）给了就用给的那个；只有它是 `undefined` 时才落默认**。`Wc` / `Lo` 是默认几何常量（同条目 488220 / 486168）。

**可执行复现**（`node /tmp/t33/pkg/test_float.mjs`，与 `ou` 逐字同构的等价实现）：

```
PASS :: ① 传 rect → 被**原样**采用（不是默认值） :: {"x":111,"y":222,"width":333,"height":444}
PASS :: ② 不传 rect → 落默认（与①不同） :: {"x":"DEFAULT_X0",…}
PASS :: 反空断言：若实现"忽略传入 rect" → 判据必红 :: 坏实现给出 {"x":"DEFAULT_X0",…}（≠ 我们的 {"x":111,…}）

---- 3/3 PASS ----
```

**⇒ 结论：`float(tabId, rect)` 的 rect 被**原样**采用（`??` 而非覆盖）。t31 的 **[未取证] 升级为 [实测]**。**

**两条硬前置（实现时必须知道）**：
- **pane 的 `host` 必须是 `"dock"`**：`if (findTabPane(layout, tabId).host !== "dock") return;` ⇒ 已浮出的 tab 再调 `float()` 会被**静默忽略**（幂等、不报错）。
- **tabId 必须已存在于 `layout.tabs`**，否则同样静默 return。

**局限（如实标注）**：本实测验证的是**几何语义**（rect 会不会被尊重），不是**含真实浏览器渲染的落点**。也就是说「rect 传进去后被原样采纳」是**代码证据 + 等价实现复现**级的；"屏幕上真的出现在那个坐标"仍需真机目视（属另一层，本任务不含）。

### 8.3 仍存的不确定性（给 t32 的前提清单）

| # | 事项 | 状态 | 对 t32 的影响 |
|---|---|---|---|
| 1 | 第三方 `inject: ["sidebarRight"]` | **[实测] 可用** | 无阻塞；按 `inject` 声明即可 |
| 2 | `float()` 的 rect 语义 | **[实测] 原样采用** | 无阻塞；rect 可自算 |
| 3 | 真实第三方包 + 真实 web 宿主端到端 | **[未取证]** | **建议**：t32 首个 commit 里就用真实插件形态跑一次；见下"为什么没做" |
| 4 | `openTab` 的 `options` 完整字段表 | **[未取证]**（只确认 `replaceTab`） | 若只用默认行为，无影响 |
| 5 | 真机目视浮窗落点 | **[未取证]** | 属产品验收，建议随 t32 的真机验证一并做 |

**为什么第 3 条（真端到端）没做**：
- 需要**真实 DSH web 宿主**（浏览器 + 前端 bundle）才能让 `sidebarRight` 真的被 `provide` —— 而它由 `dsh-client-ui-sidebar-right` 的 client 半边提供，只在浏览器里跑；
- 我尝试用 asar 里的真实 `dsh` CLI 起隔离进程（t31 及本项目此前用过该路线），但**本轮被一个基础设施问题挡住**：该 asar 里部分条目的 `(offset, size)` 与实际字节边界**不吻合**（实测：`cordis/package.json` 的 `start` 早 1 字节、`dsh/package.json` 的 `size` 少 1 字节、`js-yaml` 的 `.map` 文件内容被截断），导致 `dsh` CLI 从其抽出后**无法启动**（`Invalid package config` / `SyntaxError`）。
- **⇒ 如实记为 [未取证]，不推测。** 但注意：本节两条**已实测**项用的是**真实 cordis + 真实 dockkit 实现**，与"服务能否被 inject""rect 是否被尊重"这两个**具体问题**直接对应；第 3 条缺的是"整链路在真浏览器里"这一层。

### 8.4 本节的可复现性

- 探针位置：`/tmp/t33/pkg/test_inject2.mjs`、`/tmp/t33/pkg/test_float.mjs`（**均不在仓库内**，符合任务要求）。
- 依赖：`/tmp/t33/pkg/node_modules/@deepseek-ai/cordis/lib/index.js`（从同一棵 asar 抽出）。
- 复算方法：用 `test/asar-reader.mjs` 的 `loadAsar()` 读那棵树，按 8.2 第 3 段的绝对偏移 **44732235** 直取 `planFloatTab` 的字节。
- **抽取该 asar 的一个坑（写给下一位）**：部分条目的声明边界与实际内容不吻合，抽 `.json` 时要对 `(start±1, end±{0..2})` 做穷举 + `JSON.parse` 自愈；`.map` 文件可能被截断，若不需要就跳过。
