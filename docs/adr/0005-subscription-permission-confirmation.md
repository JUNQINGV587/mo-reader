# ADR-0005: 订阅扩权先确认再应用

- Status: Accepted
- Date: 2026-11-11
- Deciders: JUNQINGV587, DSH agent
- Issue: [#51](https://github.com/JUNQINGV587/mo-reader/issues/51), [#56](https://github.com/JUNQINGV587/mo-reader/issues/56)

## Context

书源订阅会在 DSH 运行时定时拉取社区源库并自动更新。规则变了，能力也可能变：候选可能新增网站，或给已有网站新增 JavaScript、明文 HTTP、POST 能力。若直接替换活动源，用户会在没有察觉的情况下把新的网络访问和脚本能力交给远端源库。

同时，失败必须保留旧版；用户手动停用的源不能被刷新重新启用；书架上已加入的书和已下载章节不能因上游删源而消失。

## Decision

1. **权限档案按活动源集合汇总、按 origin 分桶**：每个书源取 `bookSourceUrl` 与规则中出现的绝对 URL origin；`js` / `http` / `post` 能力记到具体 origin 上，而不是记成整份订阅的全局能力。只有新增 origin，或给已有 origin 新增能力时才算扩权。
2. **候选先全量校验**：下载并解析完整候选源库；任一条目无效即视为本次更新失败，活动快照不变。
3. **只有扩权才暂停**：新增网站或新增能力时，把候选源库、权限差异和差异计数写入 `subscription.pending`，状态置 `pending`，不写活动 `sources`；旧版继续可用。同站规则修改、删除源等不扩权变化仍原子应用。
4. **待确认期间不重复拉取**：刷新直接返回当前待确认快照，避免候选被连续覆盖；用户确认只应用已保存的候选，拒绝只清 `pending`。
5. **确认写入沿用原子路径**：确认时按候选重新规划差异，保留旧 `enabled`，写失败回滚 sources 并保留旧版与待确认状态。
6. **备份不携带候选**：备份只含活动源与非敏感订阅元数据；待确认状态导出为 `ready`，不把无法处理的半更新恢复到另一台设备。
7. **调度仍走同一把锁**：定时和手动刷新按订阅 id 合并；待确认不阻塞其他订阅。

## Consequences

Positive:

- 远端新增网站或脚本/HTTP/POST 能力不会静默生效。
- 失败保留旧版、停用状态保留、书籍与缓存章节不受删源影响。
- 待确认候选可跨重启恢复并继续确认/拒绝。

Negative:

- 订阅状态多了一个 `pending` 分支，UI、备份和测试都要覆盖。
- 候选规则会临时保存在订阅记录中，体积高于只存活动源。
- 用户确认前不会自动获得新站能力，更新可能停留在旧版。

## Alternatives considered

- **扩权也自动应用**：拒绝，违背“扩权不静默生效”。
- **只提醒不暂停**：拒绝，提醒发生时活动源已经被替换，旧版不再可用。
- **只保存差异而不保存候选**：拒绝，确认时需要重新请求，候选可能已变化，无法保证“确认的是已审内容”。
- **备份连同 pending 一起导出**：拒绝，恢复端没有对应的确认流程，容易形成不可处理的半更新。

## References

- 规格: [#51](https://github.com/JUNQINGV587/mo-reader/issues/51)
- 实施: [#54](https://github.com/JUNQINGV587/mo-reader/issues/54), [#55](https://github.com/JUNQINGV587/mo-reader/issues/55), [#56](https://github.com/JUNQINGV587/mo-reader/issues/56)
