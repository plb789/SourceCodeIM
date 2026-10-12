# 评测区 Steam 专区同款双栏布局 + 评论回复改造

## Context

用户对照 Steam 评测专区页（Gears of War E-Day）提出：游戏详情页评论区要与 Steam 同款——**左侧"最有价值的评测"主列表，右侧"最近发布"小卡栏**，且**评论回复功能必须做**（支持评论和回复）。当前评测区（上一轮刚完成 Steam 化）已是容器级全宽独立区 + 两列瀑布 + 卡内左右分栏，服务端排序已是 `helpful_count DESC, id DESC`（正是 Steam"最有价值"口径），基础良好。本轮改造：

- 评测区顶部（汇总条 + 筛选）保持全宽，下方拆**左右两栏**：左栏主列表（单列大卡，现有卡结构保留）+ 右栏 300px"最近发布"小卡流（Steam 同款带分隔线）
- **评论回复（用户明确要求）**：评测卡底部加"评论 N"按钮，点击内嵌展开评论区——平铺回复列表（"张三 回复 李四"楼中楼微信同款，复用朋友圈 MomentComment 模式）+ 底部输入框发送 + 回复指定评论 + 删除；右栏小卡不放评论区（Steam 同款右栏无评论）
- 已确认决策：**做**长文"阅读全文"展开（纯前端）；筛选条**保持现有**三态（全部/推荐/不推荐）不扩展
- 不做：右栏 PC 配置块（无硬件数据源）、欢乐/奖励反应、收藏星标、语言/日期/时长筛选

## 一、服务端（e:\SourceCodeIM\im-server\server\game.go + model\model.go）

### 1.1 模型（model.go，GameReviewLike 之后 L1105 附近）

```go
// GameReviewReply 评测回复表 im_game_review_reply（朋友圈 MomentComment 同款楼中楼模式：
// ReplyTo=0 直接评论评测，>0 回复指定回复；ReplyToUser 冗余存储防被回复删除后"张三回复李四"展示断裂）
type GameReviewReply struct {
    ID          uint   `gorm:"primaryKey;autoIncrement" json:"id"`
    ReviewID    uint   `gorm:"column:review_id;not null;index" json:"review_id"`
    Username    string `gorm:"column:username;type:varchar(32);not null" json:"username"`
    ReplyTo     uint   `gorm:"column:reply_to;default:0" json:"reply_to"`
    ReplyToUser string `gorm:"column:reply_to_user;type:varchar(32);default:''" json:"reply_to_user"`
    Content     string `gorm:"column:content;type:varchar(512)" json:"content"`
    CreateTime  time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
}
func (GameReviewReply) TableName() string { return "im_game_review_reply" }
```

- `GameReview` 结构体（L1076-1090）加 `ReplyCount int64`（`column:reply_count;default:0`）冗余计数（发布 +1 / 删除 GREATEST(-1,0)，与 HelpfulCount 同模式）
- `InitGame`（L38）AutoMigrate 补 `&model.GameReviewReply{}`

### 1.2 HandleGameReviews（L697-766）向后兼容扩展

1. `sort` 查询参数：`helpful`（默认，现状 `helpful_count DESC, id DESC`）| `latest`（`create_time DESC, id DESC`，右栏"最近发布"用，按发布时间而非编辑时间）
2. `size` 查询参数：默认 10，clamp 1-10（右栏传 5）；`revPageSize` 常量改为按此取值（`has_more` 计算同步用该值）
3. 返回项补 `create_time`（右栏小卡显示发布日期）与 `reply_count`（评论按钮计数）两个字段

### 1.3 评测回复三接口（新 handler，紧随 HandleGameReviewHelpful 之后）

路由注册（RegisterGameRoutes L184-188 附近，沿用项目踩坑先例——字面量段精确优先于 `{id}`，helpful 已验证此模式无冲突）：

