# 游戏中心 P2 商店化：Steam 同款购买/评测/视频/库页签重构 + 分类选择

## Context

用户在已有游戏中心（P1：游戏库/下载/启动 + Steam 同款商店布局 + 后台布局配置）基础上提出 P2 扩展，参考其提供的 7 张 Steam 截图：

1. 详情页 Steam 同款"加入库/获取游戏"入口（购买块）
2. 入库扣积分（Steam 同款购买），管理端上架时可设积分价格（`Game.Price` 字段已预留 float64）
3. 详情页用户评论（Steam 同款评测：推荐/不推荐拇指 + "有帮助"点赞 + 汇总胶囊 + 好评率）
4. 详情页媒体区支持视频+图片混排（Steam 同款：预告片带播放键缩略图）
5. 库页签 Steam 同款重构（左侧游戏侧栏 + 右侧 hero 大图/安装按钮/状态行）
6. 管理端添加游戏支持分类多选（单机/冒险/解谜/竞速/多人/动作/角色扮演等预设）

**用户已确认的决策**：积分共用现有 AI 积分钱包（Points 字段 + PointsLog 流水 + 管理端调整入口全部复用）；仅已入库用户可写评测；积分来源维持现状（注册赠送+AI剩余+管理员发放）；视频分片上传上限 200MB（config 可配）。

## 一、数据模型（im-server/model/model.go）

```go
// GameReview 游戏评测表 im_game_review（一人一评可编辑，仅入库用户可评）
type GameReview struct {
    ID           uint   `gorm:"primaryKey;autoIncrement" json:"id"`
    GameID       uint   `gorm:"column:game_id;uniqueIndex:idx_game_user;not null" json:"game_id"`
    Username     string `gorm:"column:username;type:varchar(32);uniqueIndex:idx_game_user;not null" json:"username"`
    Recommended  int8   `gorm:"column:recommended;type:tinyint;not null" json:"recommended"` // 1=推荐 0=不推荐
    Content      string `gorm:"column:content;type:text" json:"content"`
    PlayHours    float64 `gorm:"column:play_hours;type:double;default:0" json:"play_hours"` // 评测时库内时长冗余
    HelpfulCount int64  `gorm:"column:helpful_count;default:0" json:"helpful_count"`
    CreateTime   time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
    UpdateTime   time.Time `gorm:"column:update_time;autoUpdateTime" json:"update_time"`
}
func (GameReview) TableName() string { return "im_game_review" }

// GameReviewLike 评测"有帮助"标记表 im_game_review_like（uniqueIndex(review_id,username) 幂等）
type GameReviewLike struct { ID uint; ReviewID uint `gorm:"uniqueIndex:idx_rev_user"`; Username string `gorm:"column:username;type:varchar(32);uniqueIndex:idx_rev_user"`; CreateTime time.Time }
```

- `Game` 结构体加列：`Videos string`（varchar(2048) default '[]'，视频 URL JSON 数组，AutoMigrate 自动加列）；`Price` 字段语义启用（积分价格，0=免费）
- InitGame AutoMigrate 追加两新表

## 二、服务端·用户接口（im-server/server/game.go）

沿用 username 查询参数鉴权水位；**路由规避 ServeMux 冲突**（评审过的形态）：

| 路由 | 说明 |
|---|---|
| `GET /api/game/points` | 当前积分余额（字面量段，与 /{id} 交叉字面量优先，同 /list /config 先例） |
| `GET /api/game/{id}/reviews?page=&type=` | 评测列表（每页 10）+汇总 `summary{total,positive,summary_text}`；type=all/1/0 筛选；返回含 username+avatar（in 查 user 表）+helpful_count+liked（当前用户是否已点） |
| `POST /api/game/{id}/review` | 提交/更新自己的评测（upsert 一人一评）；校验：已入库（im_game_library 存在）、recommended ∈{0,1}、content 非空 ≤2000 字；play_hours 从 lib.play_seconds 冗余 |
| `DELETE /api/game/{id}/review` | 删除自己的评测（连带清理 helpful 标记与计数） |
| `POST /api/game/review/helpful` | body {review_id} toggle"有帮助"（唯一索引幂等：已点删除-1，未点插入+1，返回 {liked,helpful_count}）；字面量段 /review/ 与 /{id}/review 方法路径无两可冲突（已推演） |

