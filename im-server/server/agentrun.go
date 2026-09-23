package server

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"

	"im-server/config"
	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// 阶段五十九：智能 Agent 自动化任务（工具调用闭环 + 权限审批）
// 运行逻辑：发起任务 → 模型决策（thought）→ 选择工具 → 风险分级（白名单自动放行 / 高危推送审批）
// → 执行工具回传结果 → 循环迭代 → 无工具调用时输出最终答复（done）。
// 每步事件实时推送给发起用户（思考过程 / 工具执行 / 审批请求 / 任务清单 / 进度）。

// 体积与次数上限（防超长输出撑爆模型上下文 / 防滥用）
const (
	agentReadMaxChars   = 50000         // read_file 单次返回字符上限
	agentWriteMaxChars  = 200000        // write_file 单次写入字符上限
	agentCmdOutMaxChars = 8000          // run_command 输出字符上限
	agentCmdTimeoutMax  = 300           // run_command 超时秒上限
	agentTodoMaxItems   = 50            // 任务清单条数上限
	agentTaskIdleClean  = 2 * time.Hour // 结束任务在内存注册表中的保留时长（防泄漏）

	// 阶段七十四：文件工具补全（list_dir/grep/edit_file/delete_file）与 read_file 分段读取的限额
	agentGrepMaxResults   = 50      // grep 默认返回条数
	agentGrepResultsHard  = 200     // grep 返回条数硬上限（max_results 参数钳制）
	agentGrepFileMaxHits  = 20      // grep 单文件展示命中上限（防单文件刷屏挤掉其他文件）
	agentGrepMaxFiles     = 2000    // grep 单次遍历文件数上限（防超大工作区拖死任务）
	agentGrepMaxFileBytes = 2 << 20 // grep 跳过的单文件大小上限（2MB，大文件多为数据/日志非代码）
	agentGrepLineMaxRunes = 200     // grep 匹配行展示截断宽度
	agentListDirMax       = 500     // list_dir 单次列目录条目上限

	// 阶段七十五：命令执行实时输出流 + 转后台限额
	agentCmdStreamMaxBytes = 64 << 10         // 控制台流式输出累计上限（超出停止下发增量，结束帧注明总字节；模型结果仍按 agentCmdOutMaxChars 截断）
	agentCmdStreamFlushMs  = 200              // 输出聚合下发节流（毫秒，防逐行刷屏拖垮 WS）
	agentBgCmdTimeout      = 30 * time.Minute // 转后台后的兜底强杀超时（前台仍按命令自身 timeout）

	// 阶段一百零一：命令超时收尾三保险（杀整树 / 哨兵提前判定 / 强返兜底），修复任务永久挂死
	agentCmdDoneSentinel   = "__AGENT_CMD_DONE__" // 命令尾部完成哨兵（读到该行即命令链收尾，孙进程占管道也能及时返回；PC 端 CMD_DONE_SENTINEL 与此一致）
	agentCmdForceReturnGap = 5 * time.Second      // 超时杀树后的强返宽限（到点强制返回已有输出，绝不等管道 EOF 挂死任务）

	agentChangeMaxFiles = 200 // 阶段七十七：递归删目录时逐文件快照上限（防超大目录拖垮任务，超出部分不记变更不可撤销）

	// 阶段八十四：任务循环历史压缩保留轮数（最近 N 个完整"模型决策+工具执行"轮保留原文，
	// 更早轮次 LLM 摘要归并；阈值与 AI 问答共用 aiCompressThreshold，config.yaml ai.compress_threshold_tokens）
	agentCompressKeepTurns = 3
)

// agentToolResultMaxChars 阶段八十四：工具结果写入模型上下文的字符上限
// （0=默认 8000，负数=不截断；仅约束进模型的历史，前端执行控制台与留痕仍显示全量）
var agentToolResultMaxChars = 8000

// agentGrepSkipDirs grep 遍历跳过的目录名（依赖/构建产物/版本库等非源码大目录）
var agentGrepSkipDirs = map[string]bool{
	".git": true, ".idea": true, ".vscode": true, "node_modules": true,
	"vendor": true, "__pycache__": true, "dist": true, "build": true,
	"bin": true, "obj": true, "target": true,
}

// 运行时配置（InitAgent 从 config.yaml ai.agent 节点加载，均有兜底默认值）。
// 阶段八十一/八十二：除 agentWorkRoot（路径安全归口，仅启动加载）与白名单两变量（agentWlMu 保护）外，
// 全部为 atomic——后台管理保存即热生效（运行中任务下一步即按新值判定），落库重启不丢
var (
	agentEnabled     atomic.Bool             // Agent 总开关
	agentMaxSteps    atomic.Int64            // 单任务最大迭代步数
	agentToolTimeout atomic.Int64            // run_command 默认超时秒（1~300）
	agentApproveWait atomic.Int64            // 高危工具审批等待超时秒
	agentAutoWrite   = false                 // 全局写文件免审批（后台设置；agentWlMu 保护）
	agentAutoCmds    []string                // 全局命令自动放行白名单前缀（后台设置，对全员生效；agentWlMu 保护）
	agentUserCmds    = map[string][]string{} // 阶段八十三：用户个人命令白名单（审批弹窗"同意并加白"仅本人生效；agentWlMu 保护）
	agentUserWrite   = map[string]bool{}     // 阶段八十三：用户个人写文件免审批开关（同上；agentWlMu 保护）
	agentWorkRoot    = ""                    // 工作区根目录（不开放热改：改错路径会让新任务文件落错磁盘位置）
	agentPcExec      atomic.Bool             // 本地执行器开关（true 时 PC 端在线则文件/命令下放用户本地执行）
	agentConcurrency atomic.Int64            // 每用户同时运行任务数上限
	agentQueueSize   atomic.Int64            // 每用户排队任务数上限（排队已满直接拒绝）
)

// 后台可调参数的合法区间（后台保存与启动加载共用同一校验）
const (
	agentStepsMin   = 1
	agentStepsMax   = 500
	agentToolTMin   = 5  // run_command 默认超时秒下限
	agentApproveMin = 10 // 审批等待秒下限
	agentApproveMax = 3600
	agentConcMin    = 1 // 每用户并发上限区间
	agentConcMax    = 10
	agentQueueMin   = 1 // 排队上限区间
	agentQueueMax   = 50
)

func init() { // 兜底默认（config.yaml/DB 均未配置时生效）
	agentMaxSteps.Store(30)
	agentToolTimeout.Store(60)
	agentApproveWait.Store(300)
	agentConcurrency.Store(1)
	agentQueueSize.Store(5)
}

// AgentTodoItem 任务清单条目（todo_write 全量替换，前端渲染进度条）
type AgentTodoItem struct {
	Content string `json:"content"`
	Status  string `json:"status"` // pending/in_progress/done
}

// AgentApproval 审批结果（用户上行投递到等待中的任务）
type AgentApproval struct {
	Action string                 // approve / reject / cancel（取消任务时服务端内部投递）；阶段一百二十五 ask_user 复用：answer / skip
	Params map[string]interface{} // 改参放行后的新参数（approve 且非空时替换执行参数）
	Answer string                 // 阶段一百二十五：ask_user 提问的用户答案（action=answer 时非空：选项 label 或自由输入文本）
}

// AgentExecResult 阶段六十：PC 本地执行器回传的工具执行结果（handleAgentExecResp 投递到等待中的任务）
type AgentExecResult struct {
	OK      bool            // false=工具级失败（路径越界/读失败等），结果照常回传模型自纠
	Output  string          // 给模型的结果文本（与服务端执行同格式约定）
	Changes []agentPCChange // 阶段八十：本地文件变更（写/改/删回传，服务端登记审查条）
}

// agentPCChange 阶段八十：PC 本地执行回传的结构化文件变更（执行器首触备份后组装）。
// 文件在用户磁盘，服务端读不到内容——统计由执行器按任务前备份计算上报，服务端免重算；
// 撤销时把 Backup/Local 原样下发执行器还原字节（Kind=create 删除任务中新建的文件）
type agentPCChange struct {
	Path        string `json:"path"`        // 展示路径（正斜杠）
	Local       string `json:"local"`       // 文件本地绝对路径
	Kind        string `json:"kind"`        // create/modify/delete（首触行语义）
	Adds        int    `json:"adds"`        // 相对任务前内容的累计新增行数
	Dels        int    `json:"dels"`        // 相对任务前内容的累计删除行数
	Backup      string `json:"backup"`      // 本地备份文件绝对路径（create 为空）
	Deleted     bool   `json:"deleted"`     // 操作后文件已不存在
	Explanation string `json:"explanation"` // AI 修改说明（工具 explanation 参数透传，同路径取最近一次）
}

// pcRevertWait 阶段八十：撤销本地变更的回传等待器（步骤键归口防错投，异步不阻塞审查上行）
type pcRevertWait struct {
	username string
	ch       chan *AgentExecResult
}

// pcRevertWaiters 撤销等待表：step(rv-<taskID>-<纳秒>) → *pcRevertWait（完成/超时即删）
var pcRevertWaiters sync.Map

// AgentTask 运行中任务状态（内存态；结束态落库 im_agent_task 供追溯）
type AgentTask struct {
	ID       string
	Username string
	Agent    *AIRunAgent
	Goal     string

	Status    string // queued / running / waiting_approval / completed / failed / cancelled
	Cancelled atomic.Bool

	EnqueueSeq uint64 // 阶段六十七：入队序号（FIFO 派发排序依据，直接启动的任务不使用）
	SessionID  uint   // 阶段七十一：归属 AI 会话（受理时盖戳，0=默认会话；任务卡重放按会话过滤）

	mu          sync.Mutex
	todo        []AgentTodoItem
	approveCh   chan *AgentApproval   // 容量 1：等待审批时由 handleAgentApprove 投递
	approveStep string                // 当前等待审批的步骤 key（toolCall.ID，防跨任务/跨步骤错投）
	approveTool string                // 阶段六十二：当前等待审批的工具名（"同意并加白"按工具分流）
	askCh       chan *AgentApproval   // 阶段一百二十五：容量 1，等待 ask_user 提问回答时由 handleAgentAsk 投递（与审批同源挂起语义，互不干扰）
	askStep     string                // 阶段一百二十五：当前等待回答的步骤 key（toolCall.ID，防迟到回答错投）
	execCh      chan *AgentExecResult // 阶段六十：容量 1，等待 PC 本地执行回传时由 handleAgentExecResp 投递
	execStep    string                // 当前等待本地执行回传的步骤 key（toolCall.ID，防迟到回传错投）
	runBgCh     chan struct{}         // 阶段七十五：当前运行中 run_command 的"转后台"请求通道（close 广播；nil=无运行中命令）
	runBgStep   string                // 转后台通道归属步骤（toolCall.ID，防错投）
	// 阶段一百三十八：任务级取消上下文——修复"用户停止后当前轮模型调用继续烧上游 tokens"问题。
	// 原实现每轮 askCtx 派生自 context.Background()，取消信号传不到进行中的调用，当前轮要跑完
	// （叠加多源重试最长可达数倍 aiAskTimeout）才在循环回顶检查点退出；现每轮 askCtx 派生自
	// runCtx，取消归口调用 runCancel() 即刻中止当前轮上游请求，tokens 立即停耗。
	// 创建后只读访问无需锁；agentFinish endOnce 内统一 runCancel 防上下文泄漏
	runCtx     context.Context
	runCancel  context.CancelFunc
	steps      int
	StartAt    time.Time         // 阶段一百三十八：实际开始执行时刻（直接启动/队列派发时赋值），完结时算耗时随帧下发
	stepSeq    int               // 阶段六十五：执行轨迹序号计数器（与 steps 区分——steps 为模型迭代轮次，stepSeq 为工具调用留痕序号）
	changeSeq  int               // 阶段七十七：变更快照序号（备份文件命名去重）
	changes    []*agentChangeRec // 阶段七十七：任务内文件变更归口（同路径首触保留最早 before，撤销还原到任务前状态）
	usageTotal aiUsage           // 阶段一百零二：任务全程模型调用 Token 累计（mu 保护；完结时统一落库/随帧下发）
	pointsCost float64           // 阶段一百三十八：任务全程实际扣除积分累计（每轮即时扣时累加，mu 保护；完结随帧下发供前端精确展示）
	endOnce    sync.Once
}

// 任务注册表（taskID → task；含近期结束任务用于取消竞态兜底，定期清理防泄漏）
var agentTasks sync.Map // map[string]*AgentTask

// agentQueueMu 阶段六十七：任务发起/派发互斥锁——「统计并发+入队/启动」与「完结后派发队首」
// 均在锁内完成，防止并发发起时双双判定有空位超开任务（sendToUser 为非阻塞投递，锁内推送安全）
var agentQueueMu sync.Mutex

// agentEnqueueSeq 阶段六十七：全局入队序号发生器（保证 FIFO 严格递增）
var agentEnqueueSeq atomic.Uint64

// agentCountForUser 统计用户当前活动任务数（running/waiting_approval）与排队任务列表（按 EnqueueSeq 升序）
// 调用方须持有 agentQueueMu
func agentCountForUser(username string) (active int, queued []*AgentTask) {
	agentTasks.Range(func(_, value any) bool {
		t := value.(*AgentTask)
		if t.Username != username {
			return true
		}
		t.mu.Lock()
		st := t.Status
		t.mu.Unlock()
		switch st {
		case "running", "waiting_approval":
			active++
		case "queued":
			queued = append(queued, t)
		}
		return true
	})
	sort.Slice(queued, func(i, j int) bool { return queued[i].EnqueueSeq < queued[j].EnqueueSeq })
	return active, queued
}

// agentDispatchNext 阶段六十七：派发归口——用户活动任务数低于并发上限时，启动队首最早入队的排队任务；
// 无论是否派发，均给全部排队任务广播当前位次（队首取走/取消中段任务后位次前移，未变的幂等刷新）。
// 任务完结（completed/failed/cancelled）与取消排队后统一调用
func (s *Server) agentDispatchNext(username string) {
	agentQueueMu.Lock()
	active, queued := agentCountForUser(username)
	var head *AgentTask
	if active < int(agentConcurrency.Load()) && len(queued) > 0 {
		head = queued[0]
		queued = queued[1:]
		head.mu.Lock()
		head.Status = "running"
		head.StartAt = time.Now() // 阶段一百三十八：执行计时起点（耗时统计归口）
		head.mu.Unlock()
		store.DB.Model(&model.AgentTaskRecord{}).Where("task_id = ?", head.ID).Update("status", "running")
	}
	// 排队位次广播（i+1 即当前位次：队首被派发取走或中段任务取消后，后续任务位次前移）
	for i := range queued {
		s.agentEmit(queued[i], "status", map[string]interface{}{"status": "queued", "text": "排队中", "position": i + 1})
	}
	agentQueueMu.Unlock()
	if head == nil {
		return
	}
	logger.Info("Agent 任务自队列派发 %s（用户 %s，剩余排队 %d）", head.ID, username, len(queued))
	// 已受理事件（前端将排队卡片切换为执行中）
	s.agentEmit(head, "status", map[string]interface{}{"status": "running", "text": "任务已受理", "goal": head.Goal, "agent": head.Agent.Name, "from_queue": true})
	// 异步执行状态机（不阻塞 WebSocket 主调度）
	go s.runAgentTask(head)
}

// usernameSanitizeRe 用户名 → 目录名归口（注册用户名本就受限，防御性兜底：
// 仅保留字母数字下划线中划线与常用中文，其余字符替换为下划线，防路径拼接注入）
var usernameSanitizeRe = regexp.MustCompile(`[^0-9A-Za-z_\-\x{4e00}-\x{9fa5}]`)

func agentUsernameDir(username string) string {
	return usernameSanitizeRe.ReplaceAllString(username, "_")
}

// InitAgent 阶段五十九：初始化智能 Agent 模块（config 归口 + 任务表迁移）
func InitAgent(cfg *config.Config) {
	agentEnabled.Store(cfg.AI.Agent.Enabled)
	if cfg.AI.Agent.MaxSteps > 0 {
		agentMaxSteps.Store(int64(cfg.AI.Agent.MaxSteps))
	}
	if cfg.AI.Agent.ToolTimeoutSeconds > 0 {
		t := cfg.AI.Agent.ToolTimeoutSeconds
		if t > agentCmdTimeoutMax {
			t = agentCmdTimeoutMax
		}
		agentToolTimeout.Store(int64(t))
	}
	if cfg.AI.Agent.ApproveTimeoutSeconds > 0 {
		agentApproveWait.Store(int64(cfg.AI.Agent.ApproveTimeoutSeconds))
	}
	agentAutoWrite = cfg.AI.Agent.AutoWrite
	agentAutoCmds = cfg.AI.Agent.AutoCommands
	// 阶段八十四：工具结果入模型上下文的字符上限（0=默认 8000，负数=不截断；前端控制台仍显示全量）
	if cfg.AI.Agent.ToolResultMaxChars > 0 {
		agentToolResultMaxChars = cfg.AI.Agent.ToolResultMaxChars
	} else if cfg.AI.Agent.ToolResultMaxChars < 0 {
		agentToolResultMaxChars = -1
	}
	agentPcExec.Store(cfg.AI.Agent.PcExecutor)
	// 阶段六十七：任务队列参数归口（并发上限 0=1，排队上限 0=5）
	if cfg.AI.Agent.Concurrency > 0 {
		agentConcurrency.Store(int64(cfg.AI.Agent.Concurrency))
	}
	if cfg.AI.Agent.QueueSize > 0 {
		agentQueueSize.Store(int64(cfg.AI.Agent.QueueSize))
	}
	// 工作区根目录已在 config.Load 归口解析为绝对路径（空=exe目录/agent_workspace）
	agentWorkRoot = cfg.AI.Agent.WorkspaceRoot
	// 阶段六十八：网络工具配置归口（http_request 默认开启；web_search 默认关闭须显式配置服务商）
	agentHttpEnabled.Store(cfg.AI.Agent.HttpEnabled == nil || *cfg.AI.Agent.HttpEnabled)
	agentHttpAllowPrivate.Store(cfg.AI.Agent.HttpAllowPrivate == nil || *cfg.AI.Agent.HttpAllowPrivate)
	// 阶段九十一：内置浏览器工具开关（默认开启——审批分级已收敛风险，关闭即整体下线）
	agentBrowserEnabled.Store(cfg.AI.Agent.PCBrowser == nil || *cfg.AI.Agent.PCBrowser)
	agentSearchEnabled.Store(cfg.AI.Agent.WebSearch.Enabled != nil && *cfg.AI.Agent.WebSearch.Enabled)
	agentSearchConfigStore(
		strings.ToLower(strings.TrimSpace(cfg.AI.Agent.WebSearch.Provider)),
		strings.TrimSpace(cfg.AI.Agent.WebSearch.APIKey),
		strings.TrimSpace(cfg.AI.Agent.WebSearch.Endpoint))
	if err := store.DB.AutoMigrate(&model.AgentTaskRecord{}); err != nil {
		logger.Error("Agent 任务表迁移失败: %v", err)
	}
	// 阶段六十七：服务重启遗留态归口——内存任务注册表随进程消失，落库的 queued/running 记录
	// 已不可能恢复（queued 从未启动、running 执行中断），统一标记 failed 防任务历史出现幻影进行态
	// 阶段一百零五修复（2026-09-13 启动日志误报）：链式调用返回 *gorm.DB 指针恒非 nil，
	// 原实现直接 `if err := ...Updates(...)` 判空导致每次启动必误报 ERROR——须取 .Error 属性
	if err := store.DB.Model(&model.AgentTaskRecord{}).
		Where("status IN ?", []string{"queued", "running"}).
		Updates(map[string]interface{}{"status": "failed", "error": "服务重启，任务中断"}).Error; err != nil {
		logger.Error("Agent 遗留任务状态清理失败: %v", err)
	}
	// 阶段六十五：执行步骤留痕表迁移
	if err := store.DB.AutoMigrate(&model.AgentStepRecord{}); err != nil {
		logger.Error("Agent 执行轨迹表迁移失败: %v", err)
	}
	// 阶段七十七：任务文件变更审查表迁移（TRAE CN 同款"文件变更审查条"归口）
	if err := store.DB.AutoMigrate(&model.AgentChangeRecord{}); err != nil {
		logger.Error("Agent 变更审查表迁移失败: %v", err)
	}
	// 阶段七十一：AI 多会话表迁移（用户+智能体 多会话归口，Trae 同款"新建会话"）
	initAISessionTable()
	// 阶段七十二：私聊永久删除审批表迁移（双方同意才物理删除）
	if err := store.DB.AutoMigrate(&model.MsgPurgeApply{}); err != nil {
		logger.Error("永久删除审批表迁移失败: %v", err)
	}
	// 阶段一百零六：Git 助手提示词表迁移 + 启动加载（后台可配置热更新，DB 值优先于内置默认）
	initGitPrompts()
	// 阶段六十二：加载审批白名单（命令前缀 + 写文件免审批开关）——审批弹窗"同意并加白"持久化，重启不丢
	if err := store.DB.AutoMigrate(&model.AgentWhitelist{}); err != nil {
		logger.Error("Agent 白名单表迁移失败: %v", err)
	} else {
		// 阶段八十二：命令白名单改全量语义（后台管理 = 全局唯一真值）。首次升级（无 cmdinit 标记）时
		// 将 config.yaml 白名单与既有 DB 全局行（审批加白）合并回写 DB 并打标记，之后 DB 集合即真值（空集亦合法）。
		// 阶段八十三：行按 username 拆分——空=全局（agentAutoCmds），非空=用户个人（agentUserCmds，仅本人生效）
		var wlRows []model.AgentWhitelist
		store.DB.Where("kind = ?", "cmd").Find(&wlRows)
		var initRow model.AgentWhitelist
		dbInit := store.DB.Where("kind = ?", "cmdinit").First(&initRow).Error == nil
		if dbInit || len(wlRows) > 0 {
			cmds := make([]string, 0, len(wlRows))
			seen := map[string]bool{}
			userSeen := map[string]map[string]bool{}
			for _, r := range wlRows {
				v := strings.ToLower(strings.TrimSpace(r.Value))
				if v == "" {
					continue
				}
				if r.Username != "" {
					// 用户个人行：按用户去重装载（仅该用户生效）
					if userSeen[r.Username] == nil {
						userSeen[r.Username] = map[string]bool{}
					}
					if !userSeen[r.Username][v] {
						userSeen[r.Username][v] = true
						agentUserCmds[r.Username] = append(agentUserCmds[r.Username], v)
					}
					continue
				}
				if !seen[v] {
					seen[v] = true
					cmds = append(cmds, v)
				}
			}
			if !dbInit {
				// 一次性迁移：config 白名单并入 DB 全局集合 + 写初始化标记
				for _, v := range agentAutoCmds {
					v = strings.ToLower(strings.TrimSpace(v))
					if v != "" && !seen[v] {
						seen[v] = true
						cmds = append(cmds, v)
						store.DB.Create(&model.AgentWhitelist{Kind: "cmd", Value: v})
					}
				}
				store.DB.Create(&model.AgentWhitelist{Kind: "cmdinit", Value: "1"})
			}
			agentAutoCmds = cmds
		} else {
			// DB 从未有白名单：固化 config 值进 DB（后台接管为唯一真值）
			for _, v := range agentAutoCmds {
				v = strings.ToLower(strings.TrimSpace(v))
				if v != "" {
					store.DB.Create(&model.AgentWhitelist{Kind: "cmd", Value: v})
				}
			}
			store.DB.Create(&model.AgentWhitelist{Kind: "cmdinit", Value: "1"})
		}
		// 阶段八十三：写文件免审批按 username 拆分——空=全局开关（后台设置），非空=用户个人开关（审批加白）
		var awRows []model.AgentWhitelist
		store.DB.Where("kind = ?", "autowrite").Find(&awRows)
		for _, r := range awRows {
			if r.Username == "" {
				agentAutoWrite = r.Value != "0" // 阶段八十二：支持关闭（"0"=关）；旧记录空值/"on" 视为开
			} else {
				agentUserWrite[r.Username] = r.Value != "0"
			}
		}
		logger.Info("Agent 审批白名单加载完成：全局命令前缀 %d 条，全局写免审批=%v，个人白名单用户数 %d（命令 %d 条，写免审批 %d 人）",
			len(agentAutoCmds), agentAutoWrite, len(agentUserCmds), func() int {
				n := 0
				for _, l := range agentUserCmds {
					n += len(l)
				}
				return n
			}(), len(agentUserWrite))
	}
	// 阶段八十一/八十二：后台热更新参数启动加载（im_agent_whitelist 多 kind 行）——后台保存即落库，
	// DB 值优先于 config.yaml（后台调整属最新意图）；越界/坏值忽略回落配置值。
	// 阶段八十三：限定 username=''（恒为全局行）——个人 autowrite 行不在此列，避免覆盖全局开关
	var setRows []model.AgentWhitelist
	store.DB.Where("kind IN ? AND username = ?", []string{
		"maxsteps", "tool_timeout", "approve_timeout", "concurrency", "queue_size",
		"enabled", "pcexec", "autowrite",
		"http_enabled", "http_private", "browser_enabled", "search_enabled", "search_provider", "search_key", "search_endpoint",
	}, "").Find(&setRows)
	sp, sk, se := agentSearchConfig().Provider, agentSearchConfig().APIKey, agentSearchConfig().Endpoint
	for _, r := range setRows {
		v := strings.TrimSpace(r.Value)
		switch r.Kind {
		case "maxsteps":
			if n, e := strconv.Atoi(v); e == nil && n >= agentStepsMin && n <= agentStepsMax {
				agentMaxSteps.Store(int64(n))
			}
		case "tool_timeout":
			if n, e := strconv.Atoi(v); e == nil && n >= agentToolTMin && n <= agentCmdTimeoutMax {
				agentToolTimeout.Store(int64(n))
			}
		case "approve_timeout":
			if n, e := strconv.Atoi(v); e == nil && n >= agentApproveMin && n <= agentApproveMax {
				agentApproveWait.Store(int64(n))
			}
		case "concurrency":
			if n, e := strconv.Atoi(v); e == nil && n >= agentConcMin && n <= agentConcMax {
				agentConcurrency.Store(int64(n))
			}
		case "queue_size":
			if n, e := strconv.Atoi(v); e == nil && n >= agentQueueMin && n <= agentQueueMax {
				agentQueueSize.Store(int64(n))
			}
		case "enabled":
			agentEnabled.Store(v == "1")
		case "pcexec":
			agentPcExec.Store(v == "1")
		case "autowrite":
			agentAutoWrite = v != "0" // 与上方旧记录兼容语义一致
		case "http_enabled":
			agentHttpEnabled.Store(v == "1")
		case "http_private":
			agentHttpAllowPrivate.Store(v == "1")
		case "browser_enabled":
			agentBrowserEnabled.Store(v == "1")
		case "search_enabled":
			agentSearchEnabled.Store(v == "1")
		case "search_provider":
			if v != "" {
				sp = strings.ToLower(v)
			}
		case "search_key":
			sk = v
		case "search_endpoint":
			se = v
		}
	}
	agentSearchConfigStore(sp, sk, se)
	// 定期清理已结束任务（防注册表泄漏）
	go func() {
		ticker := time.NewTicker(30 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			agentTasks.Range(func(key, value any) bool {
				t := value.(*AgentTask)
				t.mu.Lock()
				st := t.Status
				t.mu.Unlock()
				if st == "completed" || st == "failed" || st == "cancelled" {
					agentTasks.Delete(key)
				}
				return true
			})
		}
	}()
	logger.Info("智能 Agent 模块加载完成：enabled=%v，max_steps=%d，工作区=%s", agentEnabled.Load(), agentMaxSteps.Load(), agentWorkRoot)
	// 阶段六十八：网络工具状态日志（web_search 未开启时提示配置方式，方便管理员启用）
	logger.Info("Agent 网络工具：http_request=%v（内网访问=%v），web_search=%v（provider=%s）",
		agentHttpEnabled.Load(), agentHttpAllowPrivate.Load(), agentSearchEnabled.Load(), agentSearchConfig().Provider)
}

