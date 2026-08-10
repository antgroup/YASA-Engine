# yasa-mcp —— MCP 统一运行底座脚手架

> YASA-Engine [OSS26] 项目 · 版本 0.1.0 · 面向零基础小白的保姆级说明

---

## 0. 这个项目是干什么的？（30 秒看懂）

**MCP（Model Context Protocol）** 是一个让 AI 助手（比如 Claude）能调用你电脑上工具的标准协议。

本项目是 **MCP 服务脚手架**，它本身不干活，它是给以后的 14 个「代码分析工具」搭的**地基**。就像盖房子前先打地基一样：

```
你现在的 AI 助手 ──连接──> 本脚手架(yasa-mcp) ──提供──> 各种代码分析工具(以后加)
```

你只需要记住一件事：**这个脚手架能启动一个 MCP 服务，服务里已经有一个 `ping` 工具可以测试通不通。**

---

## 1. 开始前的准备（一次就好）

### 1.1 安装 Python

- 本项目需要 **Python 3.10 及以上**（推荐 3.12）。
- 装好后，在终端输入 `python --version`，能显示出版本号就说明装好了。

### 1.2 下载项目代码

脚手架代码放在项目根目录的 `yasa_mcp` 文件夹里，文件夹结构如下：

```
mcp_server/
├── YASA-Engine/          ← 原有项目（不要动它！）
├── yasa_mcp/             ← 本项目脚手架（新建的）
│   ├── requirements.txt   依赖清单
│   ├── __init__.py        包入口，告诉 Python 这是一个包
│   ├── config.py          配置加载 + 环境变量校验 + 日志
│   ├── decorators.py      统一工具注册装饰器 @yasa_tool
│   ├── server.py          FastMCP 实例 + ping 工具 + 启动逻辑
│   ├── __main__.py        命令行入口（python -m yasa_mcp 就靠它）
│   └── README.md          本说明文件
└── tests/                ← 单元测试（新建的）
    └── test_framework.py   验证装饰器注册 / 参数校验 / 日志级别
```

---

## 2. 安装依赖（pip 命令）

在终端里，**先进入 `mcp_server` 目录**，然后执行：

```bash
pip install -r yasa_mcp/requirements.txt
```

> 如果提示 `pip 不是内部或外部命令`，说明 Python 没装好或没加入 PATH，请回看第 1.1 节。
>
> 如果提示权限问题（比如 Linux/Mac 的 `permission denied`），在前面加 `sudo`：
> ```bash
> sudo pip install -r yasa_mcp/requirements.txt
> ```

---

## 3. 配置环境变量（必做！不然启动会报错）

脚手架启动时**强制校验**一个环境变量：`YASA_MCP_REPO_ROOT`（你的代码仓库根目录）。
**不配置直接启动会报错退出**，这是设计好的安全行为。

### 3.1 Windows（两种写法任选一种）

**写法 A：临时设置（只对当前终端窗口有效，关闭就没了）**

```bat
set YASA_MCP_REPO_ROOT=D:\桌面\mcp_server\YASA-Engine
```

**写法 B：永久设置（推荐，一次设置以后都在）**

1. 按 `Win` 键，搜索「环境变量」并打开 **「编辑系统环境变量」**；
2. 点右下角 **「环境变量」** 按钮；
3. 在 **用户变量** 区域点 **「新建」**；
4. 变量名填 `YASA_MCP_REPO_ROOT`，变量值填你的仓库路径（例如 `D:\桌面\mcp_server\YASA-Engine`）；
5. 一路点 **确定** 保存，然后**重开一个终端窗口**生效。

### 3.2 Mac / Linux

**临时设置（只对当前终端窗口有效）：**

```bash
export YASA_MCP_REPO_ROOT=/path/to/YASA-Engine
```

**永久设置（推荐）：** 把上面这行加到 `~/.bashrc`（bash 用户）或 `~/.zshrc`（zsh 用户）末尾，然后执行 `source ~/.bashrc` 或重开终端。

> 记得把路径换成你自己的仓库路径。
> 校验规则：路径必须存在且是一个**文件夹**，否则也会报错。

---

## 4. 启动服务（两条命令）

> 假设你已经在 `mcp_server` 目录下，且 `YASA_MCP_REPO_ROOT` 已配置好。

### 4.1 方式一：stdio 模式（默认，给 AI 客户端用）

```bash
python -m yasa_mcp --transport stdio
```

- **`--transport stdio`**：表示用标准输入输出跟 AI 客户端对话，是给 **Claude Desktop、Cline、MCP Inspector** 用的模式。
- **启动后没有日志输出是正常的**，它正在安静地等客户端发消息。直接按 `Ctrl + C` 可以停止。
- 想看到调试日志，可以加 `--log-level debug`。

### 4.2 方式二：http 模式（网络模式，可被浏览器/程序访问）

```bash
python -m yasa_mcp --transport http --port 8765
```

- **`--transport http`**：启动一个 HTTP 网络服务（streamable-http）。
- **`--port 8765`**：监听端口，默认就是 8765，可不写。
- 启动后，**再开一个终端**，输入下面命令验证健康状态：

```bash
curl http://localhost:8765/healthz
```

看到返回 `{"status":"ok", ...}` 就说明服务正常。浏览器里直接打开 `http://localhost:8765/healthz` 也可以。

> 补充：http 模式下，MCP 客户端需要连接的**协议端点**在 `http://localhost:8765/mcp`
> （`/healthz` 只是给运维/浏览器探活用的，客户端别连错地址）。

### 4.3 命令行参数一览

