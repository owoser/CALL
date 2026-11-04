# 更新日志

完整历史与每个版本的发布包见 **<https://github.com/owoser/CALL/releases>**，逐条变更见仓库根目录的 [CHANGELOG.md](https://github.com/owoser/CALL/blob/main/CHANGELOG.md)。

## 如何更新

1. 到 <https://github.com/owoser/CALL/releases/latest> 下载最新的 `CALL-<版本>.zip`；
2. 解压覆盖 `plugins/CALL` 中的程序文件；
3. **保留 `plugins/CALL/userdata`**（配置、玩家设置、已保存的结构都在这里）；
4. 重启服务器。

> 3.x **没有自动更新**（1.x 的 `autoUpdate` 已移除）。

## 版本速览

| 版本 | 主要内容 |
|---|---|
| **3.0.7** | 文档站上线；配置文件路径说明与 docs 校验 |
| 3.0.6 | 大区域撤销可用；失败的撤销不再删除快照 |
| 3.0.5 | 修复"操作静默地从未开始"（撤销快照失败吞掉整个流程） |
| 3.0.4 | 修复大区域清除的偶发失败（区块注册竞态） |
| 3.0.3 | 大区域操作失败（未加载区块）——改用常加载区域租约 |
| 3.0.2 | `/ca clear` 无效并谎报成功（裸方块名被拒） |
| 3.0.1 | 粘贴转置（结构索引轴序）、空气语义、生成形状被传送 |
| 3.0.0 | 修复填充掉线（boss 条越界）、结构解析、命令层重建 |
| 2.0.0 | 移植到 LL3 / LSE 0.22；不再调用会崩溃的 `mc.setStructure` |
