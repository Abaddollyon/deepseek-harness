# Agent Note: 会话渲染为每帧与每次挂载的开销设定上限

Status: implemented

[English](2026-08-19-conversation-render-cost-bounds.md) | 中文

## Problem

一次针对会话域的渲染审计，在浏览器主线程上测出四处无界开销。

语法高亮是一次同步的 shiki 扫描，没有任何长度上限：高亮一个 20,578 字符的 TSX 文件在单个任务中耗时 **663 ms**，且开销与源文长度成线性关系（本机桌面实测每 1,000 个 TSX 字符约 10 ms）。`CodeBlock` 与 `ReadBlock` 会把调用方给出的任何内容交给 `highlightToHtml`/`highlightLines`，因此一个大代码块或一张大 read 卡片就能让标签页冻结将近一秒。

惰性语法的加载通知此前是一个全局计数器。`CodeBlock` 与 `ReadBlock` 把它当作 `useSyncExternalStore` 快照，因此 23 个惰性语法中任意一个落地，都会让会话中**每一个**已挂载表面的高亮 memo 失效。对真实语料的 82 个代码块重新高亮，每次风暴耗时 **15.5 ms**，一个涉及多种语言的会话会反复付出这笔开销，而每次风暴都落在某个网络分片恰好解析完成的时刻。与无上限的扫描叠加后，一个包含大代码块的会话遭遇风暴的后果是灾难性的。

已定稿消息的元素树只存在于组件实例的 `useMemo` 中，因此每次卸载后再挂载都要从源文重新解析。重新挂载一份 205 块、215,157 字符的语料需要 **293 ms** 的解析与元素构造。

当 `document.elementsFromPoint` 未命中时——jsdom、布局未完成、图片加载中以及快速惯性滚动这几种情况——`ChatView` 的滚动处理器会在单个滚动事件内对**每一个**已挂载锚点行调用 `getBoundingClientRect`：在实测最大的会话上是 O(5,677) 次强制布局。`JsonTree` 为每个实例安装了一个未节流的捕获阶段 `window` 滚动监听器，因此文档中任何一次滚动都会到达每个已挂载的 JSON 表面，并在有行处于 hover 状态时，每实例每事件付出两次强制布局加一次 React 状态更新。`JsonTree` 还会在每次行 hover 时重渲染整棵树：`JsonTreeNode` 未做 memo，且每次父级渲染都会收到新的回调、新的 path 数组和重建的 entries 数组。

## Decision

**高亮设有上限，结果被保留。** `highlight.ts` 新增 `HighlightConfig`，包含 `maxSourceChars`（内置 10,000）与 `cacheEntries`（每种输出形式内置 128）。超过上限时 `highlightToHtml` 与 `highlightLines` 报告「不高亮」，既不分词也不请求语法，调用方绘制它们本就为未知语言准备的等几何纯 `<pre>`。在上限之内，结果按 `(语法 id, 源文)` 保存在最近最少使用缓存中，因此重渲染是一次查表。上限先于语法请求检查是有意为之：超限的表面不应拉取一个它永远不会用到的 637 kB 语法分片。

**语法加载通知按语法分发。** `grammarLoadSource(lang)` 返回按解析后的语法 id 缓存的 subscribe/snapshot 组合（对解析不到语法的语言返回唯一的惰性组合，它们永远不可能获得高亮）。`python` 模块落地只通知 python 表面，不影响其他。该组合在文档生命周期内标识稳定，因此每次渲染都调用它也不会重新订阅。这取代了 `subscribeGrammarLoaded`/`grammarLoadCount`，它们的消费方只有 `CodeBlock` 与 `ReadBlock`。

**定稿 Markdown 渲染跨挂载保留。** `MarkdownText` 新增模块级的定稿元素树最近最少使用缓存，上限为 `MarkdownRenderConfig.settledCacheEntries`（内置 256）。键是 `(text, codeLabels 标识, fileMentions 标识)`：产出的元素捕获了这两个对象的回调——`renderSettled` 会把 `fileMentions.resolve` 处理器烘焙进锚点，这正是流式分支强制 `fileMentions: undefined` 的原因——因此为某个 owner 构建的树绝不能提供给另一个。标识按需铸造并存入 `WeakMap`，因此已消亡会话的 resolver 只是不再命中，其条目随之被淘汰。流式渲染不入缓存；增量解析器已经拥有那条路径，并且是本域中优化得最好的代码。

这是一个 cordis-free 包中的纯渲染缓存，不是 store。禁止模块级句柄的客户端分层规则约束的是 *store*——持有业务状态、并被订阅的事实上的单例。这些缓存持有的是可由输入重新计算的产物，不发布任何东西，也不观察任何东西；`highlight.ts` 的 `HighlighterCore` 单例属于同一类别，也是既有先例。

