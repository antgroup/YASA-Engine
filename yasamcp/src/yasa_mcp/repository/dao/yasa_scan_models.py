"""yasa-scan 四张兼容表的数据库行对象。"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class InterfaceDO:
    """一条 ``routes`` 表记录；一个接口的多个实现会展开为多条记录。

    ``protocol`` 是 yasa-scan ``interface.key.protocol.name`` 的原始事实，不能由
    ``framework`` 推断。``extra`` 是 routes 末尾的可空 JSON 文本扩展位；当前
    统一写入 ``{}``，后续非核心字段优先放入此列，避免每次新增扫描事实都迁移
    routes 表结构。
    """

    route_id: str
    language: str
    api_url: str
    method: str
    interface_fqn: str
    handler: str
    framework: str
    protocol: str
    file_path: str
    source_start_line: int
    source_end_line: int
    protected: bool
    def_status: str
    def_kind: str
    def_scope: str
    def_signature: str
    def_file_path: str
    def_start_line: int
    def_end_line: int
    extra: str | None


@dataclass(frozen=True)
class InterceptorDO:
    """一条 ``interceptors`` 表记录。"""

    interceptor_id: str
    language: str
    name: str
    scope: str
    file_path: str
    start_line: int
    end_line: int


@dataclass(frozen=True)
class RouteInterceptorDO:
    """一条 ``route_interceptors`` 关联记录。"""

    route_id: str
    interceptor_name: str
    interceptor_scope: str


@dataclass(frozen=True)
class RemoteCallDO:
    """一条 ``remote_calls`` 表记录，包含逐事实推导的 language。

    ``caller_name`` 是后续 scanner 版本补充 caller 时的兼容存储位，当前为空也
    必须保留。``extra`` 只预留给未来非核心扩展，放在末尾且允许 ``NULL``；当前
    查询不读取它，避免大文本进入跨应用热路径。
    """

    remote_call_id: str
    language: str
    caller_name: str
    callee_name: str
    call_site_sourcefile: str
    call_site_start_line: int
    call_site_end_line: int
    framework: str
    protocol: str
    remote_interface_fqn: str
    remote_method_name: str
    remote_repo_url: str | None
    remote_repo_file: str | None
    extra: str | None


YasaScanTableDO = InterfaceDO | InterceptorDO | RouteInterceptorDO | RemoteCallDO
