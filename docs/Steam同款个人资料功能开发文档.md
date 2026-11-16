# Steam 同款个人资料功能开发文档

> 版本：v1.0  
> 日期：2026-11-16  
> 状态：规划中  
> 前置依赖：游戏中心 P1 商店页（已完成）、游戏库（已完成）、基础资料接口（已完成）

---

## 一、可行性评估

### 1.1 技术可行性：✅ 完全可行

| 维度 | 评估 | 说明 |
|------|------|------|
| 现有数据基础 | ✅ 已具备 | User 表已有 avatar/nickname/gender/region/signature；游戏库数据已在 `im_game_library`；游戏时长统计已在 `im_game_play_time` |
| 服务端框架 | ✅ 已具备 | Go + GORM，AutoMigrate 自动加列/加表，WebSocket + HTTP 双通道 |
| 前端框架 | ✅ 已具备 | Electron + 原生 JS，Steam 风格样式体系已建立，主题色变量齐全，自绘滚动条/弹窗/Toast 已封装 |
| 游戏数据 | ✅ 已具备 | `im_game` 表含封面、介绍、开发者等；`im_game_library` 含入库状态、安装路径；游戏时长已有埋点 |
| 存储能力 | ✅ 已具备 | MySQL + MinIO/本地文件存储（头像、背景图、截图等） |

### 1.2 工作量评估

| 阶段 | 内容 | 预估工时 | 优先级 |
|------|------|---------|--------|
| **P0 - MVP** | 基础资料页 + 统计数据 + 最近游戏 | 5 天 | 🔴 最高 |
| **P1 - 完整功能** | 成就/徽章展示柜 + 好友展示 + 隐私设置 + 留言板 | 8 天 | 🟠 高 |
| **P2 - 社区化** | 评测展示柜 + 截图/艺术作品 + 创意工坊 | 6 天 | 🟡 中 |
| **P3 - 进阶** | 等级系统 + 经验值 + 卡片合成 + 主题背景商店 | 5 天 | 🟢 低 |

---

## 二、Steam 个人资料功能对标分析

### 2.1 Steam 个人资料页面结构