**两个上限都是部署值，而非常量。** `ui-primitives` 按设计是 cordis-free 的，因此它导出 `configureHighlighting` 与 `configureMarkdownRendering`，各自返回恢复此前取值并在两端丢弃缓存的 disposer。`ui-conversation` 宿主插件新增经校验的 `Config`——`rendering.highlightMaxChars`、`rendering.highlightCacheEntries`、`rendering.markdownCacheEntries`——并将其注册为新的 `ui-conversation-rendering` 设置命名空间的 base 层。浏览器半边绑定该命名空间，并在 `ctx.effect` 中安装已给出的字段，因此销毁时共享模块回到内置取值。

选择设置命名空间是因为没有别的通道：`WebBootEntry`（`packages/client/modules/src/client/manifest.ts`）携带 `id`、`url`、`rev`、`inject` 与 `immediately`——没有逐条目的 `config`——因此今天浏览器半边的插件无法直接接收 cordis.yml 配置。每个字段都是可选的，且 `ui-primitives` 拥有每个省略字段所保持的内置值，因此每个默认值只有一个归属。

**`ChatView` 的锚点查找是对数级的，元素构造做了记忆化。** 逐个测量所有已挂载行的回退路径被换成对锚点行的二分查找：这些行按文档顺序堆叠，因此底边单调递增，第一个抵达滚动视口的行可在 O(log n) 次布局读取内找到。胜出的行与旧的 filter 选出的完全一致。席位列表在一个覆盖席位输入的 `useMemo` 内构建，因此滚动阈值翻转或无关的发布不再为每个已挂载 Node 重建一个元素。轮次起始时间的扫描只在确有轮次运行时执行。

**滚动处理在一帧延迟不可见处节流，在可见处保持同步。** `JsonTree` 的捕获阶段 window 监听器合并进单个 `requestAnimationFrame` 回调，并把复制锚点的位置直接写入元素样式，而不经过 React 状态，因此一次滚动完全不产生渲染。`ChatView` 的处理器保持同步：现代引擎本就最多每帧派发一次 `scroll`，在那里做 rAF 合并几乎不省任何工作，却会给已写明的「读者输入 vs 程序写入」归属协议增加一帧延迟——该协议比较送达的 `scrollTop` 与 `observedTopRef` 台账，并驱动底部跟随。让单事件的工作变便宜才是真正的修复；推迟它是没有实测收益的风险。

**`JsonTree` 的行在 hover 时短路。** `JsonTreeNode` 做了 memo，同一次变更中稳定了所有会破坏短路的东西：`onRowHover`、`setActiveRow` 与 `clearCopyTarget` 是通过 ref 读取实时值的 `useCallback`，每个子节点的 path 数组按 `(path, value)` 派生一次，`entriesOf` 按 value 执行一次而不是按父级渲染执行一次。hover 一行仍会重渲染 `JsonTree` 根节点——复制控件的菜单取决于被 hover 的值——但其下的行不再重跑 `entriesOf` 与递归预览。

## What the owner-prop audit found

审计把「抵达 `ChatNodeSeat` 的 owner props 是否引用稳定」标为未验证，并警告说若不稳定，本域中所有 `memo` 都是死的。**它们是稳定的**，因此上述记忆化确实有效。在 `packages/client/web-react/src/scoped-slots.tsx` 中，owner 对象被展开进组件，因此起作用的是逐值标识而非对象本身：`standardProps` 按 `(host, scope, provide info)` 缓存整套标准 kit，`observableHook` 按 source 缓存每个 hook，`boundRenderSlot`/`boundRenderSlotChain` 按 entry 缓存在 `WeakMap` 中，`localeSeat` 按 `(face, namespace, revision)` 缓存，`cachedSessionInject` 按 `(entry, provide info)` 缓存整个 inject 面。`openFile`、`inspectCall`、`forkAt`、`loadImage`、`fileMentions`、`chatScroll` 与 `loadOlder` 全部经由最后这层缓存抵达。那里无需改动。

`ChatNodeSeat` 的 owner `useMemo` 在依赖数组中列出了 `node` 却没有使用它；现在它改为依赖 Node 是否存在。影响很小——派发用的 `routedOwner` 无论如何都是新的展开对象——但那条依赖会让人误解这个 memo 保护的是什么。

## Testing

`packages/client/ui-primitives/tests/render-cost.client.spec.tsx` 钉住新行为：rust 语法落地时，已挂载的 TypeScript 与 shell 代码块的 `highlightToHtml` 调用次数不变，而 rust 代码块自身取得了高亮；超限的源文被拒绝，`CodeBlock` 渲染纯 `<pre>`；从配置调高上限后同一源文被高亮，disposer 既恢复上限又丢弃更宽上限下产出的结果；对 12,000 字符源文的重复高亮耗时不到冷调用的十分之一；缓存淘汰到上限，取零时不保留任何内容；定稿消息跨卸载与重新挂载只解析一次并产出逐字节相同的 DOM；两个不同的 `codeLabels` 标识分别解析；Markdown 缓存遵守上限并在重新配置时被丢弃；流式渲染永不进入缓存；hover 一个 `JsonTree` 行对兄弟子树的值产生零次属性读取，由计数 `Proxy` 观察（重渲染的行必然经 `entriesOf` 与递归预览再次读取它）。

