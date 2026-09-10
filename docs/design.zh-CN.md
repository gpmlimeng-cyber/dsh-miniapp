# dsh-miniapp · 小程序 for DeepSeek Harness

把 [NomiFun Desktop](https://github.com/nomifun/nomifun-desktop) 的**「小程序」**功能迁移成
一个 DSH 插件：让 Agent 生成的自包含单文件网页小工具，一次发布、随开随用。

> 本插件是 NomiFun 小程序功能的**移植**，不是复刻。产品闭环沿用原版第三代设计
> （`docs/specs/2026-08-10-miniapps-v3-unified-conversations.zh.md`），实现按 DSH 的
> 插件契约重写。

---

## 它是什么

一个小程序 = **一个自包含的 HTML 文件**（CSS/JS 内联，第三方库走 CDN）。
Agent 把它写出来，你点一次「发布」，它就成为可以随时打开的工具。

```
让 Agent「做一个小程序」        →  miniapp_create：建库条目 + 给出源码绝对路径
Agent 把 HTML 写到那个路径       →  工作副本（apps/{id}/working.html）
你在面板里点「发布」             →  提升为线上快照（snapshots/{id}.html）
从库页面随时打开                 →  沙箱 iframe 直出已发布版本
想让 Agent 继续改                →  「继续迭代」给出同一路径，改完再发布
```

**改完不会自动生效。** 这是刻意的：Agent 的改动和线上版本是两个事件，半成品改不坏你正在用的工具。

**不知道要什么的时候，从模板开始。** 空白会话的输入框下面有一条模板面板，12 个已经能用的小东西
（番茄钟、待办、记账本、单位换算、随机抽签…），每个都带**真的在跑的预览**。选中一个，它的描述
会落进输入框 —— 那句话说得很像你自己会说的话，所以改得动。

---

## 安装

```bash
cd dsh-miniapp
pnpm pack                                  # 生成 dsh-miniapp-<version>.tgz
dsh plugin --profile web add ./dsh-miniapp-<version>.tgz
```

装完重启 DSH（bundle 层的变更在重启时生效）。侧栏底部「设置」那一行的右侧会出现小程序图标。

卸载：

```bash
dsh plugin --profile web remove dsh-miniapp
```

> 用 tarball 而不是 `file:` 依赖：`file:` 会让 profile 的生成暂存（generation staging）
> 在每次启动时解析不到 peer 依赖，触发回滚清扫。

---

## 使用

### 让 Agent 建一个小程序

在任意会话里说：

> 帮我做一个小程序：一个带提醒的番茄钟

Agent 会调用 `miniapp_create`，拿到源码绝对路径与一整套构建契约，然后用写文件的工具把
HTML 写进去。收尾时它会提醒你去面板点「发布」。

### 从面板操作

侧栏底部「设置」那一行的右侧有一个图标按钮（就是 DSH Desktop 自己放「连接移动设备」
图标的位置），点开是全屏面板：

| 操作 | 说明 |
|---|---|
| 打开使用 | 运行已发布版本（沙箱 iframe）；进去之后还能换到另外三个地方跑，见下 |
| 继续迭代 | 物化工作副本，把「源码绝对路径 + 要求」复制到剪贴板，粘贴给任意会话即可继续改 |
| 发布 | 工作副本 → 线上版本；运行页会在同一个动作里刷新元数据并重挂 iframe |
| 重命名 / 删除 | 删除会同时带走工作副本目录与快照文件 |
| 导入小程序 | 把你已经写好的 HTML 托管进来（先校验，再入库） |

### 小程序模式与模板

在**空白会话**的输入框上多两个座位：输入框上方一枚「小程序」chip，输入框下方一条
模板面板。

- **挑一个模板**：面板按意图分五类（计个时 / 记点事 / 算个数 / 帮我想 / 看着玩），
  共 12 个，**瀑布流四列** —— 卡片高度各自随内容，不强行对齐成格子。
  每张卡片**本身就是预览**：打开面板就能看见它们各自在跑，不需要先把指针移上去，
  而且预览的高度是**按模板内容真实量出来的**，不是一个固定比例的裁切框。
- **选中的动作是「把话说进输入框」**：模板自带的描述被写进 composer，光标落在末尾。
  你可以直接回车，也可以先改成你想要的样子 —— 它是一句可编辑的草稿，不是一次静默发送。
- **选中之后还多一个「直接创建」**：不经过模型，拿模板自己的正文直接建一个小程序
  （建好即发布，打开面板就能用）。这条路的读者是"我就要这个"的人 —— 交给模型只会重造一遍，
  而正文里刻意留的缺口也会丢掉。想改一改再让 AI 做的人走上面那条，两条路互不影响。
- **hero 上那枚 chip 是模式开关**：名字**永远是「小程序」**，点一下选中、再点一下退出。
  选中不加"模式"两个字，也不加关闭叉 —— 它是一枚状态标记，不是"关掉某个东西"的按钮；
  "再点一下会退出"由 `title`/`aria-label` 说明。选中长什么样**由 DSH 决定**（见下）。
- **输入框旁边那一格显示「你选了什么」**：选中一个模板后，那里出现 `🍅 番茄钟 ✕`，
  按 ✕ 取消选择（输入框里已经写好的字不动 —— 它已经是你的草稿了）。
  它与 hero 上的模式开关分工不同，这是照 `dsh-ppt` 的做法：模式开关只在 hero，
  输入框旁边留给"当前选择"。

面板的版式也照 `dsh-ppt`：**它自己不画底**（透明、无边框、无阴影、无圆角），视觉重量全部
落在卡片上；宽度取自 DSH 的 `--dsh-composer-card-max-width` 与 `--dsh-composer-side-clearance`
两个变量，于是它的左右边缘和输入框卡片**逐像素对齐**（实测：卡片 712px ↔ 面板 712px），
而不是一个写死的 760。这个宽度以前就写死过，表现是面板比输入框宽出 32px。

模板不是"省打字的快捷键"，是**给不知道该要什么的人看的橱窗**。所以每条模板都遵守一条
产品规则而不是工程规则：

> 做到七分好，在明显的地方留一个缺口。

番茄钟固定 25/5 分钟不能调、待办清单没有优先级、随机抽签是有放回的 —— 缺口都写在一句
克制的注释里（`lib/templates.js` 里搜「模板在这里留白」），用户用两下就会撞上，但不会崩、
不会半残。**这样做的目的是让"接下来让 AI 改"成为自然的下一步，而不是让模板自己就是终点。**

### 同一个小程序，四个地方跑

运行页工具栏上有三枚「换个地方打开」。四个位置**复用同一个运行页组件**（同一份沙箱串、同一个 `src=…/serve/{id}`），所以不会有两个 iframe 在跑同一份东西：

| 位置 | 是什么 | 约束 |
|---|---|---|
| 弹窗浮层 | 全屏浮层，默认那条路 | 盖住整个窗口 |
| 浏览器新标签 | `…/serve/{id}` | 在外面，与 DSH 无关 |
| **本会话页签** | 会话头部那一排页签（对话 / 轨迹 / **小程序**）里的一格，占满会话区宽度 | 只在**有内容的会话**里出现 —— 空白会话的头部是隐藏的 |
| **右侧抽屉** | 贴窗口右边、通高的浮层 | 不挤压会话（它是浮层，不是布局列） |
| **会话右上角浮窗** | 一块 380×420 的浮窗，锚在**会话区**右上角 | 靠 `position: fixed` + 量坐标定位，会话区几何前后不变（实测 1232px → 1232px） |

三个浮层（全屏 / 抽屉 / 右上角）**同一时刻最多一个**；会话页签不受这个约束，它是会话主体。

**切换页签这件事为什么要"替用户点一下"**：DSH 的页签高亮与身体都取自会话 store 的 `view` 字段，而写它的只有 `setView` / `openView` —— 它们只从 `conversation.session.header` 子座位的 `selectView` 进入，而**那个座位渲染子项时给的是空 props**，插件拿不到。内部服务那条路（`uiConversation.binding(id).activate(view)`）也没用：它落到 `activateTarget()`，只在目标**注册过快照 builder** 时才 `replaceView`，chat / trajectory 注册过、我们没有，于是它只是往 `activeTargets` 里加个名字就返回。所以 `focusSessionViewTab()` 的做法是：按 label 文字找到我们自己那一颗 `role="tab"`（DSH 没给它任何 data-* 标识），没选中就 `.click()` 它 —— 页签自己的 onClick 走的是 DSH 的 `selectView`，那才是真的会写 store 的路径。找不到页签就返回 false，由调用方**明说**「点会话头部的页签切过去」，不静默。

### 导入

粘贴 HTML 或选一个 `.html` 文件 → 「校验」→ 看报告 → 「导入」。

报告按 `fatal / autofix / warning` 三档分组，每条规则都会告诉你**为什么**、**怎么改**。
有一条规则可以自动修（缺少 `html`/`body` 外壳的片段会被包成完整文档），其余都不改写你的文件。
有 `fatal` 时导入会被拒绝，并给出「复制改造提示词」——把它粘给任意会话，让 Agent 改写后再导回来。

---

## 模型可见的工具

| 工具 | 作用 |
|---|---|
| `miniapp_create` | 建一个小程序（可带初始 HTML） |
| `miniapp_list` | 列出全部小程序（含「有未发布改动」） |
| `miniapp_get` | 读一个小程序的元数据与源码路径 |
| `miniapp_iterate` | 物化工作副本，准备继续迭代（幂等） |
| `miniapp_read_source` | **读源码全文**（迭代的唯一读入口） |
| `miniapp_write_source` | **写源码全文**（整份替换；迭代的唯一写入口） |
| `miniapp_publish` | 工作副本 → 线上版本（四道闸） |
| `miniapp_delete` | 删除小程序（不可恢复） |
| `miniapp_validate` | 检查一个 HTML 文件能不能导入（不写入） |
| `miniapp_import` | 校验并导入一个 HTML 文件 |

工具调用的参数与结果都会进会话日志，因此模型可见的一切都可从日志重建。

`miniapp_read_source` / `miniapp_write_source` **只接受 `miniapp_id`**，路径由插件从 id 自己派生，
从不接受调用方给的路径 —— 所以它们不构成任意文件读写的能力。
`miniapp_validate` / `miniapp_import` 是唯一接受路径的工具，因此它们把路径**限制在会话工作区内**，
且没有可解析工作区的会话一律 fail closed。

---

## 架构

```
{DSH_HOME}/miniapp/
  index.json                  库索引（元数据；永不含 HTML 正文）
  apps/{id}/working.html      工作副本 —— Agent 编辑的地方
  snapshots/{id}.html         已发布快照 —— 运行页直出的唯一来源
```

代码是六个文件，边界按"谁能独自验证"划分：

| 文件 | 是什么 | 依赖 |
|---|---|---|
| `lib/store.js` | 两层存储、索引、发布四道闸 | 只有 `node:fs`，不依赖宿主 |
| `lib/validate.js` | 12 条导入规则的判定 | 无 |
| `lib/templates.js` | 橱窗：12 个模板的正文与一句话描述 | 无（纯静态数据） |
| `lib/index.js` | 宿主机：10 个工具 + HTTP 路由（库 API、直出通道、模板目录） | 宿主 ctx |
| `lib/client.js` | 客户端：全屏面板 + 三个 composer 座位 + 侧栏入口 | 只 `require("react")` |
| `test/visual/sidebar-geometry.html` | 侧栏那条几何的可重拍照片 | 无 |

### 两层存储，物理分离

快照与工作副本**分处两棵目录树**，这不是洁癖：

- 工作副本是 Agent 每一轮都在改写的地方，也是唯一可能被整目录清掉的地方
  （换工作区、手工清理、一次失败的批量删除）。
- 线上版本必须活过它的编辑现场。清掉 `apps/{id}/`，运行页照常可用；再点「继续迭代」，
  工作副本会从快照自愈回来。

原版把快照放进 SQLite 也是同一个理由，这里换成了另一个目录。

### 未发布标记是派生的，不是存的

`has_unpublished_changes` 每次读取时由「工作副本 mtime 是否严格大于发布时间」算出。
存一个布尔值会在 Agent 写下文件的瞬间就过期。

- `(有工作副本, 没盖过章)` → **算未发布**（安全的失败方向）
- 空工作副本 + 从未发布 → 不算未发布（刚建还没写，「有未发布改动」会是一句用户无法处理的谎）

### 发布四道闸

`publish` 会依次拒绝：**没有工作副本**（400，这是用户可以自己修的状态）、
**读取期间被改写**（读前读后各 stat 一次；没有任何东西给工作副本的写入排序，
shell 的 `> working.html` 是先截断再写）、**非 UTF-8**、**看起来不是 HTML 文档**。

第四道闸是关键：否则一轮出错的会话留下的计划稿、笔记或堆栈就会覆盖掉正在用的工具，
而这里**没有上一版可以回退**。

### 沙箱与 capability URL

运行页的 iframe：

```
sandbox="allow-scripts allow-forms allow-popups allow-modals"
CSP: sandbox allow-scripts allow-forms allow-popups allow-modals; frame-ancestors 'self'
```

**刻意不给 `allow-same-origin`。** `allow-scripts` 与 `allow-same-origin` 同时给出等于取消沙箱：
文档是生成出来的代码，一旦拿到同源就能读到 harness 的 origin、会话 cookie 和存储。
代价是沙箱里的存储 API 可能抛错 —— 所以构建契约要求每个小程序把存储读写包进 `try/catch`。

沙箱同时也写在**响应头**上，而不只写在 iframe 属性上：直接导航到 `/serve/{id}`，
或者被一段我们控制不了的标记框住，都必须同样是沙箱的。

直出通道 `/plugins/dsh-miniapp/serve/{id}` **不要求 Origin**（iframe 子资源请求不带信任头），
防护是不可猜测的 UUIDv7，与 NomiFun 原版把 `/serve` 做成免鉴权是同一个判断。
未发布或不存在一律是**干净的 404**，绝不是 401/403 —— 后者会暴露「路由存在但被守着」。

写接口则相反：必须是同源的 loopback Origin，跨站页面驱动不了这个 API。

---

## 与 DSH 文件沙箱的适配（移植中最重要的一处差异）

NomiFun 原版把工作副本的**绝对路径**交给会话，让 Agent 用普通的文件工具去改。这在桌面端成立，
因为那边**每个会话的文件权限都是 `PathAuthority::Unrestricted`**（原版自己在 v2 规格 §10 里
把这一点记为已知问题）。

**DSH 不是这样。** DSH 有真正的文件沙箱：

```js
// @deepseek-ai/dsh-sandbox
function writableRoots(policy) {
  if (policy.mode !== "workspace-write") return []
  return [...new Set([policy.workspaceRoot, "/tmp", tmpdir()].map(canonicalPath))]
}
```

`workspace-write` 的可写根**只有三个**：会话工作区、`/tmp`、系统临时目录 ——
**没有任何插件可注册自己数据根的扩展点**。而小程序的工作副本在 `{DSH_HOME}/miniapp/` 下，
位于每个会话工作区之外。

这不是推测。第一次真实端到端跑（headless profile，默认 `workspace-write`）就撞上了：

```
write → 失败：file access denied under workspace-write mode
```

那个 Agent 的表现是对的：它没有用 bash 绕过去，也没有把陈旧的占位页当成新版本发布，
而是如实报告并停下。

**因此本移植把"直接改文件"换成了两条插件工具：**

| 原版 | 这里 | 为什么 |
|---|---|---|
| `read` 读绝对路径 | `miniapp_read_source(id)` | 路径由 id 派生，不经过会话文件沙箱 |
| `write`/`edit` 写绝对路径 | `miniapp_write_source(id, html)` | 同上；写的是插件自己的数据目录 |

代价与收益：

- **代价**：`miniapp_write_source` 是整份替换，不能像 `edit` 那样做局部 diff。
  大文件的 token 成本更高。
- **收益**：不依赖用户把会话开到 `danger-full-access`；而且因为工具**从不接受调用方给的路径**，
  它比"把绝对路径交给 Agent"**更安全**，不是更不安全。

如果你确实想在某个会话里用普通 `read`/`write` 直接改源码（例如做精细 diff），
把那个会话的策略设成 `danger-full-access` 即可 —— `miniapp_iterate` 返回的 `source_path` 就是可用路径。

---

## 与 NomiFun 原版的差异

| 原版 | 这里 | 原因 |
|---|---|---|
| 路由 `/api/miniapps/*` | `/plugins/dsh-miniapp/*` | DSH 的单条前缀路由，不与别的插件抢精确路径 |
| 免鉴权 serve | 同样的免鉴权 serve | iframe 子资源不带信任头，加鉴权就渲染不出来 |
| SQLite `miniapps` 表 | `index.json` + 两个目录树 | 人类手工维护的库，可 diff、可备份，不需要数据库 |
| 「继续迭代」新开一个普通会话 | 复制一段迭代指令到剪贴板 | DSH 插件没有建会话的直连 API，粘贴是唯一不骗人的做法 |
| 用普通文件工具改绝对路径 | `miniapp_read_source` / `miniapp_write_source` | DSH 的文件沙箱不允许写工作区之外的路径（见上一节） |
| 预览面板「发布为小程序」 | 库面板「导入」+ 工具 `miniapp_import` | DSH 里没有「会话预览的当前文件」这个位置 |
| 目录导入（读 `index.html`） | **不支持**，只收单文件 | 见下 |
| 会话 `extra.miniapp` 标记 | 不需要 | 构建契约随 `miniapp_create` 的工具结果下发，只被真正要建小程序的会话看到 |
| 13 条导入规则 | 12 条 | `no_root_document` 是目录导入规则，本版不做目录导入 |
| 「创建小程序」→ 建新会话 + `extra.system_prompt` | 同一个会话里就地建 | DSH 的会话创建没有 `extra` / `systemPrompt` 字段，而且这里也不需要：契约在工具描述里 |

### 原版的创建流程为什么搬不过来（也不需要搬）

原版点「创建小程序」其实**什么都不创建** —— 它只把 `miniAppMode` 置位，于是三件事变了：
chip 变成「小程序模式」、placeholder 换成「描述你想要的小程序…」、发送时的路由改道。
真正的动作发生在**发送之后**：`POST /api/conversations` 建会话 → `sessionStorage` 交接 → 跳转 →
第二个请求才把第一条消息发出去（带 `X-Nomifun-Initial-Delivery: 1`）。注入构建契约的那两个字段
（`extra.system_prompt` 的六条 builder 规则、`extra.miniapp`）是**建会话时写死的、会持久化的**，
所以原版**无法在已经存在的会话里进入这个模式**。

DSH 上这套三分法没有必要：构建契约现在挂在 `miniapp_create` 的工具描述上，模型只在自己真的要
建小程序时才看到它。于是"小程序模式"退化成一个**纯客户端引导**（chip + placeholder + 模板面板），
工作就在当前会话里发生 —— 不需要标记、不需要 `extra`、不需要为此开一个新会话。

### 为什么规则清单是 12 条而不是 13

原版的 `no_root_document`（文件夹里找不到入口页面）只在目录导入时可能发出。
本版只支持单文件导入，那条规则**没有任何代码路径能产生它**，所以它不在清单里。
清单被一个双向测试钉死：既能发出的必须在清单内，清单内的必须能被触发 ——
否则清单描述的是意图而不是行为。客户端的文案表已经保留了这条，等哪天真做目录导入再加回来。

---

## UI 与原版的一致性

界面不是"看起来差不多"，而是逐项抄自 `nomifun-desktop` 的
`pages/miniApps/index.tsx` / `RunnerPage.tsx` / `MiniAppFrame.tsx`。
尺寸、圆角、间距、悬停行为都按原值；只把 Arco 的 `--color-*` / `primary-6`
换成 DSH 的 `--dsw-alias-*`（原版大量使用的 `rgba(var(--primary-6), 0.12)`
这类半透明层，用 `color-mix` 表达同一个意思）。

**库页面**

| 元素 | 规格 |
|---|---|
| 页面标题 / 副标题 | 22px/600；副标题 13px/19px，最宽 560px |
| 工具行 | 搜索框 200px 宽 + 「导入小程序」+「创建小程序」，**仅在无错误且有内容时出现** |
| 卡片 | **横向**布局：44×44 图标块（12 圆角）+ 内容列；14 内边距 / 14 圆角 / 12 间距 |
| 卡片悬停 | 边框加深 + `0 12px 30px rgba(0,0,0,.12)` + 上移 2px |
| 卡片标题行 | 15px/600 名称 + 未发布胶囊（10px/600，`rounded-full`，warning 12% 底色）并排 |
| 描述 | 12px/17px，最多 2 行 |
| 卡片底行 | 左「更新于 …」11px；右「打开使用 →」常驻（24px 高、8 圆角、primary 10% 底 + 32% 边） |
| 悬停动作 | 右上角 26×26 图标按钮（迭代 / 重命名 / 删除），`opacity` 切换，图标带 `title` + `aria-label`，键盘可达 |
| 网格 | `repeat(auto-fill, minmax(min(280px, 100%), 1fr))`，gap 14px |
| 空态 | 72×72 圆形图标容器 + 15px/600 标题 + 13px 说明（最宽 460）+「去创建」「导入小程序」 |

**运行页**

| 元素 | 规格 |
|---|---|
| 工具栏 | 52px 高 / 16px 内边距 / 10px 间距，底边框 |
| 工具栏左 | 返回（32×32）+ 28×28 图标块（primary 12% 底）+ 15px/700 名称 |
| 工具栏右 | 「发布」与「继续迭代」带文字（26px 迷你按钮），其余为 32×32 图标：刷新 / 浏览器打开 / 重命名 / 删除（危险色） |
| 未发布横幅 | warning 8% 底 + 底边框；标签 12px/600 warning 色 + 说明 12px/18px |
| 主体 | 全幅沙箱 iframe |
| 加载看护 | 底部贴边 12px 的条：10 圆角、8×12 内边距、阴影；「重试」「在浏览器中打开」+ 忽略 |

**模板面板**（照 `dsh-ppt` 的模板面板规格：分类 tab + 卡片网格 + 三态兜底）

| 元素 | 规格 |
|---|---|
| 分类 tab | 逐项照抄 `dsh-ppt` 的 `.…_categoryTabs`：胶囊形（999 圆角）、`5px 10px`、11px；未选中 `label-caption`，悬停只提亮文字，选中是**半透明灰底**（`interactive-bg-hover`）+ `label-primary`，**不加粗、不上色**（它标记"当前筛选"，彩色留给真正的动作）。`role="tablist"` / `role="tab"` / `aria-selected` 不变；只渲染**非空**的分类 |
| 模式 chip | 名字恒为「小程序」；选中态**不写内联样式**，只挂 `data-selected` —— 样子由 DSH 在 hero 模式行上的那两条 `!important` 规则画（见「四个 DSH 契约上的坑」） |
| 面板本体 | **不上底**：透明、无边框、无阴影、无圆角；宽度 = 输入框卡片宽度（DSH 的两个 composer 变量） |
| 瀑布流 | CSS 多列 `columns: 4` + `column-gap: 14px`；卡片 `break-inside: avoid`（分片规则只对块级盒子生效，所以卡片还得是 `display: block`）。列宽公式 `floor((gridWidth - gap × (n-1)) / n)` 随 `PANEL_COLUMNS` 走，**它不能改**，因为预览的缩放系数必须等于真实列宽 |
| 卡片 | 有面的瓦片：`bg-layer-1` + 1px 描边 + 12 圆角 + 8 内边距；内容是「预览 / 名字 / 一句描述（两行截断）」。悬停描边加深 + 上移 1px，选中换 `brand` 描边 |
| 预览框 | 与实际运行页同一套沙箱串；iframe 按 **480 逻辑宽**渲染，按真实内容高度缩放（见下），预览边框**恒为 2px 透明**，选中只换颜色 —— 点一下不会把周围挤动一格 |
| 预览高度 | **按内容量出来的**：预览文档里注入一段只量高度的脚本，`postMessage` 回报 `scrollHeight`，卡片夹到 96–320px 之间；量不到就退回 16:10。实测 `显示高度 = 逻辑高度 × scale` 逐张成立 |
| 预览的开关 | 由**在不在可视区**决定，不是悬停：看得见的卡全部在跑，滚出去的立刻停。实测可视区六张 = 六个活 iframe，滚到底换成另外六个 |
| 空态 | 加载中 / 加载失败（带「重新加载」）/ 该分类为空，三种都是文字，不是空白 |
| 选中动作 | `props.inputActions.setDraft(描述)` —— 写进输入框、光标落末尾；这个 DSH 版本没有这个能力时降级为复制到剪贴板并明说 |
| 直接创建 | 选中后工具栏右侧出现；宿主侧只走 `POST /apps`（带 `html` 即建好即发布），**不发 publish、不碰输入框** |

**原版把模式做得更重**（换 placeholder、改发送路由），这里只做到能做的部分：
`InputActions` 只公开了 `setDraft / addImages / removeImage / pruneImages / submit`，
**没有**换 placeholder 的通道，所以输入框的提示语仍是 DSH 自己的那句。模式由 hero 上的 chip
和展开的面板表达，不靠 placeholder。

**侧栏入口**

侧栏入口**没有走槽位**，这是全插件唯一一处刻意的例外，理由和做法都值得记下来：

- `sidebar.settings` 是 `kind: "single"`，全 DSH 只有一个占位者（`dsh-client-ui-settings-general`），
  它的 `replaceRisk` 是 `shadows-shipped-ui` —— 往那里注册第二行会**替换掉设置按钮本身**。
- 于是走 DSH Desktop 自己的那条路：往 `[data-dsh-sidebar-settings]` 里 `appendChild` 一个按钮，
  用绝对定位挤进设置那一行。Desktop 的「连接移动设备」按钮（`#dsh-desktop-mobile-button`）
  就是这么做的，而且这个属性是 `dsh-client-ui-sidebar` 有意放在 DOM 上的。

几何是耦合的，所以三个数字必须一起读：

| 数字 | 含义 |
|---|---|
| 手机按钮 `right:0` | Desktop 自己占掉 38px 的槽位（32px 按钮 + 6px 间隙） |
| 我们 `right:38px` | 于是我们排在它左边，两个按钮不重叠 |
| 设置行 `padding-right:76px` | 这一行得同时容下两个按钮 |

`[data-dsh-sidebar-settings]` 在 CSS 里**写了两遍**：Desktop 的 preload 也写了同一个选择器
（特异度 `(0,3,0)`），而我们的 `<style>` 不保证排在它后面 —— 重复一遍把特异度顶到 `(0,4,0)`，
由特异度而不是文档顺序决定谁赢。页面上没有手机按钮时（`:has()` 兜底）退回一个按钮的位置。

折叠成 56px 轨道时按钮改成竖排（`flex-direction:column`，`margin-top:5px`），此时它**不隐藏** ——
手机按钮在未连接时会隐藏自己，但小程序入口不该因为侧栏窄了就消失。

侧栏折叠/展开、设置面板开合都会让 React 重建那棵子树、把我们的按钮连带摘掉，所以挂了一个
debounce 过的 `MutationObserver` 自愈；同时保留 `sidebar.footer.action` 上的一个兜底座位，
只在注入没成功时才渲染（否则会出现两个入口）。

`test/visual/sidebar-geometry.html` 是这条几何的**可重新拍的照片**：把三方 CSS 原样摆在一起，
截一张图回答「会不会压到 / 会不会错位 / 轨道里排得下吗」。重新生成的命令写在文件头注释里。

**三处刻意的差异**（DSH 里没有对应位置，已在「与 NomiFun 原版的差异」里说明）：
原版「创建小程序」跳启动页的小程序模式，这里库页面改成复制一段同义的创建提示词
（composer 上那个 chip 才是模式开关，见上一节）；面板多一个关闭按钮
（原版是独立路由页面，不需要返回上一层的出口）；侧栏入口走 DOM 注入而不是槽位（理由见上）。

`test/client.test.mjs` 里有一条**尺寸回归测试**：把上表里每个数字从源码里逐条找出来，
谁顺手改一个圆角、间距或字号，测试就失败。这些值没有类型能保护，
不写死一条测试，"和原版一致"会在几次改动后悄悄失真。

## 已知限制

- **不支持目录导入**：一个文件夹里的 CSS/JS 也加载不到（直出通道只给一个文档），
  所以拿文件夹导入几乎必然撞在 `local_ref_unsupported` 上。
- **发布没有撤销**：`publish` 覆盖唯一的线上快照，没有「回滚上一版」。
  后端做到了「拒绝半个文档 / 非文档」即「不会悄悄变坏」，但「变坏之后能退回去」缺失。
- **看不到工作副本**：面板里没有预览工作副本的入口；要看只能等发布，或者读那个文件。
- **未发布标记依赖毫秒级 mtime**：在 mtime 分辨率只有 1–2 秒的文件系统上
  （部分 FAT/exFAT、网络挂载），「发布后同一秒内的编辑」会被读作已发布。
- **隧道访问下 iframe 会被拒**：DSH 的远程配对/隧道通道给自己的响应加了
  `x-frame-options: DENY`，那种访问方式下运行页框不出来。本地 Web UI 不受影响。
- **`miniapp_write_source` 是整份替换**：不能做局部 diff，大文件 token 成本高（见沙箱一节）。
- **测试覆盖率**：全部 12 条导入规则、发布四道闸、两层存储、路径公式、HTTP 契约、
  工具输出 schema、导入路径边界、客户端槽位与文案对称都有测试（105 条）；
  **UI 交互（面板点击流）没有自动化测试**，只到「组件渲染出正确的 DOM 契约」这一层。
- **四列意味着卡片很小**：面板只有输入框那么宽（约 712px），四列之后每张卡约 167px，
  预览里的字基本看不清、只剩轮廓。这是"四列"的直接代价，不是 bug。想要既四列又看得清，
  得把模板广场挪进全屏浮层（那里才有四列大卡片的空间）。
- **瀑布流的高度是"后到"的**：卡片先按 16:10 兜底画出来，量到真实高度后再变。由于用的是
  CSS 多列 + `column-fill: balance`，高度到齐时整列会重新平衡 —— 首屏几百毫秒内卡片可能
  从一列挪到另一列。这是纯 CSS 瀑布流 + 异步量高的固有代价；要消掉它得把 12 个模板的高度
  预先烘进目录（`lib/templates.js` 里每条加一个 `preview.height`），那是下一步。
- **面板的可视高度由会话区决定**：模板面板挂在输入框下方，高度只能长到会话滚动区的底边。
  窗口矮的时候一屏只看得到一行多卡片（1512×957 下能看到约两行）。要一个真正的"模板广场"，
  得把它放进全屏浮层，而不是 composer 下方。
- **composer 那条路不带骨架**：选一个模板，进 composer 的只有它的**描述**；模型据此从零写
  一个小程序，而不是改我们那份"七分好"的骨架。所以想保住模板的缺口，要走「直接创建」
  （见「后续方向」第 4 条），或者选中之后自己把那句话改具体一点。
- **模板预览会真的执行模板里的 JS**：预览是真 iframe（同一套沙箱串），不是截图。
  可视区里的卡片**全部**在跑，所以同一时刻活着的 iframe 有六到九个；
  靠"滚出视口即停"把总量框住，但没有拦 `alert` 之类的措施。

---

## 开发

```bash
# 核心逻辑（存储 + 校验），不依赖宿主
node --test test/smoke.test.mjs

# 宿主半边集成：假 ctx 调真正的 apply()，跑工具与 HTTP 端点
node --test test/host.test.mjs

# 客户端半边：vm 里求值 client.js，验证槽位/沙箱串/文案对称/DOM 注入
node --test test/client.test.mjs

# 一起跑（当前 105 条）
node --test test/smoke.test.mjs test/host.test.mjs test/client.test.mjs
```

**侧栏那条几何没有单元测试能覆盖**（它一半的分量在别人的 CSS 里）。要看就得把它拍下来：

```bash
C="$HOME/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
"$C" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
     --screenshot=test/visual/sidebar-geometry.png --window-size=1120,400 \
     file://$PWD/test/visual/sidebar-geometry.html
```

`test/visual/sidebar-geometry.html` 把三方 CSS 原样摆在一起（`ui-sidebar` 的
`footArea`/`settingsArea`、`ui-settings-general` 的 `triggerRow`/`trigger`、Desktop preload
的手机按钮样式、以及我们注入的那份），一屏回答四个问题：宽侧栏会不会压到手机按钮、
没有手机按钮时 `:has()` 兜底对不对、折叠轨道里排不排得下、两个图标像不像一家人。

### 真实进程验证（推荐每次改动都跑一次）

假 ctx 覆盖不到的东西，只有真跑才能发现 —— 上面那个沙箱问题就是这么抓到的。
建一个一次性 profile，让 Agent 真的调一遍工具：

```bash
H="${DSH_HOME:-$HOME/.dsh}"
NODE="$H/.desktop-bin/node"
BIN="/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js"

# 1) 建验证 profile 并装入插件
cd "$H/profiles" && "$NODE" "$BIN" plugin --profile miniapp-verify add /path/to/dsh-miniapp-0.1.0.tgz
# 2) 把它配成 headless：bundles 里加上 @deepseek-ai/dsh-headless
# 3) 在 profile 的 cordis.patch.yml 里关掉 hmr（它需要 --expose-internals）
#    - id: hmr
#      disabled: true
# 4) 跑一次真实闭环
cd "$H/profiles/miniapp-verify" && "$NODE" --expose-internals "$BIN" --profile miniapp-verify \
  "调用 miniapp_create 建一个名为 demo 的小程序，再用 miniapp_write_source 写一段 HTML，最后 miniapp_publish。"
```

两个已知的环境坑：
- **HMR 需要 `--expose-internals`**：桌面启动器会加这个标志，直接跑 CLI 不会，所以要么加上，
  要么在 profile 层 `disabled: true`。这与插件无关。
- **peer 依赖不自动装**：`pnpm-workspace.yaml` 里 `autoInstallPeers: false`，
  所以 `pnpm add` 会报 peer 缺失警告 —— 这是预期的，`@deepseek-ai/*` 在运行时由上层解析。

本地开发需要让 `@deepseek-ai/*` 能解析（安装到 profile 后由 pnpm 负责）：

```bash
mkdir -p node_modules/@deepseek-ai
H="${DSH_HOME:-$HOME/.dsh}"
ln -sfn "$H/profiles/node_modules/@deepseek-ai/schemastery" node_modules/@deepseek-ai/schemastery
ln -sfn "$H/profiles/node_modules/@deepseek-ai/dsh-tools"   node_modules/@deepseek-ai/dsh-tools
ln -sfn "$H/profiles/node_modules/@deepseek-ai/cordis"      node_modules/@deepseek-ai/cordis
```

### 四个 DSH 契约上的坑

写的过程中被这几个约束挡过，都记录在源码注释里：

1. **`output.schema` 里不能有 `required`。** 值 schema 编译器以 `allowRequired: false`
   编译每一层，`required: [...]` 直接抛 `UNSUPPORTED_SCHEMA`。注意这**不同于** `parameters`
   —— 那里的 `required: true` 是每个属性的布尔标志。
2. **`type` 不接受数组。** `type: ['string','null']` 匹配不到编译器的任何分支；
   可空字段要写成 `oneOf: [{type:'string'},{type:'null'}]`。

---

3. **客户端文案表必须是扁平的 `"a.b.c"` 键。** DSH 的查找是

   ```js
   const value = locales?.get(localeKey(locale))?.[key]   // 一次直接属性访问
   ```

   ——**没有点分路径解析**。把表写成嵌套对象，`t("actions.open")` 就会一路回退
   （本命名空间 → `common` → 键名本身），最后把**键名画到界面上**。
   表现是按钮上写着 `actions.open`、`openInBrowser`、`publish.action` 这种字样，
   很容易被当成"界面是英文的"。DSH 内置表同样是扁平的（`"ok": "确定"`）。

   本插件的表仍然**嵌套书写**（99 个平铺键没法读），注册前由 `flattenCopy` 拍平。
   `test/client.test.mjs` 里有一条测试把源码中每个 `t("…")` 的键拿去两张表里查，
   所以这类问题不会再漏到界面上。

4. **hero 那一行的按钮外观不归插件管。** DSH 在 hero 的模式行上有两条带 `!important`
   的规则，**两条都被 `.…_heroModeCluster` 限定**（不是全局）：

   ```css
   .…_heroModeCluster button { height:28px; padding:0 8px!important; border:0!important;
     border-radius:8px!important; background:transparent!important;
     color:var(--dsw-alias-label-primary)!important; font-size:13px; font-weight:500 }
   .…_heroModeCluster button[data-selected=true] { background: color-mix(…state-business-primary 10%…)!important;
     color: var(--dsw-alias-state-business-primary)!important }
   ```

   所以在那枚模式 chip 上写内联的边框 / 圆角 / 底色 / 字色**全是死代码**（实测写上去
   也是 `0px none`）。`dsh-ppt` 的模式 chip 坐在同一个座位上，它那套
   `border:1px solid …` / `border-radius:999px` / `padding:7px 13px` 同样不生效。

   结论不是"绕过它"，而是**照做**：挂上 `data-selected`，让 DSH 自己画选中态，
   插件只保留它没管的 `display`/`align-items`。

   > 这一条我第一版写错过：当时的 grep 正则从 `button[data-selected` 开始匹配，
   > 把前面的 `.…_heroModeCluster` 前缀吃掉了，于是误判成"全局规则"。
   > 它**只在 hero 那一行**有效 —— 面板里的分类 tab 够不到它，所以那里的样式是插件说了算。

   顺带两个 token 上的坑（都是实测）：

   - `--dsw-alias-brand-primary` 是 DSH 的**高对比墨水色**（深色 `#f9fafb` / 浅色 `#0f1115`），
     不是强调色；强调色是 `--dsw-alias-state-business-primary`（`#679efe`）。
   - `--dsw-alias-brand-primary-invert` 与它**同值**，不是反面 —— 靠它救不了白底白字。
     画在实心底色上的文字要用 DSH 的按钮级别名：
     `--dsw-alias-button-primary-fill`（底）+ `--dsw-alias-label-primary-foreground`（字），
     这一对在浅色是"近黑底 + 白字"、深色是"近白底 + 近黑字"，两个主题都是高对比。

## 这个插件是怎么验证的

三层测试，加一次真实进程跑：

| 层 | 数量 | 覆盖 |
|---|---:|---|
| 核心逻辑 `test/smoke.test.mjs` | 31 | 12 条规则的双向闭集断言、发布四道闸、两层存储的派生标记、路径公式、损坏索引 fail loud |
| 宿主半边 `test/host.test.mjs` | 26 | 假 ctx 调真 `apply()`、工具与路由注册、HTTP 全端点、**工具返回值必须通过自己声明的 output schema**、导入路径边界、12 个模板自洽（含每份正文通过 `validateImport`、留白注释存在、去注释 ≤6KB） |
| 客户端半边 `test/client.test.mjs` | 48 | `vm` 里求值 client.js：五个槽位注册、**沙箱串与宿主逐字一致**、文案双语对称、`unknown` 兜底、`setDraft` 语义（含"绝不代按回车"）、模板详情队列串行去重、**侧栏 DOM 注入端到端与完整清理**、输入框旁那格显示"选中了什么"、模式 chip 名字恒定与选中态归属、瀑布流列宽公式、预览量高协议的注入与认领/拒绝、主按钮不许写死绝对色值、面板几何与输入框逐像素对齐、四个打开位置（含页签按文字定位与点击、浮窗定位公式与夹取、三浮层互斥）、尺寸回归 |

**为什么必须再跑一次真实进程**：假替身比真货宽容，就会把 bug 放行。这个插件上发生过三次：

1. **文件沙箱**：假 ctx 里没有沙箱，所以"把绝对路径交给会话去写"看起来完全正常；
   在真的 headless 会话里第一次跑就被 `workspace-write` 拒绝。这直接改掉了移植方案
   （见上面「与 DSH 文件沙箱的适配」）。
2. **文案表格式**：客户端契约测试只比对了 zh/en 的键是否对称，没有问"DSH 查得到吗"。
   对称性通过、界面上却全是裸键名 —— 测试测了自己想测的东西，不是真实契约。
3. **响应头顺序**：假 `res` 的 `removeHeader` 写成了无条件的 `delete`，于是
   `writeHead()` 之后再 `removeHeader()` —— 真 Node 会抛 `ERR_HTTP_HEADERS_SENT`、
   socket 被直接掐断、curl 报 "Empty reply from server" —— 在测试里一路绿灯。
   现在假 `res` 会像真的一样抛错，并且会跟踪 `headersSent`。

### 当前验证状态

| 项 | 怎么验的 | 结果 |
|---|---|---|
| 核心逻辑 | 31 条单元测试 | ✅ |
| 宿主半边（工具 + 路由） | 26 条集成测试，并在 headless 真实进程里跑通 `create → read_source → write_source → publish` 全闭环 | ✅ |
| 12 个模板 | 26 条里的 5 条结构断言；另用 headless Chrome **在逐字复刻 serve 通道 CSP 头的 opaque origin 沙箱里**逐个真跑（`window.origin === null`、`localStorage` 抛 `SecurityError`），12 个全部正常工作、零报错 | ✅ |
| 客户端契约 | 48 条 `vm` 测试 | ✅ |
| **web 组合下的完整装载** | 独立 web 实例（另一个端口）：首页 boot 图里含 `{"id":"dsh-miniapp","url":"/plugins/??dsh-miniapp/client.js&rev=…"}`；该 URL 返回 200 / 58536 字节 / `text/javascript` 且内容是本插件；库 API 与沙箱直出通道实测通过 | ✅ |
| 浏览器里点一遍 | 用户重启 web profile 后确认：侧栏出现「小程序」入口，点开可见「示例 · 番茄钟」 | ✅ |
| 文案在真实 bundle 上可取到 | 独立实例：拉取 combo bundle 后在 `vm` 里复刻 DSH 的 `lookup`，10 个探针键在 `zh` 下全部命中中文 | ✅ |
| 侧栏入口几何 | `test/visual/sidebar-geometry.html` 截图（宽侧栏 / `:has()` 兜底 / 折叠轨道 / 图标对比） | ✅ |
| **小程序模式与模板面板在真机上点一遍** | 需要用户重启 DSH 后人工确认 | ⏳ |

五层全部通过。宿主半边在用户重启后的实际实例（`127.0.0.1:54617`）上复验过：
`api/health`、`api/apps`、`serve/{id}` 三个端点分别返回 200，其中直出通道带
`Content-Security-Policy: sandbox …; frame-ancestors 'self'` 且没有 `X-Frame-Options`。

## 后续方向

按「值不值得做」排序，附上已经探明的接入点，省得下次重新挖：

### 1. 「继续迭代」还原成一键开新会话

原版从库卡片点一下就开一个普通会话，首条消息已经写好；这里是复制一段提示词让用户自己粘贴。
闭环是一样的，但少一次点击。

**接入点已探明**（读 `@deepseek-ai/dsh-api-session-controller` 的生成契约得到）：

```
@Remote('create') create(request: SessionCreateRequest): Promise<SessionCreateValue>
@Remote('prompt') prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>
```

客户端侧通过 `remote.session.<method>(...)` 调用（与 `remote.session.modelCatalog` 同一命名空间），
再导航到新会话。

**没有做的原因**：这三步都压在 DSH 的内部会话 RPC 与客户端路由契约上，
随宿主版本漂移；而且它们只能在浏览器里点着验证，写不进测试。
在一个「已确认可用」的功能上引入无法自动化验证的脆弱依赖，不划算。
真要做的正确姿势是把它做成一个独立的小插件，出错时可以单独停掉。

### 2. 目录导入（恢复第 13 条规则）

原版能选一个文件夹，读其中的 `index.html`。本版只收单个 `.html`。
`lib/validate.js` 的规则清单里已经说明了为什么现在没有 `no_root_document`：
它是目录导入规则，没有代码路径能触发它，而清单被一个双向测试钉死（能发的必须在清单里，
清单里的必须能触发），所以留着一个发不出来的规则就是让清单撒谎。
客户端的文案表已经把这条预留好了，加回导入时补上实现即可。

注意它的实际价值有限：直出通道只给一个文档，同目录的 CSS/JS 都加载不到，
所以文件夹导入几乎必然撞在 `local_ref_unsupported` 上。

### 3. 工作副本的差异预览

面板现在是「有未发布改动」一个徽标，看不到改了什么。要真正解决需要一份快照历史
（至少保留上一版 + 一步回滚），这是存储格式的改动。

原版也没有这个能力，v2 规格把它列在自己的已知限制里。

### 4. 模板骨架随行 —— 已经用「直接创建」实现了（记录取舍）

产品设计里有一条规则：**模板的 HTML 应当随行，好让模型改而不是重造。** 交付时它没实现：
composer 里只有模板那句话，模型看不到我们那份骨架，于是模板精心留的"缺口"未必出现在结果里。

现在用第二条路实现了（工具栏上的「直接创建」）：**完全不过模型**，宿主拿模板正文建一个小程序，
用户立刻得到一个能跑的东西，再用「继续迭代」把真正的骨架交给 AI 改。

- 为什么不是第一条路（`miniapp_create` 加 `template_id`）：那要求模型**可靠地知道**模板 id，
  可靠的做法只能是把一个技术 id 塞进那句用户可编辑的话里 —— 为了"让 AI 改我们的代码"
  而牺牲"那句话读起来像人话"，不划算。
- 代价是面板多了一条创建路径，得把分工讲清楚：**点卡片 = 让 AI 照这句话做；「直接创建」 = 就要这个。**
  两条路互不影响（互不写对方的槽位，测试里各有一条断言钉住）。

### 5. 明确不做的

- **发布撤销**：与第 3 条同源。当前只做到「不会悄悄变坏」（`publish` 拒绝半个文档与非文档内容），
  「变坏之后能退回去」仍然缺失。原版同样缺失。
- **小程序的宿主 API**：原版的小程序是被沙箱彻底隔离的静态文档，没有 `postMessage`、
  没有存储、没有平台调用。这里保持一致 —— 一旦要给小程序开宿主能力，
  那就是一套全新的消息协议与权限模型，不该顺手塞进这个插件。

## 配置

`cordis.patch.yml` 一行装载，全部可调参数在该行的 `config` 下：

| 键 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `{DSH_HOME}/miniapp` | 索引 + 两个目录树的位置 |
| `showSidebarEntry` | `true` | 是否显示侧栏底部入口 |
| `watchdogMs` | `6000` | 运行页判定 iframe 卡住的宽限毫秒数 |

---

## 许可

MIT。功能设计来自 Apache-2.0 的 [nomifun-desktop](https://github.com/nomifun/nomifun-desktop)。