```go
http.HandleFunc("GET /api/game/review/replies", s.HandleGameReviewReplies)     // 字面量优先于无冲突段
http.HandleFunc("POST /api/game/review/reply", s.HandleGameReviewReplyUpsert)  // 与 POST /api/game/review/{id} 同前缀，字面量精确优先（helpful 同款）
http.HandleFunc("DELETE /api/game/review/reply/{rid}", s.HandleGameReviewReplyDelete) // 5 段与 DELETE /api/game/review/{id}（4 段）无冲突
```

- **HandleGameReviewReplies**：`GET ?review_id=N`——公开浏览（username 可缺省，与评测列表同水位）；`CreateTime ASC` 楼层正序；limit 200 兜底不设分页（量级小，Steam 点开也是全量）；批量头像查询（复用 reviews 的 avatars 模式）；返回 `{list:[{id,username,avatar,reply_to,reply_to_user,content,create_time}]}`
- **HandleGameReviewReplyUpsert**：`POST {review_id, content, reply_to}`——`gameUsername` 鉴权（登录即可回复，无需入库——Steam 社区评论同语义）；content trim 非空限 500 字（MomentComment 同款）；评测存在校验；`reply_to>0` 时校验目标回复属于本评测（`id = ? AND review_id = ?`），`ReplyToUser` 取被回复人，**回复的回复平铺归一**（楼中楼不嵌套，只记被回复的回复 ID 与人）；Create 成功后 `reply_count = reply_count + 1`（UpdateColumn + gorm.Expr）
- **HandleGameReviewReplyDelete**：`DELETE /{rid}?username=`——回复人**或评测主人**可删（MomentComment "评论人或动态主人"同款）；删除后 `GREATEST(reply_count - 1, 0)`

## 二、前端 JS（e:\SourceCodeIM\im-client\web\js\game-store.js）

1. `state.reviews`（L45-47）加 `recent: []`、`recent_gid: 0`（回复状态局部挂卡片 DOM，不进全局 state；筛选/加载更多重绘后评论区收起——Steam 同款行为）
2. `buildReviewSection`（L1371）：骨架改两栏——
   - 全宽区保持：`gs-review-head`（标题行）+ **汇总条与筛选移出 gsReviewBody 固定挂 sec**（渲染到 `gsReviewTop` 容器，连带清理 CSS 里 column-span:all）
   - 下方 `gs-review-cols`：左 `gs-review-main`（标题"最有价值的评测" + `gsReviewBody` 卡片流）+ 右 `gs-review-aside`（标题"最近发布" + `gsRecentBody`）
3. `loadReviews`（L1402）：请求串加 sort 默认（不变），响应填充主列表状态不变
4. 新增 `loadRecentReviews(gid)`：`page=1&size=5&sort=latest&type=all`，一次性加载右栏（切游戏时刷新，不随筛选/分页变）；renderDetail 评测区挂载处与 loadReviews 同步调用
5. `renderReviews`（L1438）拆分：汇总条/筛选渲染到 `gsReviewTop`（全宽）；主列表卡渲染到 `gsReviewBody`；新增 `renderRecentReviews()` 右栏小卡 `gs-rev-mini`——头部行（头像+用户名+右侧日期/时长）+ 正文截断 + "有帮助 N"行（复用现有 helpful POST 原地更新）；自己的评测小卡也显示（Steam 同款不排除）
6. **长文展开**（主列表大卡 + 右栏小卡都做）：正文超约 200 字截断 + "阅读全文"按钮（`--primary` 主题色文字按钮），点击原地展开全文、再点"收起"；截断按字符长度末尾补 "…"
7. **buildReviewCard（L1489-1535）加评论区**：
   - `gs-rev-main2` 底部（有帮助行之后）加"评论 N"行内按钮（气泡 SVG 常量 `REV_BUBBLE_SVG` + `fmtCount(it.reply_count)`，样式与 gs-rev-help 同族；计数 0 显示"评论"不带数）
   - 点击 toggle 内嵌 `gs-rev-replies` 容器（首次展开调 `loadReplies(it.id, box)`；为 0 直接显示输入行+空态提示"还没有评论"）
   - 新增 `loadReplies(reviewId, box)`：GET `/api/game/review/replies?review_id=N` → 平铺渲染回复行：`用户名：内容`（`reply_to_user` 非空时渲染 `用户名 <i>回复</i> 被回复人：内容`，"回复"二字弱色）+ 行尾相对/绝对时间；行 hover 显示删除 ×（仅 `username` 登录且是自己或 `it.username === username` 即评测主人）→ 直接 DELETE + 原地移除 + `it.reply_count` 减一 + 按钮计数刷新（无确认弹窗，微信删除评论同款）
   - 输入行（仅登录显示）：小输入框 + 发送按钮；点某回复行内"回复"→ 记 `ReplyTo`、输入框上方前置弱色标签"回复 @张三"（右侧 × 可取消）；发送成功清空输入框、列表尾部追加新行、`it.reply_count` 加一并刷新按钮计数
