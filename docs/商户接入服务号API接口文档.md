# 商户接入服务号 API 接口文档

> 版本：v1.0 · 基础路径：`http://{host}:{port}` · 所有接口返回 `Content-Type: application/json`

---

## 目录

1. [通用约定](#1-通用约定)
2. [鉴权机制](#2-鉴权机制)
3. [服务号管理（商户后台）](#3-服务号管理商户后台)
4. [HTTP API 接入网关（企业系统对接）](#4-http-api-接入网关企业系统对接)
5. [消息推送流程详解](#5-消息推送流程详解)
6. [审核流程详解](#6-审核流程详解)
7. [频率限制配置](#7-频率限制配置)
8. [错误码一览](#8-错误码一览)
9. [完整调用示例](#9-完整调用示例)

---

## 1. 通用约定

### 1.1 响应格式

所有接口统一返回以下 JSON 结构：

**成功响应：**
```json
{
  "ok": true,
  "data": { ... }
}
```

**失败响应：**
```json
{
  "ok": false,
  "msg": "错误描述"
}
```

> **注意**：部分 API 网关接口（`/api/official/*`）的响应格式略有不同，将在对应章节单独标注。

### 1.2 分页参数

列表类接口统一使用以下查询参数：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `page` | int | 1 | 页码（从 1 开始） |
| `size` | int | 20 | 每页数量，最大 100 |

分页响应中包含 `total` 字段表示总记录数。

### 1.3 时间格式

所有时间字段为 ISO 8601 格式（RFC3339），例如：`2026-11-11T10:00:00Z`

### 1.4 HTTP 状态码

| 状态码 | 含义 |
|--------|------|
| 200 OK | 请求成功 |
| 400 Bad Request | 参数错误 |
| 401 Unauthorized | 未登录 / Token 无效 / 签名校验失败 |
| 403 Forbidden | 无权限（服务号已停用、归属不匹配等） |
| 404 Not Found | 资源不存在 |
| 429 Too Many Requests | 频率超限 |
| 500 Internal Server Error | 服务端错误 |
| 503 Service Unavailable | 服务号功能已禁用（`enabled=false`） |

---

## 2. 鉴权机制

系统提供 **两套独立的鉴权体系**，分别用于不同的接入场景：

| 鉴权类型 | 适用场景 | 路由前缀 |
|----------|----------|----------|
| **管理员/商户 Session** | 后台管理页面（Cookie 登录态） | `/admin/api/official/*`、`/api/merchant/official/*` |
| **API 签名鉴权** | 企业内部系统对接（无登录态） | `/api/official/*` |

### 2.1 API 签名鉴权（企业系统对接）

每个服务号独立拥有 `AppID` 和 `AppSecret`，支持两种认证方式：

#### 方式 A：Bearer Token（推荐）

**步骤：**

```
① POST /api/official/token  获取 Access Token（有效期 2 小时，滑动续期）
② 后续所有请求带 Header: Authorization: Bearer <token>
```

#### 方式 B：HMAC-SHA256 签名

适用于无法保存 Token、需要每次独立签名的场景。

**请求头：**

| Header | 值 | 说明 |
|--------|-----|------|
| `X-Official-AppID` | `o_7f3a2b1c` | 服务号 AppID |
| `X-Official-Signature` | `<hex签名>` | 签名结果 |
| `X-Official-Timestamp` | `1731148800` | 当前 Unix 时间戳（秒） |
| `X-Official-Nonce` | `<uuid或随机串>` | 唯一随机值，防重放（10 分钟内不可重复） |

**签名算法：**

```
1. 计算请求体 SHA256：
   body_hash = sha256_hex(request_body_bytes)

2. 拼接待签名字符串：
   string_to_sign = timestamp + "\n" + nonce + "\n" + body_hash

3. 计算 HMAC-SHA256：
   signature = hex(hash_hmac_sha256(plain_app_secret, string_to_sign))
```

**伪代码示例（Python）：**

```python
import hmac, hashlib, time, uuid, json

def sign_request(app_id, app_secret, body_bytes):
    timestamp = str(int(time.time()))
    nonce = str(uuid.uuid4())
    body_hash = hashlib.sha256(body_bytes).hexdigest()
    string_to_sign = f"{timestamp}\n{nonce}\n{body_hash}"
    signature = hmac.new(
        app_secret.encode(),
        string_to_sign.encode(),
        hashlib.sha256
    ).hexdigest()
    return {
        "X-Official-AppID": app_id,
        "X-Official-Signature": signature,
        "X-Official-Timestamp": timestamp,
        "X-Official-Nonce": nonce
    }
```

**安全校验规则：**

| 校验项 | 规则 | Redis Key |
|--------|------|-----------|
| 时间戳 | 与服务端时差 ≤ 300 秒（5 分钟） | — |
| Nonce 防重放 | 重复 nonce 直接拒绝 | `im:official:nonce:<nonce>`, TTL=10min |
| Body 完整性 | SHA256 必须与请求体一致 | — |
| 密钥正确性 | `PlainSecret` 明文比对 | — |
| 服务号状态 | `status=0`（正常）才允许操作 | — |

---

## 3. 服务号管理（商户后台）

### 3.1 获取商户登录态

商户登录后（`role=2`），会获得 `merchant_token` Cookie，后续所有 `/api/merchant/*` 接口自动携带。

> **商户前置条件**：用户名 `role=2`（商户角色），由管理员在后台分配。

---

### 3.2 服务号 CRUD

#### 3.2.1 创建服务号

**`POST /api/merchant/official/accounts`**

> 商户创建的服务号 **owner 自动设为当前商户用户名**，need_audit 默认为 `true`。

**请求体：**

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `display_name` | string | ✅ | — | 服务号展示名（≤64 字符） |
| `description` | string | ❌ | `""` | 简介（≤255 字符） |
| `avatar` | string | ❌ | `""` | 头像 URL（建议 `/static/upload/xxx.jpg`） |
| `need_audit` | bool | ❌ | `true` | 推送是否需要审核 |
| `max_per_day` | int | ❌ | `0` | 每日推送上限（0=不限） |

**成功响应：**

```json
{
  "ok": true,
  "data": {
    "id": 1,
    "app_id": "o_7f3a2b1c",
    "app_secret": "a1b2c3d4e5f6...",
    "message": "创建成功，请妥善保管 app_secret（仅显示一次）"
  }
}
```

> ⚠️ **AppSecret 仅创建时返回一次，请妥善保管！** 后续可通过重置接口重新生成。

---

#### 3.2.2 查询我的服务号列表

**`GET /api/merchant/official/accounts`**

**查询参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `page` | int | ❌ | 页码，默认 1 |
| `size` | int | ❌ | 每页数量，默认 20，最大 100 |
| `keyword` | string | ❌ | 按 `display_name` 或 `app_id` 模糊搜索 |

**成功响应：**

```json
{
  "ok": true,
  "data": {
    "list": [
      {
        "id": 1,
        "app_id": "o_7f3a2b1c",
        "display_name": "精选商城",
        "description": "优质商品每日上新",
        "status": 0,
        "need_audit": true,
        "max_per_day": 10000,
        "subscribe_count": 156,
        "today_sent": 23,
        "avatar": "/static/upload/shop.jpg",
        "create_time": "2026-11-11T10:00:00Z"
      }
    ],
    "total": 2,
    "page": 1,
    "size": 20
  }
}
```

---

#### 3.2.3 查询服务号详情

**`GET /api/merchant/official/accounts/{id}`**

**路径参数：**

| 参数 | 说明 |
|------|------|
| `id` | 服务号 ID（主键） |

**成功响应：**

```json
{
  "ok": true,
  "data": {
    "account": {
      "id": 1,
      "owner": "merchant01",
      "app_id": "o_7f3a2b1c",
      "display_name": "精选商城",
      "avatar": "/static/upload/shop.jpg",
      "description": "优质商品每日上新",
      "status": 0,
      "need_audit": true,
      "subscribe_count": 156,
      "max_per_day": 10000,
      "today_sent": 23,
      "auditors": "[]",
      "create_time": "2026-11-11T10:00:00Z",
      "update_time": "2026-11-11T10:00:00Z"
    },
    "subscribe_count": 156
  }
}
```

---

#### 3.2.4 更新服务号

**`PUT /api/merchant/official/accounts/{id}`**

**请求体（所有字段可选，传了才更新）：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `display_name` | string | 展示名（不可为空） |
| `description` | string | 简介 |
| `avatar` | string | 头像 URL |
| `need_audit` | bool | 是否需要审核 |
| `max_per_day` | int | 每日推送上限 |

**成功响应：**

```json
{ "ok": true, "data": { "ok": true } }
```

---

#### 3.2.5 删除服务号

**`DELETE /api/merchant/official/accounts/{id}`**

> **注意**：级联删除菜单、模板、订阅关系、推送记录、审核记录，操作不可恢复！

**成功响应：**

```json
{ "ok": true, "data": { "ok": true } }
```

---

#### 3.2.6 重置 AppSecret

**`PUT /api/merchant/official/accounts/{id}/secret`**

> 原密钥立即失效，新密钥仅返回一次。

**成功响应：**

```json
{
  "ok": true,
  "data": {
    "app_id": "o_7f3a2b1c",
    "app_secret": "new_secret_xxxxx",
    "message": "密钥已重置，原密钥立即失效。请妥善保管新密钥（仅显示一次）"
  }
}
```

---

### 3.3 自定义菜单管理

每个服务号最多 **3 个一级菜单 × 每个一级最多 5 个二级菜单**。

| action | 说明 |
|--------|------|
| `click` | 点击后触发关键词自动回复（value 作为触发词） |
| `view` | 点击后跳转 URL（value 为跳转地址） |

#### 3.3.1 查询菜单

**`GET /api/merchant/official/accounts/{id}/menu`**

**成功响应：**

```json
{
  "ok": true,
  "data": {
    "menus": [
      {
        "id": 1,
        "account_id": 1,
        "parent_id": 0,
        "name": "菜单1",
        "action": "click",
        "value": "关键词1",
        "sort_order": 0,
        "children": [
          {
            "id": 2,
            "parent_id": 1,
            "name": "子菜单1-1",
            "action": "view",
            "value": "https://example.com"
          }
        ]
      }
    ]
  }
}
```

---

#### 3.3.2 设置菜单（整体替换）

**`POST /api/merchant/official/accounts/{id}/menu`**

> 事务操作：先清空旧菜单，再写入新菜单树。

**请求体：**

```json
{
  "menus": [
    {
      "name": "最新活动",
      "action": "click",
      "value": "活动",
      "children": []
    },
    {
      "name": "服务中心",
      "action": "click",
      "value": "",
      "children": [
        { "name": "在线客服", "action": "click", "value": "客服" },
        { "name": "意见反馈", "action": "view", "value": "https://example.com/feedback" }
      ]
    }
  ]
}
```

**成功响应：**

```json
{ "ok": true, "data": { "ok": true, "menu_count": 3 } }
```

---

### 3.4 模板消息管理

模板用于标准化推送内容，支持 `{{key}}` 占位符。

#### 3.4.1 查询模板列表

**`GET /api/merchant/official/accounts/{id}/templates`**

**成功响应：**

```json
{
  "ok": true,
  "data": [
    {
      "id": 1,
      "account_id": 1,
      "template_id": "tpl_order_notify",
      "name": "订单发货通知",
      "content": "您的订单 {{order_no}} 状态：{{status}}\n快递单号：{{tracking_no}}",
      "example": "您的订单 SF123456 状态：已发货\n快递单号：SF1234567890",
      "create_time": "2026-11-11T10:00:00Z"
    }
  ]
}
```

---

#### 3.4.2 创建模板

**`POST /api/merchant/official/accounts/{id}/templates`**

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | 模板名称 |
| `content` | string | ✅ | 模板正文（支持 `{{变量名}}` 占位符） |
| `example` | string | ❌ | 渲染示例（帮助商户预览效果） |
| `template_id` | string | ❌ | 不传则自动生成 `tpl_xxxxxxxx` 格式 |

**成功响应：**

```json
{
  "ok": true,
  "data": {
    "id": 1,
    "account_id": 1,
    "template_id": "tpl_a1b2c3d4",
    "name": "订单发货通知",
    "content": "您的订单 {{order_no}} 状态：{{status}}",
    "example": ""
  }
}
```

---

#### 3.4.3 更新模板

**`PUT /api/merchant/official/templates/{id}`**

**请求体（所有字段可选）：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 模板名称 |
| `content` | string | 模板正文 |
| `example` | string | 渲染示例 |

---

#### 3.4.4 删除模板

**`DELETE /api/merchant/official/templates/{id}`**

**成功响应：**

```json
{ "ok": true, "data": { "ok": true } }
```

---

### 3.5 关键词自动回复

用户在服务号聊天框发送消息时，系统自动匹配关键词并回复。

**匹配优先级：** `exact 精确匹配` > `fuzzy 包含匹配`；同优先级按 `sort_order` 升序取首个命中。

#### 3.5.1 查询关键词列表

**`GET /api/merchant/official/accounts/{id}/keywords`**

---

#### 3.5.2 创建关键词

**`POST /api/merchant/official/accounts/{id}/keywords`**

**请求体：**

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `keyword` | string | ✅ | — | 触发词（≤64 字符） |
| `reply_text` | string | ✅ | — | 回复内容（≤text 上限） |
| `match_type` | string | ❌ | `fuzzy` | 匹配模式：`exact` 精确 / `fuzzy` 包含 |
| `enabled` | bool | ❌ | `true` | 是否启用 |
| `sort_order` | int | ❌ | `0` | 排序（越小越优先） |

**请求示例：**
```json
{
  "keyword": "客服",
  "reply_text": "您好！请致电客服热线 400-888-8888（8:00-22:00），或留下联系方式我们会尽快联系您。",
  "match_type": "exact",
  "sort_order": 10
}
```

---

#### 3.5.3 更新关键词

**`PUT /api/merchant/official/keywords/{id}`**

**请求体（所有字段可选）：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `keyword` | string | 触发词 |
| `reply_text` | string | 回复内容 |
| `match_type` | string | `exact` / `fuzzy` |
| `enabled` | bool | 是否启用 |
| `sort_order` | int | 排序 |

---

#### 3.5.4 删除关键词

**`DELETE /api/merchant/official/keywords/{id}`**

---

### 3.6 审核管理

#### 3.6.1 查询待审核列表

**`GET /api/merchant/official/audit/pending`**

> 商户只能看到 **自己 owner 的服务号** 的待审核消息。

**查询参数：** `page` / `size`（通用分页参数）

---

#### 3.6.2 查询全部审核记录

**`GET /api/merchant/official/audit/all`**

---

#### 3.6.3 通过审核

**`POST /api/merchant/official/audit/{id}/approve`**

> 审核通过后，消息立即进入 Worker Pool 发送队列。

---

#### 3.6.4 驳回审核

**`POST /api/merchant/official/audit/{id}/reject`**

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `remark` | string | ✅ | 驳回原因（必填） |

```json
{ "remark": "内容包含敏感词，请修改后重新提交" }
```

---

## 4. HTTP API 接入网关（企业系统对接）

### 4.1 获取 Access Token

**`POST /api/official/token`**

> 无需鉴权端点。Token 有效期 2 小时，期间内每次使用会自动续期（滑动窗口）。

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `app_id` | string | ✅ | 服务号 AppID（如 `o_7f3a2b1c`） |
| `app_secret` | string | ✅ | 服务号 AppSecret |

**成功响应：**

```json
{
  "ok": true,
  "data": {
    "access_token": "abc123def456...",
    "expires_in": 7200
  }
}
```

> 后续所有 `/api/official/*` 请求需携带 `Authorization: Bearer <token>` Header。

---

### 4.2 核心推送接口

#### 4.2.1 标准推送

**`POST /api/official/notify`**

**请求体：**

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `type` | string | ❌ | `single` | 推送模式：`single` 单推 / `batch` 多推 / `broadcast` 群发 |
| `recipients` | string[] | 条件必填 | — | `single`/`batch` 必填，接收人用户名数组 |
| `template_id` | string | ❌ | — | 模板 ID（优先使用模板渲染内容） |
| `template_data` | object | ❌ | — | 模板变量，如 `{"order_no":"SF123456","status":"已发货"}` |
| `title` | string | ❌ | — | 消息标题（会话列表摘要优先取此字段） |
| `content` | string | 条件必填 | — | 消息正文（未使用模板时必填） |
| `content_type` | string | ❌ | `text` | 内容类型：`text` / `image` / `news` / `template` |
| `url` | string | ❌ | — | 点击跳转链接 |
| `link_btn` | string | ❌ | — | 按钮文字（如「查看详情」） |
| `need_audit` | bool | ❌ | 跟随服务号默认 | 是否强制进入审核（覆盖服务号默认设置） |

**推送模式说明：**

| type | recipients 要求 | 行为 |
|------|-----------------|------|
| `single` | 数组中 1 个用户名 | 同步发送，立即返回结果 |
| `batch` | 数组中 1-1000 个用户名 | 异步入队，Worker Pool 消费 |
| `broadcast` | 忽略此字段 | 推送给所有订阅了该服务号的用户 |

**请求示例 — 单推模板消息：**

```json
{
  "type": "single",
  "recipients": ["user1"],
  "template_id": "tpl_order_notify",
  "template_data": {
    "order_no": "SF123456",
    "status": "已发货",
    "tracking_no": "SF1234567890"
  },
  "title": "订单发货通知"
}
```

**请求示例 — 批量推送：**

```json
{
  "type": "batch",
  "recipients": ["user1", "user2", "user3"],
  "title": "会员专享活动",
  "content": "双十一全场 5 折起，快来选购吧！\n活动时间：11月11日 0:00-24:00",
  "url": "https://example.com/activity",
  "link_btn": "立即查看"
}
```

**请求示例 — 群发所有订阅者：**

```json
{
  "type": "broadcast",
  "title": "系统维护公告",
  "content": "系统将于今晚 22:00-23:00 进行升级维护，期间服务暂时不可用，敬请谅解。"
}
```

**成功响应（need_audit=false 直通模式）：**

```json
{
  "ok": true,
  "data": {
    "code": 0,
    "message": "ok",
    "type": "single",
    "sent": 1,
    "message_id": 123
  }
}
```

**成功响应（need_audit=true 审核模式）：**

```json
{
  "ok": true,
  "data": {
    "code": 0,
    "message": "已进入审核队列",
    "message_id": 124,
    "audit_status": "pending"
  }
}
```

---

#### 4.2.2 大规模批量推送

**`POST /api/official/batch-notify`**

> 与 `notify type=batch` 类似，但支持 **超过 1000 用户** 的批量推送，自动分片入队。

**请求体：** 与 `notify` 的 batch 模式基本一致，但：

- 无 `type` 字段（固定为批量）
- `recipients` 无上限，服务端按 1000 自动分片
- 无 `need_audit` 覆盖字段（跟随服务号默认设置）

**成功响应：**

```json
{
  "ok": true,
  "data": {
    "code": 0,
    "message": "已入队异步发送",
    "total": 15000
  }
}
```

---

### 4.3 模板相关接口

#### 4.3.1 模板列表

**`GET /api/official/template/list`**

---

#### 4.3.2 模板预渲染（不发送）

**`POST /api/official/template/render`**

> 传入 template_id + template_data，仅返回渲染后的内容，不实际推送。可用于发送前预览。

**请求体：**

```json
{
  "template_id": "tpl_order_notify",
  "template_data": {
    "order_no": "SF123456",
    "status": "已发货"
  }
}
```

**成功响应：**

```json
{
  "ok": true,
  "data": {
    "template_id": "tpl_order_notify",
    "name": "订单发货通知",
    "rendered": "您的订单 SF123456 状态：已发货\n快递单号：..."
  }
}
```

---

### 4.4 自定义菜单接口

#### 4.4.1 更新菜单

**`POST /api/official/menu/set`**

> 与商户后台的菜单设置接口功能一致，支持服务端直接配置菜单。

**请求体：** 同 [3.3.2 设置菜单](#332-设置菜单整体替换)

---

#### 4.4.2 查询菜单

**`GET /api/official/menu/get`**

**成功响应：**

```json
{
  "ok": true,
  "data": {
    "account_id": 1,
    "app_id": "o_7f3a2b1c",
    "menus": [
      {
        "id": 1,
        "name": "最新活动",
        "action": "click",
        "value": "活动",
        "children": []
      }
    ]
  }
}
```

---

### 4.5 统计接口

#### 4.5.1 推送统计

**`GET /api/official/stats`**

**成功响应：**

```json
{
  "ok": true,
  "data": {
    "app_id": "o_7f3a2b1c",
    "account_id": 1,
    "today_sent": 23,
    "today_redis": 23,
    "subscribe_count": 156,
    "trend_7d": [
      { "date": "2026-11-05", "count": 0 },
      { "date": "2026-11-06", "count": 15 },
      { "date": "2026-11-07", "count": 20 },
      { "date": "2026-11-08", "count": 18 },
      { "date": "2026-11-09", "count": 22 },
      { "date": "2026-11-10", "count": 25 },
      { "date": "2026-11-11", "count": 23 }
    ]
  }
}
```

---

## 5. 消息推送流程详解

### 5.1 完整链路图

```
┌────────────────────────────────────────────────────────────────────┐
│ 企业系统                                                            │
│ (ERP / CRM / 自研系统)                                               │
└──────────────┬─────────────────────────────────────────────────────┘
               │ POST /api/official/notify
               │ Authorization: Bearer <token>
               │ 或 HMAC-SHA256 签名
               ▼
┌────────────────────────────────────────────────────────────────────┐
│ API 网关层                                                          │
│ ① L0 总开关（config.enabled=false → 503）                           │
│ ② L1 全局 QPS 限流（默认 50 次/秒）                                   │
│ ③ 鉴权（Token 或 HMAC 签名校验）                                      │
│ ④ L2 单 API 频率限流（默认 60 次/分钟）                                │
│ ⑤ 服务号状态校验（status=0）                                         │
└──────────────┬─────────────────────────────────────────────────────┘
               │
               ▼
┌────────────────────────────────────────────────────────────────────┐
│ 请求体处理                                                          │
│ ① template_id 存在 → 查模板表 → 渲染 {{变量}}                       │
│ ② need_audit 判断（请求参数 > 服务号默认）                            │
│ ③ max_per_day 日配额校验                                              │
│ ④ 入库 im_official_message                                          │
└──────────┬──────────────────────────────────────┬──────────────────┘
           │                                      │
    need_audit=false                         need_audit=true
           │                                      │
           ▼                                      ▼
┌───────────────────┐                  ┌─────────────────────────────┐
│ 直通发送队列        │                  │ 审核队列                       │
│ Worker Pool 异步消费 │                  │ ① 入库 im_official_audit    │
│ ① 校验订阅关系       │                  │ ② 向审核人推 118 信令        │
│ ② 落库 im_message   │                  │ ③ 审核人通过 → 进发送队列      │
│ ③ 在线用户 WebSocket │                  │ ④ 审核人驳回 → 通知发起人      │
│ ④ 离线用户入队       │                  └─────────────────────────────┘
│ ⑤ touchConversation │
│ ⑥ 更新未读角标       │
└───────────────────┘
```

### 5.2 推送信封格式（MsgType=117）

实际下发给用户的消息内容格式：

```json
{
  "official": {
    "app_id": "o_7f3a2b1c",
    "msg_type": "text",
    "title": "您的订单已发货",
    "content": "快递单号 SF1234567890，预计3天内送达",
    "url": "https://example.com/track",
    "link_btn": "查看详情"
  }
}
```

消息存储在 `im_message` 表中，关键字段：

| 字段 | 值 |
|------|-----|
| `msg_type` | `117`（服务号消息） |
| `from_user` | `o_7f3a2b1c`（`o_` + app_id） |
| `to_user` | 接收人用户名 |
| `content` | 上述 JSON 信封 |

### 5.3 Worker Pool 消费模型

```
请求 ──RPush──▶ Redis List (im:official:queue:<appid>)
                        │
                        ▼
              ┌─────────────────────┐
              │ 扇出协程 (200ms 扫描)  │
              │ SCAN + LPop          │
              └─────────┬───────────┘
                        │ pushCh（有界 channel）
                        ▼
              ┌─────────────────────┐
              │ Worker Pool (N 个)   │  N = config.batch_workers（默认 10）
              │ goroutine × N        │
              └─────────┬───────────┘
                        │ 每条任务
                        ▼
              sendOfficialOne()
              ┌──────────────────────┐
              │ ① 校验 userIsSubscribed │  未关注 → 跳过
              │ ② 构造信封 JSON        │
              │ ③ 落库 im_message      │
              │ ④ 在线 → WebSocket 推送  │
              │    离线 → queueOffline  │
              │ ⑤ touchConversation   │  未读角标 +1
              └──────────────────────┘
```

---

## 6. 审核流程详解

### 6.1 审核状态机

```
                  ┌──────────────────────────────┐
                  │                              │
     [API/请求] ──┴──▶ pending ──APPROVE──▶ approved ──▶ [进入发送队列]
                            │
                            └──REJECT──▶ rejected ──▶ [通知发起人驳回原因]
```

### 6.2 审核人权限矩阵

| 审核人 | 可审核的服务号 | 说明 |
|--------|---------------|------|
| 系统管理员（role=1） | 全部 | 最高权限 |
| 服务号归属商户（owner） | owner = 自己 username 的 | 商户只能审核自己创建的 |
| 授权审核人（auditors） | JSON 数组中包含自己用户名的 | 扩展的授权机制 |

### 6.3 审核后动作

**通过（approve）：**
1. `official_audit.status` → `approved`
2. `official_message.audit_status` → `approved`
3. 重建 `OfficialSendReq` → 根据 `recipient` 字段判断发送模式：
   - `recipient` 为空 → `SendOfficialBroadcast`
   - `recipient` 包含逗号 → `SendOfficialBatchMsg`
   - 单个值 → `SendOfficialMsg`
4. 进入 Worker Pool 异步发送

**驳回（reject）：**
1. `official_audit.status` → `rejected`
2. `official_message.audit_status` → `rejected`
3. `official_message.audit_remark` = 驳回原因（必填）
4. 向所有审核人 + 商户 owner 推 MsgType=118（审核状态变更通知）

### 6.4 审核状态通知（MsgType=118）

审核人/商户 owner 会收到以下结构的 WebSocket 消息：

```json
{
  "msg_type": 118,
  "from_user": "system",
  "from_name": "服务号审核",
  "content": {
    "message_id": 124,
    "audit_id": 5,
    "app_id": "o_7f3a2b1c",
    "status": "approved",
    "remark": "",
    "actor": "merchant01",
    "account_name": "精选商城"
  }
}
```

---

## 7. 频率限制配置

频率限制在服务端统一生效，无需商户自行控制。

### 7.1 四层限流体系

| 层级 | 配置项 | 默认值 | Redis Key | 说明 |
|------|--------|--------|-----------|------|
| **L0 总开关** | `official.enabled` | `true` | — | 关闭后所有 API 返回 503 |
| **L1 全局 QPS** | `official.global_qps` | `50` | `im:official:global:qps` | 所有官方 API 共享 |
| **L2 单 API 分钟级** | `official.api_per_minute` | `60` | `im:official:ratelimit:<appid>` | 每个服务号独立计数 |
| **L3 服务号日配额** | `max_per_day` | `0`（不限） | `im:official:daily:<appid>` | 服务号级别限制 |
| **L4 用户接收频率** | `official.user_per_hour` | `5` | `im:official:userlimit:<username>` | 防骚扰，单用户每小时最多接收 5 条 |

### 7.2 config.yaml 配置参考

```yaml
official:
  # 总开关
  enabled: true

  # 频率限制
  global_qps: 50          # L1 全局 QPS
  api_per_minute: 60      # L2 单 API 分钟级
  user_per_hour: 5        # L4 用户小时级

  # 推送执行
  batch_workers: 10       # Worker Pool goroutine 数
  batch_size: 500         # 单批次处理大小

  # 自动回复
  default_reply: "您好，请问有什么可以帮您？"
```

---

## 8. 错误码一览

### 8.1 HTTP 状态码 + 业务消息

| HTTP | msg | 触发场景 |
|------|-----|----------|
| 200 | — | 请求成功 |
| 400 | 参数错误 / 请求体为空 / 参数缺失 | 必填字段缺失 |
| 400 | 消息内容为空 | content 和 template_id 都为空 |
| 400 | 超过每日配额（max_per_day=N） | 服务号日推送量超限 |
| 401 | token 为空 / token 无效或过期 | Bearer Token 鉴权失败 |
| 401 | 请求已处理（nonce 重复） | HMAC 重放攻击 |
| 401 | 时间戳过期 | HMAC timestamp 超出 ±5min 窗口 |
| 401 | 签名校验失败 | HMAC 签名不匹配 |
| 401 | app_secret 错误 | Token 端点密钥错误 |
| 403 | 服务号不存在或已停用 | 服务号 status≠0 |
| 403 | 无权限操作该服务号 | 商户 owner 不匹配 |
| 404 | 服务号不存在 / 模板不存在 / 审核记录不存在 | 资源不存在 |
| 429 | 全局 QPS 超限 | L1 限流触发 |
| 429 | API 频率超限（N/min） | L2 限流触发 |
| 503 | 服务号功能已禁用（enabled=false） | 总开关关闭 |

### 8.2 统一错误响应格式

```json
{
  "ok": false,
  "msg": "具体错误描述"
}
```

---

## 9. 完整调用示例

### 9.1 Python SDK 封装示例

```python
import hmac, hashlib, time, uuid, json
import urllib.request

class OfficialAPIClient:
    """服务号 API 客户端"""
    
    def __init__(self, base_url, app_id, app_secret, use_token=True):
        self.base_url = base_url.rstrip('/')
        self.app_id = app_id
        self.app_secret = app_secret
        self.use_token = use_token
        self._token = None
        self._token_expire = 0

    # ========== 鉴权 ==========
    
    def _get_token(self):
        """获取或刷新 Access Token"""
        if self._token and time.time() < self._token_expire - 300:
            return self._token
        
        body = json.dumps({"app_id": self.app_id, "app_secret": self.app_secret}).encode()
        req = urllib.request.Request(
            f"{self.base_url}/api/official/token",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        resp = urllib.request.urlopen(req)
        data = json.loads(resp.read())["data"]
        self._token = data["access_token"]
        self._token_expire = time.time() + data["expires_in"]
        return self._token
    
    def _sign_headers(self, body_bytes):
        """HMAC-SHA256 签名"""
        timestamp = str(int(time.time()))
        nonce = str(uuid.uuid4())
        body_hash = hashlib.sha256(body_bytes).hexdigest()
        string_to_sign = f"{timestamp}\n{nonce}\n{body_hash}"
        signature = hmac.new(
            self.app_secret.encode(),
            string_to_sign.encode(),
            hashlib.sha256
        ).hexdigest()
        return {
            "X-Official-AppID": self.app_id,
            "X-Official-Signature": signature,
            "X-Official-Timestamp": timestamp,
            "X-Official-Nonce": nonce
        }
    
    def _request(self, path, method="GET", body=None):
        url = f"{self.base_url}{path}"
        body_bytes = json.dumps(body).encode() if body else b""
        
        headers = {"Content-Type": "application/json"}
        if self.use_token:
            token = self._get_token()
            headers["Authorization"] = f"Bearer {token}"
        else:
            headers.update(self._sign_headers(body_bytes))
        
        req = urllib.request.Request(url, data=body_bytes or None, headers=headers, method=method)
        try:
            resp = urllib.request.urlopen(req)
            return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            err_body = e.read().decode()
            print(f"[ERROR] {e.code}: {err_body}")
            raise
    
    # ========== 推送接口 ==========
    
    def notify_single(self, recipient, title=None, content=None,
                      template_id=None, template_data=None,
                      url=None, link_btn=None):
        """单用户推送"""
        body = {
            "type": "single",
            "recipients": [recipient],
        }
        if template_id:
            body["template_id"] = template_id
            body["template_data"] = template_data or {}
        else:
            body["title"] = title
            body["content"] = content
        if url:
            body["url"] = url
        if link_btn:
            body["link_btn"] = link_btn
        
        return self._request("/api/official/notify", "POST", body)
    
    def notify_batch(self, recipients, title=None, content=None,
                     template_id=None, template_data=None,
                     url=None, link_btn=None):
        """批量推送（最多 1000 用户）"""
        body = {
            "type": "batch",
            "recipients": recipients,
        }
        if template_id:
            body["template_id"] = template_id
            body["template_data"] = template_data or {}
        else:
            body["title"] = title
            body["content"] = content
        if url:
            body["url"] = url
        if link_btn:
            body["link_btn"] = link_btn
        
        return self._request("/api/official/notify", "POST", body)
    
    def broadcast(self, title, content, url=None, link_btn=None):
        """群发所有订阅者"""
        body = {
            "type": "broadcast",
            "title": title,
            "content": content,
        }
        if url:
            body["url"] = url
        if link_btn:
            body["link_btn"] = link_btn
        
        return self._request("/api/official/notify", "POST", body)
    
    def stats(self):
        """获取推送统计"""
        return self._request("/api/official/stats", "GET")


# ========== 使用示例 ==========

if __name__ == "__main__":
    client = OfficialAPIClient(
        base_url="http://localhost:8080",
        app_id="o_7f3a2b1c",
        app_secret="your_app_secret_here",
        use_token=True  # True=Bearer Token（推荐）, False=HMAC-SHA256
    )
    
    # 1. 单推模板消息
    result = client.notify_single(
        recipient="user1",
        template_id="tpl_order_notify",
        template_data={
            "order_no": "SF123456",
            "status": "已发货",
            "tracking_no": "SF1234567890"
        },
        title="订单发货通知"
    )
    print("单推结果:", result)
    
    # 2. 批量推送（最多 1000 用户）
    result = client.notify_batch(
        recipients=["user1", "user2", "user3"],
        title="会员专享活动",
        content="双十一全场 5 折起！",
        url="https://example.com/activity",
        link_btn="立即查看"
    )
    print("批量推送结果:", result)
    
    # 3. 群发所有订阅者
    result = client.broadcast(
        title="系统维护公告",
        content="今晚 22:00-23:00 系统升级，敬请谅解。"
    )
    print("群发结果:", result)
    
    # 4. 查看统计
    stats = client.stats()
    print("推送统计:", json.dumps(stats, indent=2, ensure_ascii=False))
```

---

### 9.2 cURL 命令示例

#### 获取 Token

```bash
curl -X POST http://localhost:8080/api/official/token \
  -H "Content-Type: application/json" \
  -d '{"app_id":"o_7f3a2b1c","app_secret":"your_secret"}'
```

#### 单推消息（Bearer Token）

```bash
curl -X POST http://localhost:8080/api/official/notify \
  -H "Authorization: Bearer abc123def456" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "single",
    "recipients": ["user1"],
    "title": "订单发货通知",
    "content": "快递单号 SF1234567890",
    "url": "https://example.com/track",
    "link_btn": "查看详情"
  }'
```

#### HMAC-SHA256 签名示例（Node.js）

```javascript
const crypto = require('crypto');

const appId = 'o_7f3a2b1c';
const appSecret = 'your_app_secret';
const body = JSON.stringify({
  type: 'single',
  recipients: ['user1'],
  title: '测试消息',
  content: 'Hello World'
});

const timestamp = Math.floor(Date.now() / 1000).toString();
const nonce = crypto.randomUUID();
const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
const stringToSign = `${timestamp}\n${nonce}\n${bodyHash}`;
const signature = crypto.createHmac('sha256', appSecret).update(stringToSign).digest('hex');

console.log(JSON.stringify({
  'X-Official-AppID': appId,
  'X-Official-Signature': signature,
  'X-Official-Timestamp': timestamp,
  'X-Official-Nonce': nonce
}, null, 2));
```

---

### 9.3 创建服务号 + 发送消息的完整流程

```
Step 1: 商户登录后台
  GET /login?username=merchant01&password=xxx
  → 获得 merchant_token Cookie

Step 2: 创建服务号
  POST /api/merchant/official/accounts
  Body: { "display_name": "精选商城", "need_audit": true }
  → 返回 app_id=o_a1b2c3d4, app_secret=xxxxxxxx (仅显示一次)

Step 3: 创建模板
  POST /api/merchant/official/accounts/{id}/templates
  Body: {
    "name": "订单通知",
    "content": "订单 {{order_no}} 状态：{{status}}"
  }
  → 返回 template_id=tpl_a1b2c3d4

Step 4: 用户端关注（通过 WebSocket）
  MsgType=114: {"action":"subscribe","app_id":"o_a1b2c3d4"}

Step 5: 企业系统推送消息
  POST /api/official/token → 获取 access_token
  
  POST /api/official/notify
  Authorization: Bearer <token>
  Body: {
    "type": "single",
    "recipients": ["user1"],
    "template_id": "tpl_a1b2c3d4",
    "template_data": {"order_no":"SF123456","status":"已发货"}
  }
  → need_audit=true → 返回 message_id=124, audit_status=pending

Step 6: 商户审核通过
  POST /api/merchant/official/audit/124/approve
  → 消息立即进入 Worker Pool 发送队列

Step 7: 用户收到消息
  WebSocket 收到 MsgType=117
  → 会话列表显示未读角标 +1
```

---

## 附录 A：路由总览

### A.1 API 网关路由（企业系统对接）

| 方法 | 路径 | 鉴权 | 用途 |
|------|------|------|------|
| POST | `/api/official/token` | ❌ 无需 | 获取 Access Token |
| POST | `/api/official/notify` | ✅ | 核心推送（single/batch/broadcast） |
| POST | `/api/official/batch-notify` | ✅ | 大规模批量推送 |
| POST | `/api/official/template/render` | ✅ | 模板预渲染（不发送） |
| POST | `/api/official/menu/set` | ✅ | 更新自定义菜单 |
| GET | `/api/official/menu/get` | ✅ | 查询当前菜单 |
| GET | `/api/official/stats` | ✅ | 推送统计 |
| GET | `/api/official/template/list` | ✅ | 模板列表 |

### A.2 商户后台路由（Session 鉴权）

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/merchant/official/accounts` | 查询我的服务号列表 |
| POST | `/api/merchant/official/accounts` | 创建服务号 |
| GET | `/api/merchant/official/accounts/{id}` | 查询服务号详情 |
| PUT | `/api/merchant/official/accounts/{id}` | 更新服务号 |
| DELETE | `/api/merchant/official/accounts/{id}` | 删除服务号 |
| PUT | `/api/merchant/official/accounts/{id}/secret` | 重置密钥 |
| GET | `/api/merchant/official/accounts/{id}/menu` | 查询菜单 |
| POST | `/api/merchant/official/accounts/{id}/menu` | 设置菜单 |
| GET | `/api/merchant/official/accounts/{id}/templates` | 查询模板列表 |
| POST | `/api/merchant/official/accounts/{id}/templates` | 创建模板 |
| PUT | `/api/merchant/official/templates/{id}` | 更新模板 |
| DELETE | `/api/merchant/official/templates/{id}` | 删除模板 |
| GET | `/api/merchant/official/accounts/{id}/keywords` | 查询关键词列表 |
| POST | `/api/merchant/official/accounts/{id}/keywords` | 创建关键词 |
| PUT | `/api/merchant/official/keywords/{id}` | 更新关键词 |
| DELETE | `/api/merchant/official/keywords/{id}` | 删除关键词 |
| GET | `/api/merchant/official/audit/pending` | 待审核列表 |
| GET | `/api/merchant/official/audit/all` | 全部审核记录 |
| POST | `/api/merchant/official/audit/{id}/approve` | 通过审核 |
| POST | `/api/merchant/official/audit/{id}/reject` | 驳回审核 |

### A.3 管理员后台路由（admin_token 鉴权）

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/admin/api/official/accounts` | 所有服务号列表（分页+搜索） |
| POST | `/admin/api/official/accounts` | 创建服务号（可指定 owner） |
| GET | `/admin/api/official/accounts/{id}` | 服务号详情 |
| PUT | `/admin/api/official/accounts/{id}` | 更新服务号（含 status） |
| DELETE | `/admin/api/official/accounts/{id}` | 删除服务号 |
| PUT | `/admin/api/official/accounts/{id}/secret` | 重置密钥 |
| GET | `/admin/api/official/accounts/{id}/menu` | 查询菜单 |
| POST | `/admin/api/official/accounts/{id}/menu` | 设置菜单 |
| GET | `/admin/api/official/accounts/{id}/templates` | 查询模板 |
| POST | `/admin/api/official/accounts/{id}/templates` | 创建模板 |
| PUT | `/admin/api/official/templates/{id}` | 更新模板 |
| DELETE | `/admin/api/official/templates/{id}` | 删除模板 |
| GET | `/admin/api/official/accounts/{id}/subscribers` | 订阅用户列表 |
| GET | `/admin/api/official/audit/pending` | 所有待审核 |
| GET | `/admin/api/official/audit/all` | 所有审核记录 |
| POST | `/admin/api/official/audit/{id}/approve` | 通过审核 |
| POST | `/admin/api/official/audit/{id}/reject` | 驳回审核 |

---

## 附录 B：WebSocket 信令

以下消息类型通过 WebSocket 通道传输，不属于 HTTP API 范畴，列出以作参考：

| MsgType | 常量 | 方向 | 用途 |
|---------|------|------|------|
| 113 | OfficialSubList | 下行 | 登录推送已关注服务号列表 |
| 114 | OfficialSubAction | 双向 | 关注/取消关注 |
| 115 | OfficialMenu | 下行 | 打开会话拉取底部自定义菜单 |
| 116 | OfficialMenuClick | 上行 | 点击菜单事件 |
| 117 | OfficialMsg | 下行 | **核心**：服务号消息推送 |
| 118 | OfficialMsgAck | 下行 | 审核状态变更通知 |
| 119 | OfficialSearch | 双向 | 搜索服务号 |
| 120 | OfficialCard | 双向 | 聊天内服务号名片转发 |

---

*文档生成依据：源码 [official_api.go](file:///e:/SourceCodeIM/im-server/server/official_api.go)、[official_admin.go](file:///e:/SourceCodeIM/im-server/server/official_admin.go)、[official_merchant.go](file:///e:/SourceCodeIM/im-server/server/official_merchant.go)、[official_message.go](file:///e:/SourceCodeIM/im-server/server/official_message.go)、[model.go](file:///e:/SourceCodeIM/im-server/model/model.go#L1505)、[config.go](file:///e:/SourceCodeIM/im-server/config/config.go#L1196)。所有字段名、HTTP 方法、路径均来自源码，无编造。*
