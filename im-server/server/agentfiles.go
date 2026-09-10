package server

// 阶段七十六：Agent 工作区文件面板（Trae CN 同款——Agent 会话右侧文件树 + 高亮预览 + 手动编辑保存）
// 归口原则：文件面板与 Agent 工具同源执行环境——
//   PC 在线（本地执行器开启）：经 msg 64/65 转发到用户本地磁盘执行（与本地执行工具同一套 safePath 校验）；
//   PC 离线：回退服务端工作区（agentWorkspaceDir，按用户名隔离，agentSafePath 双保险防逃逸）。
// 相对路径 → 工作区根；绝对路径 → 仅 PC 在线时允许（落在沙箱授权目录内），服务端模式拒绝。
// 所有请求按 req_id 归属（web 上行 62 携带，下行 63 原样带回），PC 回传超时自动回退服务端。

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"

	"im-server/config"
	"im-server/logger"
	"im-server/protocol"
)

// 面板操作限额（防超长内容撑爆 WS 帧 / 防滥用）
const (
	wsFileReadMax    = 512 << 10        // 单次读文件上限 512KB（超出截断，编辑保存不受限但帧体过大由 WS 层兜底）
	wsFileReadB64Max = 2 << 20          // readb 二进制读上限 2MB（base64 后约 2.7MB，PC 65 上行需在 WS 读限 4MB 内；供 docx 预览等场景）
	wsFileOpTimeout  = 15 * time.Second // PC 文件操作回传等待上限（本地磁盘 IO 很快，超时视为 PC 无响应）
)

// wsFileEntry 文件树节点（一级目录条目）
type wsFileEntry struct {
	Name string `json:"name"`
	Dir  bool   `json:"dir"`
	Size int64  `json:"size,omitempty"`
}

// wsFileResult 文件操作统一结果
type wsFileResult struct {
	OK        bool          `json:"ok"`
	Error     string        `json:"error,omitempty"`
	Root      string        `json:"root,omitempty"`      // tree：工作区根展示名（PC=主工作区真实路径 / 服务端=服务器工作区）
	Entries   []wsFileEntry `json:"entries,omitempty"`   // tree：目录条目（子目录在前文件在后）
	Content   string        `json:"content,omitempty"`   // read：文本内容（二进制为空）
	Binary    bool          `json:"binary,omitempty"`    // read：二进制文件（不回传内容）
	Truncated bool          `json:"truncated,omitempty"` // read：内容超出上限被截断
}

// PC 文件操作挂起等待表（key: username|req_id → 回传通道）
var (
	wsFileMu    sync.Mutex
	wsFileWaits = make(map[string]chan *wsFileResult)
)

// wsFileSkipDirs 目录树跳过项（与执行器/服务端 list_dir 同一套噪音目录）
var wsFileSkipDirs = map[string]bool{
	".git": true, ".idea": true, ".vscode": true, "node_modules": true, "vendor": true,
	"__pycache__": true, "dist": true, "build": true, "bin": true, "obj": true, "target": true,
}

// handleWsFileReq 上行（msg 62）：web 文件面板请求归口（tree/read/save），结果经 63 回推
func (s *Server) handleWsFileReq(c *Client, msg *protocol.Message) {
	if c.username == "" {
		return
	}
	var req struct {
		Op      string `json:"op"`
		ReqID   string `json:"req_id"`
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &req); err != nil {
		logger.Warn("文件面板 62 帧解析失败（用户 %s）：%s", c.username, msg.Content)
		return
	}
	reqID := strings.TrimSpace(req.ReqID)
	if reqID == "" || reqID == " " {
		return
	}
	logger.Info("文件面板请求（用户 %s op %s path %q req_id %s PC在线 %v 执行器开关 %v）",
		c.username, req.Op, req.Path, reqID, s.hub.HasPC(c.username), agentPcExec.Load())
	// 阶段七十六修复：PC 回传等待最长 15s，绝不能同步卡在 readPump——
	// 否则本连接的 65 回传滞留 TCP 缓冲读不进来，必然"超时→回退→迟到丢弃"死循环
	// （实测全链 trace：64 下行 12ms 即达、渲染层 10ms 完成并回 65，唯独 65 上行滞后 15s）
	go func() {
		res := s.wsFileDispatch(c.username, reqID, req.Op, req.Path, req.Content)
		if !res.OK {
			logger.Warn("文件面板执行失败（用户 %s op %s）：%s", c.username, req.Op, res.Error)
		} else {
			logger.Info("文件面板执行完成（用户 %s op %s root %q 条目 %d 截断 %v 二进制 %v）",
				c.username, req.Op, res.Root, len(res.Entries), res.Truncated, res.Binary)
		}
		s.wsFileSendResp(c.username, req.Op, reqID, res)
	}()
}

// wsFileSendResp 下行 63 回推
func (s *Server) wsFileSendResp(username, op, reqID string, res *wsFileResult) {
	if res == nil {
		res = &wsFileResult{Error: "内部错误"}
	}
	data, _ := json.Marshal(map[string]interface{}{
		"op": op, "req_id": reqID, "ok": res.OK, "error": res.Error,
		"root": res.Root, "entries": res.Entries,
		"content": res.Content, "binary": res.Binary, "truncated": res.Truncated,
	})
	out, _ := json.Marshal(protocol.Message{
		MsgType: protocol.MsgTypeWsFileResp, FromUser: "系统", ToUser: username,
		Content: string(data), Timestamp: time.Now().Unix(),
	})
	s.sendToUser(username, out)
}

// wsCloneProgressSend 下行 63 进度中间帧（proj_clone 专用：同 req_id 多帧，前端仅更新进度 UI 不结束 Promise）
func (s *Server) wsCloneProgressSend(username, reqID string, pct int, stage, speed string, sent int64) {
	data, _ := json.Marshal(map[string]interface{}{
		"op": "proj_clone", "req_id": reqID, "type": "progress",
		"pct": pct, "stage": stage, "speed": speed, "sent": sent,
	})
	out, _ := json.Marshal(protocol.Message{
		MsgType: protocol.MsgTypeWsFileResp, FromUser: "系统", ToUser: username,
		Content: string(data), Timestamp: time.Now().Unix(),
	})
	s.sendToUser(username, out)
}

// wsFileDispatch 执行环境分派：PC 在线转发本地（64/65），离线/超时回退服务端工作区。
// 绝对路径是 PC 本地概念（沙箱授权目录），服务端回退模式不支持。
func (s *Server) wsFileDispatch(username, reqID, op, path, content string) *wsFileResult {
	if isAbsishPath(path) && !(agentPcExec.Load() && s.hub.HasPC(username)) {
		return &wsFileResult{Error: "本地绝对路径仅在 PC 端在线时可用（沙箱授权目录内）"}
	}
	if agentPcExec.Load() && s.hub.HasPC(username) && op != "gitai" {
		// gitai（AI 提交信息/审查）必须服务端执行：AI 模型服务归口服务端，PC 不参与
		if res := s.wsFileWaitPC(username, reqID, op, path, content, wsFileOpWaitFor(op)); res != nil {
			// 当前项目服务端归口：PC 执行 proj_* 成功后，服务端同步写元数据（提示词构建读服务端这份）
			if res.OK && (op == "proj_open" || op == "proj_clone") {
				wsProjTouch(username, wsProjNameFromContent(op, content))
				if op == "proj_clone" {
					wsProjRecentAdd(username, wsProjURLFromContent(content), wsProjNameFromContent(op, content))
				}
			}
			return res
		}
		logger.Warn("文件面板 PC 回传超时，回退服务端工作区（用户 %s op %s）", username, op)
		if isAbsishPath(path) {
			return &wsFileResult{Error: "PC 端无响应，本地绝对路径不可用"}
		}
	}
	// 克隆进度推送闭包：服务端流式克隆 → 63 中间帧实时下发（进度归口用户+req_id）
	var push wsProgressFn
	if op == "proj_clone" {
		push = func(pct int, stage, speed string, sent int64) {
			s.wsCloneProgressSend(username, reqID, pct, stage, speed, sent)
		}
	}
	return wsFileServerOp(username, reqID, op, path, content, push)
}