```
┌─────────────────────────────────────────────────────────────────┐
│  [返回]  个人资料页面标题                                        │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  🖼️ 背景横幅 (Background)                                │   │
│  │  ┌──────┐                                                │   │
│  │  │ 头像 │  昵称                                           │   │
│  │  │ 184px│  称号/副标题                                    │   │
│  │  └──────┘  个人简介 Signature                             │   │
│  │            [编辑个人资料] [添加好友] [发送消息] [更多]    │   │
│  │            ─── 徽章条 ───                                 │   │
│  │            🏅 🏅 🏅 🏅 🏅 ...                             │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────┐  ┌────────────────────────────────────────┐ │
│  │ 📊 统计面板   │  │ 🎮 展示柜 #1 ( Showcase )              │ │
│  │ 游戏总数     │  │  - 最近游戏 / 最爱游戏                 │ │
│  │ 总游戏时长   │  │  - 成就展示 / 徽章展示                 │ │
│  │ 成就总数     │  │  - 截图 / 艺术作品                     │ │
│  │ 徽章总数     │  │  - 评测 / 指南                         │ │
│  │ 好友数       │  │  - ... 可自选排列                      │ │
│  │ 组/社区      │  │                                        │ │
│  └──────────────┘  ├────────────────────────────────────────┤ │
│                     │ 🎮 展示柜 #2                           │ │
│                     ├────────────────────────────────────────┤ │
│                     │ 🎮 展示柜 #3 ...                       │ │
│                     └────────────────────────────────────────┘ │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 📝 留言板 / 评论区 (Comment Wall)                         │   │
│  │  好友可以在此留言互动                                     │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 功能点对标清单

| # | Steam 功能 | 对标实现 | 说明 |
|---|-----------|---------|------|
| 1 | **头像 Avatar** | ✅ 已有基础 | 支持上传/裁剪；新增：头像框/挂件装饰 |
| 2 | **昵称 Profile Name** | ✅ 已有基础 | 支持修改；新增：称号/副标题 |
| 3 | **个人简介 Signature** | ✅ 已有基础 | 128 字签名；新增：支持多行、富文本 |
| 4 | **背景横幅 Background** | ❌ 新增 | 用户可上传/选择背景图；可从积分商店购买 |
| 5 | **徽章条 Badge Row** | 🆕 新增 | 等级徽章 + 特殊成就徽章横排 |
| 6 | **统计面板 Stats** | 🆕 新增 | 游戏数、总时长、成就数、好友数等聚合数据 |
| 7 | **最近游戏 Recent Games** | 🆕 新增 | 最近玩过的游戏 + 时长 + 最后游玩时间 |
| 8 | **最爱游戏 Favorite Game** | 🆕 新增 | 用户可选一款作为主展示游戏 |
| 9 | **成就展示柜 Achievement Showcase** | 🆕 新增 | 精选成就展示（最多 N 个） |
| 10 | **徽章展示柜 Badge Showcase** | 🆕 新增 | 精选徽章展示 |
| 11 | **截图展示柜 Screenshots** | 🆕 新增 | 游戏内截图 / 用户上传 |
| 12 | **艺术作品 Artwork** | 🆕 新增 | 用户上传的艺术作品 |
| 13 | **评测展示柜 Reviews** | 🆕 新增 | 用户写过的游戏评测 |
| 14 | **好友展示柜 Friends** | 🆕 新增 | 随机/精选好友展示 |
| 15 | **组/社区 Groups** | ❌ 暂不实现 | 需先有群组/社区功能 |
| 16 | **创意工坊 Workshop** | ❌ 暂不实现 | 需先有创意工坊功能 |
| 17 | **留言板 Comment Wall** | 🆕 新增 | 好友可留言，支持删除/举报 |
| 18 | **隐私设置 Privacy** | 🆕 新增 | 公开/仅好友/私密 三级 |
| 19 | **等级系统 Level** | 🆕 新增 | 经验值 + 等级 + 升级机制 |
| 20 | **卡片/徽章合成** | ❌ 后续 | 交易卡片 → 合成徽章 → 获得经验 |
| 21 | **主题背景商店** | 🆕 新增 | 用积分兑换展示柜背景/装饰 |
| 22 | **编辑个人资料页** | 🆕 新增 | 设置展示柜排列、隐私、主题 |

---

## 三、数据库设计

### 3.1 现有表扩展

#### im_user 表新增字段

```sql
ALTER TABLE im_user ADD COLUMN level INT DEFAULT 1 COMMENT '个人等级';
ALTER TABLE im_user ADD COLUMN exp BIGINT DEFAULT 0 COMMENT '经验值';
ALTER TABLE im_user ADD COLUMN title VARCHAR(64) DEFAULT '' COMMENT '称号/副标题';
ALTER TABLE im_user ADD COLUMN profile_bg VARCHAR(255) DEFAULT '' COMMENT '个人资料背景图URL';
ALTER TABLE im_user ADD COLUMN profile_theme VARCHAR(32) DEFAULT 'default' COMMENT '展示柜主题';
ALTER TABLE im_user ADD COLUMN profile_visibility TINYINT DEFAULT 1 COMMENT '隐私 0私密 1仅好友 2公开';
ALTER TABLE im_user ADD COLUMN game_visibility TINYINT DEFAULT 2 COMMENT '游戏详情隐私 0私密 1仅好友 2公开';
ALTER TABLE im_user ADD COLUMN friend_visibility TINYINT DEFAULT 2 COMMENT '好友列表隐私';
ALTER TABLE im_user ADD COLUMN comment_enabled TINYINT DEFAULT 1 COMMENT '是否允许留言';
ALTER TABLE im_user ADD COLUMN favorite_game_id INT DEFAULT 0 COMMENT '最爱游戏ID';
```

### 3.2 新增表设计

#### im_game_achievement（游戏成就表）

```sql
CREATE TABLE im_game_achievement (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  game_id INT NOT NULL COMMENT '关联游戏ID',
  code VARCHAR(64) NOT NULL COMMENT '成就唯一代码（游戏内标识）',
  name VARCHAR(128) NOT NULL COMMENT '成就名称',
  desc TEXT COMMENT '成就描述',
  icon VARCHAR(255) DEFAULT '' COMMENT '成就图标URL',
  rarity FLOAT DEFAULT 0 COMMENT '稀有度 0-100',
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY idx_game_code (game_id, code),
  KEY idx_game (game_id)
) COMMENT='游戏成就定义表';
```

#### im_user_achievement（用户成就表）

```sql
CREATE TABLE im_user_achievement (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(32) NOT NULL COMMENT '用户',
  game_id INT NOT NULL COMMENT '游戏ID',
  achievement_id BIGINT NOT NULL COMMENT '成就ID',
  unlock_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '解锁时间',
  UNIQUE KEY idx_user_ach (username, achievement_id),
  KEY idx_user_game (username, game_id)
) COMMENT='用户已解锁成就表';
```

#### im_user_badge（用户徽章表）

```sql
CREATE TABLE im_user_badge (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(32) NOT NULL,
  type VARCHAR(16) NOT NULL COMMENT '徽章类型 level/achievement/event/competition',
  code VARCHAR(64) NOT NULL COMMENT '徽章标识',
  name VARCHAR(128) NOT NULL,
  icon VARCHAR(255) DEFAULT '',
  desc VARCHAR(255) DEFAULT '',
  exp_reward INT DEFAULT 0 COMMENT '获得的经验值',
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY idx_user_badge (username, type, code),
  KEY idx_user (username)
) COMMENT='用户获得徽章表';
```

#### im_profile_showcase（个人资料展示柜配置表）

```sql
CREATE TABLE im_profile_showcase (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(32) NOT NULL,
  slot INT NOT NULL COMMENT '展示柜槽位序号 1-10',
  type VARCHAR(32) NOT NULL COMMENT '类型: recent_games/achievements/badges/screenshots/artwork/reviews/favorite_game/custom_html',
  title VARCHAR(64) DEFAULT '' COMMENT '展示柜自定义标题',
  config TEXT COMMENT 'JSON配置（如选择的成就ID列表、展示数量等）',
  enabled TINYINT DEFAULT 1,
  sort_order INT DEFAULT 0,
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY idx_user_slot (username, slot),
  KEY idx_user (username)
) COMMENT='个人资料展示柜配置表';
```

#### im_profile_comment（个人资料留言表）

```sql
CREATE TABLE im_profile_comment (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  profile_user VARCHAR(32) NOT NULL COMMENT '资料主人',
  from_user VARCHAR(32) NOT NULL COMMENT '留言人',
  content VARCHAR(500) NOT NULL COMMENT '留言内容',
  parent_id BIGINT DEFAULT 0 COMMENT '回复的留言ID',
  reply_to VARCHAR(32) DEFAULT '' COMMENT '回复目标用户名',
  deleted TINYINT DEFAULT 0 COMMENT '0正常 1已删除',
  delete_reason VARCHAR(255) DEFAULT '',
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_profile (profile_user),
  INDEX idx_from (from_user),
  INDEX idx_parent (parent_id)
) COMMENT='个人资料留言板';
```

#### im_user_screenshot（用户截图表）

```sql
CREATE TABLE im_user_screenshot (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(32) NOT NULL,
  game_id INT DEFAULT 0 COMMENT '关联游戏（0=不关联）',
  title VARCHAR(128) DEFAULT '',
  desc VARCHAR(500) DEFAULT '',
  file_path VARCHAR(255) NOT NULL COMMENT '图片存储路径',
  file_size INT DEFAULT 0,
  width INT DEFAULT 0,
  height INT DEFAULT 0,
  is_artwork TINYINT DEFAULT 0 COMMENT '是否标记为艺术作品',
  visibility TINYINT DEFAULT 2 COMMENT '0私密 1仅好友 2公开',
  likes INT DEFAULT 0,
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (username),
  INDEX idx_game (game_id)
) COMMENT='用户截图/艺术作品表';
```

#### im_profile_exp_log（经验值变动日志）

```sql
CREATE TABLE im_profile_exp_log (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(32) NOT NULL,
  change INT NOT NULL COMMENT '变动值（正=增加）',
  reason VARCHAR(32) NOT NULL COMMENT '来源: unlock_achievement/complete_game/review_publish/badge/...',
  detail VARCHAR(255) DEFAULT '',
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (username),
  INDEX idx_reason (reason)
) COMMENT='经验值变动审计日志';
```

#### im_user_level_config（等级配置表 - 系统预设）

```sql
CREATE TABLE im_user_level_config (
  level INT PRIMARY KEY COMMENT '等级',
  exp_required BIGINT NOT NULL COMMENT '达到该等级需要的累计经验',
  badge_code VARCHAR(64) DEFAULT '' COMMENT '对应等级徽章代码',
  title VARCHAR(64) DEFAULT '' COMMENT '该等级解锁的称号',
  showcase_slots INT DEFAULT 1 COMMENT '该等级解锁的展示柜槽位数',
  background_unlock VARCHAR(32) DEFAULT '' COMMENT '解锁的背景主题',
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
) COMMENT='等级配置表（管理员预设）';
```

### 3.3 ER 关系图

```
im_user ──────────────────────────────────────────────────
 │                                                        
 ├── im_user_achievement (1:N)                            
 │     └── im_game_achievement (N:1)                      
 │                                                        
 ├── im_user_badge (1:N)                                  
 │                                                        
 ├── im_profile_showcase (1:N)                            
 │                                                        
 ├── im_profile_comment (1:N)                             
 │                                                        
 ├── im_user_screenshot (1:N)                             
 │                                                        
 ├── im_profile_exp_log (1:N)                             
 │                                                        
 └── favorite_game_id → im_game                           