// agentWorkspaceDir 用户工作区目录（按 username 隔离，不存在则创建）
func agentWorkspaceDir(username string) (string, error) {
	dir := filepath.Join(agentWorkRoot, agentUsernameDir(username))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// agentSafePath 路径安全归口：将模型给定的相对路径解析到用户工作区内。
// 拒绝绝对路径 / 盘符 / 任意 .. 逃逸；返回工作区内绝对路径（双保险：Join 后 Rel 校验）
func agentSafePath(username, p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" {
		return "", errors.New("路径不能为空")
	}
	if filepath.IsAbs(p) || strings.Contains(p, ":") || strings.HasPrefix(p, "/") || strings.HasPrefix(p, `\`) {
		return "", errors.New("仅允许工作区内的相对路径")
	}
	clean := filepath.Clean(filepath.FromSlash(p))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "..") {
		return "", errors.New("路径不允许包含 .. 上级引用")
	}
	ws, err := agentWorkspaceDir(username)
	if err != nil {
		return "", err
	}
	full := filepath.Join(ws, clean)
	rel, err := filepath.Rel(ws, full)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", errors.New("路径越界")
	}
	return full, nil
}

// agentWebSearchToolDef web_search 工具 schema 归口（阶段六十九提取：Agent 任务与普通聊天
// 联网问答共用同一 schema，文案/参数防两处漂移）
func agentWebSearchToolDef() aiToolDefinition {
	return aiToolDefinition{Type: "function", Function: map[string]interface{}{
		"name":        "web_search",
		"description": "联网搜索获取实时信息（新闻/资料/行情/文档等）。返回网页标题、链接与摘要；需要页面或接口全文时再用 http_request 抓取。",
		"parameters": map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"query": map[string]interface{}{"type": "string", "description": "搜索关键词（可用空格组合多个词）"},
				"count": map[string]interface{}{"type": "integer", "description": "结果条数（1-10，默认 5）"},
			},
			"required": []string{"query"},
		},
	}}
}

// agentToolDefinitions 注入模型的工具 schema（OpenAI function calling 格式；
// 阶段六十八：http_request/web_search 按配置开关动态注入，未开启不进 schema 防模型误调用）
func (s *Server) agentToolDefinitions(username string) []aiToolDefinition {
	tools := []aiToolDefinition{
		{Type: "function", Function: map[string]interface{}{
			"name":        "read_file",
			"description": "读取文本文件内容（代码/文档/配置等）。支持工作区相对路径；用户配置白名单后也可用授权目录内的绝对路径。大文件可用 offset/limit 按行分段读取。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path":   map[string]interface{}{"type": "string", "description": "工作区内相对路径（如 src/main.go），或授权目录内的绝对路径"},
					"offset": map[string]interface{}{"type": "integer", "description": "起始行号（1 起，默认从头读）"},
					"limit":  map[string]interface{}{"type": "integer", "description": "最多读取行数（默认读到文件尾）"},
				},
				"required": []string{"path"},
			},
		}},
		{Type: "function", Function: map[string]interface{}{
			"name":        "write_file",
			"description": "新建或覆盖写入文本文件（自动创建父目录）。需要用户审批（除非管理员开启免审批）。支持工作区相对路径；用户配置白名单后也可用授权目录内的绝对路径。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path":        map[string]interface{}{"type": "string", "description": "工作区内相对路径，或授权目录内的绝对路径"},
					"content":     map[string]interface{}{"type": "string", "description": "写入的完整文本内容"},
					"mode":        map[string]interface{}{"type": "string", "enum": []string{"overwrite", "append"}, "description": "写入模式，默认 overwrite"},
					"explanation": map[string]interface{}{"type": "string", "description": "用一句中文简述本次写入的意图（面向用户的修改说明，展示在变更浮层与审查列表），如：修复聊天窗口滚动条不跟随主题的问题"},
				},
				"required": []string{"path", "content"},
			},
		}},
		{Type: "function", Function: map[string]interface{}{
			"name":        "edit_file",
			"description": "编辑文本文件：把文件中的 old_string 精确替换为 new_string（改动局部内容时比 write_file 整文件重写更高效省事）。需要用户审批。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path":        map[string]interface{}{"type": "string", "description": "工作区内相对路径，或授权目录内的绝对路径"},
					"old_string":  map[string]interface{}{"type": "string", "description": "要被替换的精确原文（须与文件内容逐字一致，含缩进换行）"},
					"new_string":  map[string]interface{}{"type": "string", "description": "替换后的新文本（传空串即删除该段）"},
					"replace_all": map[string]interface{}{"type": "boolean", "description": "目标文本多处匹配时是否全部替换，默认 false（要求唯一匹配）"},
					"explanation": map[string]interface{}{"type": "string", "description": "用一句中文简述本次替换的意图（面向用户的修改说明，展示在变更浮层与审查列表）"},
				},
				"required": []string{"path", "old_string", "new_string"},
			},
		}},
		{Type: "function", Function: map[string]interface{}{
			"name":        "delete_file",
			"description": "删除工作区内文件或目录（不可恢复，需用户审批）。删除非空目录必须 recursive=true。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path":        map[string]interface{}{"type": "string", "description": "工作区内相对路径，或授权目录内的绝对路径"},
					"recursive":   map[string]interface{}{"type": "boolean", "description": "目录递归删除（删非空目录必传 true），删除文件时忽略"},
					"explanation": map[string]interface{}{"type": "string", "description": "用一句中文简述本次删除的原因（面向用户的修改说明，展示在变更浮层与审查列表）"},
				},
				"required": []string{"path"},
			},
		}},
		{Type: "function", Function: map[string]interface{}{
			"name":        "list_dir",
			"description": "列出目录内容（子目录在前、文件在后，含文件大小），用于浏览工作区/项目结构。默认列工作区根目录。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path": map[string]interface{}{"type": "string", "description": "目录相对路径（默认工作区根目录），或授权目录内的绝对路径"},
				},
			},
		}},
		{Type: "function", Function: map[string]interface{}{
			"name":        "grep",
			"description": "在工作区内按内容搜索文件（返回 文件:行号: 内容 列表），自动跳过二进制与依赖目录。定位代码/配置关键词时优先用本工具，避免整读大文件。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"pattern":     map[string]interface{}{"type": "string", "description": "搜索的文本（默认按字面匹配）或正则表达式"},
					"is_regex":    map[string]interface{}{"type": "boolean", "description": "pattern 按正则解析，默认 false"},
					"path":        map[string]interface{}{"type": "string", "description": "搜索起点（文件或目录的相对路径，默认工作区根目录）"},
					"include":     map[string]interface{}{"type": "string", "description": "文件名过滤通配符（如 *.go、*.md）"},
					"max_results": map[string]interface{}{"type": "integer", "description": "最多返回条数（1-200，默认 50）"},
				},
				"required": []string{"pattern"},
			},
		}},
		{Type: "function", Function: map[string]interface{}{
			"name":        "todo_write",
			"description": "建立或更新任务清单（全量替换）。接到任务后应先建立清单，并在推进过程中实时更新条目状态（pending/in_progress/done），用户端实时显示进度。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"todos": map[string]interface{}{
						"type": "array",
						"items": map[string]interface{}{
							"type": "object",
							"properties": map[string]interface{}{
								"content": map[string]interface{}{"type": "string", "description": "条目内容"},
								"status":  map[string]interface{}{"type": "string", "enum": []string{"pending", "in_progress", "done"}},
							},
							"required": []string{"content", "status"},
						},
					},
				},
				"required": []string{"todos"},
			},
		}},
		{Type: "function", Function: map[string]interface{}{
			"name":        "run_command",
			"description": "在工作区目录执行命令行指令（运行程序、安装依赖、调试项目等）。默认超时 60 秒。白名单外命令需要用户审批。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"command": map[string]interface{}{"type": "string", "description": "要执行的命令"},
					"timeout": map[string]interface{}{"type": "integer", "description": "超时秒数（1-300，默认 60）"},
				},
				"required": []string{"command"},
			},
		}},
		// 阶段一百二十五：向用户提问（TRAE CN 同款）——需要用户判断/需求不明确时暂停等待回答
		{Type: "function", Function: map[string]interface{}{
			"name":        "ask_user",
			"description": "向用户提问以获取决策或澄清需求（遇到需要用户判断的问题、多种可行方案需用户选择、或需求不明确需要补充信息时使用）。调用后任务暂停，用户会选择一个选项或自由输入回答，回答将作为结果返回；用户也可能取消本次回答（此时应基于已有信息采用最合理的默认方案继续，不要重复追问）。仅在确有必要时使用，能凭现有信息合理决策的不要打扰用户。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"question": map[string]interface{}{"type": "string", "description": "问题标题（一句话说清需要用户决策什么）"},
					"context":  map[string]interface{}{"type": "string", "description": "背景补充说明（可选，帮助用户理解决策上下文）"},
					"options": map[string]interface{}{
						"type":        "array",
						"description": "候选选项列表（2-4 个为宜，按推荐度排序）",
						"items": map[string]interface{}{
							"type": "object",
							"properties": map[string]interface{}{
								"label":       map[string]interface{}{"type": "string", "description": "选项简短文案（动作导向，如\"自动迁移登录态\"）"},
								"description": map[string]interface{}{"type": "string", "description": "选项详细说明（该方案的做法与影响）"},
								"recommended": map[string]interface{}{"type": "boolean", "description": "是否为推荐选项"},
							},
							"required": []string{"label"},
						},
					},
					"allow_free": map[string]interface{}{"type": "boolean", "description": "是否允许用户跳过选项自由输入其他答案，默认允许"},
				},
				"required": []string{"question"},
			},
		}},
	}
	// 阶段六十八：网络工具（HTTP 请求 + 联网搜索）
	if agentHttpEnabled.Load() {
		tools = append(tools, aiToolDefinition{Type: "function", Function: map[string]interface{}{
			"name":        "http_request",
			"description": "向指定 URL 发起 HTTP 请求（调用接口/查询数据/抓取网页内容）。支持自定义方法、请求头与请求体；GET/HEAD 只读请求自动放行，POST/PUT/DELETE/PATCH 需用户审批。返回状态码与响应体。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"url":     map[string]interface{}{"type": "string", "description": "完整请求地址（http/https）"},
					"method":  map[string]interface{}{"type": "string", "enum": []string{"GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"}, "description": "HTTP 方法，默认 GET"},
					"headers": map[string]interface{}{"type": "object", "description": "自定义请求头键值对（可选，如 {\"Authorization\": \"Bearer xxx\"}）"},
					"body":    map[string]interface{}{"type": "string", "description": "请求体（POST/PUT/PATCH 时使用，通常为 JSON 字符串）"},
					"timeout": map[string]interface{}{"type": "integer", "description": "超时秒数（1-300，默认 60）"},
				},
				"required": []string{"url"},
			},
		}})
	}
	if agentSearchEnabled.Load() {
		tools = append(tools, agentWebSearchToolDef())
	}
	// 阶段九十一：内置浏览器工具注入（WebContentsView 在用户电脑上，PC 端本地执行；
	// 开关 ai.agent.pc_browser + 仅发起人 PC 端在线时注入——离线时调用必失败，schema 反而误导模型）
	if agentBrowserEnabled.Load() && agentPcExec.Load() && s.hub.HasPC(username) {
		tools = append(tools, agentBrowserToolDefs()...)
	}
	// 阶段八十九：MCP 工具注入（TRAE CN 同款）——已连接且启用的 MCP 服务器工具动态进入
	// schema（命名空间化 mcp_<服务器>_<工具>），模型按需调用；服务器离线时自然为空
	if mcpDefs := mcpOpenAIToolDefinitions(); len(mcpDefs) > 0 {
		tools = append(tools, mcpDefs...)
	}
	// 阶段九十：用户自定义本机 MCP 工具注入（mcp_pc_ 命名空间，仅注入该用户上报的清单；
	// 经 PC 本地执行器调用，PC 离线时不注入——调用必失败，schema 反而误导模型）
	if pcDefs := s.mcpPcOpenAIToolDefinitions(username); len(pcDefs) > 0 {
		tools = append(tools, pcDefs...)
	}
	return tools
}

// agentEmit 任务事件推送归口（事件流实时送达发起用户全部在线连接）
func (s *Server) agentEmit(t *AgentTask, eventType string, payload map[string]interface{}) {
	if payload == nil {
		payload = map[string]interface{}{}
	}
	payload["task_id"] = t.ID
	payload["type"] = eventType
	// 阶段七十一：事件流携带会话归属，客户端任务卡按会话盖戳过滤渲染（多端防串会话）
	payload["session_id"] = t.SessionID
	data, _ := json.Marshal(payload)
	msg := protocol.Message{
		MsgType:   protocol.MsgTypeAgentEvent,
		FromUser:  t.Agent.Name, // 前端按会话归属渲染事件卡片
		ToUser:    t.Username,
		Content:   string(data),
		Timestamp: time.Now().Unix(),
	}
	out, _ := json.Marshal(msg)
	s.sendToUser(t.Username, out)
}

// agentSetStatus 状态变更 + 推送（统一归口，前端据此更新进度条与状态标签）
func (s *Server) agentSetStatus(t *AgentTask, status, text string) {
	t.mu.Lock()
	t.Status = status
	t.mu.Unlock()
	s.agentEmit(t, "status", map[string]interface{}{"status": status, "text": text})
}

// agentCommandAutoAllowed run_command 白名单归口：命令（小写化）恰以白名单前缀开头（词边界）时自动放行。
// 阶段八十三：按用户隔离——该用户个人白名单 ∪ 全局白名单（后台设置）任一命中即放行
func agentCommandAutoAllowed(username, command string) bool {
	lc := strings.ToLower(strings.TrimSpace(command))
	agentWlMu.RLock()
	defer agentWlMu.RUnlock()
	check := func(list []string) bool {
		for _, p := range list {
			p = strings.ToLower(strings.TrimSpace(p))
			if p == "" {
				continue
			}
			if lc == p || strings.HasPrefix(lc, p+" ") {
				return true
			}
		}
		return false
	}
	if check(agentUserCmds[username]) {
		return true
	}
	return check(agentAutoCmds)
}

// agentWlMu 阶段六十二：白名单运行态并发保护（agentAutoCmds/agentUserCmds 变更 vs 风险分级读取）
var agentWlMu sync.RWMutex

// agentWhitelistCmd 审批"同意并加白"（run_command）：命令首词入发起用户个人白名单（内存+DB 持久化）。
// 阶段八十三：白名单按用户隔离——A 加白仅 A 本人生效，B 跑同类命令仍需自行审批；
// 后台管理员的全局白名单仍对全员生效（生效判定=个人 ∪ 全局）。
// 安全护栏：链式命令（含 && / || / | / & ）不加白——首词无法担保后续段落的危险性，仍仅本次放行
func agentWhitelistCmd(username, command string) (string, bool) {
	lc := strings.ToLower(strings.TrimSpace(command))
	if lc == "" {
		return "", false
	}
	if strings.ContainsAny(lc, "&|") {
		return "", false
	}
	token := strings.Fields(lc)[0]
	token = strings.Trim(token, "\"'")
	if token == "" || len(token) > 64 {
		return "", false
	}
	agentWlMu.Lock()
	already := false
	for _, p := range agentUserCmds[username] {
		if p == token {
			already = true
			break
		}
	}
	if !already {
		agentUserCmds[username] = append(agentUserCmds[username], token)
	}
	agentWlMu.Unlock()
	if !already {
		store.DB.Create(&model.AgentWhitelist{Kind: "cmd", Value: token, Username: username})
		logger.Info("Agent 命令加白：%s（用户 %s，审批放行时确认，仅本人生效）", token, username)
	}
	return token, true
}

// agentWhitelistAutoWrite 审批"同意并加白"（write_file/edit_file）：开启发起用户的写文件免审批（内存+DB 持久化）。
// 阶段七十四：edit_file 同为文件写操作，共用此白名单；阶段八十三：仅对该用户本人生效（全局开关归后台设置）
func agentWhitelistAutoWrite(username string) {
	agentWlMu.Lock()
	already := agentUserWrite[username]
	agentUserWrite[username] = true
	agentWlMu.Unlock()
	if !already {
		store.DB.Create(&model.AgentWhitelist{Kind: "autowrite", Value: "on", Username: username})
		logger.Info("Agent 写文件免审批已开启（用户 %s，审批放行时确认，仅本人生效）", username)
	}
}

// agentNeedsApproval 工具风险分级归口：返回是否需要人工审批与提示原因。
// username 阶段八十三：白名单按用户隔离（个人 ∪ 全局），调用方传任务发起人
func agentNeedsApproval(username, tool string, params map[string]interface{}) (bool, string) {
	switch tool {
	case "read_file", "todo_write", "list_dir", "grep":
		return false, "" // 只读与任务清单：安全，自动放行（阶段七十四新增 list_dir/grep）
	case "write_file", "edit_file":
		// 阶段七十四：edit_file 与 write_file 同为写操作，共用写文件免审批白名单
		agentWlMu.RLock()
		auto := agentAutoWrite || agentUserWrite[username]
		agentWlMu.RUnlock()
		if auto {
			return false, ""
		}
		return true, "写入/编辑文件属于敏感操作，请确认文件路径与内容"
	case "delete_file":
		// 阶段七十四：删除不可恢复，恒需审批且不参与"同意并加白"
		return true, "删除文件/目录不可恢复，请确认目标路径"
	case "run_command":
		cmd, _ := params["command"].(string)
		if agentCommandAutoAllowed(username, cmd) {
			return false, ""
		}
		return true, "命令不在自动放行白名单内，请确认后执行"
	case "web_search":
		return false, "" // 阶段六十八：只读搜索，自动放行
	case "http_request":
		// 阶段六十八：GET/HEAD 只读请求自动放行；非只读方法可能改变远端数据，走审批
		method := strings.ToUpper(strings.TrimSpace(agentParamString(params["method"])))
		if method == "GET" || method == "HEAD" || method == "" {
			return false, ""
		}
		return true, "向外部服务发起非只读请求（" + method + "），请确认目标地址与请求内容"
	}
	// 阶段九十一：内置浏览器工具风险分级——只读/导航/tab 管理免审批（页面内容用户实时可见），
	// click/input/eval 逐次审批（见 agentBrowserNeedsApproval）
	if isAgentBrowserTool(tool) {
		return agentBrowserNeedsApproval(tool)
	}
	// 阶段九十：用户本机 MCP 工具风险分级——默认逐次人工审批（模型可借工具在用户电脑上
	// 执行任意逻辑，未经确认放行风险高；审批弹窗可改参放行/直接放行/拒绝）
	if serverName, toolName, ok := agentPcRouteToolKey(username, tool); ok {
		return true, "调用你电脑本机的 MCP 服务器「" + serverName + "」的工具 " + toolName + "，将在本机执行，请确认"
	}
	// 阶段八十九：MCP 工具风险分级（TRAE 同款默认人工确认）——服务器开启 auto_approve 免审批，
	// 默认逐次审批（审批弹窗可改参放行/直接放行/拒绝），防外部工具未经确认改动数据
	if serverName, toolName, ok := mcpRouteToolKey(tool); ok {
		if mcpServerAutoApprove(serverName) {
			return false, ""
		}
		return true, "调用 MCP 服务器「" + serverName + "」的工具 " + toolName + "，请确认后执行"
	}
	return true, "未知工具默认走人工审批"
}

// agentToolExec 工具执行归口（均已在调用前完成审批）；返回给模型的结果文本。
// callID 用于 run_command 输出流/转后台事件归属（tool_call ID 贯通前后端）
func agentToolExec(s *Server, t *AgentTask, callID, tool string, params map[string]interface{}) string {
	// 阶段九十一：内置浏览器工具不在服务端执行（WebContentsView 在用户电脑上，服务端无浏览器可调）。
	// 正常路径经 agentToolExecDispatch 下发 PC 本地执行器；落到这里=PC 离线或回传超时
	if msg := agentBrowserPcFallbackMsg(tool); msg != "" {
		return msg
	}
	// 阶段九十：本机 MCP 工具不在服务端执行（stdio 子进程在用户电脑上，服务端无进程可调）。
	// 正常路径经 agentToolExecDispatch 下发 PC 本地执行器；落到这里=PC 离线或回传超时，
	// 不做服务端回退（服务端回退无法等价执行，明确报错让模型向用户说明更稳妥）
	if strings.HasPrefix(tool, "mcp_pc_") {
		if _, _, ok := agentPcRouteToolKey(t.Username, tool); !ok {
			return "错误：本机 MCP 工具 " + tool + " 未找到（可能已被用户移除或服务器已下线）"
		}
		return "错误：本机 MCP 工具仅在用户的 PC 端在线时可用（当前 PC 端离线或执行回传超时），请告知用户启动 PC 端后重试"
	}
	// 阶段八十九：MCP 工具执行（命名空间 key → 服务器+原始工具名路由归口）。
	// 错误统一"错误："前缀——与内置工具错误语义一致（前端 tool_result 的 ok 标记据此判定）
	if strings.HasPrefix(tool, "mcp_") {
		serverName, toolName, ok := mcpRouteToolKey(tool)
		if !ok {
			return "错误：MCP 工具 " + tool + " 未找到（服务器可能已断开或工具已下线）"
		}
		// 阶段一百零九：取消联动——任务取消时即时中断阻塞中的 CallTool（原实现干等工具
		// 跑完或超时，最长 tool_timeout_seconds），监视协程 200ms 轮询 Cancelled 触发 cancel
		ctx, cancel := context.WithTimeout(context.Background(), mcpToolTimeout())
		defer cancel()
		watchDone := make(chan struct{})
		go func() {
			defer close(watchDone)
			tick := time.NewTicker(200 * time.Millisecond)
			defer tick.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-tick.C:
					if t.Cancelled.Load() {
						cancel()
						return
					}
				}
			}
		}()
		// 阶段一百零九：进度透传——服务器 notifications/progress 转发为 tool_progress 事件
		//（600ms 节流防高频通知刷屏；call_id 归属到具体工具块，前端头部实时显示进度）
		var lastEmit atomic.Int64
		onProgress := func(message string, progress, total float64) {
			now := time.Now().UnixMilli()
			if now-lastEmit.Load() < 600 {
				return
			}
			lastEmit.Store(now)
			s.agentEmit(t, "tool_progress", map[string]interface{}{
				"call_id": callID, "tool": tool,
				"message": message, "progress": progress, "total": total,
			})
		}
		// 原实现：out, err := mcpCallTool(serverName, toolName, params)（无取消联动/无进度透传）
		out, err := mcpCallToolWithProgress(ctx, serverName, toolName, params, onProgress)
		cancel()
		<-watchDone
		if err != nil {
			// 取消联动触发的中断：明确报"任务已取消"（模型上下文与前端语义一致，非工具故障）
			if t.Cancelled.Load() && ctx.Err() != nil {
				return "错误：任务已取消，MCP 工具调用中止"
			}
			return "错误：" + err.Error()
		}
		if out == "" {
			out = "（工具执行成功，无文本输出）" // 防空结果让模型误判失败
		}
		return out
	}
	switch tool {
	case "read_file":
		return agentToolReadFile(t.Username, params)
	case "write_file":
		return agentToolWriteFile(t, params)
	case "edit_file":
		return agentToolEditFile(t, params) // 阶段七十四：精确替换编辑
	case "delete_file":
		return agentToolDeleteFile(t, params) // 阶段七十四：删除文件/目录
	case "list_dir":
		return agentToolListDir(t.Username, params) // 阶段七十四：列目录
	case "grep":
		return agentToolGrep(t.Username, params) // 阶段七十四：内容搜索
	case "todo_write":
		return agentToolTodoWrite(s, t, params)
	case "run_command":
		return agentToolRunCommand(s, t, callID, params) // 阶段七十五：流式输出 + 转后台
	case "http_request":
		return agentToolHttpRequest(params) // 阶段六十八：服务端代理 HTTP 请求
	case "web_search":
		return agentToolWebSearch(params) // 阶段六十八：联网搜索
	}
	return "错误：未知工具 " + tool
}

// agentToolServerOnly 阶段六十八：始终服务端执行的工具归口（不下放 PC 本地执行器）——
// todo_write 为纯任务清单状态；http_request/web_search 为服务端网络操作
// （数据归口服务端统一执行，且 PC 本地执行器无对应实现）。
// 阶段八十九：MCP 工具会话归口在服务端连接管理器（TRAE CN 同款服务端归口），恒为 server。
// 阶段九十：mcp_pc_ 本机工具恒不在此列——执行载体在用户电脑（agentToolExecDispatch 分派）
func agentToolServerOnly(tool string) bool {
	if strings.HasPrefix(tool, "mcp_") && !strings.HasPrefix(tool, "mcp_pc_") {
		if _, _, ok := mcpRouteToolKey(tool); ok {
			return true
		}
	}
	// 阶段一百二十五：ask_user 交互归口在服务端事件流（等待用户回答），与本地执行无关
	return tool == "todo_write" || tool == "http_request" || tool == "web_search" || tool == "ask_user"
}

// agentToolEnvHint 阶段六十：tool_start 事件携带的执行环境预判（仅供前端即时展示提示）。
// 实际环境以 tool_result 事件的 env 为准——本地等待超时会回退服务端执行
func agentToolEnvHint(s *Server, t *AgentTask, tool string) string {
	if agentToolServerOnly(tool) || !agentPcExec.Load() {
		return "server"
	}
	if s.hub.HasPC(t.Username) {
		return "pc"
	}
	return "server"
}

// agentToolLabel 阶段八十九：tool_start 事件的人类可读标题归口——MCP 工具名是命名空间
// key（规整后不可精确反解），服务端按路由结果下发「MCP · 服务器 / 工具」展示名，前端直用。
// 阶段九十：本机 MCP 工具下发「MCP · 服务器 / 工具（本机）」展示名，前端直用无需再解析
func agentToolLabel(username, tool string) string {
	// 阶段九十一：内置浏览器工具展示名（内置浏览器 · 打开页面 等）
	if l := agentBrowserLabel(tool); l != "" {
		return l
	}
	if strings.HasPrefix(tool, "mcp_pc_") {
		if serverName, toolName, ok := agentPcRouteToolKey(username, tool); ok {
			return "MCP · " + serverName + " / " + toolName + "（本机）"
		}
	}
	if serverName, toolName, ok := mcpRouteToolKey(tool); ok {
		return "MCP · " + serverName + " / " + toolName
	}
	return ""
}

// agentToolExecDispatch 阶段六十：工具执行环境分派归口。
// todo_write/http_request/web_search 等服务端工具始终服务端处理（agentToolServerOnly 归口）；
// 文件/命令工具在「本地执行器开启 + 发起人 PC 端在线」时下放到其电脑本地执行（文件直接落在用户磁盘），
// PC 离线或回传超时自动回退服务端工作区执行，任务不中断。
// 返回 (结果文本, 执行环境 env)，env 用于事件流展示（pc=用户本地 / server=服务端）
func (s *Server) agentToolExecDispatch(t *AgentTask, callID, tool string, params map[string]interface{}) (string, string) {
	if agentToolServerOnly(tool) {
		return agentToolExec(s, t, callID, tool, params), "server"
	}
	if agentPcExec.Load() && s.hub.HasPC(t.Username) {
		if result, ok := s.agentWaitLocalExec(t, callID, tool, params); ok {
			return result, "pc"
		}
		// 回传超时（PC 掉线/异常）：回退服务端工作区执行
		// 注：若 PC 已实际执行但回传丢失，回退可能重复执行一次（write_file 幂等覆盖、命令重跑），
		// 与既有工具超时语义一致，保证任务闭环优先
		logger.Warn("Agent 本地执行回传超时，回退服务端执行：%s 工具 %s", t.ID, tool)
	}
	return agentToolExec(s, t, callID, tool, params), "server"
}

// agentStepTrace 阶段六十五：单步工具调用轨迹落库归口（免审/审批通过/拒绝/取消/超时/本地回退各分支统一收口）。
// 每步即时落库（任务运行中查看详情亦可追溯已执行部分），序号取任务内递增 stepSeq；
// 参数摘要截断 1000 字、结果摘要截断 2000 字防超长撑表；落库失败仅记日志不阻断任务执行
func (s *Server) agentStepTrace(t *AgentTask, tool string, params map[string]interface{}, result string, ok bool, env, approval string, durationMS int64) {
	t.mu.Lock()
	t.stepSeq++
	seq := t.stepSeq
	t.mu.Unlock()
	paramsJSON := ""
	if len(params) > 0 {
		if b, err := json.Marshal(params); err == nil {
			paramsJSON = truncateRunes(string(b), 1000)
		}
	}
	rec := model.AgentStepRecord{
		TaskID:     t.ID,
		Seq:        seq,
		Tool:       tool,
		Params:     paramsJSON,
		Result:     truncateRunes(result, 2000),
		OK:         ok,
		Env:        env,
		Approval:   approval,
		DurationMS: durationMS,
	}
	if err := store.DB.Create(&rec).Error; err != nil {
		logger.Error("Agent 执行轨迹落库失败（任务 %s 步骤 %d）：%v", t.ID, seq, err)
	}
}

// agentWaitLocalExec 阶段六十：下发本地执行请求并挂起等待 PC 回传。
// step 用 toolCall.ID 归口（与服务端审批同款防错投机制），迟到/不匹配回传直接丢弃。
// 阶段七十五：挂起期间收到"转后台"请求（runBgCh close）时原样转发给 PC 渲染层——
// PC 执行器会立即回传"已转入后台"结果（进程继续跑，输出经 msg 60 持续上行），
// 本函数继续等待该回传，不做服务端回退（避免与 PC 正在跑的进程重复执行）。
// 返回 (结果文本, true=已收到 PC 回传；false=等待超时需回退服务端)
func (s *Server) agentWaitLocalExec(t *AgentTask, step, tool string, params map[string]interface{}) (string, bool) {
	ch := make(chan *AgentExecResult, 1)
	t.mu.Lock()
	t.execCh = ch
	t.execStep = step
	bgCh := make(chan struct{})
	t.runBgCh = bgCh
	t.runBgStep = step // 阶段七十五：转后台请求按步骤归属
	t.mu.Unlock()
	defer func() {
		t.mu.Lock()
		t.execCh = nil
		t.execStep = ""
		t.runBgCh = nil
		t.runBgStep = ""
		t.mu.Unlock()
	}()

	reqData, _ := json.Marshal(map[string]interface{}{
		"task_id": t.ID,
		"step":    step,
		"tool":    tool,
		"params":  params,
	})
	reqMsg := protocol.Message{
		MsgType:   protocol.MsgTypeAgentExecReq,
		FromUser:  t.Agent.Name, // 前端按会话归属桥接到本地执行器
		ToUser:    t.Username,
		Content:   string(reqData),
		Timestamp: time.Now().Unix(),
	}
	out, _ := json.Marshal(reqMsg)
	s.sendToUser(t.Username, out)

	// 等待上限 = 工具自身超时 + 回传余量（PC 端命令执行已有自身超时强杀；余量覆盖 WS 转发与 IPC 往返）
	wait := time.Duration(agentToolTimeout.Load())*time.Second + 15*time.Second
	if tool == "run_command" {
		if v, ok := params["timeout"].(float64); ok && v > 0 {
			if v > agentCmdTimeoutMax {
				v = agentCmdTimeoutMax
			}
			wait = time.Duration(v)*time.Second + 15*time.Second
		}
	}
	deadline := time.Now().Add(wait)
	bgSent := false // 阶段七十五：转后台请求转发幂等标记（重复点击只转发一次）
	for {
		d := time.Until(deadline)
		if d <= 0 {
			return "", false
		}
		timer := time.NewTimer(d)
		select {
		case r := <-ch:
			timer.Stop()
			// 工具级失败（路径越界等）照常回传，模型据此自纠；仅超时走回退
			return r.Output, true
		case <-bgCh:
			timer.Stop()
			if bgSent {
				continue // 已转发过（重复点击），继续等待回传
			}
			bgSent = true
			// 原样转发转后台请求给 PC 渲染层（桥接到本地执行器，立即回传"已转入后台"）
			bgData, _ := json.Marshal(map[string]interface{}{"task_id": t.ID, "step": step})
			s.sendToUser(t.Username, mustAgentMsg(protocol.MsgTypeAgentBg, t, string(bgData)))
		case <-timer.C:
			return "", false
		}
	}
}

// mustAgentMsg 阶段七十五：构造服务端 → 用户的 Agent 信令帧（From=智能体名，前端按会话归属渲染）
func mustAgentMsg(msgType int, t *AgentTask, content string) []byte {
	out, _ := json.Marshal(protocol.Message{
		MsgType:   msgType,
		FromUser:  t.Agent.Name,
		ToUser:    t.Username,
		Content:   content,
		Timestamp: time.Now().Unix(),
	})
	return out
}

// handleAgentExecResp 阶段六十：PC 本地执行结果上行（msg_type=51）。
// 校验发起人与步骤后投递到等待中的任务；非等待态/步骤不匹配（迟到回传）静默丢弃。
// 阶段八十：步骤命中撤销等待表（rv-*）走审查撤销完成归口（标记 reverted + 推送 66 帧）
func (s *Server) handleAgentExecResp(c *Client, msg *protocol.Message) {
	var req struct {
		TaskID  string          `json:"task_id"`
		Step    string          `json:"step"`
		OK      bool            `json:"ok"`
		Output  string          `json:"output"`
		Changes []agentPCChange `json:"changes"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &req); err != nil || req.TaskID == "" {
		return // 本地执行回传属于旁路信令，格式异常静默丢弃即可
	}
	// 阶段八十：撤销本地变更的回传（任务可能已完结不在等待态，按步骤表独立归口）
	if w, ok := pcRevertWaiters.Load(req.Step); ok {
		wt := w.(*pcRevertWait)
		if wt.username == c.username { // 仅发起人自己的 PC 连接可回传
			select {
			case wt.ch <- &AgentExecResult{OK: req.OK, Output: req.Output}:
			default:
			}
		}
		return
	}
	v, ok := agentTasks.Load(req.TaskID)
	if !ok {
		return
	}
	t := v.(*AgentTask)
	if t.Username != c.username { // 仅发起人自己的 PC 连接可回传
		return
	}
	t.mu.Lock()
	ch := t.execCh
	step := t.execStep
	t.mu.Unlock()
	if ch == nil || step != req.Step { // 非等待态或步骤不匹配（迟到的回传）直接丢弃
		return
	}
	r := &AgentExecResult{OK: req.OK, Output: req.Output, Changes: req.Changes}
	// 阶段八十：本地文件工具回传携带变更——登记审查行（env=pc）并推送审查条（任务中即时可见）
	if len(r.Changes) > 0 {
		s.agentRecordPCChanges(t, r.Changes)
	}
	select {
	case ch <- r:
	default:
	}
}

