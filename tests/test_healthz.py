# -*- coding: utf-8 -*-
"""
test_healthz.py —— 健康检查接口测试
===================================

覆盖验收标准：HTTP 模式下 GET /healthz 返回 200 与固定 JSON。
"""
from __future__ import annotations

from starlette.testclient import TestClient

from yasa_mcp import SERVER_NAME, SERVER_VERSION, TRANSPORTS_SUPPORTED
from yasa_mcp.server import mcp


def test_healthz_returns_200_and_fixed_json():
    """GET /healthz 应返回 200 + 脚手架约定的固定结构。"""
    app = mcp.http_app(transport="streamable-http")
    with TestClient(app) as client:
        resp = client.get("/healthz")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["server_name"] == SERVER_NAME
        assert data["version"] == SERVER_VERSION
        assert data["transports_supported"] == TRANSPORTS_SUPPORTED


def test_healthz_method_restricted_to_get():
    """POST /healthz 应返回 405（仅允许 GET）。"""
    app = mcp.http_app(transport="streamable-http")
    with TestClient(app) as client:
        resp = client.post("/healthz")
        assert resp.status_code == 405
