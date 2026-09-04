# Agent Note: 按 Client 就绪状态同步 Inspector Console fixture

Status: implemented

[English](2026-09-04-inspector-console-fixture-readiness.md) | 中文

## 问题

Inspector 集成 fixture 通过 DevTools 连接启用 Runtime，并通过 Worker `parentPort` 发出模拟页面的 `console.log`。两者属于独立通道。`Runtime.enable` 成功响应可以证明 Inspector Worker 已将 Client Console enable 帧加入队列，但不能证明 Client Worker 在通过 `parentPort` 收到 fixture 请求前已处理该帧并安装 Console observer。

完整的十项 Inspector 集成测试文件暴露了这条缺失的顺序边：第一个 DevTools session 可能丢失唯一的 Console 事件，而同一测试单独运行时可以通过。日志发生后再延长等待，无法找回 hook 安装前已经发出的事件。

## 决策

双 session Client Console 集成测试在两个 session 启用 Runtime 后、且要求 fixture 记录日志前，分别在两个已宣布的 Client context 中执行一次无副作用的 `Runtime.evaluate`。[跨 realm Inspector 决策](../architecture/2026-08-23-cross-realm-cdp-inspector.zh.md)所述的 Client Runtime 命令与 Client Console enable 帧使用同一条已认证 source socket。因此，每次成功求值都会在同一 socket 上排在该 session 先前已排队的 Console enable 帧之后。测试在跨到独立 fixture port 前断言两次求值结果。

Fixture 仍只发出一次外部 Console 调用，现有断言仍要求两个 session 都收到该事件、保留不同的 object id、拒绝跨 session 查找，并在释放其中一个 session 时不使另一个失效。这项同步属于测试协调；它不会把 `Runtime.enable` 重新定义为 Client hook 就绪确认。

## 考虑过的替代方案

**延长事件等待时间或增加 sleep。** 拒绝，因为经过一段时间不能证明 Client Worker 已处理 enable 帧，而且 hook 安装前丢失的 Console 事件不会在之后到达。

**重试 fixture 日志。** 拒绝，因为这样会削弱单次调用 fan-out 约定，并可能掩盖第一次事件丢失。

**通过 `Runtime.evaluate` 发出 Console 调用。** 拒绝，因为该测试有意覆盖页面发起的调用通过独立于 Inspector 控制 socket 的通道进入系统。

**在生产协议中增加 Console-enable 确认。** 暂不采用，因为本次修复需要的是确定性的 fixture 初始化，而不是新增一项由 `Runtime.enable` 对任意外部页面操作进行排序的承诺。如果生产消费方需要这项更强的就绪约定，协议必须明确确认 Client hook 已完成安装，并接受单独的实现与兼容性评审。

## 后果

该集成测试按可观察的 Client 工作进行同步，而不依赖调度时机，因此完整测试文件改变 Worker 调度时仍能保持确定性。此测试增加两次有界 Client Runtime 往返，但生产协议保持不变。

该 barrier 依赖 Runtime 与 Console 控制帧继续共用一条有序 source socket。未来若拆分传输，则必须在独立 fixture 日志之前提供另一项明确的就绪信号。本测试不证明 `Runtime.enable` 具备生产级确认约定。