// wsProjNameFromContent 从 proj_* 请求 content 提取项目名（proj_open=proj 字段 / proj_clone=name 字段）
func wsProjNameFromContent(op, content string) string {
	var req struct {
		Proj string `json:"proj"`
		Name string `json:"name"`
	}
	_ = json.Unmarshal([]byte(content), &req)
	if op == "proj_open" {
		return strings.TrimSpace(req.Proj)
	}
	return strings.TrimSpace(req.Name)
}

// wsProjURLFromContent 从 proj_clone 请求 content 提取原始仓库地址（recents 记录用）
func wsProjURLFromContent(content string) string {
	var req struct {
		URL string `json:"url"`
	}
	_ = json.Unmarshal([]byte(content), &req)
	return strings.TrimSpace(req.URL)
}

// isAbsishPath 绝对路径判定（盘符/根分隔符，与 agentSafePath 口径一致）
func isAbsishPath(p string) bool {
	p = strings.TrimSpace(p)
	return filepath.IsAbs(p) || strings.Contains(p, ":") || strings.HasPrefix(p, "/") || strings.HasPrefix(p, `\`)
}

// wsFileWaitPC 转发 PC 并挂起等待回传（msg 64 下发，65 回传经 handlePcFileResp 投递）；超时返回 nil
// wait 上限按 op 区分：git push/pull 是网络操作（远端慢时可达分钟级），本地 IO 保持 15s
func (s *Server) wsFileWaitPC(username, reqID, op, path, content string, wait time.Duration) *wsFileResult {
	key := username + "|" + reqID
	ch := make(chan *wsFileResult, 1)
	wsFileMu.Lock()
	if _, dup := wsFileWaits[key]; dup {
		wsFileMu.Unlock()
		return &wsFileResult{Error: "请求重复发送"}
	}
	wsFileWaits[key] = ch
	wsFileMu.Unlock()
	defer func() {
		wsFileMu.Lock()
		delete(wsFileWaits, key)
		wsFileMu.Unlock()
	}()

	reqData, _ := json.Marshal(map[string]interface{}{"op": op, "req_id": reqID, "path": path, "content": content})
	out, _ := json.Marshal(protocol.Message{
		MsgType: protocol.MsgTypePcFileReq, FromUser: "系统", ToUser: username,
		Content: string(reqData), Timestamp: time.Now().Unix(),
	})
	s.sendToUser(username, out)
	logger.Info("文件面板转发 PC（用户 %s op %s req_id %s）", username, op, reqID)

	select {
	case res := <-ch:
		logger.Info("文件面板 PC 回传（用户 %s op %s req_id %s ok %v error %q root %q 条目 %d）",
			username, op, reqID, res.OK, res.Error, res.Root, len(res.Entries))
		return res
	case <-time.After(wait):
		logger.Warn("文件面板 PC 回传超时（用户 %s op %s req_id %s）", username, op, reqID)
		return nil
	}
}

// handlePcFileResp 上行（msg 65）：PC 本地文件操作结果投递（req_id 归属，迟到丢弃）
func (s *Server) handlePcFileResp(c *Client, msg *protocol.Message) {
	if c.username == "" {
		return
	}
	var req struct {
		Op      string        `json:"op"`
		ReqID   string        `json:"req_id"`
		OK      bool          `json:"ok"`
		Error   string        `json:"error"`
		Root    string        `json:"root"`
		Entries []wsFileEntry `json:"entries"`
		Content string        `json:"content"`
		Binary  bool          `json:"binary"`
		Trunc   bool          `json:"truncated"`
		Type    string        `json:"type"` // "progress"：克隆进度中间帧（同 req_id 多帧，不结束等待）
		Pct     int           `json:"pct"`
		Stage   string        `json:"stage"`
		Speed   string        `json:"speed"`
		Sent    int64         `json:"sent"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &req); err != nil || req.ReqID == "" {
		logger.Warn("文件面板 65 帧解析失败（用户 %s）：%s", c.username, msg.Content)
		return
	}
	// PC 克隆进度帧：原样转发 web（63 中间帧），不投递等待通道（最终帧才收口）
	if req.Type == "progress" {
		s.wsCloneProgressSend(c.username, req.ReqID, req.Pct, req.Stage, req.Speed, req.Sent)
		return
	}
	wsFileMu.Lock()
	ch, ok := wsFileWaits[c.username+"|"+req.ReqID]
	wsFileMu.Unlock()
	if !ok {
		logger.Warn("文件面板 65 迟到回传丢弃（用户 %s req_id %s）", c.username, req.ReqID)
		return // 迟到/不匹配回传直接丢弃
	}
	ch <- &wsFileResult{
		OK: req.OK, Error: req.Error, Root: req.Root, Entries: req.Entries,
		Content: req.Content, Binary: req.Binary, Truncated: req.Trunc,
	}
}

// wsFileServerOp 服务端工作区执行（PC 离线回退）；push 仅 proj_clone 使用（进度中间帧推送）
func wsFileServerOp(username, reqID, op, path, content string, push wsProgressFn) *wsFileResult {
	switch op {
	case "tree":
		return wsServerTree(username, path)
	case "read":
		return wsServerRead(username, path)
	case "readb":
		return wsServerReadB64(username, path)
	case "save":
		return wsServerSave(username, path, content)
	case "delete":
		return wsServerDelete(username, path)
	case "rename":
		return wsServerRename(username, path, content)
	case "newfile":
		return wsServerCreateEntry(username, path, content, false)
	case "newdir":
		return wsServerCreateEntry(username, path, content, true)
	case "reveal":
		// 打开所在目录依赖本地资源管理器（explorer /select），服务端工作区无此概念
		return &wsFileResult{Error: "打开所在目录仅 PC 客户端支持"}
	case "proj_list":
		// 项目列表：工作区一级子目录 + 当前项目 + 最近使用排序（TRAE「最近」同款）
		return wsProjList(username)
	case "proj_open":
		// 切换当前项目（content=JSON{proj}）：目录须存在，写元数据
		return wsProjOpen(username, content)
	case "proj_clone":
		// 克隆 Git 仓库到工作区子目录并自动切换（content=JSON{url,name,token}）：流式进度 + 可取消
		return wsProjClone(username, reqID, content, push)
	case "proj_clone_cancel":
		// 取消运行中克隆（content=JSON{target:克隆请求的 req_id}）：kill 进程 + 清理半成品目录
		return wsProjCloneCancel(username, content)
	case "git":
		// 源代码管理：git 子命令执行（status/add/unstage/discard/commit/push/pull/init/diff）
		return wsServerGit(username, content)
	case "gitai":
		// 源代码管理 AI（提交信息生成 / 智能体审查）：模型服务归口服务端，diff 由前端收集上行
		return wsServerGitAI(username, content)
	}
	return &wsFileResult{Error: "未知操作"}
}

// wsFileOpWaitFor PC 回传等待上限按 op 区分：git push/pull 走网络（远端慢时可达分钟级）放宽到 130s，
// proj_clone 大仓库克隆可达分钟级放宽到 610s（须 ≥ PC 端克隆超时，否则超时回退会双执行），其余保持 15s
func wsFileOpWaitFor(op string) time.Duration {
	if op == "proj_clone" {
		return 610 * time.Second
	}
	if op == "git" {
		return 130 * time.Second
	}
	return wsFileOpTimeout
}