**改 `POST /api/game/library/{id}`（加库）为 Steam 同款购买流**：
1. 已入库 → 幂等返回成功（不扣分，现有语义保留，检查在扣分之前）
2. `price > 0` → **严格扣分**（区别于 AI 扣分的钳零语义）：`UPDATE im_user SET points=ROUND(points-?,3) WHERE username=? AND points>=?`，RowsAffected==0 → 400 "积分不足，请联系管理员发放"（余额可从 GET /api/game/points 查）→ `recordPointsLog(username, -price, balanceAfter, "game_purchase", "system", "购买游戏: <name>")`（复用 [aipoints.go](e:/SourceCodeIM/im-server/server/aipoints.go) 归口）
3. `price == 0` → 免费直接入库
4. **改 `DELETE /api/game/library/{id}`（移出库，仅未安装态）→ 全额退还积分**（recordPointsLog reason="game_refund"），防误操作损失
5. 加库/退库响应带 `balance` 字段供前端实时刷新（符合用户"余额实时更新"偏好）

- `gameSummary()` 增加 `videos` 字段输出（解析 Videos JSON）
- InitGame AutoMigrate 补两新表

## 三、服务端·管理接口（im-server/server/gameadmin.go）

| 路由 | 说明 |
|---|---|
| `POST /admin/api/game/upload/video` | 视频分片上传：复用 gameUploadSessions 会话模式（新增 kind 字段区分 video/version 或独立 map），raw body 分片同 handleAdminGameChunk；扩展名白名单 .mp4/.webm/.mkv；大小上限 config `video_max_size`（默认 200MB）；落 `WebDir/static/upload/games/videos/<upload_id>.<ext>`（静态服务天然托管） |
| `POST /admin/api/game/upload/video/cancel` | 取消会话清理临时分片（对齐现有 chunk/cancel 模式） |
| `DELETE /admin/api/game/video` | body {url} 删除已上传视频文件（gameRelPathClean 归口清洗防穿越） |

- handleAdminGameCreate/Update：透传 `price`（float64 ≥0 校验）与 `videos`（JSON 数组清洗：仅允许 /static/upload/games/videos/ 前缀相对路径）
- config.go GameConfig 结构体加 `VideoMaxSize int64`（yaml `game.video_max_size`，默认 209715200=200MB；**config.yaml 与 config - linux.yaml 双文件同步**）

## 四、商店前端（im-client/web/game-store.js / game-store.html，版本 v3→v4）

### 4.1 详情页媒体区（Steam 同款视频+图片混排）
- `shotUrls(d)` → `mediaItems(d)`：screenshots 图片项 `{type:'image',url}` + videos 视频项 `{type:'video',url}`（视频排前，Steam 同款预告片在前）
- `buildMediaCarousel(items)` 改造：video 项主舞台渲染深色块+居中播放 SVG 按钮，切到该项时渲染 `<video controls autoplay>`（切走 pause+清 src 释放资源）；缩略图条视频项带播放角标

### 4.2 详情页购买块（Steam 同款"获取游戏"）
- 位置：右列安装框（gs-install-state 区域改造）——未入库时显示：游戏名 + 价格行（免费=绿色"免费"徽标 / 收费="¥<price> 积分"金色文字 Steam 风格）+ 当前积分余额小字 + 主按钮（免费→"加入库"；收费→"用积分获取"）+ 浏览器端提示（同现有）
- 收费点击 → 自绘确认弹窗（复用 gsConfirm/gsModal 模式，禁系统弹窗）："将扣除 <price> 积分获取该游戏，当前余额 <balance>"；余额不足 → 弹窗提示"积分不足（余额 <balance>，需 <price>），请联系管理员发放"
- 购买成功 → toast + 按钮 state 机刷新（进 gameActions 已入库态）+ 余额实时更新
- 已入库 → 现有 gameActions 按钮态机不变

### 4.3 评论区（Steam 同款，详情页左列底部新 section）
- 汇总行：胶囊（好评率文案 Steam 规则：positive≥80% "特别好评" / ≥70% "多半好评" / 40-70% "褒贬不一" / ≤40% "差评居多"）+ 总评数 + 正负比例条
- 筛选行：全部 / 推荐 / 不推荐（type 参数）+ "加载更多"分页
- 评测卡：头像（user avatar，缺省首字母色块）+ 用户名 + 推荐蓝拇指/不推荐红拇指图标 + 游戏时长（play_hours 格式化 "xx.x 小时"）+ 内容（可展开收起，长评折叠）+ "有帮助 <n>"按钮（点亮态回显 liked）
- 写评测：已入库未评/可编辑 → "写评测"或"编辑我的评测"按钮 → 自绘弹窗（推荐/不推荐大拇指二选 + textarea + 提交）
- 未入库不显示写评测入口（服务端也校验）

