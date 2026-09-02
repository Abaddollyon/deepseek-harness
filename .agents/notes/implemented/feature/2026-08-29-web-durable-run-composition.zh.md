# Agent Note：Web 配置的持久运行组合

状态：已实现

[English](2026-08-29-web-durable-run-composition.md) | 中文

## 问题

持久运行栈（uuid 任务 id + `ctx.jobStore` + 启动对账 + supervisor 工作流所有权）已作为包落地，但没有任何随附组合挂载它：web bundle 的注册表仍只在内存中运行，因此每个后台任务、工作流运行和未读完成通知都会随服务一起消失——包括每次本地部署执行的自重启。

## 决定

`packages/bundle/web-app/cordis.patch.yml` 在宿主平面挂载整条缝：`storage-sqlite` 注册为后端 `sqlite`（DSH home 下单一 `domains.sqlite`），在 `storage-domain` 上加 `routes: { jobs: sqlite }` 覆盖（任务记录以键控行写入更新；其余域继续使用 JSON 整文件重写并保持正确），`jobs-store-domain` 与 `run-supervisor` 使用默认配置，并在 base bundle 的 `jobs` 行上开启 `persist: true`。bundle 中所有权保持 `caller`：把 `tool-workflow` 切到 `supervisor` 是在 profile 补丁层做出的部署选择，加载期守卫同时要求引擎的 `maxRunWallMs` 非零。

## 考虑过的替代方案

- **把所有域都路由到 SQLite**——否决：现有 JSON 后端的域（workspace、feedback、投影缓存）持有本地实时数据；切换介质会让这些数据成为孤儿，而只有 jobs 域需要行粒度写入，得不到持久性收益。
- **在 bundle 中挂载 `ownership: supervisor`**——否决：bundle 将不得不选定一个普适的 `maxRunWallMs`，而这正是 profile 层拥有的随部署变化的可调项；加载期守卫让 profile 侧的切换是安全的。
- **通过第二个后端行使用专用 jobs SQLite 文件**——否决：存储 hub 下单一 `domains.sqlite` 让每个域单元对同一后端注册表及其版本检查可见；按域拆文件徒增文件系统零散度，却没有带来 schema 版本控制尚未提供的隔离。

## 结果

web profile 重启后能找到它留下的每条任务记录：可恢复的被重新收养，其余诚实结清，每个未读完成恰好一条通知。目录随该栈的 Config 字段重新生成。未挂载存储的组合没有任何变化——`persist` 仍是显式选择。