// wsGitMaxOutput 单次 git 命令输出截断上限（diff 大文件防帧体爆炸）
const wsGitMaxOutput = 512 << 10

// wsGitReq 前端 git 请求体（content 为 JSON）
type wsGitReq struct {
	Sub    string   `json:"sub"`              // status/diff/diffhead/diffcached/diffrev/add/unstage/discard/commit/push/pushu/remoteadd/remoteurl/remoteseturl/pull/init/log/show/branches
	Paths  []string `json:"paths,omitempty"`  // add/unstage/discard 目标
	Path   string   `json:"path,omitempty"`   // diff 目标 / show 的提交 hash
	Msg    string   `json:"msg,omitempty"`    // commit 信息
	Branch string   `json:"branch,omitempty"` // log 未推送判定的当前分支 / push 无上游兜底
	Target string   `json:"target,omitempty"` // diffrev 审查目标分支
	Proj   string   `json:"proj,omitempty"`   // 当前项目（工作区子目录名）；空=工作区根本身
	Amend  bool     `json:"amend,omitempty"`  // commit 追加模式（--amend 覆盖上一次提交）
	Staged bool     `json:"staged,omitempty"` // discard 已暂存变更：checkout HEAD --（staged 删除/改名旧路径在 index 中已不存在，checkout -- 必报 pathspec 不匹配）
}