im_user_level_config (独立配置表)
```

---

## 四、等级与经验值系统设计

### 4.1 经验值获取规则

| 行为 | 经验值 | 说明 |
|------|--------|------|
| 解锁成就 | +10 ~ +100 | 根据成就稀有度分级 |
| 完成一款游戏（通关/全成就） | +200 | 仅首次 |
| 发布评测 | +50 | 每款游戏限 1 次 |
| 评测获得首次点赞 | +20 | 被点赞累计 |
| 上传截图/艺术作品 | +5 | 每次 |
| 上传的作品被点赞 | +2 | 每个赞 |
| 合成徽章（P3） | +100 | 每次合成 |
| 特殊活动（如节日） | 不定期 | 运营配置 |

### 4.2 等级进阶公式

```
Level(N) 需要的累计经验 = 500 * N²

Level 1 → 500 exp
Level 2 → 2000 exp  
Level 3 → 4500 exp
Level 5 → 12500 exp
Level 10 → 50000 exp
Level 20 → 200000 exp
Level 50 → 1250000 exp
```

### 4.3 等级解锁权益

| 等级 | 权益 |
|------|------|
| Lv1 | 基础展示柜 3 个 |
| Lv5 | 展示柜 4 个 + 自定义头像框 |
| Lv10 | 展示柜 5 个 + 称号系统 |
| Lv15 | 展示柜 6 个 + 背景主题 2 选 1 |
| Lv20 | 展示柜 7 个 + 动态头像框 |
| Lv30 | 展示柜 8 个 + 自定义展示柜 HTML |
| Lv40 | 展示柜 9 个 + 专属徽章 |
| Lv50 | 展示柜 10 个 + 金色昵称效果 |

---

## 五、API 接口设计

### 5.1 资料查询

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/api/profile?username=xxx` | 获取用户完整资料（含统计、展示柜、最近游戏） | 登录用户 |
| GET | `/api/profile/stats?username=xxx` | 仅获取统计数据（聚合查询，轻量） | 登录用户 |
| GET | `/api/profile/achievements?username=xxx&game_id=0` | 获取成就列表（game_id=0 返回全部） | 登录用户 |
| GET | `/api/profile/badges?username=xxx` | 获取徽章列表 | 登录用户 |
| GET | `/api/profile/screenshots?username=xxx&page=1&size=20` | 截图/艺术作品分页 | 登录用户 |

### 5.2 资料更新

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| PUT | `/api/profile/basic` | 更新基础资料（昵称/签名/称号/性别/地区） | 本人 |
| PUT | `/api/profile/background` | 上传/更换背景图 | 本人 |
| DELETE | `/api/profile/background` | 移除背景图 | 本人 |
| PUT | `/api/profile/favorite-game` | 设置最爱游戏 | 本人 |
| PUT | `/api/profile/privacy` | 更新隐私设置 | 本人 |
| PUT | `/api/profile/showcase` | 保存展示柜配置（整体提交） | 本人 |

### 5.3 留言板

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/api/profile/comments?username=xxx&page=1` | 获取留言列表 | 登录用户 |
| POST | `/api/profile/comments` | 发表留言 | 登录用户 |
| DELETE | `/api/profile/comments/{id}` | 删除留言 | 主人/留言人 |

### 5.4 成就与徽章

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| POST | `/api/profile/achievement/unlock` | 客户端上报成就解锁 | 本人 |
| GET | `/api/profile/exp-log?username=xxx&page=1` | 经验值日志（仅自己可看完整） | 本人/管理员 |

### 5.5 响应数据结构示例

**GET /api/profile 响应：**

```json
{
  "ok": true,
  "data": {
    "basic": {
      "username": "player123",
      "nickname": "游戏达人",
      "avatar": "/static/upload/avatar/xxx.jpg",
      "title": "传奇玩家",
      "signature": "热爱游戏，热爱生活 🎮",
      "gender": 1,
      "region": "北京",
      "level": 12,
      "exp": 72000,
      "exp_progress": { "current": 72000, "next_level": 80000, "percent": 90 }
    },
    "background": "/static/upload/bg/xxx.jpg",
    "privacy": {
      "profile_visibility": 2,
      "game_visibility": 2,
      "comment_enabled": true
    },
    "stats": {
      "total_games": 47,
      "total_play_hours": 1256.5,
      "total_achievements": 312,
      "total_badges": 18,
      "friends_count": 156,
      "reviews_count": 23,
      "screenshots_count": 89,
      "groups_count": 5
    },
    "favorite_game": {
      "id": 101,
      "name": "示例游戏",
      "cover": "/static/upload/game/cover/xxx.jpg"
    },
    "showcases": [
      {
        "slot": 1,
        "type": "recent_games",
        "title": "最近游玩",
        "enabled": true,
        "config": "{\"count\": 6}"
      },
      {
        "slot": 2,
        "type": "achievements",
        "title": "精选成就",
        "enabled": true,
        "config": "{\"achievement_ids\": [1,2,3,4,5,6]}"
      }
    ],
    "badges_horizontal": [
      { "type": "level", "code": "lv12", "icon": "/static/badge/lv12.png", "name": "等级 12" },
      { "type": "achievement", "code": "first_win", "icon": "...", "name": "初战告捷" }
    ]
  }
}
```

---

## 六、UI 设计方案

### 6.1 整体布局（Steam 同款双栏式）

```
┌─────────────────────────────────────────────────────────────┐
│ ← 返回  [个人资料标题栏]                                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────── 背景横幅 180px 高 ──────────────┐  │
│  │                                                        │  │
│  │  ┌────────┐  昵称                          编辑资料  │  │
│  │  │  头像   │  称号 / 副标题                            │  │
│  │  │ 120x120 │  ─────────────────────────               │  │
│  │  │ 圆形    │  个性签名 Signature                       │  │
│  │  └────────┘  [添加好友] [发送消息] [更多]             │  │
│  │              🏅🏅🏅🏅🏅 徽章横条                        │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─── 左侧统计栏 (280px) ──┐  ┌─── 右侧展示柜区 ────────┐  │
│  │ 📊 概览统计              │  │                          │  │
│  │ ─────────────────────── │  │ 🎮 展示柜 #1             │  │
│  │ 游戏数量    47           │  │  [标题]                 │  │
│  │ 总游戏时长  1,256.5h     │  │                          │  │
│  │ 成就总数    312          │  ├──────────────────────────┤  │
│  │ 徽章总数    18           │  │ 🎮 展示柜 #2             │  │
│  │ 好友数量    156          │  │                          │  │
│  │                          │  ├──────────────────────────┤  │
│  │ 📈 等级进度              │  │ 🎮 展示柜 #3             │  │
│  │ ─────────────────────── │  │                          │  │
│  │ Lv.12 ████████░░ 90%    │  └──────────────────────────┘  │
│  │ 经验 72,000 / 80,000     │                               │
│  │                          │                               │
│  │ 🎯 最爱游戏              │                               │
│  │ ─────────────────────── │                               │
│  │  [封面] 示例游戏         │                               │
│  │                          │                               │
│  │ 👥 精选好友              │                               │
│  │ ─────────────────────── │                               │
│  │  头像×6  +N              │                               │
│  └──────────────────────────┘                               │
│                                                             │
│  ┌─── 留言板 ────────────────────────────────────────────┐  │
│  │ 📝 留言墙 (Comment Wall)                               │  │
│  │ ───────────────────────────────────────────────────── │  │
│  │ [头像] 用户A                              2小时前      │  │
│  │        这也太强了吧！😮                                │  │
│  │        [回复] [删除]                                   │  │
│  │                                                        │  │
│  │ [头像] 用户B                              昨天        │  │
│  │        一起玩啊！                                      │  │
│  │                                                        │  │
│  │ ───────────────────────────────────────────────────── │  │
│  │ [发表留言输入框]                        [发送]        │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 主题色与样式变量

