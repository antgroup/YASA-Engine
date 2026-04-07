# 项目简介
<font style="color:rgb(31, 35, 40);">统一多语言程序分析是一个</font><font style="color:#1f2328;">面向工业界大规模落地的</font><font style="color:rgb(31, 35, 40);">静态程序分析工具。它为多语言定义了</font>统一的抽象语法树（UAST）中间表示，基于UAST和模拟执行技术，实现了高精度的数据流、指针分析和污点分析，并同时提供了命令式和声明式两种规则扩展能力供用户灵活、低成本使用，可广泛应用于代码安全等场景。

# 核心功能
+ 定义了统一的多语言的抽象语法树（UAST）中间表示，并提供了各语言向UAST转换的工具
+ 高精度的数据流、指针分析和污点分析
+ 可扩展的规则定制化能力，包括命令式规则和声明式查询语言
+ 内置常见的安全检测规则，面向安全检测场景可开箱即用

# 项目架构
![](https://intranetproxy.alipay.com/skylark/lark/0/2025/png/178787/1743992792193-33a83234-5229-481d-a4b6-e99a796a2fc0.png)

**QL**：Query Language

**<font style="color:rgb(0, 0, 0);">UAST</font>**<font style="color:rgb(0, 0, 0);">：Unify Abstract Syntax Tree </font>**统一抽象语法树**

**<font style="color:rgb(0, 0, 0);">YASA</font>**<font style="color:rgb(0, 0, 0);"> ：Yet Another Static Analyzer</font>

# 技术优势
+ 【统一】统一多语言抽象语法树（UAST）中间表示，可低成本支持新语言，便于跨语言的分析
+ 【高精度】多语言程序模拟执行技术，还原了真实的程序运行上下文，可提供更高的分析精度
+ 【工业界落地】经过蚂蚁内部大规模落地和业界首个程序分析评价体系开源项目[xast](https://xastbenchmark.github.io/)的“双重认证”，多语言场景下的分析完整度、准确度和性能都有较高保障
+ 【低使用成本】命令式程序分析combine声明式查询语句
    - 兼容[Github codeql](https://github.com/github/codeql)的语法和规则，用户使用门槛低
    - 提供了灵活的规则定制能力

# <font style="color:rgb(31, 35, 40);">支持的语言</font>
<font style="color:rgb(31, 35, 40);">Java、JS、Go、Python......</font>

<font style="color:rgb(31, 35, 40);">其他语言的支持为开源社区共建“留白”</font>