// wsGitBuildArgs 子命令 → git 参数与超时（PC 执行器与服务端同一张映射表口径）
func wsGitBuildArgs(r *wsGitReq) ([]string, time.Duration, error) {
	switch r.Sub {
	case "status":
		return []string{"status", "--porcelain=v1", "-b"}, 20 * time.Second, nil
	case "diff":
		if strings.TrimSpace(r.Path) == "" {
			return nil, 0, errors.New("缺少差异文件路径")
		}
		return []string{"diff", "HEAD", "--", r.Path}, 20 * time.Second, nil
	case "add":
		if len(r.Paths) == 0 {
			return nil, 0, errors.New("缺少暂存目标")
		}
		return append([]string{"add", "--"}, r.Paths...), 30 * time.Second, nil
	case "unstage":
		if len(r.Paths) == 0 {
			return nil, 0, errors.New("缺少取消暂存目标")
		}
		return append([]string{"reset", "-q", "HEAD", "--"}, r.Paths...), 30 * time.Second, nil
	case "discard":
		if len(r.Paths) == 0 {
			return nil, 0, errors.New("缺少放弃目标")
		}
		if r.Staged {
			// 已暂存变更放弃：从 HEAD 恢复索引+工作树。staged 删除（D_）/改名旧路径在 index 中已不存在，
			// checkout -- <p> 从 index 恢复会报 pathspec 不匹配（实测）；HEAD 版本仍可恢复
			return append([]string{"checkout", "-q", "HEAD", "--"}, r.Paths...), 30 * time.Second, nil
		}
		return append([]string{"checkout", "-q", "--"}, r.Paths...), 30 * time.Second, nil
	case "commit":
		if strings.TrimSpace(r.Msg) == "" {
			return nil, 0, errors.New("请填写提交信息")
		}
		args := []string{"commit", "-q", "-m", r.Msg}
		if r.Amend {
			args = append(args, "--amend")
		}
		return args, 60 * time.Second, nil
	case "diffhead":
		// 全部跟踪文件的工作区变更（AI 提交信息源）
		return []string{"diff", "HEAD"}, 30 * time.Second, nil
	case "diffcached":
		// 暂存区变更（AI 提交信息优先数据源）
		return []string{"diff", "--cached"}, 30 * time.Second, nil
	case "diffrev":
		// 分支审查：目标分支...HEAD 三点 diff（merge-base 以来的变更）
		if strings.TrimSpace(r.Target) == "" {
			return nil, 0, errors.New("请选择审查目标分支")
		}
		return []string{"diff", r.Target + "...HEAD"}, 60 * time.Second, nil
	case "log":
		// 提交历史（近 30 条，\x1f 分段防止字段内分隔符冲突）
		return []string{"log", "-30", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%at"}, 30 * time.Second, nil
	case "show":
		if strings.TrimSpace(r.Path) == "" {
			return nil, 0, errors.New("缺少提交 hash")
		}
		return []string{"show", r.Path, "--no-color", "--format=__META__%H%x1f%h%x1f%s%x1f%an%x1f%at"}, 30 * time.Second, nil
	case "branches":
		// 本地 + 远端跟踪分支：审查目标可选 origin/xxx（三点 diff origin/main...HEAD 合法口径）；
		// --format 输出全名，branches 响应段归一为短名并剔除裸 remote 容器（refs/remotes/origin）
		return []string{"for-each-ref", "refs/heads", "refs/remotes", "--format=%(refname)"}, 20 * time.Second, nil
	case "untracked":
		// 未跟踪文件全量清单（-z NUL 分隔防文件名含空格/引号解析错位）：
		// git status 会把整个未跟踪目录折叠为 "dir/"，前端用它展开目录内的具体文件
		return []string{"ls-files", "--others", "--exclude-standard", "-z"}, 20 * time.Second, nil
	case "push":
		return []string{"push"}, 120 * time.Second, nil
	case "pushu":
		// 无上游分支的兜底推送：git push -u origin <branch>
		if strings.TrimSpace(r.Branch) == "" {
			return nil, 0, errors.New("缺少分支名")
		}
		return []string{"push", "-u", "origin", r.Branch}, 120 * time.Second, nil
	case "remoteadd":
		// 关联远程仓库（面板推送引导闭环）：git remote add origin <url>，url 走 Target 字段
		if strings.TrimSpace(r.Target) == "" {
			return nil, 0, errors.New("请填写远程仓库地址")
		}
		return []string{"remote", "add", "origin", r.Target}, 20 * time.Second, nil
	case "remoteurl":
		// 读当前远程地址（未关联 origin 时 git 报 "No such remote"，前端静默视为未关联）
		return []string{"remote", "get-url", "origin"}, 20 * time.Second, nil
	case "remoteseturl":
		// 修改远程地址：git remote set-url origin <新url>
		if strings.TrimSpace(r.Target) == "" {
			return nil, 0, errors.New("请填写远程仓库地址")
		}
		return []string{"remote", "set-url", "origin", r.Target}, 20 * time.Second, nil
	case "pull":
		return []string{"pull", "--no-edit"}, 120 * time.Second, nil
	case "init":
		return []string{"init", "-q"}, 30 * time.Second, nil
	}
	return nil, 0, errors.New("未知 git 子命令")
}

// wsGitExec 在 dir 下执行 git 子命令（超时控制 + 输出截断），返回 (输出, 失败错误)
func wsGitExec(dir string, args []string, timeout time.Duration) (string, error) {
	if _, err := exec.LookPath("git"); err != nil {
		return "", errors.New("未检测到 git，请先安装 Git 并加入 PATH")
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	// core.quotepath=off：中文/非 ASCII 文件名原样输出（与 PC 执行器同款前缀，双端口径一致）
	fullArgs := append([]string{"-c", "core.quotepath=off"}, args...)
	cmd := exec.CommandContext(ctx, "git", fullArgs...)
	// GIT_CEILING_DIRECTORIES 防护（阶段八十一）：git 默认向上搜索父目录 .git，服务端工作区根
	// 不是仓库时会窜到宿主目录的仓库（如部署目录本身是 git 仓库），面板显示无关变更造成误导。
	// 以工作区根为搜索上限阻断越界；工作区根自身的 .git 与项目子目录仓库（repo_ui）不受影响。
	// 兜底：agentWorkRoot 未初始化（如测试环境）时用 dir 父目录，保证 ceiling 恒为非空绝对路径
	ceil := agentWorkRoot
	if ceil == "" {
		ceil = filepath.Dir(dir)
	}
	cmd.Env = append(os.Environ(), "GIT_CEILING_DIRECTORIES="+ceil)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if len(out) > wsGitMaxOutput {
		out = out[:wsGitMaxOutput]
	}
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		return "", errors.New(msg)
	}
	return string(out), nil
}

// wsGitStatusParse 解析 git status --porcelain=v1 -b 输出：
// 首行 "## main...origin/main [ahead 1, behind 2]" → 分支/上游/领先落后；其余 XY 行 → 变更条目；
// 全新仓库（无任何提交）输出 "## No commits yet on master"，末段才是真实分支名（noCommits=true 供前端提示）
func wsGitStatusParse(out string) (branch, upstream string, ahead, behind int, noCommits bool, changes []map[string]string) {
	for _, ln := range strings.Split(out, "\n") {
		ln = strings.TrimRight(ln, "\r")
		if ln == "" {
			continue
		}
		if strings.HasPrefix(ln, "## ") {
			b := strings.TrimPrefix(ln, "## ")
			if strings.HasPrefix(b, "HEAD (no branch)") {
				branch = "(游离 HEAD)"
				continue
			}
			if m := strings.TrimSpace(strings.TrimPrefix(b, "No commits yet on ")); m != b && m != "" {
				branch = m
				noCommits = true
				continue
			}
			if j := strings.Index(b, "..."); j >= 0 {
				branch = b[:j]
				rest := b[j+3:]
				if k := strings.IndexAny(rest, " ["); k >= 0 {
					upstream = rest[:k]
				} else {
					upstream = rest
				}
			} else if b != "" {
				branch = b // 无上游分支
			}
			if s := strings.Index(b, "["); s >= 0 {
				e := strings.Index(b, "]")
				if e > s {
					for _, part := range strings.Split(b[s+1:e], ",") {
						f := strings.Fields(strings.TrimSpace(part))
						if len(f) == 2 {
							if n, err := strconv.Atoi(f[1]); err == nil {
								if f[0] == "ahead" {
									ahead = n
								} else if f[0] == "behind" {
									behind = n
								}
							}
						}
					}
				}
			}
			continue
		}
		if len(ln) < 4 {
			continue
		}
		x, y := string(ln[0]), string(ln[1])
		if x == "!" && y == "!" {
			continue // .gitignore 忽略项不展示
		}
		changes = append(changes, map[string]string{"p": ln[3:], "x": x, "y": y})
	}
	return branch, upstream, ahead, behind, noCommits, changes
}

// wsGitResultPack git 结果统一打包（ok 帧内 JSON：错误也在内容里，前端按 error 字段分支提示）
func wsGitResultPack(payload map[string]interface{}) *wsFileResult {
	payload["git"] = true
	b, _ := json.Marshal(payload)
	return &wsFileResult{OK: true, Content: string(b)}
}

// wsGitErrorHint 常见 git 失败场景中文引导（与服务端/执行器同口径）：身份未配置 / 远程未配置
func wsGitErrorHint(msg, sub string) string {
	low := strings.ToLower(msg)
	if strings.Contains(low, "tell me who you are") || strings.Contains(low, "user.name") {
		return msg + "\n—— 请先在终端配置 git 身份（全局一次即可）：\n" +
			"git config --global user.name \"你的名字\"\n" +
			"git config --global user.email \"你的邮箱@example.com\""
	}
	if sub == "push" || sub == "pushu" || sub == "pull" {
		for _, kw := range []string{
			"does not appear to be a git repository", "no configured push destination",
			"could not read from remote repository", "repository does not exist",
		} {
			if strings.Contains(low, kw) {
				return msg + "\n—— 仓库尚未关联远程地址，请先执行：\n" +
					"git remote add origin https://github.com/用户名/仓库名.git"
			}
		}
	}
	if sub == "remoteadd" && strings.Contains(low, "already exists") {
		return msg + "\n—— 已关联过远程地址，如需修改请执行：\n" +
			"git remote set-url origin 新地址"
	}
	return msg
}

// wsServerGit 服务端工作区 git 执行（PC 离线回退；服务器需安装 git）
func wsServerGit(username, content string) *wsFileResult {
	ws, err := agentWorkspaceDir(username)
	if err != nil {
		return &wsFileResult{Error: err.Error()}
	}
	var r wsGitReq
	if err := json.Unmarshal([]byte(content), &r); err != nil {
		return &wsFileResult{Error: "git 请求解析失败"}
	}
	// 项目根归口：带 proj 时 git 的 cwd 指向工作区子目录（agentSafePath 防穿越）
	base := ws
	if proj := strings.TrimSpace(r.Proj); proj != "" {
		p, perr := agentSafePath(username, proj)
		if perr != nil || !wsProjDirExists(p) {
			return &wsFileResult{Error: "项目目录不存在"}
		}
		base = p
	}
	args, timeout, err := wsGitBuildArgs(&r)
	if err != nil {
		return &wsFileResult{Error: err.Error()}
	}
	out, gerr := wsGitExec(base, args, timeout)
	if gerr != nil {
		// status 下"不是仓库"是常态（引导初始化），不算失败
		if r.Sub == "status" && strings.Contains(gerr.Error(), "not a git repository") {
			return wsGitResultPack(map[string]interface{}{"sub": "status", "repo": false})
		}
		// 放弃变更降级：checkout -- 从 index 恢复，但 staged 删除/改名旧路径 index 中已无该文件，
		// 必报 pathspec 不匹配（实测 Developer 场景）——自动改从 HEAD 恢复重试一次
		if r.Sub == "discard" && !r.Staged && strings.Contains(gerr.Error(), "did not match any file(s) known to git") {
			if retry, rerr := wsGitExec(base, append([]string{"checkout", "-q", "HEAD", "--"}, r.Paths...), 30*time.Second); rerr == nil {
				out = retry
				gerr = nil
			}
		}
		if gerr != nil {
			msg := wsGitErrorHint(gerr.Error(), r.Sub)
			// staged 放弃对 HEAD 中不存在的文件（暂存的新增 A_）必失败：引导先取消暂存（不做自动删文件的危险动作）
			if r.Sub == "discard" && r.Staged && strings.Contains(gerr.Error(), "did not match any file(s) known to git") {
				msg += "\n—— 该文件在上次提交中不存在（暂存的新增文件）：请先「取消暂存」，再在更改区处理或通过文件树删除"
			}
			return wsGitResultPack(map[string]interface{}{"sub": r.Sub, "error": msg})
		}
	}
	switch r.Sub {
	case "status":
		branch, upstream, ahead, behind, noCommits, changes := wsGitStatusParse(out)
		return wsGitResultPack(map[string]interface{}{
			"sub": "status", "repo": true, "branch": branch, "upstream": upstream,
			"ahead": ahead, "behind": behind, "no_commits": noCommits, "changes": changes,
		})
	case "log":
		commits := wsGitLogParse(out)
		// 未推送集合：origin/<branch>..HEAD 可解析则逐条标记；无上游/报错=全部未推送
		if r.Branch != "" {
			un, uerr := wsGitExec(base, []string{"log", "origin/" + r.Branch + "..HEAD", "--format=%H"}, 30*time.Second)
			if uerr != nil {
				for _, c := range commits {
					c["un"] = true
				}
			} else {
				pushed := map[string]bool{}
				for _, ln := range strings.Split(un, "\n") {
					ln = strings.TrimSpace(ln)
					if ln != "" {
						pushed[ln] = true
					}
				}
				for _, c := range commits {
					c["un"] = !pushed[c["h"].(string)]
				}
			}
		} else {
			for _, c := range commits {
				c["un"] = true
			}
		}
		return wsGitResultPack(map[string]interface{}{"sub": "log", "commits": commits})
	case "show":
		// 首行 __META__ 头拆出提交元信息，其余为 diff 正文
		meta, rest := wsGitShowSplit(out)
		return wsGitResultPack(map[string]interface{}{"sub": "show", "meta": meta, "diff": rest})
	case "branches":
		// --format 全名输出（refs/heads/master、refs/remotes/origin/main），此处归一为短名：
		// 本地分支直接剥前缀；远端须两层以上（origin/xxx）——裸 remote 容器（refs/remotes/origin，
		// 本地 push 后 fetch 前会出现）不是分支，diff 无意义，剔除
		list := []string{}
		for _, ln := range strings.Split(out, "\n") {
			ln = strings.TrimSpace(ln)
			switch {
			case strings.HasPrefix(ln, "refs/heads/"):
				list = append(list, strings.TrimPrefix(ln, "refs/heads/"))
			case strings.HasPrefix(ln, "refs/remotes/"):
				short := strings.TrimPrefix(ln, "refs/remotes/")
				if strings.Contains(short, "/") {
					list = append(list, short)
				}
			}
		}
		return wsGitResultPack(map[string]interface{}{"sub": "branches", "list": list})
	case "untracked":
		files := []string{}
		for _, f := range strings.Split(out, "\x00") {
			// 不 TrimSpace：文件名可能合法含首尾空格，仅过滤 NUL 分隔产生的空段
			if f != "" {
				files = append(files, f)
			}
		}
		return wsGitResultPack(map[string]interface{}{"sub": "untracked", "files": files})
	case "diff", "diffhead", "diffcached", "diffrev":
		return wsGitResultPack(map[string]interface{}{"sub": "diff", "diff": out})
	default:
		return wsGitResultPack(map[string]interface{}{"sub": r.Sub, "output": strings.TrimSpace(out)})
	}
}

// wsGitLogParse 提交历史解析：%H\x1f%h\x1f%s\x1f%an\x1f%at 每提交一行，首条标记 HEAD
func wsGitLogParse(out string) []map[string]interface{} {
	commits := []map[string]interface{}{}
	for i, ln := range strings.Split(out, "\n") {
		ln = strings.TrimRight(ln, "\r")
		if ln == "" {
			continue
		}
		f := strings.Split(ln, "\x1f")
		if len(f) < 5 {
			continue
		}
		at, _ := strconv.ParseInt(f[4], 10, 64)
		commits = append(commits, map[string]interface{}{
			"h": f[0], "sh": f[1], "msg": f[2], "an": f[3], "at": at, "head": i == 0,
		})
	}
	return commits
}

// wsGitShowSplit git show 输出拆分：首行 __META__\x1f 分段（hash/短hash/主题/作者/时间），其余为 diff
func wsGitShowSplit(out string) (map[string]interface{}, string) {
	out = strings.TrimPrefix(out, "__META__")
	idx := strings.Index(out, "\n")
	if idx < 0 {
		return map[string]interface{}{}, out
	}
	f := strings.Split(out[:idx], "\x1f")
	meta := map[string]interface{}{}
	if len(f) >= 5 {
		at, _ := strconv.ParseInt(f[4], 10, 64)
		meta = map[string]interface{}{"h": f[0], "sh": f[1], "msg": f[2], "an": f[3], "at": at}
	}
	return meta, strings.TrimPrefix(out[idx+1:], "\n")
}

// ===== 源代码管理 AI（提交信息生成 / 智能体审查）：模型服务归口服务端 =====

// wsGitAIMaxDiff 上行 diff 截断上限（字符）：防 token 爆炸，超长截断并注明
const wsGitAIMaxDiff = 32000

// wsGitAIReq gitai 请求体
type wsGitAIReq struct {
	Mode   string `json:"mode"`             // commitmsg=生成提交信息 / review=分支审查报告
	Diff   string `json:"diff"`             // 前端收集的 diff 内容
	Target string `json:"target,omitempty"` // review 目标分支
}

// wsGitAIMsgClean 提交信息清洗：去代码块围栏/引号/换行，压成一行，限长
func wsGitAIMsgClean(s string) string {
	s = strings.NewReplacer("\r", " ", "\n", " ", "`", "", "\"", "", "'", "", "；", "; ", "。", ".").Replace(s)
	s = strings.Join(strings.Fields(s), " ")
	if s != "" && s[0] == ' ' {
		s = strings.TrimSpace(s)
	}
	if r := []rune(s); len(r) > 110 {
		s = string(r[:110]) + "…"
	}
	return s
}

// wsServerGitAI AI 提交信息/审查报告生成（复用聊天同源模型服务；取首个可用 provider）
func wsServerGitAI(username, content string) *wsFileResult {
	var r wsGitAIReq
	if err := json.Unmarshal([]byte(content), &r); err != nil {
		return &wsFileResult{Error: "gitai 请求解析失败"}
	}
	diff := r.Diff
	if diff == "" {
		return &wsFileResult{Error: "缺少 diff 内容"}
	}
	if len(diff) > wsGitAIMaxDiff {
		diff = diff[:wsGitAIMaxDiff] + "\n…（diff 过长已截断）"
	}
	aiMu.RLock()
	var prov *config.AIProviderConfig
	for _, a := range aiAgents {
		if a.Provider != nil {
			prov = a.Provider
			break
		}
	}
	aiMu.RUnlock()
	if prov == nil {
		return &wsFileResult{Error: "服务端尚未配置模型服务（AI providers），无法使用智能提交信息/审查"}
	}
	var sys string
	if r.Mode == "review" {
		sys = "你是资深代码审查员。审查给出的分支变更 diff（相对目标分支 " + strings.TrimSpace(r.Target) +
			" 的三点差异），输出 Markdown 审查报告，结构：## 变更总结（3-6 条要点，逐条概述改了什么、为什么）、" +
			"## 潜在问题（按严重程度列出，含位置与原因；确无问题则写\"未发现明显问题\"）、## 改进建议（可执行的具体建议）。全中文，简洁专业。"
	} else {
		sys = "你是提交信息生成助手。根据 git diff 生成一条符合 Conventional Commits 规范的中文提交信息：" +
			"格式为 type(scope): 描述，type 从 feat/fix/refactor/style/docs/test/chore/perf 中选择，scope 可省略；" +
			"描述概括本次变更的核心内容与目的。只输出这一行文本，不要任何解释、引号或代码块标记。"
	}
	agent := &AIRunAgent{Name: "Git助手", Provider: prov}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()
	text, _, err := aiStreamChat(ctx, agent, []aiChatMessage{
		{Role: "system", Content: sys},
		{Role: "user", Content: "git diff:\n```\n" + diff + "\n```"},
	}, func(string) {})
	if err != nil {
		return &wsFileResult{Error: "AI 调用失败：" + err.Error()}
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return &wsFileResult{Error: "AI 未返回内容，请稍后重试"}
	}
	if r.Mode == "commitmsg" {
		text = wsGitAIMsgClean(text)
	}
	return wsGitResultPack(map[string]interface{}{"mode": r.Mode, "text": text})
}

// wsServerTree 列目录（相对路径解析到用户工作区，agentSafePath 防 .. 逃逸；路径为空=根目录）
func wsServerTree(username, path string) *wsFileResult {
	full, root, err := wsServerResolve(username, path)
	if err != nil {
		return &wsFileResult{Error: err.Error()}
	}
	items, err := os.ReadDir(full)
	if err != nil {
		return &wsFileResult{Error: "无法读取目录：" + err.Error()}
	}
	entries := make([]wsFileEntry, 0, len(items))
	for _, it := range items {
		if it.IsDir() {
			if wsFileSkipDirs[it.Name()] {
				continue
			}
			entries = append(entries, wsFileEntry{Name: it.Name(), Dir: true})
			continue
		}
		var size int64
		if info, err := it.Info(); err == nil {
			size = info.Size()
		}
		entries = append(entries, wsFileEntry{Name: it.Name(), Size: size})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Dir != entries[j].Dir {
			return entries[i].Dir // 子目录在前
		}
		return entries[i].Name < entries[j].Name
	})
	return &wsFileResult{OK: true, Root: root, Entries: entries}
}

