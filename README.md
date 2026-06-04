# CodeGraph-WX

CodeGraph-WX 是面向 C/C++ 千万行级代码仓的本地代码知识图谱增强项目，基于开源 [CodeGraph](https://github.com/colbymchenry/codegraph) 演进。项目通过静态解析源代码，将函数、变量、结构体、字段、枚举、typedef、include 等代码实体抽象为图谱节点，并建立调用、引用、包含、继承、跨文件依赖等关系，为 AI Agent、WEBIDE 和研发工具链提供符号级代码查询与影响面分析能力。

> 当前命令行入口仍为 `codegraph`。企业内部发布时，可将本文中的上游包名和下载地址替换为内部地址。

## 适用场景

- 大型 C/C++ 存量代码理解和模块梳理
- 函数调用链、接口影响面和跨文件依赖分析
- 全局变量读写引用追踪
- 结构体字段、typedef、枚举等符号级检索
- AI 编码助手上下文增强，减少大文件读取和反复 `grep`
- WEBIDE、嵌入式软件、系统软件、通信软件等企业研发环境集成

## 核心能力

- **符号图谱构建**：提取文件、函数、方法、结构体、字段、变量、常量、枚举、类型别名等节点。
- **关系建模**：建立 `contains`、`calls`、`references`、`imports`、`extends`、`implements` 等边。
- **C/C++ 增强**：支持全局变量、常量、多声明器、指针/数组声明、结构体字段、C++ 类成员、typedef/using 和 include 提取。
- **跨文件解析**：结合 include、`compile_commands.json`、常见 include 目录和名称匹配解析跨文件调用与引用。
- **本地查询**：基于 SQLite + FTS5 存储，支持符号搜索、调用方/被调方、影响面、调用路径和任务上下文查询。
- **增量同步**：基于文件大小、mtime 和内容哈希同步变更，MCP 模式下可自动监听文件变化。
- **企业部署**：支持自包含 bundle、内置运行时、无 native addon 依赖，并提供 `node:sqlite` / `sql.js` WASM 后端。

## C/C++ 增强点

CodeGraph-WX 相比上游重点补强 C/C++ 大仓场景：

- 文件级变量提取：`int g_counter = 0;`
- 静态变量识别：`static int s_counter = 0;` 标记为非导出
- 常量提取：`const int MAX = 100;` 生成 `constant`
- 多声明器拆分：`int x, y, z;`
- 指针、数组、引用声明名称解析：`int *p`、`int arr[10]`
- 跳过 `extern` 声明和函数前向声明，避免误建变量节点
- 结构体和类字段提取：`struct S { int id; char name[32]; };`
- 函数体内全局变量引用追踪，并排除同名局部变量、参数和函数调用目标
- `#include "foo.h"` / `#include <vector>` 提取与解析
- 从 `compile_commands.json` 读取 `-I`、`-isystem` 路径，缺失时启用常见目录探测

## 架构

```text
源代码
  -> 文件扫描与语言识别
  -> Tree-sitter WASM 静态解析
  -> 符号节点提取
  -> 调用、引用、include、继承等关系收集
  -> 跨文件引用解析
  -> SQLite 图谱持久化
  -> CLI / MCP 查询
```

主要模块：

- `src/extraction/`：扫描、解析、符号提取、增量索引
- `src/extraction/languages/c-cpp.ts`：C/C++ 提取配置
- `src/resolution/`：引用解析、include/import 解析
- `src/db/`：SQLite schema 与数据库适配
- `src/graph/`：图遍历、上下文和影响面查询
- `src/mcp/`：MCP Server 与 AI Agent 工具
- `src/bin/codegraph.ts`：CLI 入口

## 快速开始

### 安装

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh

# Windows PowerShell
irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex
```

已有 Node.js 时也可使用：

```bash
npx @colbymchenry/codegraph
npm i -g @colbymchenry/codegraph
```

### 初始化索引

```bash
cd your-c-or-cpp-project
codegraph init -i
codegraph status
```

索引数据保存在项目根目录 `.codegraph/` 下，不应提交到代码仓。

## 常用命令

```bash
codegraph query g_counter --kind variable      # 搜索符号
codegraph callers g_counter                    # 查询调用方/引用方
codegraph callees init_device                  # 查询被调方
codegraph impact init_device --depth 3         # 影响面分析
codegraph context "分析接口变更影响"            # 构建任务上下文
codegraph files --filter src --format tree     # 查看文件结构
codegraph sync                                 # 增量同步
codegraph index --force                        # 强制全量重建
codegraph uninit                               # 删除本项目索引
```

## MCP 集成

交互式配置 AI 编码助手：

```bash
codegraph install
```

手动 MCP 配置示例：

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph",
      "args": ["serve", "--mcp"]
    }
  }
}
```

常用 MCP 工具：

- `codegraph_search`：搜索符号
- `codegraph_context`：为任务构建代码上下文
- `codegraph_callers` / `codegraph_callees`：查询调用关系
- `codegraph_impact`：分析影响范围
- `codegraph_trace`：追踪两个符号之间的调用路径
- `codegraph_node` / `codegraph_explore`：查看符号详情和相关源码
- `codegraph_files` / `codegraph_status`：查看文件结构和索引状态

## 部署说明

- 自包含 bundle 可携带 Node 运行时、编译产物、Tree-sitter WASM 和生产依赖。
- 优先使用 Node 内置 `node:sqlite`，不可用时回退到 `sql.js` WASM。
- 无 `better-sqlite3` 等 native addon，降低低版本 glibc 和受限环境部署成本。
- 可通过 `CODEGRAPH_FORCE_WASM=1` 强制使用 WASM SQLite 后端。
- 文件监听不稳定时可使用 `codegraph serve --mcp --no-watch`。

## 开发

```bash
npm install
npm run build
npm test
npm run cli -- --help
```

构建自包含 bundle：

```bash
scripts/build-bundle.sh linux-x64
scripts/build-bundle.sh linux-arm64
scripts/build-bundle.sh win32-x64
```

## 许可

CodeGraph-WX 基于开源 CodeGraph 演进，沿用 MIT License。