| 参数 | 可选值 | 默认值 | 作用 |
|------|--------|--------|------|
| `--transport` | `stdio` / `http` | `stdio` | 传输模式 |
| `--port` | 1~65535 的整数 | `8765` | HTTP 端口 |
| `--log-level` | `debug` / `info` / `warn` / `error` | `info` | 日志详细程度 |

---

## 5. 接入 Claude Desktop（完整配置片段）

如果你用 **Claude Desktop**，让它连接本脚手架：

1. 打开配置文件：Windows 在 `%APPDATA%\Claude\claude_desktop_config.json`，
   Mac 在 `~/Library/Application Support/Claude/claude_desktop_config.json`。
2. 在 `mcpServers` 里加一段（**注意替换成你自己的仓库路径**）：

```json
{
  "mcpServers": {
    "yasa-mcp": {
      "command": "python",
      "args": ["-m", "yasa_mcp", "--transport", "stdio"],
      "env": {
        "YASA_MCP_REPO_ROOT": "D:\\桌面\\mcp_server\\YASA-Engine"
      }
    }
  }
}
```

> 说明：
> - `command` / `args`：告诉 Claude Desktop 用 `python -m yasa_mcp` 启动服务；
> - `env`：在客户端侧就把环境变量配好，这样命令行里没配也不影响；
> - Windows 路径里的反斜杠要写成 `\\`（JSON 转义），Mac/Linux 直接用 `/` 即可。
>
> 保存后**重启 Claude Desktop**，能看到 `yasa-mcp` 已连接，并且能检索到 `ping` 工具。

---

## 6. 如何添加你自己的 MCP 工具（官方推荐写法）

脚手架提供了统一装饰器 `@yasa_tool`，新增工具只需要**三步**：

```python
# 新建一个工具文件，比如 yasa_mcp/tools_hello.py
from yasa_mcp.decorators import yasa_tool
from yasa_mcp.server import mcp


@yasa_tool(mcp)                                  # 第一步：加装饰器（自动注册）
def add(a: int, b: int) -> int:                  # 第二步：写函数，类型注解写清楚
    """两数相加，返回和。"""                        # 第三步：写说明，AI 会读它来理解工具
    return a + b
```

写完保存即可，**不需要任何其它改动**。装饰器自动帮你做了：

| 能力 | 谁做的 | 说明 |
|------|--------|------|
| 注册到服务 | `@yasa_tool` | 等价于 `mcp.tool()` |
| 类型校验 | fastmcp + pydantic | `a: int` 传成字符串会自动报错 |
| 非空校验 | 装饰器内置 | 必填的字符串参数传空串会返回标准错误 |
| 异常捕获 | 装饰器内置 | 函数抛错服务不崩，返回标准化错误 JSON |

**再举个带多个参数、有异常处理的例子：**

```python
@yasa_tool(mcp)
def divide(a: float, b: float) -> float:
    """a 除以 b。"""
    if b == 0:
        raise ValueError("除数不能为 0")
    return a / b
```

> 试一试：调用 `divide(a=1, b=0)`，你会收到一条标准化错误 JSON，而服务不会崩溃。

---

## 7. 用 MCP Inspector 调试（推荐工具）

MCP 官方提供了一个图形化调试工具 Inspector：

```bash
# 1) 先在一个终端启动 stdio 模式（或 http 模式）
python -m yasa_mcp --transport stdio

# 2) 再开一个终端，运行 Inspector
npx @modelcontextprotocol/inspector
```

打开浏览器里的 Inspector 界面，选择「Connect」，就能看到 `ping` 工具并直接调用它。

---

## 8. 单元测试（pytest）

脚手架内置了单元测试，覆盖三类场景：
1. `@yasa_tool` 装饰器自动注册功能是否生效；
2. 工具传入非法参数时，参数校验是否触发、异常是否被捕获；
3. 不同日志级别下，日志输出格式与过滤是否正常。

**运行命令（在项目根目录执行）：**

```bash
pytest tests/ -v
```

看到 `5 passed` 就说明全部通过。单看某一个文件也可以：

```bash
pytest tests/test_framework.py -v
```

> 说明：测试运行时会自动把项目根目录加入 `sys.path`，并兜底设置
> `YASA_MCP_REPO_ROOT` 环境变量，所以你**不需要手动配置**环境变量也能跑测试。

---

## 9. 常见问题（FAQ）

**Q1：启动时报错 `环境变量 YASA_MCP_REPO_ROOT 未配置或为空`？**
→ 没配置环境变量，请看第 3 节。这也是脚手架刻意做的「强制校验」。

**Q2：`python` 不是内部或外部命令？**
→ Python 没装好或没加入 PATH，请用 `py -3.12 -m yasa_mcp ...` 试试，或重装 Python。

**Q3：启动 http 模式后端口被占用？**
→ 换一个端口：`python -m yasa_mcp --transport http --port 9000`。

**Q4：Claude Desktop 里看不到 yasa-mcp？**
→ 检查第 5 节配置的路径是否正确、JSON 是否有语法错误、并已重启客户端。

**Q5：`tools/list` 里只有 `ping`？**
→ 正常，脚手架目前只内置演示工具，后续 14 个代码分析工具会陆续注册进来。

---

## 10. 项目架构（为什么这么拆分）

每个文件职责单一、互不依赖，方便后续扩展：

```
__main__.py  (命令行入口)
     │ 传参
config.py   (配置 + 环境变量校验 + 日志)  ← 所有配置的唯一来源
     │
decorators.py (@yasa_tool 统一注册/校验/异常捕获)
     │
server.py   (FastMCP 实例 + ping + stdio/http 双模式启动)
     │
     └──> 以后新增的 14 个代码分析工具都注册到这里的 mcp 实例上
```

想加新工具：只管在 `server.py`（或你自己的工具文件）里写函数 + `@yasa_tool(mcp)`，其它都不用动。