// wsServerRead 读文本文件（512KB 截断；NUL 判二进制；非 UTF-8 按 GBK 兜底转码，与服务端 read_file 同语义）
func wsServerRead(username, path string) *wsFileResult {
	full, _, err := wsServerResolve(username, path)
	if err != nil {
		return &wsFileResult{Error: err.Error()}
	}
	info, err := os.Stat(full)
	if err != nil {
		return &wsFileResult{Error: "文件不存在或无法访问"}
	}
	if info.IsDir() {
		return &wsFileResult{Error: "目标是目录，请展开浏览"}
	}
	f, err := os.Open(full)
	if err != nil {
		return &wsFileResult{Error: "读取失败：" + err.Error()}
	}
	defer f.Close()
	buf := make([]byte, wsFileReadMax)
	n, _ := f.Read(buf)
	data := buf[:n]
	truncated := info.Size() > int64(n)
	headLen := n
	if headLen > 8000 {
		headLen = 8000
	}
	if n > 0 && bytes.IndexByte(data[:headLen], 0) >= 0 {
		return &wsFileResult{OK: true, Binary: true, Truncated: truncated}
	}
	text := string(data)
	if n > 0 && !utf8.Valid(data) {
		if dec, err := simplifiedchinese.GB18030.NewDecoder().String(text); err == nil {
			text = dec
		}
	}
	return &wsFileResult{OK: true, Content: text, Truncated: truncated}
}

