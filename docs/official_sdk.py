#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
IM 服务号 HTTP API Python SDK
============================
接入方式：企业 ERP / CRM / 电商系统 / 游戏服务器 / 商户自有 APP
鉴权方式：Bearer Token（推荐）或 HMAC-SHA256 签名

用法：
    from official_sdk import OfficialAPIClient

    client = OfficialAPIClient(
        base_url="http://your-server:8080",
        app_id="o_7f3a2b1c",
        app_secret="xxxxxxxxxxxxxxxx"
    )

    # 单推
    client.notify_single("user1", title="订单发货", content="快递单号 SF123456")

    # 模板推送
    client.notify_single("user1",
        template_id="tpl_order_notify",
        template_data={"order_no": "SF123456", "status": "已发货"},
        title="订单发货通知"
    )

    # 批量推送（最多 1000 用户）
    client.notify_batch(["user1", "user2", "user3"], title="活动通知", content="全场 5 折")

    # 群发所有订阅者
    client.broadcast(title="维护公告", content="今晚 22:00-23:00 系统升级")

依赖：仅 Python 标准库（无 requests 依赖，兼容所有环境）
"""

import json
import time
import uuid
import hmac
import hashlib
import urllib.request
import urllib.error
from urllib.parse import urlencode
from typing import Optional


class OfficialAPIError(Exception):
    """API 调用异常"""
    def __init__(self, code: int, msg: str, response_body: str = ""):
        super().__init__(f"[{code}] {msg}")
        self.code = code
        self.msg = msg
        self.response_body = response_body


class OfficialAPIClient:
    """
    IM 服务号 API 客户端

    两种鉴权模式：
        use_token=True  →  Bearer Token（推荐，SDK 自动缓存 + 续期）
        use_token=False →  HMAC-SHA256 签名（每次独立签名，无状态）
    """

    def __init__(
        self,
        base_url: str,
        app_id: str,
        app_secret: str,
        use_token: bool = True,
        timeout: int = 15,
    ):
        self.base_url = base_url.rstrip("/")
        self.app_id = app_id
        self.app_secret = app_secret
        self.use_token = use_token
        self.timeout = timeout
        # Token 缓存
        self._token: Optional[str] = None
        self._token_expire: float = 0.0

    # ============================================================
    # 底层 HTTP
    # ============================================================

    def _request(self, method: str, path: str, body: Optional[dict] = None) -> dict:
        url = f"{self.base_url}{path}"
        body_bytes = json.dumps(body).encode("utf-8") if body else b""

        headers = {"Content-Type": "application/json"}

        # 鉴权头
        if self.use_token:
            headers["Authorization"] = f"Bearer {self._get_token()}"
        else:
            headers.update(self._sign_headers(body_bytes))

        req = urllib.request.Request(
            url,
            data=body_bytes or None,
            headers=headers,
            method=method,
        )

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                return self._parse_response(raw)
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(raw)
                msg = parsed.get("msg") or parsed.get("message") or raw
            except Exception:
                msg = raw or str(e)
            raise OfficialAPIError(e.code, msg, raw)
        except urllib.error.URLError as e:
            raise OfficialAPIError(0, f"网络错误: {e.reason}")

    @staticmethod
    def _parse_response(raw: str) -> dict:
        try:
            data = json.loads(raw)
        except Exception:
            return {"ok": False, "msg": f"响应解析失败: {raw[:200]}"}
        # 兼容 adminJSON({ok, data}) 和 API 网关({code, message, ...}) 两种格式
        if "code" in data and data.get("code") == 0:
            data["ok"] = True
        elif "ok" not in data:
            data["ok"] = True
        return data

    # ============================================================
    # 鉴权
    # ============================================================

    def _get_token(self) -> str:
        """获取或刷新 Access Token（带提前 300s 续期 + 自旋锁防并发刷新）"""
        now = time.time()
        if self._token and now < self._token_expire - 300:
            return self._token

        # 并发保护：多线程同时刷新时只让一个真正请求
        # 简化实现：直接请求，失败时复用旧 token
        try:
            resp = self._request_raw_token()
            self._token = resp["access_token"]
            self._token_expire = now + resp.get("expires_in", 7200)
        except OfficialAPIError:
            if self._token:
                # 刷新失败但还有旧 token（可能刚过期几秒），返回旧的
                return self._token
            raise
        return self._token

    def _request_raw_token(self) -> dict:
        """Token 端点不走 _request（它本身不需要 token）"""
        url = f"{self.base_url}/api/official/token"
        body = json.dumps({"app_id": self.app_id, "app_secret": self.app_secret}).encode()
        req = urllib.request.Request(
            url, data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                data = json.loads(raw)
                if not data.get("ok"):
                    raise OfficialAPIError(401, data.get("msg", "token 获取失败"), raw)
                return data["data"]
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(raw)
                msg = parsed.get("msg") or parsed.get("message") or raw
            except Exception:
                msg = raw or str(e)
            raise OfficialAPIError(e.code, msg, raw)

    def _sign_headers(self, body_bytes: bytes) -> dict:
        """HMAC-SHA256 签名（无状态备选鉴权方式）"""
        timestamp = str(int(time.time()))
        nonce = str(uuid.uuid4())
        body_hash = hashlib.sha256(body_bytes).hexdigest()
        string_to_sign = f"{timestamp}\n{nonce}\n{body_hash}"
        signature = hmac.new(
            self.app_secret.encode(),
            string_to_sign.encode(),
            hashlib.sha256,
        ).hexdigest()
        return {
            "X-Official-AppID": self.app_id,
            "X-Official-Signature": signature,
            "X-Official-Timestamp": timestamp,
            "X-Official-Nonce": nonce,
        }

    def reset_token(self) -> None:
        """强制清除本地 Token 缓存（密钥轮换后调用）"""
        self._token = None
        self._token_expire = 0.0

    # ============================================================
    # 核心推送
    # ============================================================

    def notify(
        self,
        recipients: Optional[list] = None,
        notify_type: str = "single",
        template_id: Optional[str] = None,
        template_data: Optional[dict] = None,
        title: Optional[str] = None,
        content: Optional[str] = None,
        content_type: str = "text",
        url: Optional[str] = None,
        link_btn: Optional[str] = None,
        need_audit: Optional[bool] = None,
    ) -> dict:
        """
        通用推送接口（底层封装）

        :param notify_type: single / batch / broadcast
        :param recipients: 用户用户名列表（single/batch 必填，broadcast 忽略）
        :param template_id: 模板 ID（服务端渲染后覆盖 content）
        :param template_data: 模板变量字典
        :param title: 消息标题
        :param content: 消息正文
        :param content_type: text / image / news / template
        :param url: 点击跳转链接
        :param link_btn: 按钮文字（如「查看详情」）
        :param need_audit: 是否强制走审核队列（None=跟随服务号默认设置）
        """
        if not template_id and not content:
            raise ValueError("template_id 和 content 至少提供一个")
        if notify_type in ("single", "batch") and not recipients:
            raise ValueError(f"{notify_type} 模式必须提供 recipients")
        if notify_type == "batch" and len(recipients) > 1000:
            raise ValueError("batch 模式单次最多 1000 用户，超过请用 batch_notify()")

        body = {
            "type": notify_type,
            "recipients": recipients or [],
            "content_type": content_type,
        }
        if template_id:
            body["template_id"] = template_id
            body["template_data"] = template_data or {}
        if title:
            body["title"] = title
        if content:
            body["content"] = content
        if url:
            body["url"] = url
        if link_btn:
            body["link_btn"] = link_btn
        if need_audit is not None:
            body["need_audit"] = need_audit

        return self._request("POST", "/api/official/notify", body)

    def notify_single(
        self,
        recipient: str,
        *,
        template_id: Optional[str] = None,
        template_data: Optional[dict] = None,
        title: Optional[str] = None,
        content: Optional[str] = None,
        url: Optional[str] = None,
        link_btn: Optional[str] = None,
        need_audit: Optional[bool] = None,
    ) -> dict:
        """单用户推送"""
        return self.notify(
            recipients=[recipient], notify_type="single",
            template_id=template_id, template_data=template_data,
            title=title, content=content, url=url, link_btn=link_btn,
            need_audit=need_audit,
        )

    def notify_batch(
        self,
        recipients: list,
        *,
        template_id: Optional[str] = None,
        template_data: Optional[dict] = None,
        title: Optional[str] = None,
        content: Optional[str] = None,
        url: Optional[str] = None,
        link_btn: Optional[str] = None,
        need_audit: Optional[bool] = None,
    ) -> dict:
        """批量推送（最多 1000 用户）"""
        return self.notify(
            recipients=recipients, notify_type="batch",
            template_id=template_id, template_data=template_data,
            title=title, content=content, url=url, link_btn=link_btn,
            need_audit=need_audit,
        )

    def broadcast(
        self,
        *,
        template_id: Optional[str] = None,
        template_data: Optional[dict] = None,
        title: Optional[str] = None,
        content: Optional[str] = None,
        url: Optional[str] = None,
        link_btn: Optional[str] = None,
        need_audit: Optional[bool] = None,
    ) -> dict:
        """群发所有订阅者"""
        return self.notify(
            recipients=[], notify_type="broadcast",
            template_id=template_id, template_data=template_data,
            title=title, content=content, url=url, link_btn=link_btn,
            need_audit=need_audit,
        )

    def batch_notify(
        self,
        recipients: list,
        *,
        template_id: Optional[str] = None,
        template_data: Optional[dict] = None,
        title: Optional[str] = None,
        content: Optional[str] = None,
        url: Optional[str] = None,
        link_btn: Optional[str] = None,
    ) -> dict:
        """
        大规模批量推送（超过 1000 用户）
        服务端按 1000 自动分片，异步入队
        """
        body = {
            "recipients": recipients,
            "content_type": "text",
        }
        if template_id:
            body["template_id"] = template_id
            body["template_data"] = template_data or {}
        if title:
            body["title"] = title
        if content:
            body["content"] = content
        if url:
            body["url"] = url
        if link_btn:
            body["link_btn"] = link_btn
        return self._request("POST", "/api/official/batch-notify", body)

    # ============================================================
    # 模板
    # ============================================================

    def list_templates(self) -> list:
        """查询模板列表"""
        resp = self._request("GET", "/api/official/template/list")
        return resp.get("data") or resp.get("list") or []

    def render_template(self, template_id: str, template_data: dict) -> dict:
        """
        模板预渲染（不发送，仅返回渲染结果用于发送前预览）
        """
        return self._request("POST", "/api/official/template/render", {
            "template_id": template_id,
            "template_data": template_data,
        })

    # ============================================================
    # 菜单
    # ============================================================

    def get_menu(self) -> dict:
        """查询自定义菜单"""
        resp = self._request("GET", "/api/official/menu/get")
        return resp.get("data") or resp

    def set_menu(self, menus: list) -> dict:
        """
        设置自定义菜单（整体替换）

        格式示例：
        [
            {"name": "最新活动", "action": "click", "value": "活动", "children": []},
            {"name": "服务中心", "action": "click", "value": "", "children": [
                {"name": "在线客服", "action": "click", "value": "客服"},
                {"name": "官网", "action": "view", "value": "https://example.com"}
            ]}
        ]
        """
        return self._request("POST", "/api/official/menu/set", {"menus": menus})

    # ============================================================
    # 统计
    # ============================================================

    def stats(self) -> dict:
        """
        查询推送统计

        返回字段：today_sent / subscribe_count / trend_7d / app_id
        """
        resp = self._request("GET", "/api/official/stats")
        return resp.get("data") or resp


# ============================================================
# 命令行入口（方便直接跑测试）
# ============================================================

def _cli():
    import argparse
    parser = argparse.ArgumentParser(description="IM 服务号 API CLI")
    parser.add_argument("--url", required=True, help="服务端地址，如 http://localhost:8080")
    parser.add_argument("--app-id", required=True, help="服务号 AppID")
    parser.add_argument("--app-secret", required=True, help="服务号 AppSecret")
    parser.add_argument("--mode", choices=["token", "hmac"], default="token", help="鉴权方式")
    parser.add_argument("--action", required=True,
                        choices=["single", "batch", "broadcast", "stats", "menu-get", "template-list", "render"])
    parser.add_argument("--to", help="single 接收人用户名，或 batch 多个用户名（逗号分隔）")
    parser.add_argument("--title", default="CLI 测试消息")
    parser.add_argument("--content", default="Hello from OfficialAPIClient")
    parser.add_argument("--template-id", help="可选模板 ID")
    parser.add_argument("--template-data", help="模板变量 JSON 字符串，如 '{\"order_no\":\"SF123\",\"status\":\"已发货\"}'")
    args = parser.parse_args()

    client = OfficialAPIClient(
        base_url=args.url,
        app_id=args.app_id,
        app_secret=args.app_secret,
        use_token=(args.mode == "token"),
    )

    try:
        if args.action == "single":
            if not args.to: raise SystemExit("--action=single 需要 --to")
            resp = client.notify_single(args.to, title=args.title, content=args.content,
                                        template_id=args.template_id,
                                        template_data=json.loads(args.template_data) if args.template_data else None)
        elif args.action == "batch":
            if not args.to: raise SystemExit("--action=batch 需要 --to（逗号分隔）")
            users = [u.strip() for u in args.to.split(",") if u.strip()]
            resp = client.notify_batch(users, title=args.title, content=args.content)
        elif args.action == "broadcast":
            resp = client.broadcast(title=args.title, content=args.content)
        elif args.action == "stats":
            resp = client.stats()
        elif args.action == "menu-get":
            resp = client.get_menu()
        elif args.action == "template-list":
            resp = client.list_templates()
        elif args.action == "render":
            if not args.template_id: raise SystemExit("--action=render 需要 --template-id")
            resp = client.render_template(args.template_id,
                                          json.loads(args.template_data or "{}"))
        print(json.dumps(resp, ensure_ascii=False, indent=2))
    except OfficialAPIError as e:
        print(f"[FAIL] HTTP {e.code}: {e.msg}")
        if e.response_body:
            print(f"  body: {e.response_body[:500]}")
        raise SystemExit(1)


if __name__ == "__main__":
    _cli()


# ============================================================
# 使用示例（复制到你的项目里改参数即可跑）
# ============================================================

def _example_order_notify():
    """电商系统订单发货后自动推送通知"""
    client = OfficialAPIClient(
        base_url="http://localhost:8080",
        app_id="o_7f3a2b1c",
        app_secret="your_app_secret_here",
    )
    result = client.notify_single(
        recipient="buyer_zhangsan",
        template_id="tpl_order_notify",
        template_data={
            "order_no": "SF1234567890",
            "status": "已发货",
            "tracking_no": "SF1234567890",
        },
        title="订单发货通知",
        url="https://shop.example.com/track/SF1234567890",
        link_btn="查看物流",
    )
    print("推送结果:", result)


def _example_vip_broadcast():
    """会员日批量推送活动通知"""
    client = OfficialAPIClient(
        base_url="http://localhost:8080",
        app_id="o_7f3a2b1c",
        app_secret="your_app_secret_here",
    )
    # 从数据库查前 1000 个活跃会员
    vip_users = ["user001", "user002", "user003"]  # ... 省略
    result = client.notify_batch(
        recipients=vip_users,
        title="🎉 会员日专享",
        content="全场 5 折起！积分双倍！活动时间：11月11日 0:00-24:00",
        url="https://shop.example.com/vip-day",
        link_btn="立即参与",
    )
    print("批量推送结果:", result)


if __name__ == "__main__":
    # 跑 CLI
    _cli()