// handleAgentToolOutput 阶段七十五：PC 本地命令输出上行（msg_type=60），转发为任务事件流
// tool_output（增量）/tool_exit（进程结束，退出码/耗时仅前端控制台展示，不进模型上下文）。
// 校验任务归属后按 call_id（step）下发；非运行中任务的迟到帧静默丢弃
func (s *Server) handleAgentToolOutput(c *Client, msg *protocol.Message) {
	var req struct {
		TaskID     string `json:"task_id"`
		Step       string `json:"step"`
		Chunk      string `json:"chunk"`
		TotalBytes int    `json:"total_bytes"`
		Over       bool   `json:"over"`
		Final      bool   `json:"final"`
		ExitCode   int    `json:"exit_code"`
		DurationMS int64  `json:"duration_ms"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &req); err != nil || req.TaskID == "" || req.Step == "" {
		return
	}
	v, ok := agentTasks.Load(req.TaskID)
	if !ok {
		return
	}
	t := v.(*AgentTask)
	if t.Username != c.username { // 仅发起人自己的 PC 连接可上行
		return
	}
	if req.Final {
		s.agentEmit(t, "tool_exit", map[string]interface{}{
			"call_id": req.Step, "exit_code": req.ExitCode,
			"duration_ms": req.DurationMS, "total_bytes": req.TotalBytes,
		})
		return
	}
	s.agentEmit(t, "tool_output", map[string]interface{}{
		"call_id": req.Step, "chunk": req.Chunk, "total_bytes": req.TotalBytes, "over": req.Over,
	})
}

// handleAgentBg 阶段七十五：长命令"转后台"请求上行（msg_type=61）。
// 命令在服务端执行：close runBgCh 使 agentToolRunCommand 立即返回、进程转后台继续；
// 命令在 PC 本地执行（agentWaitLocalExec 挂起中）：通道同样触发，由其转发给 PC 渲染层桥接执行器。
// 步骤不匹配/通道不存在（命令已结束等）静默忽略
func (s *Server) handleAgentBg(c *Client, msg *protocol.Message) {
	var req struct {
		TaskID string `json:"task_id"`
		Step   string `json:"step"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &req); err != nil || req.TaskID == "" || req.Step == "" {
		return
	}
	v, ok := agentTasks.Load(req.TaskID)
	if !ok {
		return
	}
	t := v.(*AgentTask)
	if t.Username != c.username {
		return
	}
	t.mu.Lock()
	ch := t.runBgCh
	step := t.runBgStep
	if ch != nil && step == req.Step {
		t.runBgCh = nil // 先摘再 close：防重复请求 close 已关闭通道 panic
		t.runBgStep = ""
	} else {
		ch = nil
	}
	t.mu.Unlock()
	if ch != nil {
		close(ch)
	}
}

// agentSandbox 阶段六十一：PC 端上报的用户本地沙箱白名单（主工作区 + 授权目录列表）。
// 仅内存保存不落库（本地磁盘路径机器相关，隐私归口用户本机）；仅提示词注入与 HasPC 判定使用，
// 服务端不据此放行任何本地路径——服务端工作区安全仍归口 agentSafePath
type AgentSandbox struct {
	Primary string   // 主工作区：相对路径的落盘根目录（空=PC 端默认工作区）
	Dirs    []string // 授权目录列表：绝对路径文件操作仅允许落在这些目录内（PC 端执行时强校验）
}

// agentSandboxes username → *AgentSandbox（登录后/变更时由 PC 端上报覆盖）
var agentSandboxes sync.Map

const (
	agentSandboxMaxDirs    = 10  // 授权目录数量上限（防滥用）
	agentSandboxMaxPathLen = 512 // 单目录路径长度上限
)

// handleAgentSandbox 阶段六十一：PC 端沙箱白名单上报（msg_type=52）。
// 仅接受 platform=pc 的连接上报；校验裁剪后原子覆盖内存态（异常静默丢弃，旁路信令不影响主链路）
func (s *Server) handleAgentSandbox(c *Client, msg *protocol.Message) {
	if c.platform != "pc" {
		return // 仅 PC 端存在本地磁盘沙箱概念
	}
	var req struct {
		Primary string   `json:"primary"`
		Dirs    []string `json:"dirs"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &req); err != nil {
		return
	}
	if len(req.Dirs) > agentSandboxMaxDirs {
		req.Dirs = req.Dirs[:agentSandboxMaxDirs]
	}
	// 清洗：去空白/超长项，保序去重
	dirs := make([]string, 0, len(req.Dirs))
	seen := make(map[string]bool)
	for _, d := range req.Dirs {
		d = strings.TrimSpace(d)
		if d == "" || len(d) > agentSandboxMaxPathLen || seen[d] {
			continue
		}
		seen[d] = true
		dirs = append(dirs, d)
	}
	primary := strings.TrimSpace(req.Primary)
	if len(primary) > agentSandboxMaxPathLen {
		primary = ""
	}
	// 主工作区必须在授权目录列表内（不在则回退首个目录；列表为空则无主工作区=PC 默认工作区）
	if primary != "" && !seen[primary] {
		if len(dirs) > 0 {
			primary = dirs[0]
		} else {
			primary = ""
		}
	}
	if len(dirs) == 0 {
		agentSandboxes.Delete(c.username) // 空白名单=回到默认工作区语义
		return
	}
	agentSandboxes.Store(c.username, &AgentSandbox{Primary: primary, Dirs: dirs})
}

// agentSandboxFor 阶段六十一：读取用户沙箱白名单（仅在 PC 端在线时返回——
// Web/手机端发起的任务永远走服务端执行，注入本地目录提示反而误导模型）
func (s *Server) agentSandboxFor(username string) *AgentSandbox {
	if !agentPcExec.Load() || !s.hub.HasPC(username) {
		return nil
	}
	if v, ok := agentSandboxes.Load(username); ok {
		return v.(*AgentSandbox)
	}
	return nil
}

// ===== 阶段九十：用户自定义本机 MCP 服务器（TRAE 同款本地 stdio，凭据仅存用户本机） =====

// AgentPcTool PC 端上报的单个本机 MCP 工具元数据（不含命令/环境变量等敏感配置——
// 那些仅存用户本机 agent_mcp.json，服务端只拿工具名/描述/参数 schema 供模型注入与路由）
type AgentPcTool struct {
	Server      string          `json:"server"`                 // 本机 MCP 服务器名（用户自定义，PC 端进程管理归口）
	Tool        string          `json:"tool"`                   // 工具原始名（服务器内唯一）
	Description string          `json:"description,omitempty"`  // 工具说明（供模型理解）
	InputSchema json.RawMessage `json:"input_schema,omitempty"` // 参数 JSON Schema（原样透传）
}

// agentPcToolSet 单用户本机 MCP 工具清单快照（整体覆盖更新，无部分更新语义）
type agentPcToolSet struct {
	tools []AgentPcTool
}

// agentPcToolStore username → *agentPcToolSet（登录后/清单变更时由 PC 端 msg 67 全量覆盖；
// 仅内存不落库——清单源头在用户本机，服务端重启后等 PC 重新上报即可，无持久化必要）
var agentPcToolStore sync.Map

const (
	agentPcMcpMaxServers   = 10      // 本机 MCP 服务器数量上限（防滥用）
	agentPcMcpMaxTools     = 64      // 工具总数上限（防注入 schema 撑爆模型上下文）
	agentPcMcpMaxNameLen   = 128     // 服务器名/工具名长度上限
	agentPcMcpMaxDescLen   = 512     // 工具描述长度上限
	agentPcMcpMaxSchemaLen = 8 << 10 // 单工具参数 schema 字节数上限（超长丢弃走空 schema 兜底）
)

// handleAgentPcTools 阶段九十：PC 端本机 MCP 工具清单上报（msg_type=67）。
// 仅接受 platform=pc 连接；清洗校验后原子覆盖内存态（空清单=清除注入）；
// 异常静默丢弃（旁路信令不影响主链路）；回执 {ok,count} 供前端确认收口
func (s *Server) handleAgentPcTools(c *Client, msg *protocol.Message) {
	if c.platform != "pc" {
		return // 工具由 PC 本地进程发现并执行，其他端上报无执行载体
	}
	var req struct {
		Tools []AgentPcTool `json:"tools"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &req); err != nil {
		return
	}
	cleaned := make([]AgentPcTool, 0, len(req.Tools))
	seen := make(map[string]bool)   // server+tool 去重
	servers := make(map[string]int) // 服务器名 → 计数（超限防御）
	for _, t := range req.Tools {
		t.Server = strings.TrimSpace(t.Server)
		t.Tool = strings.TrimSpace(t.Tool)
		if t.Server == "" || t.Tool == "" ||
			len(t.Server) > agentPcMcpMaxNameLen || len(t.Tool) > agentPcMcpMaxNameLen {
			continue
		}
		if len(t.Description) > agentPcMcpMaxDescLen {
			t.Description = truncateRunes(t.Description, agentPcMcpMaxDescLen)
		}
		if len(t.InputSchema) > agentPcMcpMaxSchemaLen {
			t.InputSchema = nil // 超长 schema 丢弃，注入时走空对象兜底
		}
		key := t.Server + "\x00" + t.Tool
		if seen[key] {
			continue
		}
		seen[key] = true
		servers[t.Server]++
		if len(servers) > agentPcMcpMaxServers {
			break
		}
		cleaned = append(cleaned, t)
	}
	if len(cleaned) > agentPcMcpMaxTools {
		cleaned = cleaned[:agentPcMcpMaxTools]
	}
	if len(cleaned) == 0 {
		agentPcToolStore.Delete(c.username)
	} else {
		agentPcToolStore.Store(c.username, &agentPcToolSet{tools: cleaned})
	}
	logger.Info("Agent 本机 MCP 工具清单上报：用户 %s，%d 个工具", c.username, len(cleaned))
	// 确认帧：前端 toast 提示上报收口（count=0 表示已清除注入）
	if ack, err := json.Marshal(map[string]interface{}{"ok": true, "count": len(cleaned)}); err == nil {
		out, _ := json.Marshal(protocol.Message{
			MsgType:   protocol.MsgTypeAgentPcTools,
			ToUser:    c.username,
			Content:   string(ack),
			Timestamp: time.Now().Unix(),
		})
		s.sendToUser(c.username, out)
	}
}