// wsServerReadB64 读二进制文件转 base64（≤2MB，供 docx 等文档前端解析预览；Binary 标记二进制模式）
func wsServerReadB64(username, path string) *wsFileResult {
	full, _, err := wsServerResolve(username, path)
	if err != nil {
		return &wsFileResult{Error: err.Error()}
	}
	info, err := os.Stat(full)
	if err != nil {
		return &wsFileResult{Error: "文件不存在或无法访问"}
	}
	if info.IsDir() {
		return &wsFileResult{Error: "目标是目录，请展开浏览"}
	}
	if info.Size() > int64(wsFileReadB64Max) {
		return &wsFileResult{Error: "文档过大（超过 2MB），暂不支持预览"}
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return &wsFileResult{Error: "读取失败：" + err.Error()}
	}
	return &wsFileResult{OK: true, Binary: true, Content: base64.StdEncoding.EncodeToString(data)}
}

// wsServerSave 写文件（自动建父目录；UTF-8 落盘，与执行器 write_file 同语义）
func wsServerSave(username, path, content string) *wsFileResult {
	full, _, err := wsServerResolve(username, path)
	if err != nil {
		return &wsFileResult{Error: err.Error()}
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return &wsFileResult{Error: "创建目录失败：" + err.Error()}
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		return &wsFileResult{Error: "保存失败：" + err.Error()}
	}
	return &wsFileResult{OK: true}
}

// wsEntryName 校验新建/重命名的名字：仅取末段文件名，禁路径分隔符、..、Windows 非法字符与控制字符
func wsEntryName(name string) (string, bool) {
	name = strings.TrimSpace(strings.ReplaceAll(name, "\\", "/"))
	if i := strings.LastIndex(name, "/"); i >= 0 {
		name = name[i+1:]
	}
	if name == "" || name == "." || name == ".." {
		return "", false
	}
	if strings.ContainsAny(name, `<>:"|?*`) || strings.ContainsFunc(name, func(r rune) bool { return r < 0x20 }) {
		return "", false
	}
	return name, true
}

// wsServerDelete 删除文件/目录（递归，工作区内）：根目录一律拒绝
func wsServerDelete(username, path string) *wsFileResult {
	if strings.TrimSpace(path) == "" {
		return &wsFileResult{Error: "不能删除工作区根目录"}
	}
	full, _, err := wsServerResolve(username, path)
	if err != nil {
		return &wsFileResult{Error: err.Error()}
	}
	if _, err := os.Stat(full); err != nil {
		return &wsFileResult{Error: "文件不存在或无法访问"}
	}
	if err := os.RemoveAll(full); err != nil {
		return &wsFileResult{Error: "删除失败：" + err.Error()}
	}
	logger.Info("工作区删除（用户 %s：%s）", username, path)
	return &wsFileResult{OK: true}
}

// wsServerRename 重命名（仅本级改名，content=新名称；不跨目录移动）：目标名冲突拒绝
func wsServerRename(username, path, newName string) *wsFileResult {
	if strings.TrimSpace(path) == "" {
		return &wsFileResult{Error: "不能重命名工作区根目录"}
	}
	newName, ok := wsEntryName(newName)
	if !ok {
		return &wsFileResult{Error: "名称非法（不能包含路径分隔符与 <>:\"|?* 等字符）"}
	}
	full, _, err := wsServerResolve(username, path)
	if err != nil {
		return &wsFileResult{Error: err.Error()}
	}
	if _, err := os.Lstat(full); err != nil {
		return &wsFileResult{Error: "文件不存在或无法访问"}
	}
	dst := filepath.Join(filepath.Dir(full), newName)
	if _, err := os.Lstat(dst); err == nil {
		return &wsFileResult{Error: "同名文件已存在"}
	}
	if err := os.Rename(full, dst); err != nil {
		return &wsFileResult{Error: "重命名失败：" + err.Error()}
	}
	logger.Info("工作区重命名（用户 %s：%s -> %s）", username, path, newName)
	return &wsFileResult{OK: true}
}

// wsServerCreateEntry 新建文件/目录（path=父级目录，content=名称）
func wsServerCreateEntry(username, path, name string, dir bool) *wsFileResult {
	name, ok := wsEntryName(name)
	if !ok {
		return &wsFileResult{Error: "名称非法（不能包含路径分隔符与 <>:\"|?* 等字符）"}
	}
	full, _, err := wsServerResolve(username, path)
	if err != nil {
		return &wsFileResult{Error: err.Error()}
	}
	if info, err := os.Stat(full); err != nil || !info.IsDir() {
		return &wsFileResult{Error: "父目录不存在或不是目录"}
	}
	dst := filepath.Join(full, name)
	if _, err := os.Lstat(dst); err == nil {
		return &wsFileResult{Error: "同名文件已存在"}
	}
	if dir {
		if err := os.Mkdir(dst, 0o755); err != nil {
			return &wsFileResult{Error: "创建目录失败：" + err.Error()}
		}
	} else {
		f, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err != nil {
			return &wsFileResult{Error: "创建文件失败：" + err.Error()}
		}
		f.Close()
	}
	kind := "文件"
	if dir {
		kind = "目录"
	}
	logger.Info("工作区新建%s（用户 %s：%s/%s）", kind, username, path, name)
	return &wsFileResult{OK: true}
}

// wsServerResolve 面板路径解析：空=工作区根；否则 agentSafePath（拒绝绝对路径与 .. 逃逸）
// 返回 (盘上绝对路径, 工作区展示名, 错误)
func wsServerResolve(username, path string) (string, string, error) {
	ws, err := agentWorkspaceDir(username)
	if err != nil {
		return "", "", err
	}
	root := "服务器工作区"
	if path == "" || path == "." || path == "/" {
		return ws, root, nil
	}
	full, err := agentSafePath(username, path)
	if err != nil {
		return "", "", err
	}
	return full, root, nil
}