### 4.4 库页签 Steam 同款重构（gsViewLibrary）
- 双栏布局：左侧库侧栏（竖排行：小缩略图+名称，选中高亮；顶部"库"标题+数量）+ 右侧内容区
- 未选中游戏：右侧显示"最近游戏"横排卡片（按 last_play_at 降序，封面+名称+最后运行时间）+ 空态
- 选中游戏：hero 大图（cover，渐隐底部）+ 主按钮行（gameActions 现有按钮：安装/暂停/继续/启动/更新）+ 状态行（已安装版本/安装大小 size_bytes/最后运行 last_play_at/游戏时间 play_seconds 格式化 h 小时 m 分）+ 游戏简介
- 数据零新增（/api/game/library 已返回 lib+game 全字段），纯前端重构

### 4.5 杂项
- 详情页返回逻辑不变；搜索/标签筛选不受影响
- html 引用 `js/game-store.js?v=4`，pc/main.js loadURL 同步 `?v=4`

## 五、管理端（im-client/web/admin.html / js/admin.js / css/admin.css）

- **游戏表单分类多选**：`gm-f-tags` 自由文本输入替换为预设分类胶囊多选（单机/多人/动作/冒险/解谜/竞速/角色扮演/策略/休闲/射击/模拟/恐怖）+ "自定义"小输入框（逗号分隔补充）；编辑回显：已有 tags 命中预设则勾选，未命中的显示为自定义胶囊；保存时合并为逗号串（存储格式不变，旧数据零迁移）
- **积分价格输入**：表单新增 `gm-f-price`（number，≥0，默认 0=免费，占位提示"0=免费，>0 为入库所需积分"）
- **视频上传**：表单新增视频区——选择文件（accept=.mp4,.webm,.mkv）→ 8MB 分片顺序 POST /admin/api/game/upload/video（对齐现有游戏包分片上传的进度条模式）→ 上传完成追加视频行（URL+删除按钮）；提交时 videos 数组随表单 JSON 一起 PUT/POST
- 列表页加"价格"列显示（积分/免费）

## 六、实施顺序

1. model.go：GameReview/GameReviewLike 两表 + Game.Videos 列 → 编译
2. game.go：points 接口 + reviews CRUD/helpful + 加库购买流改造 + gameSummary videos → 编译
3. gameadmin.go：视频分片上传/取消/删除 + Create/Update 支持 price/videos + config VideoMaxSize → 编译
4. config.yaml + config - linux.yaml 同步 game.video_max_size
5. game-store.js/html：媒体混排 → 购买块 → 评论区 → 库页签重构
6. admin.html/js/css：分类多选 + 价格 + 视频上传
7. 实测（下节）→ 清理测试数据 → 更新开发文档 7.3.53 章节

## 七、验证方案

**数据层（curl，服务端重编译重启 2087）**：
- GET /api/game/points 返回余额
- 免费游戏加库 → 200 幂等（重复加库不重复扣）；收费游戏（测试价格 30）加库 → 扣 30 + PointsLog 出现 game_purchase 流水 + balance 实时返回
- 余额不足场景（临时调价或扣除后）→ 400 "积分不足"
- 退库 → 全额退还 + game_refund 流水
- 评测：未入库提交 → 403；入库后提交/更新/删除 → 全链路；helpful toggle → 计数+liked 回显幂等
- 管理端视频分片上传 → 200 落盘 videos/ 目录；超 200MB 拒绝；非法扩展名拒绝

**真机 UI（computer_use + Edge，browser_use 通道不稳时的既定替代路径）**：
- 详情页：购买块显示价格与余额 / 确认弹窗 / 积分不足提示 / 购买后按钮态切换+余额刷新
- 评论区：写评测弹窗 / 提交后列表刷新 / 有帮助点赞 / 筛选切换
- 媒体区：视频缩略图播放键 / 点击内联播放
- 库页签：侧栏选中 / hero+状态行 / 最近游戏横排
- 管理端：分类胶囊多选保存回显 / 价格输入 / 视频上传进度
- Console 零 ERROR

**测试数据清理**：测试游戏（1 免费 1 收费）+ 测试评测 + 测试视频文件，测完即删

## 八、关键复用清单

- [aipoints.go](e:/SourceCodeIM/im-server/server/aipoints.go)：userPoints / recordPointsLog（新增 game_purchase/game_refund reason，管理端流水页自动兼容）
- [gameadmin.go](e:/SourceCodeIM/im-server/server/gameadmin.go)：gameUploadSessions 分片会话模式 / gameRelPathClean 路径清洗 / handleAdminGameImage 落盘路径约定
- [game-store.js](e:/SourceCodeIM/im-client/web/js/game-store.js)：gameActions 按钮态机 / gsConfirm 自绘弹窗 / toast / osbInitH 横向滑块 / buildPh 占位块
- admin.js：现有游戏包分片上传进度模式（视频上传复用）
- 积分流水管理页（admin 积分页签）自动展示 game_purchase/game_refund 新 reason，无需改动