// agentPcToolsFor 读取用户本机 MCP 工具清单（快照值，调用方可安全遍历）
func (s *Server) agentPcToolsFor(username string) []AgentPcTool {
	if !agentPcExec.Load() || !s.hub.HasPC(username) {
		return nil // 与沙箱白名单同款口径：仅 PC 端在线时有效（离线时调用必失败，注入反而误导模型）
	}
	if v, ok := agentPcToolStore.Load(username); ok {
		return v.(*agentPcToolSet).tools
	}
	return nil
}

// agentPcToolKey 本机 MCP 工具注入名（与服务端 mcpToolKey 同一算法、mcp_pc_ 命名空间前缀；
// PC 端 mcp-manager.js pcToolKey 保持逐字节一致——路由按名反查，两端算法不一致即调用错位）
func agentPcToolKey(server, tool string) string {
	return mcpToolKey("pc_"+server, tool)
}

// agentPcRouteToolKey 按注入名反查本机工具路由（mcp_pc_<服务器>_<工具> 归属确认；
// 直接读存储不校验 PC 在线——审批/报错路径需要准确归属，在线性由注入与执行分派归口把关。
// O(n) 遍历——单用户清单受 64 上限约束，量级足够小）
func agentPcRouteToolKey(username, key string) (serverName, toolName string, ok bool) {
	v, has := agentPcToolStore.Load(username)
	if !has {
		return "", "", false
	}
	for _, t := range v.(*agentPcToolSet).tools {
		if agentPcToolKey(t.Server, t.Tool) == key {
			return t.Server, t.Tool, true
		}
	}
	return "", "", false
}

// agentToolReadFile 读取工作区文本文件（UTF-8 输出，超长截断，GBK 兜底转码）。
// 阶段七十四：新增二进制检测（含 NUL 字节不灌上下文）与 offset/limit 行级分段读取
func agentToolReadFile(username string, params map[string]interface{}) string {
	path, _ := params["path"].(string)
	full, err := agentSafePath(username, path)
	if err != nil {
		return "错误：" + err.Error()
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return "错误：读取失败 " + err.Error()
	}
	// 二进制检测：含 NUL 字节视为二进制文件，避免乱码灌入模型上下文
	if bytes.IndexByte(data, 0) >= 0 {
		return fmt.Sprintf("（二进制文件，不支持文本读取，大小 %d 字节）", len(data))
	}
	text := string(data)
	// GBK 编码兜底：Windows 常见中文文本为 GBK，UTF-8 解码出现替换符时尝试转码
	if strings.ContainsRune(text, 0xFFFD) {
		if gbk, gerr := simplifiedchinese.GBK.NewDecoder().Bytes(data); gerr == nil {
			text = string(gbk)
		}
	}
	runes := []rune(text)
	if len(runes) == 0 {
		return "（空文件）"
	}
	// offset/limit 行级分段（行号 1 起；limit<=0 视为读到文件尾）
	lines := strings.Split(text, "\n")
	offset := 1
	if v, ok := params["offset"].(float64); ok && v > 1 {
		offset = int(v)
	}
	end := len(lines)
	if v, ok := params["limit"].(float64); ok && v > 0 {
		if e := offset - 1 + int(v); e < end {
			end = e
		}
	}
	seg := text
	if offset > 1 || end < len(lines) {
		if offset > len(lines) {
			return fmt.Sprintf("（文件共 %d 行，offset 超出范围）", len(lines))
		}
		seg = strings.Join(lines[offset-1:end], "\n")
		seg = strings.TrimRight(seg, "\n")
		runes = []rune(seg)
	}
	if len(runes) > agentReadMaxChars {
		return fmt.Sprintf("文件共 %d 字符，已截断显示前 %d 字符：\n%s", len(runes), agentReadMaxChars, string(runes[:agentReadMaxChars]))
	}
	return seg
}

// agentToolWriteFile 工作区写文件（自动建父目录；overwrite/append）。
// 阶段七十七：写前快照改前内容归口变更审查（不存在=创建语义；备份失败不记录、不阻断任务）
func agentToolWriteFile(t *AgentTask, params map[string]interface{}) string {
	username := t.Username
	path, _ := params["path"].(string)
	content, _ := params["content"].(string)
	mode, _ := params["mode"].(string)
	if mode == "" {
		mode = "overwrite"
	}
	if mode != "overwrite" && mode != "append" {
		return "错误：mode 仅支持 overwrite/append"
	}
	runes := []rune(content)
	if len(runes) > agentWriteMaxChars {
		return fmt.Sprintf("错误：内容超长（%d 字符，上限 %d）", len(runes), agentWriteMaxChars)
	}
	full, err := agentSafePath(username, path)
	if err != nil {
		return "错误：" + err.Error()
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return "错误：创建目录失败 " + err.Error()
	}
	bak := agentSnapshotBefore(t, full) // 阶段七十七：写前快照（""=新建；成功后据此登记 create/modify）
	var n int
	var diffStat string // 阶段六十二：+N -M 行变化统计（Trae CN 同款，仅 overwrite 且旧文件存在时计算）
	if mode == "append" {
		f, err := os.OpenFile(full, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err != nil {
			return "错误：" + err.Error()
		}
		defer f.Close()
		n, err = f.WriteString(content)
		if err != nil {
			return "错误：写入失败 " + err.Error()
		}
	} else {
		// 覆盖前读旧内容（存在才统计 diff；不存在视为创建）
		oldContent, oldErr := os.ReadFile(full)
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			return "错误：写入失败 " + err.Error()
		}
		n = len(content)
		if oldErr == nil {
			add, del := agentLineDiffStat(string(oldContent), content)
			diffStat = fmt.Sprintf("+%d -%d ", add, del)
		}
	}
	// 阶段七十七：登记变更（kind 由"改前是否存在"决定——append 到不存在的文件同属 create）
	kind := "modify"
	if bak == "" {
		kind = "create"
	}
	agentRecordChange(t, agentRelPath(username, full), kind, bak, agentParamString(params["explanation"]))
	verb := "写入"
	if mode == "append" {
		verb = "追加"
	}
	if diffStat != "" {
		return fmt.Sprintf("已编辑 %s（%s，%d 字节）", path, diffStat, n)
	}
	if mode == "overwrite" {
		return fmt.Sprintf("已创建 %s（%d 字节）", path, n)
	}
	return fmt.Sprintf("已%s %s（%d 字节）", verb, path, n)
}

// agentToolEditFile 阶段七十四：精确替换编辑（old_string→new_string，比整文件重写省 token）。
// 语义对齐主流编码智能体：old_string 须与文件内容逐字一致；多处匹配要求唯一化或显式 replace_all；
// GBK 文件编辑后统一转存 UTF-8（与 write_file 写入语义一致）
func agentToolEditFile(t *AgentTask, params map[string]interface{}) string {
	username := t.Username
	path, _ := params["path"].(string)
	oldStr := agentParamString(params["old_string"])
	newStr := agentParamString(params["new_string"])
	replaceAll, _ := params["replace_all"].(bool)
	if strings.TrimSpace(oldStr) == "" {
		return "错误：old_string 不能为空"
	}
	if oldStr == newStr {
		return "错误：old_string 与 new_string 相同，无内容变化"
	}
	if len([]rune(oldStr)) > agentWriteMaxChars || len([]rune(newStr)) > agentWriteMaxChars {
		return fmt.Sprintf("错误：替换内容超长（单次上限 %d 字符）", agentWriteMaxChars)
	}
	full, err := agentSafePath(username, path)
	if err != nil {
		return "错误：" + err.Error()
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return "错误：读取失败 " + err.Error()
	}
	bak := agentSnapshotBefore(t, full) // 阶段七十七：改前快照（编辑必为已有文件；备份失败则不记变更、不可撤销）
	if bytes.IndexByte(data, 0) >= 0 {
		return "错误：不支持编辑二进制文件"
	}
	text := string(data)
	if strings.ContainsRune(text, 0xFFFD) { // GBK 兜底（同 read_file）
		if gbk, gerr := simplifiedchinese.GBK.NewDecoder().Bytes(data); gerr == nil {
			text = string(gbk)
		}
	}
	count := strings.Count(text, oldStr)
	if count == 0 {
		return "错误：未找到目标文本（old_string 须与文件内容精确一致，含缩进与换行；可先用 grep/read_file 确认原文）"
	}
	if count > 1 && !replaceAll {
		return fmt.Sprintf("错误：目标文本匹配 %d 处，请扩大 old_string 上下文使其唯一，或传 replace_all=true 全部替换", count)
	}
	var newText string
	if replaceAll {
		newText = strings.ReplaceAll(text, oldStr, newStr)
	} else {
		newText = strings.Replace(text, oldStr, newStr, 1)
	}
	if err := os.WriteFile(full, []byte(newText), 0o644); err != nil {
		return "错误：写入失败 " + err.Error()
	}
	if bak != "" {
		agentRecordChange(t, agentRelPath(username, full), "modify", bak, agentParamString(params["explanation"])) // 阶段七十七：登记变更
	}
	add, del := agentLineDiffStat(text, newText)
	return fmt.Sprintf("已编辑 %s（+%d -%d，替换 %d 处）", path, add, del, count)
}

// agentToolDeleteFile 阶段七十四：删除工作区内文件/目录（审批归口在 agentNeedsApproval，恒需审批）。
// agentSafePath 已拒绝空路径与"."，工作区根本身不可删；非空目录必须显式 recursive=true。
// 阶段七十七：删除前逐文件快照（撤销可还原）；快照失败的文件不记变更（不可撤销）
func agentToolDeleteFile(t *AgentTask, params map[string]interface{}) string {
	username := t.Username
	path, _ := params["path"].(string)
	recursive, _ := params["recursive"].(bool)
	full, err := agentSafePath(username, path)
	if err != nil {
		return "错误：" + err.Error()
	}
	info, err := os.Stat(full)
	if err != nil {
		return "错误：目标不存在 " + err.Error()
	}
	if info.IsDir() {
		if !recursive {
			if err := os.Remove(full); err != nil {
				return "错误：" + path + " 是目录且非空，需传 recursive=true 递归删除"
			}
			return "已删除目录 " + path + "/（空目录）"
		}
		// 阶段七十七：递归删除前先快照全部文件（删后无法再读），单文件单行 kind=delete；
		// 超出 agentChangeMaxFiles 截断（截断部分不记变更不可撤销），空目录不还原（可容忍）
		var snapFiles []string
		n := 0
		_ = filepath.WalkDir(full, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				return nil
			}
			n++
			if len(snapFiles) < agentChangeMaxFiles {
				snapFiles = append(snapFiles, p)
			}
			return nil
		})
		baks := make([]string, len(snapFiles))
		for i, p := range snapFiles {
			baks[i] = agentSnapshotBefore(t, p)
		}
		if err := os.RemoveAll(full); err != nil {
			return "错误：删除失败 " + err.Error()
		}
		for i, p := range snapFiles {
			if baks[i] != "" {
				agentRecordChange(t, agentRelPath(username, p), "delete", baks[i], agentParamString(params["explanation"]))
			}
		}
		return fmt.Sprintf("已删除目录 %s/（递归，含 %d 个条目）", path, n)
	}
	bak := agentSnapshotBefore(t, full) // 删前快照（撤销还原）
	if err := os.Remove(full); err != nil {
		return "错误：删除失败 " + err.Error()
	}
	if bak != "" {
		agentRecordChange(t, agentRelPath(username, full), "delete", bak, agentParamString(params["explanation"])) // 阶段七十七：登记变更
	}
	return fmt.Sprintf("已删除文件 %s（%d 字节）", path, info.Size())
}

// agentToolListDir 阶段七十四：列目录（子目录在前、文件在后，各按名称排序，含文件大小）。
// path 缺省列工作区根目录；超 agentListDirMax 条目截断防撑爆上下文
func agentToolListDir(username string, params map[string]interface{}) string {
	dirParam := strings.TrimSpace(agentParamString(params["path"]))
	var full string
	if dirParam == "" || dirParam == "." {
		ws, err := agentWorkspaceDir(username)
		if err != nil {
			return "错误：" + err.Error()
		}
		full = ws
	} else {
		var err error
		if full, err = agentSafePath(username, dirParam); err != nil {
			return "错误：" + err.Error()
		}
	}
	entries, err := os.ReadDir(full)
	if err != nil {
		return "错误：" + err.Error()
	}
	if len(entries) == 0 {
		return "（空目录）"
	}
	var b strings.Builder
	shown := 0
	truncated := false
	for _, e := range entries { // 目录在前（os.ReadDir 已按名排序）
		if !e.IsDir() {
			continue
		}
		if shown >= agentListDirMax {
			truncated = true
			break
		}
		fmt.Fprintf(&b, "%s/\n", e.Name())
		shown++
	}
	for _, e := range entries { // 文件在后
		if e.IsDir() {
			continue
		}
		if shown >= agentListDirMax {
			truncated = true
			break
		}
		size := ""
		if fi, ferr := e.Info(); ferr == nil {
			size = fmt.Sprintf("（%d 字节）", fi.Size())
		}
		fmt.Fprintf(&b, "%s %s\n", e.Name(), size)
		shown++
	}
	head := fmt.Sprintf("共 %d 个条目", len(entries))
	if truncated {
		head += fmt.Sprintf("（仅显示前 %d 条）", shown)
	}
	return head + "：\n" + strings.TrimRight(b.String(), "\n")
}