// min 整数较小值（Go 版本内建 min 不可用时的兜底）
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// ===== 项目体系（TRAE「打开文件夹/克隆 Git 仓库/最近」同款）=====
// 项目 = 工作区根下的一个子目录（一个仓库一个项目）。文件树根/请求 path 天然以 proj 为前缀，
// 服务端只需归口三件事：项目元数据（当前项目+最近使用）、git 的 -C 指向、克隆/列表/切换 op。

// wsProjMeta 项目元数据（持久化于工作区根 .im_proj.json，PC/服务端工作区同构）
type wsProjMeta struct {
	Cur     string           `json:"cur"`
	TS      map[string]int64 `json:"ts"`
	Recents []wsProjRecent   `json:"recents,omitempty"` // 最近克隆历史（去凭证 URL，弹窗回填用）
}

// wsProjRecent 最近克隆条目（P1：克隆弹窗「最近克隆」回填）
type wsProjRecent struct {
	URL  string `json:"url"`
	Name string `json:"name"`
	TS   int64  `json:"ts"`
}

func wsProjMetaPath(username string) (string, error) {
	ws, err := agentWorkspaceDir(username)
	if err != nil {
		return "", err
	}
	return filepath.Join(ws, ".im_proj.json"), nil
}

func wsProjMetaLoad(username string) *wsProjMeta {
	m := &wsProjMeta{TS: map[string]int64{}}
	p, err := wsProjMetaPath(username)
	if err == nil {
		if data, rerr := os.ReadFile(p); rerr == nil {
			_ = json.Unmarshal(data, m)
		}
	}
	if m.TS == nil {
		m.TS = map[string]int64{}
	}
	return m
}

func wsProjMetaSave(username string, m *wsProjMeta) {
	p, err := wsProjMetaPath(username)
	if err != nil {
		return
	}
	data, _ := json.Marshal(m)
	_ = os.WriteFile(p, data, 0o644)
}

// wsProjTouch 更新项目最近使用时间并把 cur 设为该项目（proj 空串=回到工作区根，cur 置空）
func wsProjTouch(username, proj string) {
	m := wsProjMetaLoad(username)
	m.Cur = strings.TrimSpace(proj)
	if m.Cur != "" {
		m.TS[m.Cur] = time.Now().Unix()
	}
	wsProjMetaSave(username, m)
}

func wsProjDirExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

