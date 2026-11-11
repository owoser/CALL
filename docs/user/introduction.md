# 插件介绍

&emsp;&emsp;**CALL**（Construct Assistant，建造助手）是面向**基岩版专用服务器（BDS）**的建造辅助插件：在服务器里快速选区、复制、粘贴、填充、生成几何形状，并把作品保存下来。

&emsp;&emsp;本仓库是 [superx101/CALL](https://github.com/superx101/CALL) 的社区维护分支。上游已停止维护，本分支负责适配新的服务端平台并修复已知问题。

## 运行环境

| 组件 | 版本 | 必需 |
|---|---|---|
| Bedrock Dedicated Server | 1.26.51+ | ✅ |
| LeviLamina（LL3） | 26.51.9+ | ✅ |
| legacy-script-engine-nodejs | 0.22.4+ | ✅ |
| **HologramLib** | **26.51.11+ / 26.60.8+**（450 导出面） | ✅ 预览与选区线框依赖它；缺失时这两项降级，其余功能照常 |

当前版本：**4.0.0** ｜ 许可证：**GPL-3.0-or-later**

## 能做什么

- **选区**：A/B 点选区、视野选区、快捷键选区，自动显示选区范围与尺寸
- **复制粘贴**：整块结构复制/粘贴，支持镜像与 90/180/270 度旋转
- **填充**：实心填充、空心、轮廓、替换、清空
- **形状**：内置基础几何形状，支持第三方形状包扩展
- **保存与载入**：把建筑存成结构，随时还原到任意位置
- **撤销 / 重做**：多步撤销，快照保存在服务器本地
- **菜单与工具**：图形化菜单、物品快捷工具

## 与 1.x 的主要区别

3.x 是针对 LL3 / LSE 0.22 重写的执行层，最重要的几点：

1. **进度显示可选**：旧版 boss 条颜色越界会踢客户端（已修复），现在由 `previewCountdownHud` 选择动作栏或 Boss 条；
2. **不再传送玩家**来加载区块，改用 `/tickingarea`；
3. **不再自动更新**；
4. 大区域操作会更快、更稳，失败会明确告诉你原因。

细节见[从 1.x / 2.0 升级](user/migrate.md)。

## 开始使用

1. [安装说明](user/install.md)
2. [快速上手：选区与复制粘贴](user/function/area.md)
3. [配置参考](user/config.md)
4. [已知限制](user/known-limitations.md)

## 项目地址

- 仓库：<https://github.com/owoser/CALL>
- 问题反馈：<https://github.com/owoser/CALL/issues>
- 发布包：<https://github.com/owoser/CALL/releases>