个人资料页扩展以下 CSS 变量（复用 style.css 基础变量）：

```css
:root {
  /* Steam 蓝作为资料页主强调色 */
  --profile-primary: #66c0f4;
  --profile-bg-overlay: rgba(0, 0, 0, 0.5);
  --profile-card-bg: rgba(20, 22, 30, 0.6);
  --profile-level-gold: #e8c547;
  --profile-level-silver: #a8a8a8;
}

[data-theme="light"] {
  --profile-primary: #2b6cb8;
  --profile-bg-overlay: rgba(255, 255, 255, 0.7);
  --profile-card-bg: rgba(255, 255, 255, 0.8);
}
```

### 6.3 展示柜类型样式规范

| 展示柜类型 | 尺寸/布局 | 内容 |
|-----------|----------|------|
| recent_games | 2~6 行游戏卡 | 封面 + 名称 + 最近游玩 + 时长 |
| favorite_game | 大卡 16:9 | 大图 + 名称 + 简介 |
| achievements | 6 格网格（2×3 或 3×2） | 成就图标 + 名称 + 稀有度颜色 |
| badges | 横排 3~10 枚 | 徽章图标 + tooltip 名称 |
| screenshots | 2~6 张网格 | 图片 + 标题 hover 显示 |
| artwork | 1 张大图 + 2 小图 | 突出展示艺术作品 |
| reviews | 1~3 条卡片 | 游戏封面 + 评测标题 + 摘要 + 推荐率 |
| friends | 6~12 个头像网格 | 头像 + 昵称 + 在线状态点 |

### 6.4 自绘组件清单（禁止系统默认弹窗）

| 组件 | 说明 | 状态 |
|------|------|------|
| 自绘 Toast | 提示消息 | ✅ 已有（游戏中心复用） |
| 自绘确认弹窗 | 确认删除等操作 | ✅ 已有 |
| 自绘滚动条 | 悬浮滑块样式 | ✅ 已有 |
| 编辑资料弹窗 | 昵称/签名/头像/背景编辑 | 🆕 需新建 |
| 展示柜选择器 | 拖拽排序 + 类型选择 | 🆕 需新建 |
| 留言输入框 | @提及/表情 | 🆕 需新建 |
| 头像上传裁剪 | 圆形裁剪 + 预览 | 🆕 需新建 |

---

## 七、服务端实现要点

### 7.1 核心数据聚合逻辑

`GET /api/profile?username=xxx` 需要一次性聚合：

```go
func (s *Server) BuildProfile(viewer, target string) (ProfileData, error) {
    var data ProfileData
    
    // 1. 基础信息 + 隐私过滤
    user, _ := s.getUser(target)
    if !s.canViewProfile(viewer, user) {
        return ProfileData{}, ErrPrivate
    }
    data.Basic = buildBasic(user)
    
    // 2. 统计数据（单条聚合 SQL）
    data.Stats = s.aggregateStats(target)
    // SELECT 
    //   COUNT(DISTINCT gl.game_id) as total_games,
    //   SUM(gl.play_seconds) as total_play_time,
    //   COUNT(DISTINCT ua.achievement_id) as total_achievements,
    //   COUNT(DISTINCT ub.code) as total_badges,
    //   (SELECT COUNT(*) FROM im_friend WHERE user_id = target) as friends_count
    // FROM im_game_library gl
    // LEFT JOIN im_user_achievement ua ON ua.username = target
    // LEFT JOIN im_user_badge ub ON ub.username = target
    
    // 3. 展示柜配置（按 slot 排序）
    data.Showcases = s.getShowcases(target)
    
    // 4. 徽章横条（等级 + 特殊徽章，按 create_time 倒序取前 10）
    data.BadgesHorizontal = s.getFeaturedBadges(target, 10)
    
    // 5. 最近游戏（取 play_time > 0 的按 last_play_at 倒序前 6）
    //    —— 但这部分在前端按需懒加载（首次渲染只给 3 条 + "查看全部"按钮）
    
    // 6. 检查是否好友 → 填充 IsFriend / IsBlocked / CanComment
    
    return data, nil
}
```

### 7.2 隐私过滤矩阵

