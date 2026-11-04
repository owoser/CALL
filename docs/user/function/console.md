# 权限

?> 若您**不是**服务器后台管理者，可**跳过**本节文档

**本节中命令全部为后台指令，仅在后台输入有效**

## 重启插件 `reload`
重启CALL和所有形状包
#### 指令
> /call \<reload | r :enum\>

## 导出结构 `export`
#### 指令
从玩家保存的结构中导出，导出到：`plugins/CALL/userdata/export` 文件夹
> /call \<export | ex :enum\> \<mcstructure :enum\> \<id :string\> \[includeEntity :boolean\] \[name :string\]
- `mcstructure`：选择导出的格式为 .mcstructure
- `id`：结构id, 可使用 /call list 查看所有结构的id
- `includeEntity`：是否包含实体，默认为false
- `name`：导出的文件名，默认为id  

指令示例：ca export mcstructure c0001230111205510003 true test  
表示导出id为c0001230111205510003的结构，包含实体，且文件名为：test.mcstructure

## 导入结构 `import`
从 `plugins/CALL/userdata/import` 文件夹下选择文件导入为结构，导入到某个玩家的保存中
#### 指令
> /call \<import | im :enum\> \<fileName :string\> \<playerName :string\> \[includeEntity :boolean\] \[name :string\]
- `fileName`：需要导入文件的文件名，请包含后缀。例：test.mcstructure
- `playerName`：玩家名，需要输入一位使用过CALL的玩家
- `includeEntity`：是否包含实体，默认为false
- `name`：导入结构的结构名，默认为当前时间 

指令示例：ca import test.mcstructure steve true a  
表示从 `plugins/CALL/userdata/import/test.mcstructure` 导入结构给玩家 steve，且保留实体，结构名为 a

## 重载配置 `reload`
重新读取配置文件并重载语言包，等同于重启插件但不断线。3.x **不再提供自动更新**。
#### 指令
> /call \<reload | r :enum\>

> 大多数情况下直接输入 `/ca r` 即可。

## 添加一个玩家进白名单 `add`
#### 指令

> /call \<add :enum\>

## 移除一个白名单内的玩家 `ban`
#### 指令

> /call \<ban :enum\>

## 列出白名单内的玩家 `list`
本指令和[查询结构](user/function/other?id=%e6%9f%a5%e8%af%a2%e7%bb%93%e6%9e%84-list)命令语法相同，但是在后台执行
#### 指令

> /call \<list :enum\>

## 列出所有已加载的形状包 `shape`
本指令和[查询结构](user/function/other?id=%e6%9f%a5%e8%af%a2%e7%bb%93%e6%9e%84-list)命令语法相同，但是在后台执行
#### 指令

> /call \<shape :enum> \<list :enum\>
## 填充时怎么指定方块状态

三种写法完全等价，任选一种：

~~~text
/ca fill minecraft:oak_stairs ["weirdo_direction"=2]
/ca fill minecraft:oak_stairs [weirdo_direction=2]
/ca fill minecraft:oak_stairs[weirdo_direction=2]
~~~

> **推荐第三种**：状态直接跟在方块名后面、整段不含空格，永远不会被命令参数切碎。
> （前两种带空格时，某些版本会把参数拆开，于是报"无效的方块名或选区"。）

其他可接受的写法：

| 写法 | 说明 |
|---|---|
| `["a"=1,"b"="x"]` | 标准写法 |
| `[a=1,b=x]` | 不写引号 |
| `a=1,b=x` | 不写方括号 |
| `{"a":1}` | JSON 风格 |
| `方块名[a=1]` | 并入方块名（无空格，推荐） |

!> **状态名与取值随游戏版本变化**。例如 1.26 里楼梯朝向叫 `weirdo_direction`
（旧文档里的 `facing_direction` 已经无效），错误的状态名会被服务端直接拒绝。
用工具点击一个方块、或先 `/ca fill <方块>` 放一个再看它的状态，是最稳妥的办法。
