<img src="folder-img/logo.png"  />

## [ Official Website ](https://cybersec.antgroup.com/)
#### [简体中文](README_ch.md) / [English](README.md)

## What is YASA
Hello! This is the open unified multi-language program analysis product YASA (Yet Another Static Analyzer)!

YASA is a program analysis product designed for industrial-level applications. By constructing a unified abstract syntax tree (UAST) intermediate representation and combining simulation execution technology with large model inference, YASA achieves precise data flow, pointer, and taint analysis.

We are committed to building an open, unified, efficient, and accurate program analysis product, providing strong technical support for enterprise-level code security and quality assurance.

## What YASA Can Do
YASA provides unified multi-language program analysis capabilities, including four core components: YASA-UAST, YASA-Engine, YASA-UQL, and YASA-MCP, as described below.

Currently, YASA-UAST and YASA-Engine are open-sourced, while YASA-UQL and YASA-MCP will be open-sourced later.

YASA-Engine currently offers default capabilities such as unified AST parsing for multiple languages, taint data flow analysis, and CG generation. Additionally, YASA provides custom checker capabilities, allowing users to flexibly extend and develop customized checkers based on specific business needs. Developers and enterprise users are welcome to try it out. Support for JS/TS、Python、Go languages has been open-sourced, while support for Java language is not open-sourced yet.

## Components
<img src="folder-img/Structure.png"  />

### YASA-UAST
[UAST](https://github.com/antgroup/YASA-UAST)（Unified Abstract Syntax Tree）is an intermediate representation structure for multi-language program analysis. The UAST-Parser parses code from different programming languages into a unified abstract syntax format. Through UAST, source code in different languages can be converted into a standardized tree structure, enabling unified analysis and processing across multiple languages.

### YASA-Engine: Unified multi-language Analysis Engine
The unified multi-language analysis engine is the core component of a modern program analysis platform. It aims to achieve efficient and precise analysis of multiple programming languages through a unified analysis framework and methodology. Also, with the help of AI capabilities, it addresses issues such as broken chains in traditional program analysis and high adaptation costs for new scenarios. (The AI part is not open-sourced yet.)


### YASA-UQL: Unified Declarative Rule Query Language (not open-sourced yet)
Supports declarative unified query rule writing for multiple languages, compatible with CodeQL syntax, lowering the barrier to rule writing while unifying rule sets across languages.

### YASA-MCP: Unified multi-language Program Analysis MCP (not open-sourced yet)
Provides atomic analysis APIs for large models, offering program analysis services that are large-model-friendly.

## YASA Technical Advantages
### Low Cost for New Language Support
- YASA is directly modeled and analyzed based on UAST. When adapting to a new language, once it is parsed into UAST, the general-layer analyzer's capabilities can be used. After supporting the new language's package structure, the new language's analysis is already supported.

<img src="folder-img/newLanguage.png"  />


### High Analysis Accuracy, Measurable, and Unified Multi-Languages
- YASA is based on unified multi-language symbolic interpretation capabilities, offering high precision and scalability in static code analysis. It naturally supports domain-sensitive, context-sensitive, object-sensitive, path-sensitive, and flow-sensitive capabilities in the field of static analysis.

- During YASA's development, we used [xAST](https://github.com/alipay/ant-application-security-testing-benchmark) to evaluate and verify our capabilities, achieving "measurable capabilities." We compared YASA's performance with other open-source program analysis tools under the xAST evaluation system:

<img src="folder-img/xastTest.png" style="width:50%;"  />

### Making Program Analysis Easily, and Friendly
- Introduced the unified declarative rule query language UQL, compatible with CodeQL syntax, and pioneered a unified QL rule library for multiple languages, making program analysis more user-friendly.

- Launched YASA MCP (large-model-friendly) and SDK (application-friendly).

## Quick Start

[Getting Started](https://www.yuque.com/u22090306/bebf6g/evyf4chw26deq8xq)

[Installation and Deployment](https://www.yuque.com/u22090306/bebf6g/gm7b32tcn9vosgll)

## Join Us
Welcome to submit issues if you encounter any problems!

For code contributions, please refer to [CONTRIBUTION](https://www.yuque.com/u22090306/bebf6g/rgm1xmoa38wlfxzc)

## Resource Links
[Official Documentation](https://www.yuque.com/u22090306/bebf6g)

[Community Activities](https://www.yuque.com/u22090306/bebf6g/fn1rauxwtp7z0l1u)

## Open Source License
Apache License 2.0 - Details in LICENSE Apache-2.0.

## Acknowledgments
Thanks to all developers who have contributed to the YASA project! Special thanks to the open-source community for their support and feedback, enabling us to jointly advance the development of program analysis technology.

YASA - Making code analysis more precise, easier, and smarter.

## Contact Us
[Official Website](https://cybersec.antgroup.com/)

<img src="folder-img/contactus.png" style="width:40%;" />