// agentToolGrep 阶段七十四：工作区内容搜索（文件:行号: 内容），字面/正则双模式。
// 防护：跳过依赖与构建目录、2MB 以上大文件、二进制（NUL 检测）；文件数/单文件命中/总条数三重上限
func agentToolGrep(username string, params map[string]interface{}) string {
	pattern := agentParamString(params["pattern"])
	if strings.TrimSpace(pattern) == "" {
		return "错误：pattern 不能为空"
	}
	isRegex, _ := params["is_regex"].(bool)
	matcher, err := regexp.Compile(pattern)
	if !isRegex {
		matcher, err = regexp.Compile(regexp.QuoteMeta(pattern)) // 字面模式转义后仍走同一匹配路径
	}
	if err != nil {
		return "错误：正则表达式无效 " + err.Error()
	}
	include := strings.TrimSpace(agentParamString(params["include"]))
	var incRe *regexp.Regexp
	if include != "" {
		if incRe, err = regexp.Compile(globToRegexp(include)); err != nil {
			return "错误：include 通配符无效 " + err.Error()
		}
	}
	maxResults := agentGrepMaxResults
	if v, ok := params["max_results"].(float64); ok && v >= 1 {
		maxResults = int(v)
		if maxResults > agentGrepResultsHard {
			maxResults = agentGrepResultsHard
		}
	}
	// 起点：path 缺省为工作区根；显式 path 走安全校验（可为文件或目录）
	dirParam := strings.TrimSpace(agentParamString(params["path"]))
	var root string
	if dirParam == "" || dirParam == "." {
		ws, werr := agentWorkspaceDir(username)
		if werr != nil {
			return "错误：" + werr.Error()
		}
		root = ws
	} else if root, err = agentSafePath(username, dirParam); err != nil {
		return "错误：" + err.Error()
	}
	rootInfo, err := os.Stat(root)
	if err != nil {
		return "错误：" + err.Error()
	}
	relBase := func(p string) string {
		if rootInfo.IsDir() {
			if r, rerr := filepath.Rel(root, p); rerr == nil {
				return filepath.ToSlash(r)
			}
		} else if r, rerr := filepath.Rel(filepath.Dir(root), p); rerr == nil {
			return filepath.ToSlash(r)
		}
		return filepath.ToSlash(p)
	}
	var b strings.Builder
	total := 0
	fileCount := 0
	fileHits := 0 // 单文件命中计数（跨文件清零）
	walkErr := filepath.WalkDir(root, func(p string, d fs.DirEntry, werr error) error {
		if werr != nil {
			return nil // 无权限/竞态删除等逐项跳过
		}
		if d.IsDir() {
			if p != root && agentGrepSkipDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if total >= maxResults || fileCount >= agentGrepMaxFiles {
			return fs.SkipAll
		}
		fileCount++
		if incRe != nil && !incRe.MatchString(filepath.ToSlash(d.Name())) {
			return nil
		}
		if fi, ferr := d.Info(); ferr != nil || fi.Size() > agentGrepMaxFileBytes {
			return nil
		}
		data, rerr := os.ReadFile(p)
		if rerr != nil || bytes.IndexByte(data, 0) >= 0 {
			return nil // 读取失败或二进制跳过
		}
		text := string(data)
		if strings.ContainsRune(text, 0xFFFD) { // GBK 兜底（同 read_file）
			if gbk, gerr := simplifiedchinese.GBK.NewDecoder().Bytes(data); gerr == nil {
				text = string(gbk)
			}
		}
		rel := relBase(p)
		fileHits = 0
		for i, line := range strings.Split(text, "\n") {
			if total >= maxResults {
				return fs.SkipAll
			}
			if fileHits >= agentGrepFileMaxHits {
				break // 该文件命中过多仅展示前缀，继续搜其他文件
			}
			if !matcher.MatchString(line) {
				continue
			}
			trimmed := strings.TrimSpace(line)
			if r := []rune(trimmed); len(r) > agentGrepLineMaxRunes {
				trimmed = string(r[:agentGrepLineMaxRunes]) + "…"
			}
			fmt.Fprintf(&b, "%s:%d: %s\n", rel, i+1, trimmed)
			total++
			fileHits++
		}
		return nil
	})
	_ = walkErr // 遍历中断（SkipAll）属正常配额收敛
	if total == 0 {
		return "（无匹配结果）"
	}
	tail := ""
	if total >= maxResults {
		tail = fmt.Sprintf("\n…（已达 %d 条上限，结果可能不完整，可缩小 path/include 范围或提高 max_results）", maxResults)
	} else if fileCount >= agentGrepMaxFiles {
		tail = fmt.Sprintf("\n…（遍历文件数已达 %d 上限，结果可能不完整）", agentGrepMaxFiles)
	}
	return fmt.Sprintf("共 %d 处匹配：\n%s", total, strings.TrimRight(b.String(), "\n")) + tail
}

// globToRegexp 阶段七十四：文件名通配符（* ?）转正则（仅用于 include 过滤，大小写不敏感）
func globToRegexp(g string) string {
	var sb strings.Builder
	sb.WriteString("(?i)^")
	for _, c := range g {
		switch c {
		case '*':
			sb.WriteString("[^/\\\\]*")
		case '?':
			sb.WriteString("[^/\\\\]")
		default:
			sb.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	sb.WriteString("$")
	return sb.String()
}

// agentLineDiffStat 行级 diff 统计（多行集合交集近似：added=新文独有行数 removed=旧文独有行数，
// 展示用足够，非严格 LCS diff）
func agentLineDiffStat(oldContent, newContent string) (int, int) {
	oldSet := make(map[string]int)
	for _, l := range strings.Split(oldContent, "\n") {
		oldSet[l]++
	}
	common := 0
	newCount := 0
	for _, l := range strings.Split(newContent, "\n") {
		newCount++
		if oldSet[l] > 0 {
			oldSet[l]--
			common++
		}
	}
	oldCount := len(strings.Split(oldContent, "\n"))
	return newCount - common, oldCount - common
}

// ===== 阶段七十七：文件变更审查归口（TRAE CN 同款"文件变更审查条"） =====
// 快照归口：write/edit/delete 落盘前备份"改前内容"到 <kbDataDir>/agent_changes/<taskID>/；
// 统计归口：任务完结时统一 diff（agentFinalizeChanges）；撤销归口：按 Kind 还原（handleAgentChanges）。

// agentChangeRec 任务内文件变更内存态（t.mu 保护；同路径首触保留最早 before，任务级累积 diff）
type agentChangeRec struct {
	Path        string // 工作区相对路径（正斜杠）
	Kind        string // create/modify/delete（首触语义：原不存在=create，否则 modify/delete）
	Backup      string // 首触备份绝对路径（create 首触为空——任务前文件不存在）
	Env         string // 阶段八十：server=服务端工作区（完结统一 diff 统计）/ pc=用户本地（统计执行器上报，免重算）
	Explanation string // AI 修改说明（同路径重复触碰取最近一次，供前端变更浮层/审查列表展示）
}

// agentChangeView 下发视图（done/error 事件与下行 66 刷新帧共用）
type agentChangeView struct {
	Path        string `json:"path"`
	Kind        string `json:"kind"`
	Adds        int    `json:"adds"`
	Dels        int    `json:"dels"`
	Status      string `json:"status"`
	Explanation string `json:"explanation,omitempty"`
}

// agentRelPath 工作区内绝对路径 → 相对路径（正斜杠，记录表与前端展示归口）；解析失败回退文件名
func agentRelPath(username, full string) string {
	ws, err := agentWorkspaceDir(username)
	if err != nil {
		return filepath.Base(full)
	}
	rel, err := filepath.Rel(ws, full)
	if err != nil {
		return filepath.Base(full)
	}
	return filepath.ToSlash(rel)
}

// agentSnapshotBefore 写/改/删前快照：备份改前内容到 agent_changes/<taskID>/<seq>_<basename>。
// 返回备份绝对路径；原不存在返回 ""（创建语义）；备份失败也返回 ""（不记录、不阻断任务）。
// 同路径重复触碰直接复用首触备份（最早 before，撤销即还原任务前状态，不产生冗余备份文件）
func agentSnapshotBefore(t *AgentTask, full string) string {
	rel := agentRelPath(t.Username, full)
	t.mu.Lock()
	var exist *agentChangeRec
	for _, r := range t.changes {
		if r.Path == rel {
			exist = r
			break
		}
	}
	t.mu.Unlock()
	if exist != nil {
		return exist.Backup // 首触已备份：create 复用 ""（仍为创建语义）
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return "" // 原不存在=创建语义；读失败视同不存在
	}
	dir := filepath.Join(kbDataDir, "agent_changes", t.ID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return ""
	}
	t.mu.Lock()
	t.changeSeq++
	seq := t.changeSeq
	t.mu.Unlock()
	dst := filepath.Join(dir, fmt.Sprintf("%d_%s", seq, filepath.Base(full)))
	if err := os.WriteFile(dst, data, 0o644); err != nil {
		return ""
	}
	return dst
}

// agentRecordChange 变更登记：锁内写内存归口（同路径去重，首触为准），锁外落库（status=pending）。
// 落库失败仅记日志（撤销链路以内存+DB 双归口，重启后靠 DB 重放）。
// explanation：AI 修改说明——同路径重复触碰时 Kind/Backup 不动（撤销语义依赖首触），仅回写最新说明（last-wins）
func agentRecordChange(t *AgentTask, rel, kind, backup, explanation string) {
	if len([]rune(explanation)) > 1024 {
		explanation = string([]rune(explanation)[:1024]) // 防滥用截断，与 DB 列宽对齐
	}
	t.mu.Lock()
	var dup *agentChangeRec
	for _, r := range t.changes {
		if r.Path == rel {
			dup = r
			break
		}
	}
	if dup == nil {
		rec := &agentChangeRec{Path: rel, Kind: kind, Backup: backup, Explanation: explanation}
		t.changes = append(t.changes, rec)
	}
	t.mu.Unlock()
	if dup != nil {
		// 同路径重复触碰：仅回写最新说明（空串不覆盖，防模型某次漏传清掉旧说明）
		if explanation != "" {
			dup.Explanation = explanation
			store.DB.Model(&model.AgentChangeRecord{}).Where("task_id = ? AND path = ?", t.ID, rel).
				Updates(map[string]interface{}{"explanation": explanation})
		}
		return
	}
	if err := store.DB.Create(&model.AgentChangeRecord{
		TaskID: t.ID, Username: t.Username, Path: rel, Kind: kind, BackupFile: backup,
		Explanation: explanation, Status: "pending",
	}).Error; err != nil {
		logger.Error("Agent 变更登记落库失败（任务 %s，%s）：%v", t.ID, rel, err)
	}
}

// agentRecordPCChanges 阶段八十：PC 本地执行变更登记归口（env=pc 行）。
// 文件在用户磁盘服务端读不到——行数统计由执行器按任务前备份计算后上报，此处免重算直接落库；
// create 行操作后又删除（任务中建了又删）净零剔除；同路径重复触碰回写最新累计行数。
// 逐条登记后推送 66 全量帧：审查条任务执行中即时可见（TRAE 同款），不等到完结
func (s *Server) agentRecordPCChanges(t *AgentTask, changes []agentPCChange) {
	changed := false
	for _, ch := range changes {
		if ch.Path == "" {
			continue
		}
		t.mu.Lock()
		var dup *agentChangeRec
		for _, r := range t.changes {
			if r.Path == ch.Path {
				dup = r
				break
			}
		}
		if dup == nil {
			t.changes = append(t.changes, &agentChangeRec{Path: ch.Path, Kind: ch.Kind, Backup: ch.Backup, Env: "pc", Explanation: ch.Explanation})
		} else if ch.Explanation != "" {
			dup.Explanation = ch.Explanation // 说明 last-wins（与 agentRecordChange 同口径）
		}
		t.mu.Unlock()
		if ch.Deleted && ch.Kind == "create" {
			// 任务中新建又删除：净零，剔除记录行（含首触即删除的极端同帧场景，不登记）
			store.DB.Where("task_id = ? AND path = ?", t.ID, ch.Path).Delete(&model.AgentChangeRecord{})
			changed = true
			continue
		}
		if dup != nil {
			// 同路径重复触碰：回写最新累计行数与说明（首触 kind/备份不变，撤销仍还原任务前状态）
			updates := map[string]interface{}{"adds": ch.Adds, "dels": ch.Dels}
			if ch.Explanation != "" {
				updates["explanation"] = ch.Explanation
			}
			store.DB.Model(&model.AgentChangeRecord{}).Where("task_id = ? AND path = ?", t.ID, ch.Path).
				Updates(updates)
			changed = true
			continue
		}
		if err := store.DB.Create(&model.AgentChangeRecord{
			TaskID: t.ID, Username: t.Username, Path: ch.Path, Kind: ch.Kind,
			Adds: ch.Adds, Dels: ch.Dels, BackupFile: ch.Backup, LocalPath: ch.Local,
			Env: "pc", Status: "pending", Explanation: ch.Explanation,
		}).Error; err != nil {
			logger.Error("Agent 本地变更登记落库失败（任务 %s，%s）：%v", t.ID, ch.Path, err)
			continue
		}
		changed = true
	}
	if changed {
		s.agentChangesPush(t.Username, t.ID)
	}
}

// agentFinalizeChanges 任务完结统计归口（agentFinish done/error/cancelled emit 前调用）：
// 逐文件 diff 当前内容 vs 首触 before，回写记录表并返回下发视图（无变更返回 nil）。
// 任务中先建后删（首触 create 且当前已不存在）净零，从清单剔除；二进制（含 NUL）行数记 0
func (s *Server) agentFinalizeChanges(t *AgentTask) []agentChangeView {
	t.mu.Lock()
	recs := make([]*agentChangeRec, len(t.changes))
	copy(recs, t.changes)
	t.mu.Unlock()
	if len(recs) == 0 {
		return nil
	}
	views := make([]agentChangeView, 0, len(recs))
	for _, r := range recs {
		// 阶段八十：pc 行统计由执行器上报时已回写（本地文件服务端读不到），免重算直接取库内最新值；
		// 行不存在（净零剔除）不进完结视图
		if r.Env == "pc" {
			var row model.AgentChangeRecord
			if err := store.DB.Where("task_id = ? AND path = ?", t.ID, r.Path).First(&row).Error; err != nil {
				continue
			}
			views = append(views, agentChangeView{Path: r.Path, Kind: r.Kind, Adds: row.Adds, Dels: row.Dels, Status: row.Status, Explanation: row.Explanation})
			continue
		}
		full, err := agentSafePath(t.Username, r.Path)
		if err != nil {
			continue
		}
		var before string
		if r.Backup != "" {
			b, rerr := os.ReadFile(r.Backup)
			if rerr != nil {
				continue // 备份丢失：无法统计也无法撤销，跳过
			}
			before = string(b)
		}
		cur, cerr := os.ReadFile(full)
		curExists := cerr == nil
		if r.Backup == "" && !curExists {
			// 任务中先建后删：净零，剔除记录行
			store.DB.Where("task_id = ? AND path = ?", t.ID, r.Path).Delete(&model.AgentChangeRecord{})
			continue
		}
		var adds, dels int
		if !curExists {
			_, dels = agentLineDiffStat(before, "") // modify/delete 后文件已不在：del=before 行数
		} else if bytes.IndexByte(cur, 0) >= 0 || bytes.IndexByte([]byte(before), 0) >= 0 {
			adds, dels = 0, 0 // 二进制文件：记录变更但行数记 0
		} else {
			adds, dels = agentLineDiffStat(before, string(cur))
		}
		store.DB.Model(&model.AgentChangeRecord{}).Where("task_id = ? AND path = ?", t.ID, r.Path).
			Updates(map[string]interface{}{"adds": adds, "dels": dels})
		views = append(views, agentChangeView{Path: r.Path, Kind: r.Kind, Adds: adds, Dels: dels, Status: "pending", Explanation: r.Explanation})
	}
	if len(views) == 0 {
		return nil
	}
	return views
}

// agentChangesPush 下行 66 全量刷新帧：从 DB 读全量构造（不依赖内存任务态，天然支持多端/重连/重启）。
// 会话归属随帧下发（前端任务卡按会话过滤渲染，与 agentEmit 同口径）
func (s *Server) agentChangesPush(username, taskID string) {
	var rec model.AgentTaskRecord
	agentName, sid := "", uint(0)
	if err := store.DB.Select("agent_name", "session_id").Where("task_id = ?", taskID).First(&rec).Error; err == nil {
		agentName, sid = rec.AgentName, rec.SessionID
	}
	var rows []model.AgentChangeRecord
	store.DB.Where("task_id = ?", taskID).Order("id ASC").Find(&rows)
	changes := make([]agentChangeView, 0, len(rows))
	totalAdds, totalDels := 0, 0
	for _, r := range rows {
		changes = append(changes, agentChangeView{Path: r.Path, Kind: r.Kind, Adds: r.Adds, Dels: r.Dels, Status: r.Status, Explanation: r.Explanation})
		totalAdds += r.Adds
		totalDels += r.Dels
	}
	payload, _ := json.Marshal(map[string]interface{}{
		"task_id": taskID, "session_id": sid, "changes": changes,
		"total_adds": totalAdds, "total_dels": totalDels,
	})
	out, _ := json.Marshal(protocol.Message{
		MsgType:   protocol.MsgTypeAgentChanges,
		FromUser:  agentName,
		ToUser:    username,
		Content:   string(payload),
		SessionID: sid,
		Timestamp: time.Now().Unix(),
	})
	s.sendToUser(username, out)
}

// handleAgentChanges 阶段七十七：文件变更审查上行（content 为 JSON：{task_id,action,path?}）。
// action=keep 弃备份确认保留；revert 按 Kind 还原（modify/delete → 恢复备份，create → 删除文件，
// git discard 同语义：用户事后手动改动会被覆盖）。path 缺省=全部 pending 行。
// 处理后回下行 66 全量帧同步多端；全部行离开 pending 后清理备份目录（孤儿容忍）
func (s *Server) handleAgentChanges(c *Client, msg *protocol.Message) {
	var req struct {
		TaskID string `json:"task_id"`
		Action string `json:"action"` // keep / revert
		Path   string `json:"path"`   // 缺省=全部 pending
	}
	if err := json.Unmarshal([]byte(msg.Content), &req); err != nil || req.TaskID == "" {
		s.sendError(c, "参数错误")
		return
	}
	if req.Action != "keep" && req.Action != "revert" {
		s.sendError(c, "action 仅支持 keep/revert")
		return
	}
	db := store.DB.Where("task_id = ? AND username = ? AND status = ?", req.TaskID, c.username, "pending")
	if req.Path != "" {
		db = db.Where("path = ?", req.Path)
	}
	var rows []model.AgentChangeRecord
	db.Order("id ASC").Find(&rows)
	// 阶段八十：env=pc 行的文件在用户磁盘，撤销/保留需下发其 PC 执行器执行（服务端只归口登记与状态）
	var pcRows []model.AgentChangeRecord
	for _, r := range rows {
		if r.Env == "pc" {
			pcRows = append(pcRows, r)
			continue
		}
		if req.Action == "keep" {
			if r.BackupFile != "" {
				os.Remove(r.BackupFile)
			}
			store.DB.Model(&model.AgentChangeRecord{}).Where("id = ?", r.ID).Update("status", "kept")
			continue
		}
		// revert：按 Kind 还原工作区文件
		if full, err := agentSafePath(c.username, r.Path); err == nil {
			if r.Kind == "create" {
				os.Remove(full)
			} else if data, rerr := os.ReadFile(r.BackupFile); rerr == nil {
				os.MkdirAll(filepath.Dir(full), 0o755) // 递归删目录后父目录可能已不存在
				os.WriteFile(full, data, 0o644)
			}
		}
		if r.BackupFile != "" {
			os.Remove(r.BackupFile)
		}
		store.DB.Model(&model.AgentChangeRecord{}).Where("id = ?", r.ID).Update("status", "reverted")
	}
	// 阶段八十：pc 行归口（keep=标记后异步清备份；revert=下发执行器还原，完成回传后再标记 reverted）
	if len(pcRows) > 0 {
		if !s.hub.HasPC(c.username) {
			s.sendError(c, "本地文件变更需 PC 客户端在线才能"+map[string]string{"keep": "清理备份", "revert": "撤销"}[req.Action])
			return
		}
		if req.Action == "keep" {
			backs := make([]string, 0, len(pcRows))
			for _, r := range pcRows {
				if r.BackupFile != "" {
					backs = append(backs, r.BackupFile)
				}
				store.DB.Model(&model.AgentChangeRecord{}).Where("id = ?", r.ID).Update("status", "kept")
			}
			if len(backs) > 0 {
				go s.agentPCBackupCleanup(c.username, req.TaskID, backs) // fire-and-forget：离线时孤儿备份由执行器 7 天兜底清理
			}
		} else {
			s.agentPCRevertAsync(c, req.TaskID, pcRows)
			return // 撤销结果由执行器回传后异步标记 + 推送 66（此处先不刷帧，行保持 pending）
		}
	}
	var cnt int64
	store.DB.Model(&model.AgentChangeRecord{}).Where("task_id = ? AND status = ?", req.TaskID, "pending").Count(&cnt)
	if cnt == 0 {
		os.RemoveAll(filepath.Join(kbDataDir, "agent_changes", req.TaskID))
	}
	s.agentChangesPush(c.username, req.TaskID)
}

// agentPCBackupCleanup 阶段八十：保留后的本地备份清理（经执行器下行 agent_cleanup_backups，尽力而为）
func (s *Server) agentPCBackupCleanup(username, taskID string, backups []string) {
	reqData, _ := json.Marshal(map[string]interface{}{
		"task_id": taskID, "step": "cb-" + taskID + "-" + strconv.FormatInt(time.Now().UnixNano(), 10),
		"tool": "agent_cleanup_backups", "params": map[string]interface{}{"backups": backups},
	})
	out, _ := json.Marshal(protocol.Message{
		MsgType: protocol.MsgTypeAgentExecReq, FromUser: "", ToUser: username,
		Content: string(reqData), Timestamp: time.Now().Unix(),
	})
	s.sendToUser(username, out)
}

// agentPCRevertAsync 阶段八十：撤销本地变更——下发执行器 agent_revert_change 并挂异步等待器，
// 回传成功后标记 reverted + 推送 66 帧；超时（PC 掉线/无响应）行保持 pending，用户可重试。
// 步骤键含纳秒防并发撤销错投；FromUser 由前端按会话归属桥接（此处占位空串不影响下行投递）
func (s *Server) agentPCRevertAsync(c *Client, taskID string, pcRows []model.AgentChangeRecord) {
	step := "rv-" + taskID + "-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	changes := make([]map[string]interface{}, 0, len(pcRows))
	ids := make([]uint, 0, len(pcRows))
	for _, r := range pcRows {
		ids = append(ids, r.ID)
		changes = append(changes, map[string]interface{}{
			"path": r.Path, "local": r.LocalPath, "backup": r.BackupFile, "kind": r.Kind,
		})
	}
	w := &pcRevertWait{username: c.username, ch: make(chan *AgentExecResult, 1)}
	pcRevertWaiters.Store(step, w)
	defer pcRevertWaiters.Delete(step)

	reqData, _ := json.Marshal(map[string]interface{}{
		"task_id": taskID, "step": step,
		"tool": "agent_revert_change", "params": map[string]interface{}{"changes": changes},
	})
	out, _ := json.Marshal(protocol.Message{
		MsgType: protocol.MsgTypeAgentExecReq, FromUser: "", ToUser: c.username,
		Content: string(reqData), Timestamp: time.Now().Unix(),
	})
	s.sendToUser(c.username, out)

	// 异步等待回传：同步等待会占死上行连接的读循环——撤销常从 PC 端发起，执行器回传经同一 WS 连接，
	// 读循环被占则回传永远进不来（必然 15 秒超时），故归口 goroutine
	username := c.username
	go func() {
		select {
		case res := <-w.ch:
			if !res.OK {
				logger.Warn("Agent 本地变更撤销执行失败（任务 %s）：%s", taskID, res.Output)
				// 阶段一百：失败也推 66 帧重建审查条（按钮恢复可点可重试，行保持待审查）——
				// 原实现仅记日志不推帧，前端按钮灰死且无任何变化，被误以为按钮无效
				s.agentChangesPush(username, taskID)
				return // 行保持 pending，用户可重试
			}
			store.DB.Model(&model.AgentChangeRecord{}).Where("id IN ?", ids).Update("status", "reverted")
			var cnt int64
			store.DB.Model(&model.AgentChangeRecord{}).Where("task_id = ? AND status = ?", taskID, "pending").Count(&cnt)
			if cnt == 0 {
				os.RemoveAll(filepath.Join(kbDataDir, "agent_changes", taskID))
			}
			s.agentChangesPush(username, taskID)
		case <-time.After(15 * time.Second):
			logger.Warn("Agent 本地变更撤销回传超时（任务 %s），行保持待审查", taskID)
			s.agentChangesPush(username, taskID) // 阶段一百：超时也推帧恢复前端按钮可点（行保持待审查可重试）
		}
	}()
}

// agentToolTodoWrite 任务清单全量替换 + 进度事件推送（前端渲染清单卡片与进度条）
func agentToolTodoWrite(s *Server, t *AgentTask, params map[string]interface{}) string {
	raw, ok := params["todos"].([]interface{})
	if !ok {
		return "错误：todos 必须为数组"
	}
	if len(raw) > agentTodoMaxItems {
		return fmt.Sprintf("错误：清单条数超限（%d > %d）", len(raw), agentTodoMaxItems)
	}
	items := make([]AgentTodoItem, 0, len(raw))
	for _, it := range raw {
		m, ok := it.(map[string]interface{})
		if !ok {
			continue
		}
		content, _ := m["content"].(string)
		status, _ := m["status"].(string)
		content = strings.TrimSpace(content)
		if content == "" {
			continue
		}
		if status != "pending" && status != "in_progress" && status != "done" {
			status = "pending"
		}
		items = append(items, AgentTodoItem{Content: content, Status: status})
	}
	if len(items) == 0 {
		return "错误：清单不能为空"
	}
	t.mu.Lock()
	t.todo = items
	t.mu.Unlock()
	done := 0
	for _, it := range items {
		if it.Status == "done" {
			done++
		}
	}
	s.agentEmit(t, "todo", map[string]interface{}{
		"todos": items,
		"done":  done,
		"total": len(items),
	})
	return fmt.Sprintf("任务清单已更新（共 %d 项，已完成 %d 项）", len(items), done)
}

// agentKillTree 阶段一百零一：Windows 递归终止进程树（taskkill /F /T /PID）。
// 原 cancel/Process.Kill 只杀 cmd.exe 直接子进程，powershell 等孙进程存活会攥着
// stdout 管道句柄导致 cmd.Wait 永久阻塞（完成信号回不来、任务挂死）；失败仅忽略（调用方 cancel 兜底）
func agentKillTree(pid int) {
	if pid <= 0 {
		return
	}
	_ = exec.Command("taskkill", "/F", "/T", "/PID", strconv.Itoa(pid)).Run()
}

// agentToolRunCommand 工作区内执行命令（cmd /C，超时强杀，输出截断；chcp 65001 统一 UTF-8 输出）。
// 阶段七十五：输出管道流式读取，行级聚合 200ms 节流下发 tool_output 事件（控制台实时可见）；
// 执行期间用户可请求"转后台"（runBgCh close 触发）——立即返回不阻塞模型，进程继续跑完，
// 结束后发 tool_exit 事件（退出码/耗时仅前端展示，不进模型上下文）。后台兜底 30 分钟强杀。
func agentToolRunCommand(s *Server, t *AgentTask, callID string, params map[string]interface{}) string {
	command, _ := params["command"].(string)
	command = strings.TrimSpace(command)
	if command == "" {
		return "错误：command 不能为空"
	}
	timeout := time.Duration(agentToolTimeout.Load()) * time.Second
	if v, ok := params["timeout"].(float64); ok && v > 0 {
		if v > agentCmdTimeoutMax {
			v = agentCmdTimeoutMax
		}
		timeout = time.Duration(v) * time.Second
	}
	ws, err := agentWorkspaceDir(t.Username)
	if err != nil {
		return "错误：" + err.Error()
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// chcp 65001 先切控制台代码页为 UTF-8（失败不中断），解决中文输出乱码
	// 阶段一百零一：命令尾部追加完成哨兵——读到哨兵行即命令链收尾（powershell 等孙进程占住
	// stdout 管道时 cmd.Wait 会永久阻塞，哨兵先到即返回已有输出，不等进程退出）
	cmd := exec.CommandContext(ctx, "cmd", "/C", "chcp 65001 >nul 2>&1 & "+command+" & echo "+agentCmdDoneSentinel)
	cmd.Dir = ws
	stdout, perr := cmd.StdoutPipe()
	if perr != nil {
		return "错误：" + perr.Error()
	}
	stderr, perr := cmd.StderrPipe()
	if perr != nil {
		return "错误：" + perr.Error()
	}
	if err := cmd.Start(); err != nil {
		return "错误：启动失败 " + err.Error()
	}
	start := time.Now()

	// 注册"转后台"请求通道（handleAgentBg 校验步骤后 close 广播）
	bgCh := make(chan struct{})
	t.mu.Lock()
	t.runBgCh = bgCh
	t.runBgStep = callID
	t.mu.Unlock()
	defer func() {
		t.mu.Lock()
		t.runBgCh = nil
		t.runBgStep = ""
		t.mu.Unlock()
	}()

	// 前台超时（后台化时 Stop 并换 30 分钟兜底）：
	// 阶段一百零一：先 taskkill /F /T 递归杀整树（cancel 仅杀 cmd.exe，孙进程存活会攥管道
	// 导致 cmd.Wait 永久阻塞），再 cancel 兜底；timedOutFlag 供 Wait 返回分支判定超时
	// （原检查 ctx.Err()==DeadlineExceeded 永假——ctx 是 WithCancel 创建，超时会被误报"退出码异常"）
	var timedOutFlag atomic.Bool
	timer := time.AfterFunc(timeout, func() {
		timedOutFlag.Store(true)
		agentKillTree(cmd.Process.Pid)
		cancel()
	})

	// 输出泵：stdout/stderr 各一个 goroutine 按行收口，行级 UTF-8 检测 + GBK 兜底转码；
	// 累计超 agentCmdStreamMaxBytes 停止下发（over 标记），全量另存 head+tail 供模型结果组装
	var (
		mu       sync.Mutex
		acc      []string // 待下发行（已转码）
		fullBuf  []byte   // 模型结果用（head 8KB + tail 56KB 环形丢弃中间，上限 64KB）
		total    int      // 原始字节计数
		over     bool     // 流式下发截断标记
		fullOver bool     // 模型结果截断标记（超过 head+tail 容量后丢弃中间段）
	)
	const fullHead = 8 << 10
	const fullTail = 56 << 10
	// 阶段一百零一：完成哨兵信号（容量 1，重复命中忽略）——读到哨兵行即命令链收尾
	doneSentinel := make(chan struct{}, 1)

	addLine := func(raw []byte) {
		mu.Lock()
		defer mu.Unlock()
		// 阶段一百零一：哨兵行不计入输出上下文（total/fullBuf/acc 均不含），命中即通知主流程可提前返回
		if bytes.Contains(raw, []byte(agentCmdDoneSentinel)) {
			select {
			case doneSentinel <- struct{}{}:
			default:
			}
			return
		}
		total += len(raw)
		if len(fullBuf) <= fullHead+fullTail {
			if len(fullBuf)+len(raw) > fullHead+fullTail {
				fullOver = true // 中间将截断：保头保尾
			}
			fullBuf = append(fullBuf, raw...)
			if len(fullBuf) > fullHead+fullTail {
				tail := fullBuf[len(fullBuf)-fullTail:]
				fullBuf = append(fullBuf[:0:fullHead], append([]byte("…（中间输出已截断）…\n"), tail...)...)
			}
		}
		if total > agentCmdStreamMaxBytes {
			over = true
			return
		}
		text := string(raw)
		if !utf8.Valid(raw) { // 行级 GBK 兜底（\n 单字节不会切断多字节序列）
			if gbk, gerr := simplifiedchinese.GBK.NewDecoder().Bytes(raw); gerr == nil {
				text = string(gbk)
			}
		}
		acc = append(acc, text)
	}
	pump := func(r io.Reader) {
		br := bufio.NewReaderSize(r, 8192)
		for {
			line, err := br.ReadBytes('\n')
			if len(line) > 0 {
				addLine(line)
			}
			if err != nil {
				return
			}
		}
	}
	go pump(stdout)
	go pump(stderr)

	// 节流下发：200ms 聚合一次，锁内取走待发行、锁外推送
	stopTick := make(chan struct{})
	defer close(stopTick)
	go func() {
		tk := time.NewTicker(time.Duration(agentCmdStreamFlushMs) * time.Millisecond)
		defer tk.Stop()
		for {
			select {
			case <-stopTick:
				return
			case <-tk.C:
				mu.Lock()
				if len(acc) == 0 {
					mu.Unlock()
					continue
				}
				chunk := strings.Join(acc, "")
				acc = nil
				ovr := over
				tot := total
				mu.Unlock()
				s.agentEmit(t, "tool_output", map[string]interface{}{"call_id": callID, "chunk": chunk, "total_bytes": tot, "over": ovr})
			}
		}
	}()

	finalFlush := func() {
		mu.Lock()
		chunk := strings.Join(acc, "")
		acc = nil
		ovr := over
		tot := total
		mu.Unlock()
		if chunk != "" || ovr {
			s.agentEmit(t, "tool_output", map[string]interface{}{"call_id": callID, "chunk": chunk, "total_bytes": tot, "over": ovr})
		}
	}
	modelText := func() string {
		mu.Lock()
		defer mu.Unlock()
		text := string(fullBuf)
		if strings.ContainsRune(text, 0xFFFD) {
			if gbk, gerr := simplifiedchinese.GBK.NewDecoder().Bytes(fullBuf); gerr == nil {
				text = string(gbk)
			}
		}
		runes := []rune(text)
		if len(runes) > agentCmdOutMaxChars {
			text = string(runes[:agentCmdOutMaxChars]) + fmt.Sprintf("\n…（输出过长已截断，共 %d 字符）", len(runes))
		}
		if fullOver && len(runes) <= agentCmdOutMaxChars {
			text += "\n…（输出较长，仅保留头尾）"
		}
		return text
	}

	doneCh := make(chan error, 1)
	go func() { doneCh <- cmd.Wait() }()

	// 阶段一百零一：超时强返计时器（超时杀树后再等 agentCmdForceReturnGap 宽限，
	// 个别残留进程攥管道仍可致 Wait 不返回，到点强制收尾，任务绝不挂死）
	forceReturn := time.NewTimer(timeout + agentCmdForceReturnGap)
	defer forceReturn.Stop()

	select {
	case err := <-doneCh:
		finalFlush()
		text := modelText()
		if err != nil {
			if timedOutFlag.Load() {
				return fmt.Sprintf("错误：命令执行超时（%v），已终止\n输出：\n%s", timeout, text)
			}
			// 非零退出码也把已有输出带回（编译报错等场景输出比退出码更有价值）
			return fmt.Sprintf("命令退出码异常：%v\n输出：\n%s", err, text)
		}
		if strings.TrimSpace(text) == "" {
			return "（命令执行成功，无输出）"
		}
		return text
	case <-doneSentinel:
		// 阶段一百零一：哨兵先到即返回（命令链已跑完、输出已完整；cmd.Wait 因孙进程占管道
		// 未返回时不再死等，TRAE 同款哨兵语义）。残余输出仍会经输出泵推到控制台，不进模型
		finalFlush()
		text := modelText()
		if strings.TrimSpace(text) == "" {
			return "（命令执行成功，无输出）"
		}
		return text
	case <-forceReturn.C:
		// 阶段一百零一：强返兜底——杀树已在超时时刻发生，Wait 仍未返回则强制收尾
		finalFlush()
		text := modelText()
		return fmt.Sprintf("错误：命令执行超时（%v），已强制终止\n输出：\n%s", timeout, text)
	case <-bgCh:
		// 转后台：停前台超时，换 30 分钟兜底强杀（阶段一百零一：同样杀整树再 cancel 兜底）；
		// 进程继续，输出继续流，结束仅发 tool_exit 事件
		timer.Stop()
		time.AfterFunc(agentBgCmdTimeout, func() { agentKillTree(cmd.Process.Pid); cancel() })
		go func() {
			err := <-doneCh
			finalFlush()
			exitCode := 0
			if err != nil {
				if ee, ok := err.(*exec.ExitError); ok {
					exitCode = ee.ExitCode()
				} else {
					exitCode = -1
				}
			}
			s.agentEmit(t, "tool_exit", map[string]interface{}{
				"call_id": callID, "exit_code": exitCode,
				"duration_ms": time.Since(start).Milliseconds(), "total_bytes": total,
			})
			cancel() // 释放 CommandContext 资源
		}()
		return "命令已转入后台执行（输出在任务卡控制台实时展示；结束后控制台显示退出码，无需等待即可继续其他操作）"
	}
}

// agentNewTaskID 生成任务 ID（agt_时间戳_随机 hex）
func agentNewTaskID() string {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("agt_%d", time.Now().UnixNano())
	}
	return fmt.Sprintf("agt_%d_%s", time.Now().Unix(), hex.EncodeToString(b))
}

// agentSystemPrompt Agent 系统提示词（工作区说明 + 本地授权目录 + 工具纪律 + 任务清单指引）。
// 阶段六十二修复：配置了主工作区（沙箱白名单）时主工作区优先宣传、命令无需 cd——
// 此前服务端工作区路径排在最前，模型会 cd 到服务端路径（cd...&&... 链式命令必触发审批），
// 与用户本地主工作区语义冲突。
// 阶段九十：增加本机 MCP 工具纪律说明（清单已按 mcp_pc_ 前缀注入 schema）
func (s *Server) agentSystemPrompt(username string, wsDir string, sandbox *AgentSandbox) string {
	workRule := "当前服务端为用户 " + username + " 分配了独立工作区（你的所有文件操作与命令执行都限制在该目录内）：" + wsDir + "。\n"
	pathRule := "4. 所有文件操作仅使用工作区内的相对路径。"
	if sandbox != nil && len(sandbox.Dirs) > 0 {
		// 主工作区优先：命令执行的工作目录就是主工作区，模型无需（也不应）cd 切换目录
		primary := sandbox.Primary
		if primary == "" {
			primary = sandbox.Dirs[0]
		}
		workRule = "用户已在本地电脑授权以下目录（沙箱白名单，可直接读写），你的文件操作与命令执行默认发生在主工作区：\n"
		for i, d := range sandbox.Dirs {
			mark := ""
			if d == primary {
				mark = "（主工作区）"
			}
			workRule += fmt.Sprintf("%d. %s%s\n", i+1, d, mark)
		}
		workRule += "命令执行的当前目录已经是主工作区，直接执行目标命令即可，禁止用 cd 切换目录（cd ... && ... 链式命令会触发人工审批）。\n"
		workRule += "服务端另为用户 " + username + " 保留了独立回退工作区：" + wsDir + "（仅在本地执行器离线时使用）。\n"
		pathRule = "4. 文件操作优先使用相对路径（落在主工作区）；操作白名单内其他授权目录时使用完整绝对路径，禁止访问白名单外的任何路径。"
	}
	// 当前项目提示：用户在文件面板切换到工作区子项目后，引导 AI 把操作聚焦该目录（TRAE「打开文件夹」同款语义）
	if cur := wsProjMetaLoad(username).Cur; strings.TrimSpace(cur) != "" {
		workRule += "\n当前项目：用户正在工作区的子目录 \"" + cur + "/\" 内开发（已克隆的独立仓库）。本次任务的所有文件读写与命令执行请优先在该目录内进行（相对路径以 \"" + cur + "/\" 前缀落点，或命令中进入该目录），不要把文件散落到工作区根。\n"
	}
	// 阶段六十八：工具列表动态归口（与 agentToolDefinitions 注入 schema 同口径，未开启不宣传防误调用）
	// 阶段七十四：补全 list_dir/grep/edit_file/delete_file
	toolList := "read_file（读文件，支持 offset/limit 分段）、list_dir（列目录）、grep（按内容搜索文件）、" +
		"write_file（写文件，需用户审批）、edit_file（精确替换编辑文件，需用户审批）、delete_file（删除文件/目录，需用户审批且不可恢复）、" +
		"todo_write（任务清单）、run_command（执行命令，白名单外需审批）、ask_user（向用户提问获取决策/澄清需求，用户选择选项或自由输入后继续）"
	if agentHttpEnabled.Load() {
		toolList += "、http_request（HTTP 接口调用/网页抓取，非只读方法需审批）"
	}
	if agentSearchEnabled.Load() {
		toolList += "、web_search（联网搜索）"
	}
	// 阶段九十一：内置浏览器工具提示（仅 PC 在线时已注入 schema，这里给分工纪律：
	// JS 渲染/登录态页面用 browser_*，纯接口/静态抓取仍优先 http_request）
	if agentBrowserEnabled.Load() && agentPcExec.Load() && s.hub.HasPC(username) {
		toolList += "、内置浏览器工具（browser_navigate/browser_snapshot/browser_click/browser_input/browser_screenshot/browser_eval/browser_tabs/browser_close，在用户电脑内置浏览器打开与操作网页；登录态/JS 渲染页面优先用本族工具，纯接口调用仍用 http_request）"
	}
	// 阶段九十：本机 MCP 工具提示（schema 已按用户上报清单动态注入，这里给纪律性说明防误用）
	if pcTools := s.agentPcToolsFor(username); len(pcTools) > 0 {
		toolList += "、本机 MCP 工具（mcp_pc_ 前缀，经用户电脑本地执行，使用前确认语义与参数来自用户数据）"
	}
	return "你是运行在即时通讯软件内的智能 Agent（自动化任务执行器）。\n" +
		workRule +
		"可用工具：" + toolList + "。\n" +
		"工作纪律：\n" +
		"1. 接到任务先分析，第一步必须调用 todo_write 建立任务清单（拆解为可执行的子步骤），并在推进过程中持续更新各条目状态。\n" +
		"2. 每轮先输出你的思考（简述本步要做什么、为什么），再发起工具调用；需要用户审批的操作会先推送给用户确认。\n" +
		"3. 工具结果回传后继续下一步；遇到错误要分析原因并调整方案，不要盲目重试同一操作。\n" +
		pathRule + "\n" +
		"5. 浏览目录结构用 list_dir；定位内容先 grep 搜索再 read_file 按需分段（offset/limit）读取，避免整读大文件。\n" +
		"6. 修改既有文件优先 edit_file 精确替换，仅新建文件或整体重写时才用 write_file。\n" +
		"6a. 调用 write_file/edit_file/delete_file 时必须在 explanation 字段用一句中文说明本次修改意图（面向用户的变更说明，将展示在变更浮层与审查列表中，帮助用户决定保留或撤销）。\n" +
		"7. 需要实时/外部信息（新闻、行情、文档、接口数据）时优先 web_search 检索，再用 http_request 抓取具体接口或页面；向用户转述时注明信息来源链接。\n" +
		"8. C/C++ 编译能力：可直接调用 gcc/g++/make 等编译命令，客户端首次使用时会自动准备本地编译环境（系统已有 MSVC/编译器时优先使用，无需任何安装操作；若系统为 MSVC，错误提示会引导改用 cl 语法）。\n" +
		"9. 任务完成后（所有清单条目 done），不再调用任何工具，直接输出最终总结答复（做了什么、产出在哪里、结果如何）。\n" +
		"10. 遇到需要用户判断/决策的问题（多种可行方案、需求不明确、缺少关键信息且无法自行获取）时，用 ask_user 提问：问题简明扼要，给 2-4 个带说明的候选选项并标出推荐项；一次只问一个最关键的问题，能凭现有信息合理决策的不要打扰用户；用户取消回答时按最合理的默认方案继续，不要重复追问。"
}

// agentEchoGoal 阶段七十：任务目标落库并回显（服务端归口会话历史——切会话/重登后提问不丢失，
// 与 AI 问答提问落库回显同口径 ai.go handleAIChat；最终答复由 agentFinish 落库，问答成对可见）。
// 阶段七十一：sid 指定归属会话（0=默认会话），回显/落库同源盖戳
func (s *Server) agentEchoGoal(c *Client, agentName, goal string, sid uint) {
	record := model.Message{
		MsgType:     2,
		FromUser:    c.username,
		ToUser:      agentName,
		Content:     goal,
		IsRead:      true, // AI 会话无已读回执语义，避免自己发的提问永远显示"未读"
		AISessionID: sid,
	}
	if err := store.DB.Create(&record).Error; err != nil {
		logger.Error("Agent 任务目标落库失败（用户 %s）：%v", c.username, err)
		return
	}
	// 阶段七十一：占位标题会话以任务目标生成标题（与 AI 提问同归口）
	aiSessionAutoTitle(c.username, agentName, sid, goal)
	// 回显给发起人全部在线连接（复用私聊渲染链路，多端同步），真实 msg_id 随帧下发；
	// SessionID 随帧下发：多端按会话归属过滤渲染
	echo := protocol.Message{
		MsgType:   protocol.MsgTypePrivate,
		FromUser:  c.username,
		ToUser:    agentName,
		Content:   goal,
		MsgID:     record.ID,
		SessionID: sid,
		IsRead:    true,
		Timestamp: time.Now().Unix(),
	}
	echoData, _ := json.Marshal(echo)
	s.sendToUser(c.username, echoData)
	// 会话摘要归口（会话列表显示任务目标并排序置顶）
	s.touchConversation(c.username, agentName, messageSummary(goal))
	s.notifyConvUpdate(c.username)
}

// handleAgentRun 阶段五十九：任务发起/取消（上行 msg_type=46）
// 发起 content 为 JSON {goal, agent_name}；取消 content 为 JSON {task_id, action:"cancel"}
func (s *Server) handleAgentRun(c *Client, msg *protocol.Message) {
	content := strings.TrimSpace(msg.Content)
	var req struct {
		TaskID    string `json:"task_id"`
		Action    string `json:"action"`
		Goal      string `json:"goal"`
		AgentName string `json:"agent_name"`
		SessionID uint   `json:"session_id"` // 阶段七十一：归属会话（0=默认会话），任务全程按此盖戳
	}
	if err := json.Unmarshal([]byte(content), &req); err != nil {
		s.sendError(c, "任务请求格式错误")
		return
	}

	// 取消分支
	if req.Action == "cancel" {
		if req.TaskID == "" {
			s.sendError(c, "缺少 task_id")
			return
		}
		if v, ok := agentTasks.Load(req.TaskID); ok {
			t := v.(*AgentTask)
			if t.Username == c.username { // 仅发起人可取消
				t.mu.Lock()
				st := t.Status
				t.mu.Unlock()
				// 阶段六十七：排队任务取消——未启动无状态机可唤醒，直接收尾
				// （agentFinish 落库 cancelled+"任务已取消"通知留档，is_read=true 本人操作无未读），随后派发队首
				if st == "queued" {
					s.agentFinish(t, "cancelled", "", "")
					s.agentDispatchNext(t.Username)
					return
				}
				t.Cancelled.Store(true)
				// 阶段一百三十八：立即中止任务级上下文——当前轮进行中的上游模型调用即刻断开
				// （原实现要等当前轮自然跑完才在循环检查点退出，期间 tokens 持续无感知消耗）
				if t.runCancel != nil {
					logger.Info("Agent 任务取消（任务 %s，用户 %s）：已发出任务级取消信号，正在中止当前轮上游模型调用", t.ID, c.username)
					t.runCancel()
				}
				t.mu.Lock()
				ch := t.approveCh
				step := t.approveStep
				askCh := t.askCh // 阶段一百二十五：提问等待同步唤醒（停止按钮对提问挂起同样生效）
				askStep := t.askStep
				t.mu.Unlock()
				if ch != nil && step != "" {
					// 唤醒等待中的审批（携带 cancel 标记，状态机内统一收口）
					select {
					case ch <- &AgentApproval{Action: "cancel"}:
					default:
					}
				}
				if askCh != nil && askStep != "" {
					// 阶段一百二十五：唤醒等待中的提问（取消语义同审批，任务收口为已取消）
					select {
					case askCh <- &AgentApproval{Action: "cancel"}:
					default:
					}
				}
			}
		}
		return
	}

	// 发起分支
	if !agentEnabled.Load() {
		s.sendError(c, "智能 Agent 功能未开启（后台管理 Agent 设置或 config.yaml ai.agent.enabled 可开启）")
		return
	}
	goal := strings.TrimSpace(req.Goal)
	if goal == "" {
		s.sendError(c, "任务目标不能为空")
		return
	}
	agentName := strings.TrimSpace(req.AgentName)
	if agentName == "" {
		agentName = aiAgentList()[0].Name // 缺省取首个智能体
	}
	agent := aiAgentForUser(agentName, c.username)
	if agent == nil {
		s.sendError(c, "智能体不存在或无权使用")
		return
	}
	if agent.Provider == nil {
		s.sendError(c, "该智能体未绑定模型服务，无法执行自动化任务")
		return
	}

	// 阶段七十一：多会话归属校验（0=默认会话），任务回显/答复/记录全程按此会话盖戳
	sid := req.SessionID
	if !aiSessionValidate(c.username, agent.Name, sid) {
		s.sendError(c, "会话不存在或已被删除")
		return
	}

	// 阶段六十七：任务队列归口——活动任务数低于并发上限直接启动，超出入队排队（FIFO），
	// 排队已满拒绝；全程持锁防并发发起竞态超开（sendToUser 非阻塞投递，锁内推送安全）
	agentQueueMu.Lock()
	active, queued := agentCountForUser(c.username)
	if active >= int(agentConcurrency.Load()) && len(queued) >= int(agentQueueSize.Load()) {
		agentQueueMu.Unlock()
		s.sendError(c, fmt.Sprintf("已有任务在执行中且排队已满（并发 %d + 排队 %d），请等待任务完成或取消后再发起", agentConcurrency.Load(), agentQueueSize.Load()))
		return
	}

	t := &AgentTask{
		ID:        agentNewTaskID(),
		Username:  c.username,
		Agent:     agent,
		Goal:      goal,
		SessionID: sid, // 阶段七十一：任务全程会话归属（事件流/答复/任务记录同源）
	}
	// 阶段一百三十八：任务级取消上下文（直接启动与排队派发共用；agentFinish 统一 runCancel 防泄漏）
	t.runCtx, t.runCancel = context.WithCancel(context.Background())
	if active < int(agentConcurrency.Load()) {
		// 有空位：直接启动（阶段五十九原路径）
		t.Status = "running"
		t.StartAt = time.Now() // 阶段一百三十八：执行计时起点（耗时统计归口；任务未暴露无并发，直赋安全）
		agentTasks.Store(t.ID, t)
		agentQueueMu.Unlock()

		// 落库初始记录（running 态即建行，结束态更新，任务全程可追溯）
		rec := model.AgentTaskRecord{
			TaskID:    t.ID,
			Username:  c.username,
			AgentName: agent.Name,
			Goal:      goal,
			Status:    "running",
			SessionID: sid,
		}
		store.DB.Create(&rec)

		// 阶段七十：任务目标落库回显（提问进会话历史，切会话/重登不丢；先于受理事件保证提问气泡在任务卡上方）
		s.agentEchoGoal(c, agent.Name, goal, sid)

		// 已受理事件（前端创建任务面板）
		s.agentEmit(t, "status", map[string]interface{}{"status": "running", "text": "任务已受理", "goal": goal, "agent": agent.Name})

		// 异步执行状态机（不阻塞 WebSocket 主调度）
		go s.runAgentTask(t)
		return
	}

	// 无空位：入队排队（FIFO 序号归口，落库 queued 态，任务历史可见）
	t.Status = "queued"
	t.EnqueueSeq = agentEnqueueSeq.Add(1)
	agentTasks.Store(t.ID, t)
	position := len(queued) + 1
	agentQueueMu.Unlock()

	rec := model.AgentTaskRecord{
		TaskID:    t.ID,
		Username:  c.username,
		AgentName: agent.Name,
		Goal:      goal,
		Status:    "queued",
		SessionID: sid,
	}
	store.DB.Create(&rec)
	logger.Info("Agent 任务入队 %s（用户 %s，排队位次 %d）", t.ID, c.username, position)
	// 阶段七十：任务目标落库回显（排队任务同口径，提问进会话历史；先于受理事件保证提问气泡在任务卡上方）
	s.agentEchoGoal(c, agent.Name, goal, sid)
	s.agentEmit(t, "status", map[string]interface{}{"status": "queued", "text": "排队中", "position": position, "goal": goal, "agent": agent.Name})
}

// agentFinish 任务结束归口：状态落库 + done/error 事件推送（endOnce 防重复收尾）
func (s *Server) agentFinish(t *AgentTask, status, result, errMsg string) {
	t.endOnce.Do(func() {
		t.mu.Lock()
		t.Status = status
		usage := t.usageTotal      // 阶段一百零二：快照全任务 Token 累计（落库/随帧下发）
		pointsCost := t.pointsCost // 阶段一百三十八：快照全任务实际扣费积分累计（随完结帧下发）
		// 阶段一百三十八：任务耗时快照（StartAt→完结毫秒；零值兜底 0，前端不显示），落库并随完结帧下发
		var elapsedMs int64
		if !t.StartAt.IsZero() {
			elapsedMs = time.Since(t.StartAt).Milliseconds()
			if elapsedMs < 0 {
				elapsedMs = 0
			}
		}
		t.mu.Unlock()
		// 阶段一百三十八：任务完结统一释放任务级取消上下文（防 context 泄漏；幂等）
		if t.runCancel != nil {
			t.runCancel()
		}
		store.DB.Model(&model.AgentTaskRecord{}).Where("task_id = ?", t.ID).
			Updates(map[string]interface{}{"status": status, "result": result, "error": errMsg, "steps": t.steps, "elapsed_ms": elapsedMs, "points_cost": pointsCost})
		// 阶段六十六：任务完结通知落库（会话流留档+未读归口：切走会话/最小化/离线后经历史与角标可靠感知）
		// completed 落最终答复（修复事件流不落库、重登后最终答复丢失）；failed/cancelled 落简短通知；
		// cancelled 由用户本人现场操作触发，is_read=true 不产生未读提醒
		notifyContent := ""
		notifyRead := false
		switch status {
		case "completed":
			notifyContent = result
		case "cancelled":
			notifyContent = "任务已取消"
			notifyRead = true
		default:
			if errMsg != "" {
				notifyContent = "任务执行失败：" + errMsg
			} else {
				notifyContent = "任务执行失败"
			}
		}
		var msgID uint
		if notifyContent != "" {
			reply := model.Message{
				MsgType:     2,
				FromUser:    t.Agent.Name,
				ToUser:      t.Username,
				Content:     notifyContent,
				IsRead:      notifyRead,
				AISessionID: t.SessionID, // 阶段七十一：完结答复与任务目标同会话盖戳，问答成对归位
				// 阶段一百零二：任务全程 Token 消耗随完结消息落库（历史加载与普通回复同口径显示）
				PromptTokens:     usage.PromptTokens,
				CompletionTokens: usage.CompletionTokens,
				TotalTokens:      usage.TotalTokens,
			}
			if err := store.DB.Create(&reply).Error; err == nil {
				msgID = reply.ID
				// 阶段七十：完结答复消息 ID 回写任务记录（前端重进会话按此锚点在答复气泡前内联重放任务卡）
				store.DB.Model(&model.AgentTaskRecord{}).Where("task_id = ?", t.ID).Update("reply_msg_id", msgID)
			} else {
				logger.Error("Agent 完结通知落库失败（任务 %s）：%v", t.ID, err)
			}
			// 会话摘要与未读归口联动（CONV_LIST 推送后托盘角标/闪动自动生效）
			s.touchConversation(t.Username, t.Agent.Name, messageSummary(notifyContent))
			s.notifyConvUpdate(t.Username)
		}
		switch status {
		case "completed":
			// 阶段一百三十八：积分已改每轮即时扣除（见任务循环 step_tokens 归口，按单轮实际消耗扣，
			// 总额不变），完结时不再按全任务总 tokens 扣（防重复扣费）；仅查询当前余额随帧下发刷新标题栏
			// 阶段七十七：完结统计文件变更（done/error/cancelled 均携带——中途取消的脏改也可撤销）
			changes := s.agentFinalizeChanges(t)
			donePayload := map[string]interface{}{
				"result": result, "steps": t.steps, "msg_id": msgID,
				// 阶段一百零二：全任务 Token 消耗随完结帧下发（前端任务卡与答复气泡同口径标注）
				"prompt_tokens":     usage.PromptTokens,
				"completion_tokens": usage.CompletionTokens,
				"total_tokens":      usage.TotalTokens,
				// 阶段一百三十八：任务耗时随帧下发（前端展示"耗时 X 分 Y 秒"，TRAE CN 同款）
				"elapsed_ms": elapsedMs,
				// 阶段一百三十八：全任务实际扣费积分随帧下发（前端状态行展示"扣 N 积分"，每轮单扣精确合计）
				"points_cost": pointsCost,
			}
			if balance, berr := userPoints(t.Username); berr == nil {
				donePayload["points_balance"] = balance
			} else {
				logger.Error("Agent 完结查询余额失败（任务 %s，用户 %s）：%v", t.ID, t.Username, berr)
			}
			if len(changes) > 0 {
				donePayload["changes"] = changes
			}
			s.agentEmit(t, "done", donePayload)
			// 阶段六十三：任务完成后异步提炼可复用经验入库（原实现：任务结束即止，无经验沉淀）
			var todoSummary string
			t.mu.Lock()
			for _, it := range t.todo {
				todoSummary += "[" + it.Status + "] " + it.Content + "\n"
			}
			t.mu.Unlock()
			agentExpEnqueue(t.Agent, t.Username, t.Goal, todoSummary, result, t.steps)
			// 阶段七十：后续提问建议（Trae 同款，与普通 AI 问答同链路）——done 帧先行下发（答复立即收尾），
			// 建议异步生成后经独立帧推送（客户端胶囊点击直接续问：Agent 模式开启发起新任务，关闭走普通问答）；
			// 仅 completed 生成（失败/取消无追问语义），失败静默无建议
			go func() {
				sugs := aiGenerateSuggestions(t.Agent, t.Goal, result)
				if len(sugs) == 0 {
					return
				}
				payload, _ := json.Marshal(sugs)
				sugMsg := protocol.Message{
					MsgType:   protocol.MsgTypeAISuggest,
					FromUser:  t.Agent.Name,
					ToUser:    t.Username,
					Content:   string(payload),
					Timestamp: time.Now().Unix(),
				}
				sugData, _ := json.Marshal(sugMsg)
				s.sendToUser(t.Username, sugData)
			}()
		case "cancelled":
			// 阶段七十七：取消同样结算变更（任务中已落盘的脏改出现审查条，可撤销）
			// 阶段一百零二：取消不扣积分，但已消耗 Token 随帧下发（用户可感知消耗）
			cancelPayload := map[string]interface{}{
				"status": "cancelled", "text": "任务已取消", "msg_id": msgID,
				"prompt_tokens":     usage.PromptTokens,
				"completion_tokens": usage.CompletionTokens,
				"total_tokens":      usage.TotalTokens,
				"elapsed_ms":        elapsedMs,  // 阶段一百三十八：耗时随帧下发（取消也显示耗时）
				"points_cost":       pointsCost, // 阶段一百三十八：实际扣费积分随帧下发（取消也显示扣了多少）
			}
			if changes := s.agentFinalizeChanges(t); len(changes) > 0 {
				cancelPayload["changes"] = changes
			}
			s.agentEmit(t, "status", cancelPayload)
		default:
			errPayload := map[string]interface{}{
				"message": errMsg, "steps": t.steps, "msg_id": msgID,
				// 阶段一百零二：失败不扣积分，但已消耗 Token 随帧下发（用户可感知消耗）
				"prompt_tokens":     usage.PromptTokens,
				"completion_tokens": usage.CompletionTokens,
				"total_tokens":      usage.TotalTokens,
				"elapsed_ms":        elapsedMs,  // 阶段一百三十八：耗时随帧下发（失败也显示耗时）
				"points_cost":       pointsCost, // 阶段一百三十八：实际扣费积分随帧下发（失败也显示扣了多少）
			}
			if changes := s.agentFinalizeChanges(t); len(changes) > 0 {
				errPayload["changes"] = changes
			}
			s.agentEmit(t, "error", errPayload)
		}
		logger.Info("Agent 任务结束 %s（用户 %s，状态 %s，%d 步）", t.ID, t.Username, status, t.steps)
		// 阶段六十七：任务释放并发名额后派发归口——队首排队任务自动启动（活动数达上限时为空操作）
		s.agentDispatchNext(t.Username)
	})
}

// runAgentTask Agent Loop 状态机：模型决策 → 工具调用（含审批挂起）→ 循环迭代 → 最终答复
func (s *Server) runAgentTask(t *AgentTask) {
	wsDir, err := agentWorkspaceDir(t.Username)
	if err != nil {
		s.agentFinish(t, "failed", "", "工作区创建失败："+err.Error())
		return
	}

	// 阶段六十三：系统提示词追加历史经验上下文（按任务目标向量检索该用户与该智能体的记忆与任务经验，
	// 原实现：仅注入 agentSystemPrompt，无经验复用）
	sysContent := s.agentSystemPrompt(t.Username, wsDir, s.agentSandboxFor(t.Username))
	if expCtx := agentExpContext(t.Agent, t.Username, t.Goal); expCtx != "" {
		sysContent += "\n\n" + expCtx
	}
	// 阶段一百零四：规则注入（TRAE CN 同款"AI 回答前先看规则"——任务执行同样遵守用户自定义规则，
	// 全局+智能体两层全量拼入系统提示；比记忆更早注入且每任务仅一次，无重复注入开销）
	if ruleCtx := rulesContextForAgent(t.Agent, t.Username); ruleCtx != "" {
		sysContent += "\n\n" + ruleCtx
	}
	msgs := []aiChatMessage{
		// 阶段六十一：PC 端在线且用户配置了沙箱白名单时，注入本地授权目录（模型据此可用绝对路径操作用户自选目录）
		{Role: "system", Content: sysContent},
		{Role: "user", Content: t.Goal},
	}
	tools := s.agentToolDefinitions(t.Username)

	for {
		// 取消检查（模型调用前）
		if t.Cancelled.Load() {
			s.agentFinish(t, "cancelled", "", "用户取消")
			return
		}

		t.mu.Lock()
		t.Status = "running"
		t.mu.Unlock()

		// 阶段八十四：TRAE 同款历史压缩——上下文估算 token 超阈值时把最早若干完整工具轮
		// LLM 摘要归并（assistant+tool 配对永不拆分），Recent 轮保留原文；事件流实时提示前端
		msgs = s.agentCompressTaskHistory(t, msgs)

		// 阶段一百三十八：每轮超时上下文派生自任务级 runCtx（原 context.Background()）——
		// 用户停止任务时取消归口调 runCancel()，当前轮进行中的上游调用立即中止，tokens 即刻停耗
		askCtx, cancelAsk := context.WithTimeout(t.runCtx, aiAskTimeout)
		// 阶段六十二：改流式调用（Trae CN 同款打字机）——正文/推理增量经 text_delta/thought_delta
		// 事件实时推送；无增量（上游一次性返回）时回退整段 thought 事件兼容
		// 阶段一百三十八：正文增量经泄漏过滤器（模型幻觉输出的工具调用标记整行拦截，思考流不过滤）
		agentLeak := &aiLeakFilter{out: func(delta string) {
			s.agentEmit(t, "text_delta", map[string]interface{}{"text": delta})
		}}
		content, toolCalls, streamed, u, err := aiAgentChatStream(askCtx, t.Agent, msgs, tools,
			agentLeak.write,
			func(delta string) {
				s.agentEmit(t, "thought_delta", map[string]interface{}{"text": delta})
			})
		agentLeak.flush()
		content = aiSanitizeToolLeak(content) // 结果层兜底净化（全泄漏→友好提示）
		cancelAsk()
		// 阶段一百零二：任务全程 Token 累计（每轮模型调用累加；失败轮已产生的消耗同样计入，
		// 完结时统一落库/扣积分/随帧下发，completed 再扣积分）
		t.mu.Lock()
		t.usageTotal.PromptTokens += u.PromptTokens
		t.usageTotal.CompletionTokens += u.CompletionTokens
		t.usageTotal.TotalTokens += u.TotalTokens
		snap := t.usageTotal
		round := t.steps + 1 // 阶段一百零三：steps 在轮末自增，+1 得当前轮次（1 起）
		t.mu.Unlock()
		// 阶段一百零三：每轮 Token 消耗实时事件——任务循环每轮全量重发上下文，轮次越多消耗越大
		// （近似平方级），用户可见每轮增量与累计才能定位消耗烧点（TRAE 同款"测量先行"）
		// 阶段一百三十八：积分改每轮即时扣除（用户要求，原完结时按全任务总 tokens 一次扣）——
		// 总额不变（Σ单轮=总数），但扣费流水逐轮可见、与每轮真实消耗一一对应，消除"完结虚扣"观感；
		// 失败轮已产生消耗同样扣（u 零值天然跳过），与累计口径一致防漏扣；扣后余额随帧刷新标题栏 ⚡
		// 阶段一百三十九：随帧携带本轮实际上下文字节数与阈值（TRAE CN 同款任务卡右下角
		// "◔ 30%" 上下文占用环）——msgs 已过压缩归口，即本轮真实发送量；禁用压缩时不下发
		stepPayload := map[string]interface{}{
			"round":             round,
			"prompt_tokens":     u.PromptTokens,
			"completion_tokens": u.CompletionTokens,
			"total_tokens":      u.TotalTokens,
			"total_prompt":      snap.PromptTokens,
			"total_completion":  snap.CompletionTokens,
			"total_all":         snap.TotalTokens,
		}
		// 原实现：随帧携带本轮上下文字节数（阶段一百三十九上半，固定 KB 口径）
		// if aiCompressThresholdKB > 0 {
		// 	stepPayload["context_bytes"] = aiMsgsBytes(msgs)
		// 	stepPayload["context_max_bytes"] = aiCompressThresholdKB * 1024
		// }
		// 阶段一百三十九：随帧携带本轮占用/阈值/口径（后台所选口径归一——TRAE CN 同款任务卡
		// 右下角"◔ 30%"上下文占用环）——msgs 已过压缩归口，即本轮真实发送量
		if cfgC := aiCompressCfgGet(); cfgC.Mode == "tokens" {
			stepPayload["context_used"] = aiMsgsEstimateTokens(msgs)
			stepPayload["context_max"] = cfgC.Tokens
			stepPayload["context_mode"] = "tokens"
		} else {
			stepPayload["context_used"] = aiMsgsBytes(msgs)
			stepPayload["context_max"] = cfgC.KB * 1024
			stepPayload["context_mode"] = "kb"
		}
		if u.TotalTokens > 0 {
			// 阶段一百三十八：扣费走计费归口（usage=按量 / percall=按次固定积分，config.yaml 热更）
			cost := aiChargeCost(u.TotalTokens)
			billingMode := aiBillingMode()
			if balance, derr := userPointsDeduct(t.Username, cost); derr != nil {
				logger.Error("Agent 第 %d 轮积分扣除失败（任务 %s，用户 %s，%d tokens）：%v", round, t.ID, t.Username, u.TotalTokens, derr)
			} else {
				t.mu.Lock()
				// 阶段一百六十二：累加后归一 3 位小数——float64 多轮直接累加产生二进制误差长尾
				// （如 10 轮 0.011 累计得 0.10999999999999999），逐轮归一保证完结下发值干净
				t.pointsCost = aiPointsRound3(t.pointsCost + cost)
				t.mu.Unlock()
				stepPayload["points_balance"] = balance
				stepPayload["points_cost"] = cost // 阶段一百三十八：该轮实际扣费（前端 percall 模式轮次行展示"扣 N 积分"）
				stepPayload["billing_mode"] = billingMode
				logger.Info("Agent 第 %d 轮积分扣除（任务 %s，用户 %s，- %.3f 积分，%d tokens，余额 %.3f，模式 %s）", round, t.ID, t.Username, cost, u.TotalTokens, balance, billingMode)
				// 积分流水审计（Agent 单轮扣除，操作人 system；type 与完结扣 ai_agent_deduct 区分；描述按模式区分）
				desc := fmt.Sprintf("Agent 任务第 %d 轮（智能体 %s）消耗 %d tokens，按 1000 tokens = 1 积分折算（保留 3 位小数）", round, t.Agent.Name, u.TotalTokens)
				if billingMode == "percall" {
					desc = fmt.Sprintf("Agent 任务第 %d 轮（智能体 %s）单次调用，按次计费固定扣 %.3f 积分（TRAE CN 同款，与 token 数无关）", round, t.Agent.Name, cost)
				}
				recordPointsLog(t.Username, -cost, balance, "ai_agent_round", "system", desc)
			}
		}
		s.agentEmit(t, "step_tokens", stepPayload)
		if err != nil {
			// 阶段一百三十八：取消导致的调用中止优先记为"用户取消"（原实现误记"模型调用失败"——
			// runCtx 取消后本轮 err=context.Canceled，先查取消标记再按失败收口）
			if t.Cancelled.Load() || t.runCtx.Err() != nil {
				logger.Info("Agent 任务 %s：当前轮上游调用已确认终止（用户取消收口，共 %d 轮）", t.ID, t.steps)
				s.agentFinish(t, "cancelled", "", "用户取消")
				return
			}
			s.agentFinish(t, "failed", "", "模型调用失败："+err.Error())
			return
		}
		if t.Cancelled.Load() {
			s.agentFinish(t, "cancelled", "", "用户取消")
			return
		}

		// 无工具调用：模型给出最终答复，任务完成
		if len(toolCalls) == 0 {
			if strings.TrimSpace(content) == "" {
				s.agentFinish(t, "failed", "", "模型未返回有效内容")
				return
			}
			// 本轮已流式推送过（streamed）则不再重复整段；一次性返回的上游回退 thought 事件
			if !streamed {
				s.agentEmit(t, "thought", map[string]interface{}{"text": content})
			}
			s.agentFinish(t, "completed", content, "")
			return
		}

		// 有思考文本且未流式推送过则补推（体现思考过程）
		if strings.TrimSpace(content) != "" && !streamed {
			s.agentEmit(t, "thought", map[string]interface{}{"text": content})
		}

		// assistant 消息（含 tool_calls）入历史，后续 tool 结果按 tool_call_id 对应回传
		msgs = append(msgs, aiChatMessage{Role: "assistant", Content: content, ToolCalls: toolCalls})

		for _, tc := range toolCalls {
			if t.Cancelled.Load() {
				s.agentFinish(t, "cancelled", "", "用户取消")
				return
			}
			toolName := tc.Function.Name
			// 参数解析（非法 JSON 视为空参数，工具内部按缺参报错回传模型自纠）
			var params map[string]interface{}
			if strings.TrimSpace(tc.Function.Arguments) != "" {
				if err := json.Unmarshal([]byte(tc.Function.Arguments), &params); err != nil {
					params = map[string]interface{}{"_parse_error": err.Error()}
				}
			}

			// 阶段六十五：计时起点前移至 tool_start 之前，轨迹耗时覆盖"审批等待 + 执行"全程
			start := time.Now()

			// 阶段七十五：事件携带 call_id（toolCall ID），前端控制台输出/转后台按钮按步骤精确归属
			s.agentEmit(t, "tool_start", map[string]interface{}{"tool": toolName, "params": params, "env": agentToolEnvHint(s, t, toolName), "call_id": tc.ID, "label": agentToolLabel(t.Username, toolName)})

			// 风险分级：需审批的工具挂起等待用户确认（改参放行/直接放行/拒绝/取消/超时）
			needApprove, reason := agentNeedsApproval(t.Username, toolName, params)

			// 阶段一百二十五：ask_user 向用户提问（TRAE CN 同款）——强制人工应答，
			// 不走审批/自动放行/白名单体系；提问下发后任务挂起，答案/跳过/取消统一收口
			if toolName == "ask_user" {
				// 缺 question 直接回错误结果让模型自纠，不劳烦用户
				if strings.TrimSpace(agentParamString(params["question"])) == "" {
					result := "错误：ask_user 缺少 question 参数（要向用户提出的问题文本）"
					s.agentEmit(t, "tool_result", map[string]interface{}{"tool": toolName, "ok": false, "output": result, "env": "server"})
					s.agentStepTrace(t, toolName, params, result, false, "server", "none", time.Since(start).Milliseconds())
					msgs = append(msgs, aiChatMessage{Role: "tool", Content: result, ToolCallID: tc.ID, Name: toolName})
					continue
				}
				action, answer, aerr := s.agentWaitAskUser(t, tc.ID, params)
				if aerr != nil {
					// 等待超时：与审批同语义，先留痕再中止任务
					s.agentStepTrace(t, toolName, params, aerr.Error(), false, "server", "timeout", time.Since(start).Milliseconds())
					s.agentFinish(t, "failed", "", aerr.Error())
					return
				}
				if action == "cancel" {
					// 用户停止任务：与审批取消同语义
					s.agentStepTrace(t, toolName, params, "用户取消了任务", false, "server", "cancelled", time.Since(start).Milliseconds())
					s.agentFinish(t, "cancelled", "", "用户取消")
					return
				}
				var result string
				if action == "skip" {
					result = "用户取消了本次回答（未选择任何选项，也未输入补充）。请基于已有信息采用最合理的默认方案继续推进，不要重复追问。"
				} else {
					result = "用户的回答：" + answer
				}
				s.agentEmit(t, "tool_result", map[string]interface{}{"tool": toolName, "ok": true, "output": result, "env": "server"})
				s.agentStepTrace(t, toolName, params, result, true, "server", "answered", time.Since(start).Milliseconds())
				msgs = append(msgs, aiChatMessage{Role: "tool", Content: result, ToolCallID: tc.ID, Name: toolName})
				continue
			}

			var result string
			var env string
			if needApprove {
				approved, out, aerr := s.agentWaitApproval(t, tc.ID, toolName, params, reason)
				if aerr != nil {
					// 阶段六十五：审批等待超时先留痕再中止任务
					s.agentStepTrace(t, toolName, params, aerr.Error(), false, "server", "timeout", time.Since(start).Milliseconds())
					s.agentFinish(t, "failed", "", aerr.Error())
					return
				}
				if approved == "cancel" {
					// 阶段六十五：审批中取消先留痕再收尾任务
					s.agentStepTrace(t, toolName, params, "用户取消了任务", false, "server", "cancelled", time.Since(start).Milliseconds())
					s.agentFinish(t, "cancelled", "", "用户取消")
					return
				}
				if approved == "reject" {
					result = "用户拒绝了该操作" + out
					s.agentEmit(t, "tool_result", map[string]interface{}{"tool": toolName, "ok": false, "output": result, "rejected": true})
					// 阶段六十五：用户拒绝留痕（该步未执行）
					s.agentStepTrace(t, toolName, params, result, false, "server", "rejected", time.Since(start).Milliseconds())
				} else {
					// 阶段六十：执行环境分派（PC 在线且开关开启时本地执行，事件流带 env 标签）
					result, env = s.agentToolExecDispatch(t, tc.ID, toolName, params)
					s.agentEmit(t, "tool_result", map[string]interface{}{"tool": toolName, "ok": !strings.HasPrefix(result, "错误"), "output": result, "env": env})
					// 阶段六十五：审批通过留痕（params 已含用户改参后的最终参数）
					s.agentStepTrace(t, toolName, params, result, !strings.HasPrefix(result, "错误"), env, "approved", time.Since(start).Milliseconds())
				}
			} else {
				result, env = s.agentToolExecDispatch(t, tc.ID, toolName, params)
				s.agentEmit(t, "tool_result", map[string]interface{}{
					"tool": toolName, "ok": !strings.HasPrefix(result, "错误"), "output": result,
					"duration_ms": time.Since(start).Milliseconds(), "env": env,
				})
				// 阶段六十五：免审批步骤留痕
				s.agentStepTrace(t, toolName, params, result, !strings.HasPrefix(result, "错误"), env, "none", time.Since(start).Milliseconds())
			}

			// tool 结果消息入历史（role=tool + tool_call_id，OpenAI 兼容格式）；
			// 阶段八十四：超长结果先截断再入模型上下文（前端 tool_result 事件与留痕仍是全量）；
			// 阶段一百一十四：截图图像（[[MCP_IMAGE:...]] 内联标记，Computer Use 等）在截断前抽出，
			// 以独立 user 多模态消息紧随注入（OpenAI 兼容 API 的 tool 角色不支持图像内容）
			clean, images := agentExtractToolImages(result)
			msgs = append(msgs, aiChatMessage{Role: "tool", Content: agentTruncateToolResult(clean), ToolCallID: tc.ID, Name: toolName})
			if len(images) > 0 {
				parts := []aiContentPart{{Type: "text", Text: fmt.Sprintf("工具 %s 返回了 %d 张屏幕截图（base64 已转为图像附件），请结合截图画面与上文工具输出继续完成任务。", toolName, len(images))}}
				for _, dataURL := range images {
					parts = append(parts, aiContentPart{Type: "image_url", ImageURL: &aiImageURLField{URL: dataURL}})
				}
				msgs = append(msgs, aiChatMessage{Role: "user", Content: parts})
			}
		}

		// 步数限制：防模型死循环（阶段八十一：agentMaxSteps 为 atomic，后台热改后运行中任务下一步即按新值判定）
		t.steps++
		if t.steps >= int(agentMaxSteps.Load()) {
			s.agentFinish(t, "failed", "", fmt.Sprintf("已达最大迭代步数（%d），任务中止", agentMaxSteps.Load()))
			return
		}
	}
}

// agentExtractToolImages 阶段一百一十四：从工具结果中抽出 [[MCP_IMAGE:data:...;base64,...]] 内联标记
// （Computer Use 截图等 ImageContent，由 mcp.go 与 PC 执行器统一转为该标记）。
// 返回：去除标记并替换为占位说明的文本 + data URL 图像列表（按出现顺序）。
// 必须在 agentTruncateToolResult 之前调用——base64 体量远超截断上限，混在文本里会被吃掉且污染上下文
var agentImageMarkRe = regexp.MustCompile(`\[\[MCP_IMAGE:data:(image/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+?)\]\]`)

func agentExtractToolImages(s string) (string, []string) {
	if !strings.Contains(s, "[[MCP_IMAGE:") {
		return s, nil
	}
	matches := agentImageMarkRe.FindAllStringSubmatch(s, -1)
	if len(matches) == 0 {
		return s, nil // 格式异常（如被外层截断打断）保持原样，不误吞内容
	}
	images := make([]string, 0, len(matches))
	for _, m := range matches {
		images = append(images, "data:"+m[1]+";base64,"+m[2])
	}
	clean := agentImageMarkRe.ReplaceAllString(s, "[屏幕截图已作为图像附件注入下一消息]")
	return clean, images
}

// agentTruncateToolResult 阶段八十四：工具结果入模型上下文前的字符截断归口——
// 保留头 2/3 + 尾 1/3（尾部常含最终状态/错误信息，对模型决策更关键），中段以省略标注替代。
// 仅约束进模型的历史；前端执行控制台（tool_result 事件）与步骤留痕仍是全量。
// run_command 已有 agentCmdOutMaxChars 截断（其标注位于结果末尾，本函数尾部保留天然保护其完整性）
func agentTruncateToolResult(s string) string {
	limit := agentToolResultMaxChars
	if limit < 0 {
		return s
	}
	runes := []rune(s)
	if len(runes) <= limit {
		return s
	}
	head := limit * 2 / 3
	tail := (limit - head) / 2
	omit := len(runes) - head - tail
	return string(runes[:head]) +
		fmt.Sprintf("\n…[中段省略 %d 字符，全量输出见执行控制台/留痕]…\n", omit) +
		string(runes[len(runes)-tail:])
}

// agentCompressBoundary 阶段八十四：计算任务历史压缩边界——返回最近第 keepTurns 个完整
// 工具轮（assistant+tool_calls 起）的消息下标，msgs[start:] 保留原文，msgs[1:start] 可整段摘要。
// 在 assistant(含 tool_calls) 处切割保证其与后续 tool 结果（tool_call_id 配对）要么全在保留区、
// 要么全在压缩区，OpenAI 兼容格式不会因拆对而报错；start<=1 表示无可压缩轮次
func agentCompressBoundary(msgs []aiChatMessage, keepTurns int) int {
	starts := make([]int, 0, 8)
	for i := 2; i < len(msgs); i++ { // 0=system 1=任务目标（goal），均不参与压缩
		if msgs[i].Role == "assistant" && len(msgs[i].ToolCalls) > 0 {
			starts = append(starts, i)
		}
	}
	if len(starts) <= keepTurns {
		return 0
	}
	return starts[len(starts)-keepTurns]
}

// agentCompressTaskHistory 阶段八十四：Agent 任务循环历史压缩归口（每轮模型调用前执行）。
// 长任务 msgs 无界增长且每轮全量重发，token 消耗随步数近似平方级膨胀——超阈值时把最早若干
// 完整工具轮 LLM 摘要成一条 user 消息（旧摘要文本也在转录内，天然增量合并），最近
// agentCompressKeepTurns 轮保留原文。摘要失败时若未超 3 倍阈值则本轮跳过（下轮重试），
// 超 3 倍则紧急截断（弃旧轮+省略声明）防"上下文超长"直接压死任务
// 阶段一百三十九：触发口径后台可选（admin 后台保存即热生效）——tokens 估算 / kb 字节（TRAE CN
// 状态栏同款）双口径，归口 aicompresscfg.go（aiCompressCfgGet）；仅 Agent 任务生效，
// AI 问答压缩仍走 aiCompressThreshold token 判据（aiCompressHistory）
func (s *Server) agentCompressTaskHistory(t *AgentTask, msgs []aiChatMessage) []aiChatMessage {
	// 原实现：token 判据（阶段八十四，AI 问答与 Agent 任务共用 aiCompressThreshold）
	// if aiCompressThreshold <= 0 || t.Agent == nil || t.Agent.Provider == nil || len(msgs) < 4 {
	// 	return msgs
	// }
	// if aiMsgsEstimateTokens(msgs) < aiCompressThreshold {
	// 	return msgs
	// }
	// 原实现：KB 判据（阶段一百三十九上半，config.yaml compress_threshold_kb 静态阈值）
	// if aiCompressThresholdKB <= 0 || t.Agent == nil || t.Agent.Provider == nil || len(msgs) < 4 {
	// 	return msgs
	// }
	// if aiMsgsBytes(msgs) < aiCompressThresholdKB*1024 {
	// 	return msgs // 未达 KB 阈值：本轮上下文原样全发
	// }
	// 阶段一百三十九：压缩口径后台可选（admin 后台 tokens/kb 双口径，保存即热生效无需重启）
	cfg := aiCompressCfgGet()
	used, maxV := 0, 0
	if cfg.Mode == "tokens" {
		used, maxV = aiMsgsEstimateTokens(msgs), cfg.Tokens
	} else {
		used, maxV = aiMsgsBytes(msgs), cfg.KB*1024
	}
	if maxV <= 0 || t.Agent == nil || t.Agent.Provider == nil || len(msgs) < 4 {
		return msgs
	}
	if used < maxV {
		return msgs // 未达阈值：本轮上下文原样全发
	}
	bnd := agentCompressBoundary(msgs, agentCompressKeepTurns)
	if bnd <= 2 {
		return msgs // 不足可压缩轮次（保留区外没有完整轮）
	}
	before := len(msgs)
	est := aiMsgsEstimateTokens(msgs)
	totalBytes := aiMsgsBytes(msgs)
	// 压缩开始先推事件（TRAE 同款"历史对话压缩中"实时提示，摘要期间用户可见进度）
	// 阶段一百三十九：随帧携带当前占用 used/阈值 max/口径 mode（前端任务卡上下文占用环即时升到峰值）
	s.agentEmit(t, "history_compress", map[string]interface{}{"phase": "start", "before": before, "est_tokens": est, "used": used, "max": maxV, "mode": cfg.Mode})
	// 转录压缩区（跳过 0=system；1=goal 亦纳入转录，摘要需原始目标锚定语义）
	// 阶段一百零三：转录段瘦身——每条先按 rune 截断再进摘要（摘要只需要点，工具结果全文转录
	// 会让压缩调用本身烧掉大量 tokens；原始历史仅在本次内存中，保留区轮次不受影响）
	segs := make([]string, 0, bnd-1)
	for i := 1; i < bnd; i++ {
		role := "用户"
		switch msgs[i].Role {
		case "assistant":
			role = "模型"
		case "tool":
			role = "工具结果(" + msgs[i].Name + ")"
		}
		text := aiChatMsgText(msgs[i])
		if aiCompressSegMaxRunes > 0 {
			if r := []rune(text); len(r) > aiCompressSegMaxRunes {
				text = string(r[:aiCompressSegMaxRunes]) + "…（本条已截断）"
			}
		}
		segs = append(segs, role+"："+text)
	}
	summary := aiCompressSummarize(nil, t.Agent, "", segs)
	if summary == "" {
		// 原实现：token 口径 3 倍兜底（阶段八十四）
		// if est < aiCompressThreshold*3 {
		// 原实现：KB 口径 3 倍兜底（阶段一百三十九上半）
		// if totalBytes < aiCompressThresholdKB*1024*3 {
		if used < maxV*3 { // 阶段一百三十九：按当前口径 3 倍兜底
			return msgs // 瞬时失败：本轮维持全量，下轮重试
		}
		// 溢出紧急截断：不再调 LLM，直接弃旧轮留声明，任务保命优先
		out := make([]aiChatMessage, 0, len(msgs)-bnd+3)
		out = append(out, msgs[0], msgs[1],
			aiChatMessage{Role: "user", Content: fmt.Sprintf("[系统提示] 更早的 %d 条执行记录因上下文超长被省略，请基于下方近期记录继续完成任务。", bnd-1)})
		out = append(out, msgs[bnd:]...)
		logger.Info("Agent 任务 %s 历史压缩失败，紧急截断 %d→%d 条", t.ID, before, len(out))
		return out
	}
	out := make([]aiChatMessage, 0, len(msgs)-bnd+3)
	out = append(out, msgs[0], msgs[1],
		aiChatMessage{Role: "user", Content: "[前序执行历史摘要（较早工具轮已压缩归并）]\n" + summary})
	out = append(out, msgs[bnd:]...)
	// 阶段一百三十九：done 帧携带压缩后占用（同口径）/阈值/口径（前端任务卡上下文占用环即时回落）
	afterUsed := totalBytes
	if cfg.Mode == "tokens" {
		afterUsed = aiMsgsEstimateTokens(out)
	} else {
		afterUsed = aiMsgsBytes(out)
	}
	s.agentEmit(t, "history_compress", map[string]interface{}{"phase": "done", "before": before, "after": len(out),
		"est_tokens": aiMsgsEstimateTokens(out), "used": afterUsed, "max": maxV, "mode": cfg.Mode})
	// 阶段一百三十九：日志带口径与阈值（token 仅作参考趋势）
	logger.Info("Agent 任务 %s 历史压缩（%s 口径阈值 %d）：%d→%d 条（%.1fKB→%.1fKB，估算 token %d→%d）", t.ID, cfg.Mode, maxV,
		before, len(out), float64(totalBytes)/1024, float64(aiMsgsBytes(out))/1024, est, aiMsgsEstimateTokens(out))
	return out
}

// agentWaitApproval 审批挂起：推送审批请求，阻塞等待用户上行结果（approve/reject/cancel/超时）。
// 返回 (action, 附加说明, error)；approve 时 params 已按用户改参更新
func (s *Server) agentWaitApproval(t *AgentTask, callID, tool string, params map[string]interface{}, reason string) (string, string, error) {
	ch := make(chan *AgentApproval, 1)
	step := callID // 审批步骤 key：tool_call ID 全局唯一且与本次调用一一对应
	t.mu.Lock()
	t.approveCh = ch
	t.approveStep = step
	t.approveTool = tool // 阶段六十二："同意并加白"按工具分流（run_command 加命令前缀 / write_file 开免审批）
	t.Status = "waiting_approval"
	t.mu.Unlock()
	defer func() {
		t.mu.Lock()
		t.approveCh = nil
		t.approveStep = ""
		t.approveTool = ""
		t.mu.Unlock()
	}()

	reqData, _ := json.Marshal(map[string]interface{}{
		"task_id": t.ID,
		"step":    step,
		"tool":    tool,
		"label":   agentToolLabel(t.Username, tool), // 阶段八十九：MCP 工具下发人类可读展示名（命名空间 key 不可反解）
		"params":  params,
		"reason":  reason,
	})
	reqMsg := protocol.Message{
		MsgType:   protocol.MsgTypeAgentApproveReq,
		FromUser:  t.Agent.Name, // 前端按会话归属渲染审批卡片
		ToUser:    t.Username,
		Content:   string(reqData),
		Timestamp: time.Now().Unix(),
	}
	out, _ := json.Marshal(reqMsg)
	s.sendToUser(t.Username, out)
	s.agentSetStatus(t, "waiting_approval", "等待用户审批："+tool)

	select {
	case ap := <-ch:
		switch ap.Action {
		case "approve":
			if ap.Params != nil {
				// 改参放行：用户审阅并修改后的参数替换执行参数
				for k, v := range ap.Params {
					params[k] = v
				}
			}
			s.agentSetStatus(t, "running", "审批通过，继续执行")
			return "approve", "", nil
		case "reject":
			s.agentSetStatus(t, "running", "用户拒绝，继续寻找替代方案")
			return "reject", "（如可行请调整方案，或说明任务无法继续的原因）", nil
		default: // cancel
			return "cancel", "", nil
		}
	case <-time.After(time.Duration(agentApproveWait.Load()) * time.Second):
		return "", "", fmt.Errorf("审批等待超时（%d 秒），任务中止", agentApproveWait.Load())
	}
}

// handleAgentApprove 审批结果上行（msg_type=49）：校验发起人与步骤后投递到等待中的任务
func (s *Server) handleAgentApprove(c *Client, msg *protocol.Message) {
	var req struct {
		TaskID string                 `json:"task_id"`
		Step   string                 `json:"step"`
		Action string                 `json:"action"`
		Params map[string]interface{} `json:"params"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &req); err != nil || req.TaskID == "" {
		s.sendError(c, "审批请求格式错误")
		return
	}
	if req.Action != "approve" && req.Action != "reject" && req.Action != "whitelist" {
		s.sendError(c, "未知的审批操作")
		return
	}
	v, ok := agentTasks.Load(req.TaskID)
	if !ok {
		s.sendError(c, "任务不存在或已结束")
		return
	}
	t := v.(*AgentTask)
	if t.Username != c.username { // 仅发起人可审批
		return
	}
	t.mu.Lock()
	ch := t.approveCh
	step := t.approveStep
	tool := t.approveTool
	t.mu.Unlock()
	if ch == nil || step != req.Step { // 非等待态或步骤不匹配（迟到的审批）直接忽略
		return
	}
	// 阶段六十二："同意并加白"= 先按工具持久化白名单，再按 approve 放行本次。
	// 阶段七十四：edit_file 与 write_file 共用写文件免审批；delete_file 不可加白（恒需逐次审批，
	// 上行 whitelist 仅等同本次 approve，无白名单副作用）
	if req.Action == "whitelist" {
		switch tool {
		case "run_command":
			cmd, _ := req.Params["command"].(string)
			agentWhitelistCmd(t.Username, cmd) // 链式命令内部拒白，仅本次放行；阶段八十三仅对发起人生效
		case "write_file", "edit_file":
			agentWhitelistAutoWrite(t.Username)
		}
		req.Action = "approve"
	}
	select {
	case ch <- &AgentApproval{Action: req.Action, Params: req.Params}:
	default:
	}
}

// agentWaitAskUser 阶段一百二十五：ask_user 提问挂起（TRAE CN 同款"正在向用户提问"）——
// 下发提问事件，阻塞等待用户上行答案（answer/skip/cancel/超时）。与审批同源：
// 等待期计入活动任务数、超时复用审批等待秒数；但强人工应答，无自动放行与改参。
// 返回 (action, 答案, error)；action=answer/skip/cancel
func (s *Server) agentWaitAskUser(t *AgentTask, callID string, params map[string]interface{}) (string, string, error) {
	ch := make(chan *AgentApproval, 1)
	step := callID // 步骤 key：tool_call ID 全局唯一且与本次调用一一对应
	t.mu.Lock()
	t.askCh = ch
	t.askStep = step
	t.Status = "waiting_approval"
	t.mu.Unlock()
	defer func() {
		t.mu.Lock()
		t.askCh = nil
		t.askStep = ""
		t.mu.Unlock()
	}()

	// 参数规整（模型输出容错）：选项仅保留有 label 的条目；无选项时强制允许自由输入（否则用户无话可答）
	question := agentParamString(params["question"])
	options := make([]map[string]interface{}, 0, 4)
	if raw, ok := params["options"].([]interface{}); ok {
		for _, o := range raw {
			if m, ok := o.(map[string]interface{}); ok {
				if label := agentParamString(m["label"]); strings.TrimSpace(label) != "" {
					options = append(options, m)
				}
			}
		}
	}
	allowFree := true
	if af, ok := params["allow_free"].(bool); ok {
		allowFree = af
	}
	if len(options) == 0 {
		allowFree = true
	}
	payload := map[string]interface{}{
		"step":       step,
		"question":   question,
		"options":    options,
		"allow_free": allowFree,
	}
	if ctx := agentParamString(params["context"]); strings.TrimSpace(ctx) != "" {
		payload["context"] = ctx
	}
	s.agentEmit(t, "ask_user", payload)
	s.agentSetStatus(t, "waiting_approval", "等待用户回答："+question)

	select {
	case ap := <-ch:
		switch ap.Action {
		case "answer":
			s.agentSetStatus(t, "running", "用户已回答，继续执行")
			return "answer", ap.Answer, nil
		case "skip":
			s.agentSetStatus(t, "running", "用户跳过回答，继续执行")
			return "skip", "", nil
		default: // cancel（用户停止任务时服务端内部投递）
			return "cancel", "", nil
		}
	case <-time.After(time.Duration(agentApproveWait.Load()) * time.Second):
		return "", "", fmt.Errorf("提问等待超时（%d 秒），任务中止", agentApproveWait.Load())
	}
}

// handleAgentAsk 提问回答上行（msg_type=68）：校验发起人与步骤后投递到等待中的任务
func (s *Server) handleAgentAsk(c *Client, msg *protocol.Message) {
	var req struct {
		TaskID string `json:"task_id"`
		Step   string `json:"step"`
		Action string `json:"action"` // answer=选择选项/自由输入；skip=取消本次回答
		Answer string `json:"answer"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &req); err != nil || req.TaskID == "" {
		s.sendError(c, "提问回答格式错误")
		return
	}
	if req.Action != "answer" && req.Action != "skip" {
		s.sendError(c, "未知的提问回答操作")
		return
	}
	if req.Action == "answer" && strings.TrimSpace(req.Answer) == "" {
		s.sendError(c, "回答内容不能为空")
		return
	}
	v, ok := agentTasks.Load(req.TaskID)
	if !ok {
		s.sendError(c, "任务不存在或已结束")
		return
	}
	t := v.(*AgentTask)
	if t.Username != c.username { // 仅发起人可回答
		return
	}
	t.mu.Lock()
	ch := t.askCh
	step := t.askStep
	t.mu.Unlock()
	if ch == nil || step != req.Step { // 非等待态或迟到的回答直接忽略
		return
	}
	select {
	case ch <- &AgentApproval{Action: req.Action, Answer: req.Answer}:
	default:
	}
}

// HandleAgentPreview 工作区静态访问（阶段五十九：页面预览工具的前端支撑，iframe 加载工作区 HTML 等产物）。
// 鉴权与现有 HTTP 接口一致（query username，内网信任模式）；路径安全归口 agentSafePath，
// 仅允许访问本人工作区内的文件
func (s *Server) HandleAgentPreview(w http.ResponseWriter, r *http.Request) {
	username := strings.TrimSpace(r.URL.Query().Get("username"))
	if username == "" {
		http.Error(w, "缺少 username 参数", http.StatusBadRequest)
		return
	}
	p := strings.TrimSpace(r.URL.Query().Get("path"))
	full, err := agentSafePath(username, p)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		http.Error(w, "文件不存在", http.StatusNotFound)
		return
	}
	// ServeFile 自动处理 MIME/Range/缓存头；路径已归口校验不越界
	http.ServeFile(w, r, full)
}

// ===== 阶段六十四：Agent 任务历史查看 =====
// 用户端：查看本人任务分页列表与单任务详情（鉴权水位与 /api/agents 一致：username 查询参数）；
// 管理端：审计全部用户任务（adminGuard 保护，支持用户名/状态筛选）。
// 数据归口 im_agent_task（running 态即建行、结束态更新，任务全程可追溯）；
// 列表项 goal/result 截断防超长记录撑大响应，全文经详情接口获取。

// agentTaskListQuery 任务列表查询参数解析归口（用户端与管理端共用）：页码/条数/状态筛选
// 返回 (page, size, status)；status 为空表示不筛选
func agentTaskListQuery(r *http.Request) (int, int, string) {
	page := int(adminQueryUint(r.URL.Query().Get("page")))
	if page <= 0 {
		page = 1
	}
	size := int(adminQueryUint(r.URL.Query().Get("size")))
	if size <= 0 {
		size = 20
	}
	if size > 100 {
		size = 100
	}
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	return page, size, status
}

// agentTaskBrief 列表项构造归口：goal 截断 100 字、result 截断 300 字（全文走详情接口），
// 其余字段原样输出（含 update_time 供前端展示最近活动时间）
func agentTaskBrief(rows []model.AgentTaskRecord) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(rows))
	for _, r := range rows {
		out = append(out, map[string]interface{}{
			"task_id":      r.TaskID,
			"username":     r.Username,
			"agent_name":   r.AgentName,
			"goal":         truncateRunes(r.Goal, 100),
			"result":       truncateRunes(r.Result, 300),
			"error":        truncateRunes(r.Error, 200),
			"status":       r.Status,
			"steps":        r.Steps,
			"elapsed_ms":   r.ElapsedMs,                  // 阶段一百三十八：耗时随任务列表下发（重放卡 meta 展示）
			"points_cost":  aiPointsRound3(r.PointsCost), // 阶段一百三十八：实际扣费积分随任务列表下发；一百六十二：归一 3 位（存量记录可能带历史 double 误差长尾）
			"reply_msg_id": r.ReplyMsgID,
			"session_id":   r.SessionID,
			"create_time":  r.CreateTime,
			"update_time":  r.UpdateTime,
		})
	}
	return out
}