| 查询者 \ 目标 | 自己 | 好友 | 陌生人 |
|--------------|------|------|--------|
| 基础资料 | ✅ 全部 | ✅ 全部 | ✅ 公开字段 |
| 统计数据 | ✅ 全部 | ✅ 全部 | 🟡 隐私设置决定 |
| 展示柜 | ✅ 全部 | ✅ 全部 | 🟡 隐私设置决定 |
| 最近游戏 | ✅ 全部 | ✅ 全部 | 🟡 隐私设置决定 |
| 成就列表 | ✅ 全部 | ✅ 全部 | 🟡 隐私设置决定 |
| 好友列表 | ✅ 全部 | 🟡 隐私设置决定 | ❌ 私密时隐藏 |
| 留言板 | ✅ 全部 | ✅ 全部 | 🟡 隐私设置决定 |

### 7.3 成就解锁上报防刷

```go
// POST /api/profile/achievement/unlock 请求结构
// { "game_id": 101, "achievement_code": "first_blood", "client_time": 1731657600 }

func (s *Server) handleAchievementUnlock(c *Client, msg *protocol.Message) {
    var req struct {
        GameID   int    `json:"game_id"`
        Code     string `json:"achievement_code"`
        ClientTS int64  `json:"client_time"`
    }
    json.Unmarshal([]byte(msg.Content), &req)
    
    // 1. 校验：游戏是否在用户库中
    if !s.isGameInLibrary(c.username, req.GameID) {
        s.sendError(c, "游戏不在库中")
        return
    }
    
    // 2. 幂等：已解锁直接返回成功
    if s.isAchievementUnlocked(c.username, req.GameID, req.Code) {
        s.sendOK(c, "已解锁")
        return
    }
    
    // 3. 可选：签名校验（游戏客户端上报带签名防伪造）
    // ...
    
    // 4. 落库
    // ...
    
    // 5. 发放经验值 + 可能触发升级
    s.grantExp(c.username, achievement.ExpReward, "unlock_achievement", 
        fmt.Sprintf("解锁成就 %s", achievement.Name))
}
```

---

## 八、前端实现要点

### 8.1 页面入口（游戏中心顶部头像气泡 → 点击"个人资料"）

现有代码位置：`game-store.js` 顶部用户区 `.gs-user` 的点击事件。

```javascript
// 新增：点击气泡中的"个人资料"按钮 → 打开资料页
function openProfile(username) {
    // 方式 A：在游戏中心窗口内新开一个 tab/section（Steam 式）
    // 方式 B：Electron openWindow 开独立窗口（与现有游戏中心同构）
    // 方式 C：前端 SPA 切换视图（最轻量，推荐）
    
    // 推荐方案：在游戏中心主窗口内容区内切换 profile view
    // 左侧导航栏新增一个"个人资料"图标按钮
    showView('profile');
    loadProfile(username || currentUsername);
}
```

### 8.2 前端状态管理

```javascript
// 新增 state.profile
state.profile = {
    username: '',         // 当前查看的用户
    basic: null,          // 基础资料
    stats: null,          // 统计数据
    showcases: [],        // 展示柜配置
    badges: [],           // 徽章横条
    recentGames: [],      // 最近游戏（懒加载）
    achievements: [],     // 成就（懒加载）
    comments: [],         // 留言（懒加载 + 分页）
    loading: false
};
```

### 8.3 展示柜渲染引擎

```javascript
function renderShowcase(slot) {
    var cfg = state.profile.showcases.find(function(s) { return s.slot === slot; });
    if (!cfg || !cfg.enabled) return null;
    
    // 每种类型一个 renderer
    var renderers = {
        recent_games: renderRecentGames,
        favorite_game: renderFavoriteGame,
        achievements: renderAchievementsShowcase,
        badges: renderBadgesShowcase,
        screenshots: renderScreenshotsShowcase,
        artwork: renderArtworkShowcase,
        reviews: renderReviewsShowcase,
        friends: renderFriendsShowcase
    };
    
    var renderer = renderers[cfg.type] || renderCustomHTML;
    return renderer(cfg);
}

function renderAllShowcases() {
    var container = $('profileShowcases');
    container.innerHTML = '';
    state.profile.showcases
        .filter(function(s) { return s.enabled; })
        .sort(function(a, b) { return (a.sort_order || a.slot) - (b.sort_order || b.slot); })
        .forEach(function(s) {
            var box = renderShowcase(s);
            if (box) container.appendChild(box);
        });
}
```

### 8.4 隐私设置前端交互

```javascript
// 编辑隐私设置 → 弹窗（自绘，3 行三选一：公开/仅好友/私密）
function showPrivacyEditor() {
    var mask = $('privacyMask');
    mask.classList.remove('hidden');
    // 三个设置项：个人资料 / 游戏详情 / 好友列表
    // 每行 radio button 三选一（复用现有主题变量）
}
```

---

## 九、实施计划（分阶段）

### P0 - MVP（5 天）

| 天 | 服务端 | 前端 |
|----|--------|------|
| 1 | ✅ User 表扩展字段 + AutoMigrate | ✅ 资料页 HTML 骨架 + CSS 样式基础 |
| 2 | ✅ im_game_achievement / im_user_achievement 表 + CRUD | ✅ 资料页入口（导航栏 + 气泡按钮联动） |
| 3 | ✅ /api/profile 聚合接口 | ✅ 基础资料渲染（头像/昵称/签名/统计面板） |
| 4 | ✅ /api/profile/stats 接口 | ✅ 等级进度条 + 最爱游戏 + 徽章横条 |
| 5 | ✅ 成就解锁上报接口 | ✅ 最近游戏展示柜 + 联调测试 |

### P1 - 完整功能（8 天）

| 天 | 服务端 | 前端 |
|----|--------|------|
| 1 | ✅ im_profile_showcase 表 + 配置 CRUD | ✅ 编辑资料弹窗（昵称/签名/称号/背景） |
| 2 | ✅ im_profile_comment 表 + CRUD + 防刷 | ✅ 留言板 UI + 发表/删除交互 |
| 3 | ✅ 隐私过滤逻辑（所有查询接口加过滤） | ✅ 隐私设置弹窗 + 三选一交互 |
| 4 | ✅ 展示柜配置保存接口 | ✅ 展示柜编辑页（选择类型/排序） |
| 5 | ✅ 好友展示数据接口 | ✅ 好友展示柜渲染 |
| 6 | ✅ /api/profile/achievements 列表接口 | ✅ 成就展示柜渲染 + 稀有度颜色 |
| 7 | ✅ 经验值日志接口 | ✅ 经验值变动历史查看 |
| 8 | ✅ 集成测试 + Bug 修复 | ✅ 联调 + UI 打磨 |

### P2 - 社区化（6 天）

- 评测展示柜（需已有评测功能）
- 截图/艺术作品上传 + 展示
- 截图点赞 + 经验值奖励
- 展示柜主题背景（积分兑换）