// wsProjValidName 克隆目录名合法性：禁路径分隔符/.. 与盘符（目录名不是路径）
func wsProjValidName(name string) bool {
	if name == "" || len(name) > 100 {
		return false
	}
	if strings.ContainsAny(name, `/\`) || strings.Contains(name, "..") || strings.Contains(name, ":") {
		return false
	}
	return filepath.Clean(name) == name
}

// wsProjList 项目列表：一级子目录（is_git 标记含 .git 仓库），按最近使用倒序，带当前项目
func wsProjList(username string) *wsFileResult {
	ws, err := agentWorkspaceDir(username)
	if err != nil {
		return &wsFileResult{Error: err.Error()}
	}
	m := wsProjMetaLoad(username)
	ents, _ := os.ReadDir(ws)
	type projItem struct {
		Name  string `json:"name"`
		IsGit bool   `json:"is_git"`
		TS    int64  `json:"ts"`
	}
	list := []projItem{}
	for _, e := range ents {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue // 隐藏目录（含 .im_proj.json 所在工作区根元数据）不作为项目
		}
		it := projItem{Name: e.Name(), TS: m.TS[e.Name()]}
		if _, serr := os.Stat(filepath.Join(ws, e.Name(), ".git")); serr == nil {
			it.IsGit = true
		}
		list = append(list, it)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].TS > list[j].TS })
	data, _ := json.Marshal(map[string]interface{}{"proj": m.Cur, "list": list, "recents": m.Recents})
	return &wsFileResult{OK: true, Content: string(data)}
}

// wsProjRecentAdd 记录克隆历史：URL 剥凭证后按 URL 去重置顶，上限 10 条（新旧 clone 双路归口此处）
func wsProjRecentAdd(username, rawURL, name string) {
	u := wsProjSanitizeURL(rawURL)
	if u == "" || name == "" {
		return
	}
	m := wsProjMetaLoad(username)
	out := make([]wsProjRecent, 0, 11)
	out = append(out, wsProjRecent{URL: u, Name: name, TS: time.Now().Unix()})
	for _, r := range m.Recents {
		if r.URL == u || len(out) >= 10 {
			continue
		}
		out = append(out, r)
	}
	m.Recents = out
	wsProjMetaSave(username, m)
}

// wsProjSanitizeURL 剥离 URL 中的凭证段（https://token@host → https://host），防 Token 泄入元数据
func wsProjSanitizeURL(u string) string {
	u = strings.TrimSpace(u)
	if j := strings.Index(u, "://"); j >= 0 {
		if i := strings.Index(u[j+3:], "@"); i >= 0 {
			u = u[:j+3] + u[j+3+i+1:]
		}
	}
	return u
}

// wsProjOpen 切换当前项目（content=JSON{proj}；空串=回到工作区根）
func wsProjOpen(username, content string) *wsFileResult {
	var req struct {
		Proj string `json:"proj"`
	}
	_ = json.Unmarshal([]byte(content), &req)
	proj := strings.TrimSpace(req.Proj)
	if proj != "" {
		p, err := agentSafePath(username, proj)
		if err != nil || !wsProjDirExists(p) {
			return &wsFileResult{Error: "项目目录不存在"}
		}
	}
	wsProjTouch(username, proj)
	return &wsFileResult{OK: true}
}

// 运行中克隆登记（取消归口：key username|req_id → 进程句柄；PC 在线时克隆在 PC 执行，此表为空）
var (
	wsCloneMu      sync.Mutex
	wsCloneRunning = make(map[string]*wsCloneProc)
)

type wsCloneProc struct {
	cancel context.CancelFunc
	dir    string // 半成品目录（取消 kill 后 git 不会自清理，须手动删除）
}

// wsProgressFn 克隆进度回调（pct 阶段百分比 / stage 阶段名 / speed 速度文本 / sent 已接收字节估算）
type wsProgressFn func(pct int, stage, speed string, sent int64)

// wsProjCloneCancel 取消运行中克隆：ctx 取消杀进程 → wsProjClone 收尾统一清理半成品目录
func wsProjCloneCancel(username, content string) *wsFileResult {
	var req struct {
		Target string `json:"target"`
	}
	_ = json.Unmarshal([]byte(content), &req)
	target := strings.TrimSpace(req.Target)
	if target == "" {
		return &wsFileResult{Error: "缺少目标 req_id"}
	}
	wsCloneMu.Lock()
	p := wsCloneRunning[username+"|"+target]
	wsCloneMu.Unlock()
	if p == nil {
		return &wsFileResult{Error: "克隆已结束或不在服务端执行"}
	}
	p.cancel()
	return &wsFileResult{OK: true}
}

// wsCloneProgressPump 扫描 git --progress stderr 推送进度（\r 单行刷写 → 按 \r/\n 双分隔切行）；
// 返回 stderr 尾段文本（错误信息提取用，cap 8KB）。节流 500ms/帧。
// recover 兜底：pump 在独立 goroutine 运行，任何解析异常只中断进度推送（克隆本身继续走完），绝不带崩服务端
func wsCloneProgressPump(username, reqID string, r io.Reader, push wsProgressFn) string {
	defer func() {
		if r := recover(); r != nil {
			logger.Warn("克隆进度解析异常恢复（用户 %s req_id %s）：%v", username, reqID, r)
		}
	}()
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 256*1024)
	sc.Split(func(data []byte, atEOF bool) (int, []byte, error) {
		if atEOF && len(data) == 0 {
			return 0, nil, nil
		}
		if i := bytes.IndexAny(data, "\r\n"); i >= 0 {
			return i + 1, data[:i], nil
		}
		if atEOF {
			return len(data), data, nil
		}
		return 0, nil, nil
	})
	rePct := regexp.MustCompile(`(Receiving objects|Resolving deltas|Updating files|Checking out files):\s+(\d+)%`)
	reSpeed := regexp.MustCompile(`\|\s+([\d.]+\s+[KMG]?i?B/s)`)
	// 已接收量：git 进度行形如 "Receiving objects:  45% (123/456), 1.23 MiB | 2.34 MiB/s"（两组：数值+单位）
	reSent := regexp.MustCompile(`,\s+([\d.]+)\s+([KMG]?i?B)`)
	// 远端统计阶段（大仓库 Enumerating/Counting/Compressing 可持续数分钟，且先于 Receiving objects）：
	// 命中即推帧（pct 置 0、阶段透出远端行为），避免前端长时间停留在"正在连接仓库…"无反馈
	reRemote := regexp.MustCompile(`remote:\s*(Enumerating objects|Counting objects|Compressing objects)(?::\s*(\d+)%)?`)
	var tail strings.Builder
	var lastPush time.Time
	anySeen := false // stderr 首个非空行即推帧：远端枚举对象阶段 git 无输出，先用"连接远端中"占位反馈
	pct, stage, speed, sent := -1, "", "", int64(0)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		if !anySeen {
			anySeen = true
			if stage == "" {
				stage = "连接远端中"
			}
		}
		tail.WriteString(line)
		tail.WriteByte('\n')
		if tail.Len() > 8192 {
			tail.Reset()
			tail.WriteString(line)
			tail.WriteByte('\n')
		}
		if m := rePct.FindStringSubmatch(line); m != nil {
			stage = m[1]
			pct, _ = strconv.Atoi(m[2])
		}
		if m := reRemote.FindStringSubmatch(line); m != nil {
			stage = m[1]
			if m[2] != "" {
				stage += " " + m[2] + "%"
			}
		}
		if m := reSpeed.FindStringSubmatch(line); m != nil {
			speed = m[1]
		}
		if m := reSent.FindStringSubmatch(line); m != nil {
			v, _ := strconv.ParseFloat(m[1], 64)
			switch m[2][0] {
			case 'G':
				sent = int64(v * (1 << 30))
			case 'M':
				sent = int64(v * (1 << 20))
			case 'K':
				sent = int64(v * (1 << 10))
			default:
				sent = int64(v)
			}
		}
		if anySeen && push != nil && time.Since(lastPush) >= 500*time.Millisecond {
			lastPush = time.Now()
			if pct < 0 {
				pct = 0
			}
			push(pct, stage, speed, sent)
		}
	}
	return tail.String()
}

// wsProjClone 克隆仓库到工作区子目录并自动切换（content=JSON{url,name,token}）。
// token 仅内存拼接 URL（私有仓库 PAT），不落盘不进日志；--progress stderr 流式解析 → 63 进度中间帧；
// 登记运行句柄支持取消（proj_clone_cancel → ctx kill → 半成品目录清理）；完成后写元数据与克隆历史。
func wsProjClone(username, reqID, content string, push wsProgressFn) *wsFileResult {
	var req struct {
		URL   string `json:"url"`
		Name  string `json:"name"`
		Token string `json:"token"`
	}
	if err := json.Unmarshal([]byte(content), &req); err != nil {
		return &wsFileResult{Error: "请求解析失败"}
	}
	url := strings.TrimSpace(req.URL)
	name := strings.TrimSpace(req.Name)
	if name == "" {
		// 默认目录名取 URL 尾段（去 .git 后缀）
		name = strings.TrimSuffix(url[strings.LastIndex(url, "/")+1:], ".git")
	}
	if !wsProjValidName(name) {
		return &wsFileResult{Error: "目录名不合法（仅限常规名称，不含路径分隔符）"}
	}
	if url == "" || (!strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "git@") && !strings.HasPrefix(url, "ssh://")) {
		return &wsFileResult{Error: "仓库地址需以 https:// 、git@ 或 ssh:// 开头"}
	}
	if strings.HasPrefix(url, "https://") && strings.TrimSpace(req.Token) != "" {
		url = strings.Replace(url, "://", "://"+strings.TrimSpace(req.Token)+"@", 1) // PAT 凭证仅出现在本次进程参数
	}
	ws, err := agentWorkspaceDir(username)
	if err != nil {
		return &wsFileResult{Error: err.Error()}
	}
	dest := filepath.Join(ws, name)
	if _, serr := os.Stat(dest); serr == nil {
		return &wsFileResult{Error: "目录已存在：" + name}
	}
	if _, serr := exec.LookPath("git"); serr != nil {
		return &wsFileResult{Error: "未检测到 git，请先安装 Git 并加入 PATH"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-c", "credential.helper=", "-c", "core.quotepath=off", "clone", "--progress", url, name)
	cmd.Dir = ws
	// 禁用交互式凭据弹窗：服务端无人值守，匿名 401 仓库若触发 GCM 对话框会挂住克隆直至超时。
	// 实测 GCM 2.7.3 对 gitee 这类未知主机无视 GCM_INTERACTIVE=never，必须 -c credential.helper=
	// 置空彻底禁用助手（GIT_TERMINAL_PROMPT=0 + GIT_ASKPASS=echo 双保险防终端/askpass 提示）；
	// URL 内嵌 Token 的私有仓库克隆不受影响（凭证随 URL 传递，不经 helper）。
	// GIT_CEILING_DIRECTORIES 同 wsGitExec：阻断向上搜索到宿主目录仓库
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=echo", "GCM_INTERACTIVE=never", "GIT_CEILING_DIRECTORIES="+agentWorkRoot)
	stderr, perr := cmd.StderrPipe()
	if perr != nil {
		return &wsFileResult{Error: perr.Error()}
	}
	if serr := cmd.Start(); serr != nil {
		return &wsFileResult{Error: serr.Error()}
	}
	key := username + "|" + reqID
	wsCloneMu.Lock()
	wsCloneRunning[key] = &wsCloneProc{cancel: cancel, dir: dest}
	wsCloneMu.Unlock()
	tailCh := make(chan string, 1)
	go func() { tailCh <- wsCloneProgressPump(username, reqID, stderr, push) }()
	werr := cmd.Wait()
	wsCloneMu.Lock()
	delete(wsCloneRunning, key)
	wsCloneMu.Unlock()
	tail := <-tailCh
	if ctx.Err() == context.Canceled {
		os.RemoveAll(dest) // 取消：git 被杀不会自清理，手动删半成品
		return &wsFileResult{Error: "已取消"}
	}
	if werr != nil {
		msg := strings.TrimSpace(tail)
		if msg == "" {
			msg = werr.Error()
		}
		if strings.Contains(msg, "Authentication failed") || strings.Contains(msg, "403") {
			msg += "\n—— 私有仓库请在克隆弹窗填入访问 Token（GitHub：Settings → Developer settings → Personal access tokens）"
		} else if strings.Contains(msg, "already exists and is not an empty directory") {
			msg = "目录已存在：" + name
		} else if strings.Contains(msg, "Repository not found") || strings.Contains(msg, "not found") {
			msg += "\n—— 仓库不存在或无权访问，请检查地址（私有仓库需填 Token）"
		}
		os.RemoveAll(dest) // 失败兜底清理（git 通常自清理，双保险）
		return &wsFileResult{Error: msg}
	}
	wsProjTouch(username, name)
	wsProjRecentAdd(username, wsProjSanitizeURL(strings.TrimSpace(req.URL)), name)
	return &wsFileResult{OK: true}
}