// HandleAgentTaskList 用户端任务历史分页列表（仅本人任务；status 可选筛选）
func (s *Server) HandleAgentTaskList(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	page, size, status := agentTaskListQuery(r)
	db := store.DB.Model(&model.AgentTaskRecord{}).Where("username = ?", username)
	if status != "" {
		db = db.Where("status = ?", status)
	}
	// 阶段七十：agent 过滤（会话内任务卡重放按智能体归口拉取，不掺其他会话任务）
	if ag := strings.TrimSpace(r.URL.Query().Get("agent")); ag != "" {
		db = db.Where("agent_name = ?", ag)
	}
	// 阶段七十一：会话过滤（任务卡重放按当前查看会话拉取；参数缺省=不过滤（任务历史弹窗全量），
	// 显式传 0=默认会话（未盖戳存量任务），防跨会话运行中任务卡串显）
	if r.URL.Query().Has("session_id") {
		db = db.Where("session_id = ?", adminQueryUint(r.URL.Query().Get("session_id")))
	}
	var total int64
	db.Count(&total)
	var rows []model.AgentTaskRecord
	db.Order("id DESC").Offset((page - 1) * size).Limit(size).Find(&rows)
	briefs := agentTaskBrief(rows)
	// 阶段七十九：用户端列表附待审查变更（仅有 pending 行的任务才带 changes 键，一次分组查询归口）。
	// 会话打开重放时即可点亮输入区上方"文件变更"审查页签，无需点开任务卡
	if len(rows) > 0 {
		ids := make([]string, 0, len(rows))
		for _, r := range rows {
			ids = append(ids, r.TaskID)
		}
		var chRows []model.AgentChangeRecord
		store.DB.Where("task_id IN ? AND status = ?", ids, "pending").Order("id ASC").Find(&chRows)
		if len(chRows) > 0 {
			byTask := map[string][]model.AgentChangeRecord{}
			for _, c := range chRows {
				byTask[c.TaskID] = append(byTask[c.TaskID], c)
			}
			for _, b := range briefs {
				if tid, _ := b["task_id"].(string); tid != "" {
					if cs := byTask[tid]; len(cs) > 0 {
						b["changes"] = cs
					}
				}
			}
		}
	}
	adminJSON(w, map[string]interface{}{
		"total": total, "page": page, "size": size,
		"tasks": briefs,
	})
}