### P3 - 进阶（5 天）

- 卡片系统 + 合成徽章
- 动态头像框（CSS 动画/小视频）
- 金色昵称效果（高等级）
- 自定义展示柜 HTML（高等级）

---

## 十、风险与应对

| 风险 | 影响 | 概率 | 应对 |
|------|------|------|------|
| 成就解锁接口被刷，经验值暴涨 | 等级通胀 | 中 | 客户端上报 + 游戏进程签名校验 + 频率限制 + 成就唯一性 |
| 资料页聚合查询慢（多表 JOIN） | 首屏卡顿 | 中 | 分接口懒加载：基础资料先返回，成就/留言等按需加载；统计数据可加 Redis 缓存 |
| 展示柜配置 JSON 随意嵌套 | 前端渲染崩 | 低 | config 字段做 schema 校验，类型白名单过滤 |
| 背景图/截图存储暴涨 | 磁盘占满 | 低 | 单用户容量上限（如 500MB）+ 压缩上传 |
| 隐私设置被绕过（前端自己改） | 数据泄露 | 中 | **所有隐私过滤必须在服务端完成**，前端只做展示层面的 UI 隐藏 |

---

## 十一、与现有系统的集成点

| 集成点 | 现有模块 | 集成方式 |
|--------|---------|---------|
| 用户登录态 | chat.js / localStorage im_auth | 同源读取 username，复用鉴权 |
| 头像上传 | 现有 avatar.go 接口 | 复用 /api/avatar/upload |
| 游戏库数据 | game-store.js state.lib | 资料页统计聚合查询走现有库表 |
| 好友关系 | friend.go / im_friend | 判断是否好友 → 决定隐私过滤级别 |
| 主题切换 | style.css data-theme | 所有颜色引用 CSS 变量，明暗自动切换 |
| Electron 窗口 | 游戏中心独立窗口 | 资料页作为新视图切换，或 openWindow 开独立窗 |
| 滚动条样式 | .osb-thumb 悬浮滑块 | 资料页所有滚动容器挂自绘滑块 |
| 弹窗系统 | gsModalMask / showConfirm | 编辑资料、删除留言等全部用自绘弹窗 |
| 积分系统 | im_points / PointsLog | 后续 P3 积分商店用积分兑换背景主题 |

---

## 十二、附录

### A. 等级配置初始化 SQL

```sql
INSERT INTO im_user_level_config (level, exp_required, badge_code, title, showcase_slots) VALUES
(1, 0,  'lv1',  '新人玩家',    3),
(2, 500, 'lv2',  '',            3),
(3, 1125, 'lv3', '',            3),
(4, 2000, 'lv4', '',            3),
(5, 3125, 'lv5', '初级玩家',    4),
(10, 50000, 'lv10', '资深玩家',  5),
(15, 112500, 'lv15', '',        6),
(20, 200000, 'lv20', '老玩家',  7),
(30, 450000, 'lv30', '',        8),
(40, 800000, 'lv40', '',        9),
(50, 1250000, 'lv50', '传奇玩家', 10);
```

### B. 成就稀有度分级

| 稀有度 | 颜色 | 经验值 |
|--------|------|--------|
| Common 常见 | #b0b0b0 (灰) | +10 |
| Uncommon 罕见 | #1e90ff (蓝) | +25 |
| Rare 稀有 | #9b59b6 (紫) | +50 |
| Epic 史诗 | #e67e22 (橙) | +100 |
| Legendary 传说 | #f1c40f (金) | +200 |

### C. 展示柜类型代码表

| type 代码 | 中文 | 配置格式 |
|-----------|------|---------|
| recent_games | 最近游玩 | `{"count": 6}` |
| favorite_game | 最爱游戏 | `{"game_id": 101}` |
| achievements | 精选成就 | `{"achievement_ids": [1,2,3,4,5,6]}` |
| badges | 徽章展示 | `{"badge_codes": ["lv12","first_win"], "count": 6}` |
| screenshots | 截图展示 | `{"count": 4}` |
| artwork | 艺术作品 | `{"count": 3}` |
| reviews | 评测展示 | `{"count": 2}` |
| friends | 好友展示 | `{"count": 8, "sort": "random"}` |

---

## 十三、总结

**完全可行**，且与现有游戏中心、用户系统、好友系统高度复用。核心工作量在：
1. **服务端**：新表建表 + 聚合查询 + 隐私过滤 + 成就/经验值逻辑
2. **前端**：资料页全新 UI + 展示柜渲染引擎 + 编辑交互

建议从 **P0 MVP** 开始，先跑通基础资料 + 统计 + 最近游戏，再逐步迭代 P1/P2/P3。

---

## 十四、游戏端成就解锁对接开发方案（评审稿）

> 状态：**已实施（2026-11-17）**。P0-a/b/c/d 与 P1 全部落地：签名死锁修复（会话密钥 + `achievement_sign_required` 降级开关）、`achUnlockCore` 抽取、自动解锁引擎（`server/gameachengine.go`）、WS 推送（msg_type=122）+ `achievement-toast.js`、ImGameSDK 桥接（`im-game-sdk.js`，仅 PC 端）。

### 14.0 背景与现状盘点

后端 `POST /api/game/achievement/unlock`（`profile.go` HandleGameAchievementUnlock）已具备完整防刷三件套：

| # | 防线 | 实现位置 | 说明 |
|---|------|---------|------|
| 1 | 游戏在库校验 | `achIsGameInLibrary` | 不能解锁未入库游戏的成就 |
| 2 | 防重放 | `achCheckReplayAndRateLimit` | nonce 5 分钟唯一 + 时间戳 ±300s 窗口（Redis/内存双模式） |
| 3 | 频率限制 | 同上 | 单用户 60s 内最多 10 条 |
| 4 | HMAC 签名 | `achVerifySignature` | P2-c，密钥为 `config.Game.LaunchSecret` |
| 5 | 幂等+事务 | unlock 事务段 | OnConflict DoNothing + FOR UPDATE 行锁 + 经验原子增量 + 升级徽章 |

**两个关键调查结论：**

#### 结论 1：签名机制当前为"死锁"状态

- `achVerifySignature` 的验签密钥为 `config.Game.LaunchSecret`，该密钥**仅存 config.yaml 从不下发任何客户端**（config.go L245 注释明确"不下发客户端"）；
- config.go L1154 有空值兜底，保证 `LaunchSecret` **永远非空**；
- 因此任何客户端上报：带 `X-Game-Signature` → 算不出正确签名被拒；不带 → `clientSig == ""` 被拒。
- **结论：即使补齐调用链，接口也必然 100% 被签名挡住。必须先修复密钥分发机制。**