`packages/client/ui-primitives/tests/read-block.client.spec.tsx` 直接钉住按语法的订阅：ruby 加载只通知 ruby 的 source，TypeScript 的快照不变，也绝不到达未知语言的惰性 source；同一语言始终返回同一个 source 对象。

`packages/client/ui-conversation/tests/chat-view.client.spec.tsx` 钉住滚动查找：在 64 个已挂载行上的一次读者滚动最多测量其中 8 个，且记录的行正是第一个抵达滚动视口的行——与被移除的全量扫描给出的胜者相同。

`packages/client/ui-conversation/tests/host.client.spec.ts` 钉住配置面：部署取值抵达渲染命名空间的 base 层，未设置的部署发布空 section 因而所有内置值成立，上限为零在加载时被拒绝。

## Alternatives considered

**把分词移入 worker 而不是设上限。** 这是结构性修复，规模大得多：worker 需要在每个客户端插件构建中有自己的 bundle 入口、一套承载 2D token runs 的消息协议，以及两个消费方各自的换入路径。上限加结果缓存今天就消除了病态情况，而按语法的加载订阅已经就是 worker 会复用的换入通道，因此 worker 是在此之上落地，而非取而代之。已在两个包的 README 中记为暂缓事项。

**按时间而非按体量限制高亮。** shiki 的 `tokenizeTimeLimit` 是按行而非按调用的，因此无法限制一个 470 行的文件。总时间预算需要分词器可中断，而同步内核并非如此。

**按字节而非条目数缓存高亮 HTML。** 度量每条目保留的 HTML 开销几乎与产出它相当，而条目数与 `maxSourceChars` 组合可以给出部署方能够直接推理的上限。

**只按 text 作为 Markdown 缓存的键，读取时重新绑定处理器。** 键更便宜，但会把一个会话的元素树交给另一个会话的 resolver。正是 owner 标识让缓存的元素可以安全复用。

**对 `ChatView` 的滚动处理器做 rAF 合并。** 这是审计的建议。滚动事件在所有现代引擎中本就与帧对齐，因此合并几乎不省工作，而归属协议依赖把送达位置与每次程序滚动同步写入的台账相比较；推迟这次比较有可能把程序写入误判为读者输入，从而破坏底部跟随。两个合计 2,333 行的测试套件之所以存在，正是因为该协议很微妙。真正的开销是 O(已挂载) 的回退，它已被移除。

**用 `IntersectionObserver` 维护的可见集合替换锚点回退。** 读取次数是 O(可见) 而非 O(log n)，但它会把一个异步的事实来源引入必须同步作答的处理器，还要为每次发布都在变化的列表管理 observer 生命周期。二分查找不需要状态，也不需要新的生命周期。

**滚动时关闭 `JsonTree` 的复制控件而不是重新定位它。** 最省，但用户可见；它需要 UX 负责人拍板，而不是一次性能变更。

**虚拟化聊天流**（审计的 F1）。有意不在范围内：它是一次针对底部跟随、前插锚定与已保存位置恢复的大型架构变更，且另有一条工作线正在缩减会话载荷本身。上面的定稿 Markdown 缓存正是那份记录要求的前置条件——虚拟化器在滚动时会卸载并重新挂载行，若无缓存，这会把一次性的打开开销变成每行进入窗口约 1.3 ms 的重新解析。

## Consequences

高亮一个 20,578 字符的 TSX 文件，从 663 ms 的阻塞工作降到 0.004 ms 的上限检查加一个纯 `<pre>`。对 82 个真实语料代码块的语法加载风暴，从 15.5 ms 降到 0.039 ms——而且对以其他语言书写的表面根本不再发生。重新挂载 205 块语料从 293 ms 降到 16 ms，后者正是 react-dom 自身在两个对照组中都要付出的字符串渲染开销；解析与元素构造已经消失。在 64 个已挂载行上的一次读者滚动测量 8 个盒模型而非 64 个，且该比值随会话长度继续拉大。

用户可见的变化是：超过 10,000 字符的代码表面以等宽纯文本而非高亮渲染。几何、复制行为、行号与 read 卡片的行号槽均不变，因为该回退正是未知语言一直走的那条。想让更大表面获得高亮的部署调高 `rendering.highlightMaxChars`，并接受 README 写明的延迟。

设置读取仅限 loopback（对非 loopback 客户端，`SettingsScopeController` 以 `memory` 模式运行），因此局域网浏览器无论 cordis.yml 如何都使用内置上限。这是设置传输的性质，不是本次变更引入的，而内置值正是今天每个部署得到的取值。

保留内存最多增加 `highlightCacheEntries × maxSourceChars` 的源文及其 HTML，以及 `markdownCacheEntries` 份元素树。两者都按条目数而非字节数设限，因此为超长会话调整它们的部署是在显式做一个内存决策。

`docs/config-catalog.md` 新增了 `ui-conversation` 的配置面，需要与其余 doc-sync 生成器一并重新生成。