// HandleAgentTaskDetail 用户端单任务详情（归属校验：仅本人任务可看，全文返回）。
// 阶段七十七：附 changes 文件变更记录（重放卡渲染审查条，pending 可操作）
func (s *Server) HandleAgentTaskDetail(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	taskID := strings.TrimSpace(r.PathValue("task_id"))
	var rec model.AgentTaskRecord
	if err := store.DB.Where("task_id = ? AND username = ?", taskID, username).First(&rec).Error; err != nil {
		adminFail(w, http.StatusNotFound, "任务不存在")
		return
	}
	// 保持原返回结构（记录字段平铺顶层）并追加 changes 键（前端旧解析不破坏）
	var changes []model.AgentChangeRecord
	store.DB.Where("task_id = ?", taskID).Order("id ASC").Find(&changes)
	data, _ := json.Marshal(rec)
	var body map[string]interface{}
	_ = json.Unmarshal(data, &body)
	body["changes"] = changes
	adminJSON(w, body)
}

// HandleAdminAgentTaskList 管理端全量任务审计列表（user 用户名模糊筛选 + status 精确筛选 + 分页）
func (s *Server) HandleAdminAgentTaskList(w http.ResponseWriter, r *http.Request) {
	page, size, status := agentTaskListQuery(r)
	user := strings.TrimSpace(r.URL.Query().Get("user"))
	db := store.DB.Model(&model.AgentTaskRecord{})
	if user != "" {
		db = db.Where("username LIKE ?", "%"+user+"%")
	}
	if status != "" {
		db = db.Where("status = ?", status)
	}
	var total int64
	db.Count(&total)
	var rows []model.AgentTaskRecord
	db.Order("id DESC").Offset((page - 1) * size).Limit(size).Find(&rows)
	adminJSON(w, map[string]interface{}{
		"total": total, "page": page, "size": size,
		"tasks": agentTaskBrief(rows),
	})
}