#### 结论 2：通用成就（12/13 条）不需要游戏内事件

seed 的通用成就全部为**时长 / 次数 / 时间段型**，判定数据服务端已持有（`HandleGamePlay` start/end 上报 → `GameLibrary.play_seconds` / 游玩次数）：

| 成就 code（以 `im_game_achievement` 实际数据为准） | 判定规则 | 数据来源 |
|------|------|------|
| `first_play` | 游玩次数 ≥ 1 | GameLibrary 次数 |
| `play_25h` / `play_50h` / `play_100h` | 累计秒数达阈值 | `play_seconds` |
| `play_30_times` | 启动次数 ≥ 30 | GameLibrary 次数 |
| `early_bird` | start 上报时间在 06:00–09:00 | start 打点 |
| `night_owl` | start 上报时间在 23:00–次日 04:00 | start 打点 |

**只有游戏专属成就**（如 war3「四方霸主：四个种族各赢一场对战」）才真正需要游戏内事件上报。

### 14.1 总体架构：三条链路分层对接

```
链路 A（P0，零游戏端改动）
  GamePlay end 上报 → 服务端自动判定 → achUnlockCore 内部解锁
    → WS 推送 achievement_unlocked → PC/Web 弹成就 toast

链路 B（P1，自研游戏 / 网页游戏 / Overlay）
  游戏/Overlay → ImGameSDK.unlockAchievement(code)
    → PC 客户端代为 HTTP 上报（登录 token + 会话签名密钥）

链路 C（P2，按游戏逐个做）
  客户端监控第三方游戏进程 + 解析本地日志/回放
    → 命中条件 → 复用链路 B 上报
```

### 14.2 必修项：签名死锁修复（不修则链路 B/C 必被拒）

**问题**：全局静态 `launch_secret` 作验签密钥且从不下发。

**修复设计——一次性会话签名密钥**：

```
1. 下发：游戏启动接口（HandleGameLaunch）返回体新增：
     session_sign_key = hex(hmac_sha256(launch_secret, username|game_id|random|ts))
   同时写 Redis：im:ach:signkey:{username}:{game_id} → TTL 24h

2. 验签（achVerifySignature 改造）：
   a. 优先取 Redis 会话密钥验签（username+game_id 从 body 取）
   b. 会话密钥不存在时：
      - 配置 achievement_sign_required: true → 拒绝
      - 默认 false → 降级放行（登录 token + 在库 + 防重放 + 限流四道防线仍在）

3. 安全属性：
   - 泄露半径 = 单用户 × 单游戏 × 24h 会话
   - launch_secret 本体永不出服务器
   - canonicalMessage 公式不变（口径冻结，全工程唯一入口）
```

配置新增（config.yaml game 段，同步补齐 config - linux.yaml）：

```yaml
game:
  achievement_sign_required: false  # 成就上报签名强制开关（无会话密钥时是否拒绝）
```

> **评审结论（已敲定）**：默认 `false` 确认采纳。语义：客户端上报未带有效签名时，不拒绝，靠登录 token + 在库校验 + 防重放 + 限流四道防线兜底；待链路 B 稳定、全部上报方携带会话密钥后，再切 `true` 收紧。

### 14.3 链路 A：服务端自动解锁引擎（P0）

#### 14.3.1 解锁核心抽取

把 `HandleGameAchievementUnlock` 的事务段（幂等解锁 + 经验增量 + 升级徽章）抽成共用函数，HTTP 接口与自动引擎走同一入口，避免逻辑漂移：

```go
// profile.go
// 返回 (已解锁与否, 获得经验, 新等级, 是否升级)
func achUnlockCore(username string, gameID uint, code string) (bool, int64, int, bool, error)
```

#### 14.3.2 判定触发点与规则引擎

触发点：`HandleGamePlay`（game.go L1750）处理 **end 上报**成功落库后，异步 goroutine 判定（不阻塞上报响应）：

| 规则 | 判定逻辑 | 上限保护 |
|------|---------|---------|
| 次数型 | `play_count` 跨过阈值（25/50/100 次…） | 以 seed code 实际定义为准 |
| 时长型 | `play_seconds` 跨过阈值（25h/50h/100h…） | 同上 |
| first_play | 次数 ≥ 1 | — |
| 时间段型 | start 打点时间落窗口（early_bird 06–09 / night_owl 23–04） | 以服务端时间为准，防客户端改钟 |

实现方式：每次触发时查询该游戏全部成就定义 → 内存中按规则表逐条比对 → 命中且未解锁者循环调用 `achUnlockCore`（自身幂等，无需额外加锁）。规则表以 code 前缀/名称约定匹配（`play_` 前缀解析数字阈值；`first_`/`_times` 固定映射），**未匹配规则的成就静默跳过，留给链路 B/C**。

#### 14.3.3 WS 推送协议

复用现有 WS hub，新增消息类型（与客户端既有消息分发机制对齐）：

```json
{
  "type": "achievement_unlocked",
  "game_id": 101,
  "code": "play_25h",
  "name": "沉浸其中",
  "desc": "累计游玩 25 小时",
  "icon": "",
  "rarity": 1,
  "exp_reward": 25,
  "level_up": false,
  "new_level": 0
}
```

推送目标：该用户**所有在线端**（PC / Web / APP），由 hub 按 username 广播。

#### 14.3.4 客户端成就 toast UI（Steam 同款）

- **独立实现于 `im-client/web/js/achievement-toast.js`（评审已敲定拆分，不并入 game-store.js）**，PC 端与 Web 端共用；
- 位置：右下角滑入，与现有消息 toast 同层但独立样式；
- 结构：左侧成就图标（无图标用稀有度色块兜底）+ 名称/描述 + `+25 EXP`；
- 稀有度描边颜色跟随主题色体系（与展示柜稀有度色板一致）；
- 动画：滑入 → 停留 4s → 滑出；多条排队依次弹出；
- 触发源（3 个，均调 achievement-toast.js 暴露的同一入口 `AchievementToast.show(payload)`）：WS 推送（链路 A）、链路 B 桥接上报回调、未来活动/运营系统；
- **禁止系统默认弹窗；主题色必须跟随现有主题；滚动/样式沿用项目自绘组件**；
- **实施补充（2026-11-17）**：
  - 页内 toast 动画在后台/被遮挡窗口会被 Chromium 冻结在起点（opacity 卡 0、transform 卡滑出位）——窗口无焦点时跳过滑入动画直接以可见态呈现，前台正常播放，150ms 自检兜底；
  - **桌面卡片弹窗**（独立于好友消息的系统通知）：主窗口失焦/被遮挡/最小化时，经 `desktop.achNotify` 转发主进程，弹**独立透明不夺焦通知窗**（`web/achievement-notify.html` + `js/achievement-notify.js`，卡片经 `AchievementToast.buildCard` 构建与页内完全同源，改样式一处生效）。屏幕右下角 workArea 内缩 12px，堆叠最多 4 条动态高度、悬停暂停、点击聚焦主窗口、Win7 回退系统通知。排障截图常驻：`userData/ach-notify-debug.png`；
  - 经验教训：通知窗"整窗不可见"曾误判透明合成失败，实为渲染层卡片漏 `appendChild` 挂载——窗口层级/位置/生命周期日志均正常时优先怀疑 DOM 挂载而非合成层。