8. 防缓存：`game-store.html` 引用升 `?v=9`

## 三、前端 CSS（e:\SourceCodeIM\im-client\web\game-store.html）

1. 两栏：`.gs-review-cols { display:flex; gap:24px; align-items:flex-start; }`，`.gs-review-main { flex:1; min-width:0; }`，`.gs-review-aside { width:300px; flex-shrink:0; border-left:1px solid var(--divider); padding-left:24px; }`（Steam 右栏分隔线同款，颜色走 `--divider`）
2. 主列表瀑布改单列：`.gs-review-body` 移除 `column-count:2`，连带清理 `column-span:all` 规则（sum/filters/more 已移出或移到 gsReviewTop）
3. 右栏小卡：`.gs-rev-mini`（内边距+底部分隔线）、头部行、正文 4 行截断（`-webkit-line-clamp`）——颜色全走 style.css 现有主题变量
4. 评论区：`.gs-rev-replies`（上边框 `var(--divider)` 分隔 + 左缩进贴齐正文列）；`.gs-rev-reply` 行（用户名主题色/正文正文色/时间 text-light 弱色）；输入行 flex（圆角小输入框 `var(--search-bg)`+`var(--border)` + 发送小按钮 `--primary`）；"回复 @xx"前置标签弱色胶囊；删除 × 弱色 hover 变红（`--danger` 若存在，否则 `--primary` 之外既有语义色，以 style.css 实际变量为准）
5. "阅读全文"按钮：无背景文字按钮 `color: var(--primary)`，hover 下划线
6. 窄窗口 `@media(max-width:900px)`：`.gs-review-cols` 纵向堆叠（右栏 `border-left` 改 `border-top`、宽度 100%）

## 四、验证（真机实测，禁止猜测）

1. 编译并重启 im-server，curl 验证：
   - `/api/game/reviews/{id}?size=5&sort=latest` 按时间降序、size 生效；不带参数行为不变（向后兼容）；list 项含 `create_time`/`reply_count`
   - POST `/api/game/review/reply` 发布/楼中楼回复 → GET `/api/game/review/replies` 平铺返回含 reply_to_user → DELETE 删除（回复人/评测主人口径、他人删除被拒）
2. Edge 打开 game-store.html（Ctrl+Shift+R 硬刷新）进详情页：
   - 布局：汇总条/筛选全宽，下方左主列表单列 + 右栏"最近发布"，右栏左缘分隔线
   - DevTools Console 注入模拟数据（主列表 3 条长文 + 右栏 2 条）验证：长文截断+"阅读全文"展开/收起、右栏小卡结构、窄窗口（<900px 设备模拟）右栏堆叠
   - 评论区实测：点开"评论 N"展开、发布评论、回复指定人（楼中楼标签）、删除自己的回复、按钮计数联动、未登录（浏览器只读模式）只展示列表无输入框
   - getBoundingClientRect 精确测量：左栏+gap+右栏 = 容器内容宽 1036
3. 功能回归：筛选三态只影响主列表、"写评测/编辑我的评测"按钮、提交后两栏刷新、有帮助点赞原地更新、库页签不受影响
4. 测试数据零污染（Console 注入法，F5 还原；实测回复数据从库清理）；开发文档 7.3.53 追加第 11 点记录