// HandleAdminAgentTaskDetail 管理端单任务详情（管理员权限，不做 username 限制，全文返回）
func (s *Server) HandleAdminAgentTaskDetail(w http.ResponseWriter, r *http.Request) {
	taskID := strings.TrimSpace(r.PathValue("task_id"))
	var rec model.AgentTaskRecord
	if err := store.DB.Where("task_id = ?", taskID).First(&rec).Error; err != nil {
		adminFail(w, http.StatusNotFound, "任务不存在")
		return
	}
	adminJSON(w, rec)
}

// ===== 阶段六十五：Agent 执行轨迹留痕 =====
// 每步工具调用即时落库 im_agent_step（免审/审批通过/拒绝/取消/超时各分支统一走 agentStepTrace 归口），
// 用户端/管理端均按任务维度拉取全量步骤（步数上限 agentMaxSteps 且摘要已截断，体积可控，不分页）

// HandleAgentTaskSteps 用户端单任务执行轨迹（归属校验：仅本人任务可看，按序号升序全量返回）
func (s *Server) HandleAgentTaskSteps(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	taskID := strings.TrimSpace(r.PathValue("task_id"))
	// 归属校验归口 im_agent_task：非本人任务一律 404（与详情接口同语义）
	var cnt int64
	store.DB.Model(&model.AgentTaskRecord{}).Where("task_id = ? AND username = ?", taskID, username).Count(&cnt)
	if cnt == 0 {
		adminFail(w, http.StatusNotFound, "任务不存在")
		return
	}
	var rows []model.AgentStepRecord
	store.DB.Where("task_id = ?", taskID).Order("seq ASC").Find(&rows)
	adminJSON(w, map[string]interface{}{"task_id": taskID, "total": len(rows), "steps": rows})
}

// HandleAdminAgentTaskSteps 管理端单任务执行轨迹（管理员权限，不做 username 限制）
func (s *Server) HandleAdminAgentTaskSteps(w http.ResponseWriter, r *http.Request) {
	taskID := strings.TrimSpace(r.PathValue("task_id"))
	var rows []model.AgentStepRecord
	store.DB.Where("task_id = ?", taskID).Order("seq ASC").Find(&rows)
	adminJSON(w, map[string]interface{}{"task_id": taskID, "total": len(rows), "steps": rows})
}