### 14.4 链路 B：PC 客户端桥接 SDK（P1）

> **评审结论（已敲定）**：ImGameSDK 仅覆盖 **PC 端**（Electron Web 层 + 进程桥接），**APP 端不做**。

#### 14.4.1 启动时密钥下发

`HandleGameLaunch` 响应新增 `session_sign_key` 字段；PC 客户端启动游戏后持有，用于本会话签名。

#### 14.4.2 客户端桥接 API

```
window.ImGameSDK.unlockAchievement(code)      // 单条
window.ImGameSDK.getUnlockedAchievements()    // 已解锁列表（本地缓存 + 服务端同步）
```

客户端代为组装上报（游戏进程无需知道服务端地址与密钥之外的信息）：

```
POST /api/game/achievement/unlock
Header: Authorization(game token) + X-Game-Signature
Body:   { game_id, achievement_code, client_ts, nonce }
```

#### 14.4.3 上报失败策略

- 网络失败 / 限流：客户端本地队列重试（退避 5s/30s/120s，最多 3 次）；
- 「成就不存在」：静默丢弃并记录日志（游戏版本与服务端定义不一致时不打扰用户）；
- 幂等（`already: true`）：静默成功。

### 14.5 链路 C：第三方游戏判读（P2 预留）

按游戏逐个实现，不在本次范围：

- war3：客户端读取本地对战记录/回放摘要 → 命中「四族各一胜」等条件 → 走链路 B 上报；
- 通用兜底：管理员后台配置「进程存活 N 分钟」型伪成就（映射到次数/时长型 code）。

### 14.6 API 与配置变更清单

| 项 | 变更 | 兼容性 |
|----|------|--------|
| `POST /api/game/launch`（实际路径以 game.go 为准） | 响应新增 `session_sign_key` | 旧客户端忽略新字段，无影响 |
| `POST /api/game/achievement/unlock` | 验签逻辑改为会话密钥优先 + 开关降级 | 旧调用方（无签名）在新开关默认 false 下可用 |
| `HandleGamePlay` | end 落库后异步触发判定 | 无接口变更 |
| WS 消息 | 新增 `achievement_unlocked` 类型 | 旧客户端 unknown type 走既有忽略分支 |
| config.yaml / config - linux.yaml | game 段新增 `achievement_sign_required` | 缺省 false，两份配置同步补齐 |

数据库变更（实施补充决议）：**新增一列** —— `im_game_library.play_count`（游玩会话次数，AutoMigrate 自动加列）。原方案「无新列」的前提经实测不成立：GameLibrary 只有 play_seconds/last_play_at，无游玩次数数据，且客户端心跳复用 start 动作无法直接计数。评审确认加列：每次新会话 start（presence 无在玩标记）时 +1，心跳续期不计数，作为 first_play / play_X_times 的判定数据源。其余无新表。

### 14.7 实施计划与改动量

| 阶段 | 内容 | 预估改动 | 验收标准 |
|------|------|---------|---------|
| P0-a | 签名死锁修复（会话密钥 + 降级开关） | 服务端 ~120 行 | 带会话密钥上报通过；无密钥按开关行为；重放/超窗被拒 |
| P0-b | `achUnlockCore` 抽取 + HTTP 接口复用 | 服务端 ~80 行重构 | unlock 接口行为回归不变（幂等/经验/徽章） |
| P0-c | 自动解锁引擎（GamePlay end 触发 + 规则表） | 服务端 ~150 行 | 累计时长跨阈值后对应成就自动解锁且只解锁一次 |
| P0-d | WS 推送 + 客户端成就 toast（独立 `achievement-toast.js`） | 客户端 ~150 行 | PC/Web 弹 toast；主题色跟随；多条排队；刷新后不重复弹 |
| P1 | session_sign_key 下发 + ImGameSDK 桥接（仅 PC 端，APP 不做）+ 重试队列 | 服务端 ~60 行 / PC 端 ~200 行 | 桥接调用端到端解锁并全端收到通知 |

### 14.8 测试要点

1. **死锁修复回归**：`launch_secret` 非空 + 无会话密钥 + 开关 false → 上报成功；开关 true → 拒绝；
2. **防刷回归**：重放同一 nonce 拒绝；±300s 外时间戳拒绝；60s 内第 11 条拒绝；未入库游戏拒绝；
3. **自动引擎**：mock `play_seconds` 跨 25h 阈值 → 仅解锁一次（重复 end 上报不重复发经验）；early_bird 时段边界（05:59/06:00/09:00/09:01）；
4. **幂等**：HTTP 上报与自动引擎同 code 竞态 → 仅一条经验入账（OnConflict + 行锁验证）；
5. **升级联动**：解锁触发升级 → 徽章只发一枚（并发重复上报验证）；
6. **UI**：暗/亮主题下 toast 颜色；连续解锁 3 条排队动画；离线后上线补推不轰炸（历史解锁不重推，只推实时解锁）；
7. **性能**：end 上报响应时间不受判定影响（异步验证）；规则比对为内存操作，无额外 SQL 压力（成就定义可会话内缓存）。

### 14.9 风险与回滚

| 风险 | 应对 |
|------|------|
| 会话密钥下发被中间人截获 | 通道复用现有 HTTPS/登录 token 链路，风险与登录态同级；密钥 24h 过期 |
| 自动引擎误判（play_seconds 异常暴涨） | 限流已有 60s/10 条兜底；单次 end 最多解锁数上限（建议 3 条/次） |
| 开关误配导致线上上报全拒 | 默认 false；管理日志打印当前生效模式 |
| 重构 unlock 事务段引入回归 | P0-b 独立提交，先跑防刷/幂等回归再合入 P0-c |
