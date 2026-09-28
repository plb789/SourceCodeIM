package server

// 阶段一百七十七：项目结构注入（TRAE CN 同款"项目结构"进上下文）
// 任务启动时扫描工作区/当前项目目录树（限深度/条目/字符预算），注入系统提示，
// 让模型不开列目录就能了解项目全貌、快速定位文件——先看结构再动手，减少盲目 list_dir。
// 扫描通道归口文件面板分派（wsFileDispatch）：PC 在线遍历用户本地主工作区，离线回退
// 服务端工作区，与阶段一百七十五规则文件同一通道同一语义（一套代码覆盖两种场景）。

import (
	"im-server/logger"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	agentTreeMaxDepth  = 3                // 目录树展开深度（根为第 1 层；更深层目录只显示名不展开）
	agentTreeMaxLines  = 300              // 注入行数上限（每行一个条目，防大仓库撑爆上下文）
	agentTreeMaxRunes  = 6000             // 注入总字符上限（超出中途截断，尾部注明）
	agentTreeMaxDirs   = 40               // 实际访问的目录数上限（PC 通道每目录一次往返，防慢链路放大）
	agentTreePerDirMax = 40               // 单目录展示条目上限（超出省略并注明）
	agentTreeCacheTTL  = 60 * time.Second // 扫描结果缓存（连续任务免重复跨端遍历；任务完结/切换项目即失效）
)

// agentTreeCacheEntry 项目结构缓存（60s 复用；任务完结/切换当前项目时失效）
type agentTreeCacheEntry struct {
	block string
	root  string
	at    time.Time
}

var agentTreeCache sync.Map

// agentTreeInvalidate 项目结构缓存失效（任务完结/切换当前项目/克隆后调用，下个任务立即重扫）
func agentTreeInvalidate(username string) {
	if username != "" {
		agentTreeCache.Delete(username)
	}
}

// agentTreeReqID 文件面板通道请求标识（独立前缀，与前端面板请求天然区分、日志可辨识）
func agentTreeReqID() string {
	return "tree-" + strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
}

// agentTreeWalk 目录树遍历状态（预算收敛：行数/字符/目录数三重上限，超限置 cut 全局停走）
type agentTreeWalk struct {
	s     *Server
	user  string
	b     strings.Builder
	lines int
	chars int
	dirs  int
	cut   bool
}

// emit 输出一行树文本；行数/字符预算耗尽置 cut 并返回 false（调用方停止下钻）
func (w *agentTreeWalk) emit(line string) bool {
	if w.cut {
		return false
	}
	if w.lines >= agentTreeMaxLines || w.chars >= agentTreeMaxRunes {
		w.cut = true
		return false
	}
	w.b.WriteString(line)
	w.b.WriteByte('\n')
	w.lines++
	w.chars += len([]rune(line)) + 1
	return true
}

// listDir 经文件面板通道列目录（PC 在线走本地执行器，离线走服务端工作区；
// 失败视为空目录静默跳过——结构注入是增强信息，不因个别目录读失败打断任务）
func (w *agentTreeWalk) listDir(rel string) []wsFileEntry {
	res := w.s.wsFileDispatch(w.user, agentTreeReqID(), "tree", rel, "")
	if res == nil || !res.OK {
		return nil
	}
	entries := make([]wsFileEntry, len(res.Entries))
	copy(entries, res.Entries)
	// 防御性重排：子目录在前文件在后、同组按名排序（服务端 tree 已此序，PC 执行器序不假设）
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Dir != entries[j].Dir {
			return entries[i].Dir
		}
		return entries[i].Name < entries[j].Name
	})
	return entries
}

// walk 递归展开目录树（depth 从 1 起：1=根层条目；超深的目录显示名不展开）
func (w *agentTreeWalk) walk(rel, prefix string, depth int) {
	if w.cut || depth > agentTreeMaxDepth || w.dirs >= agentTreeMaxDirs {
		return
	}
	w.dirs++
	entries := w.listDir(rel)
	// 过滤依赖/构建目录（服务端 tree 已跳过，PC 执行器行为不假设——此处统一再滤一遍）+ 单目录条目上限
	kept := make([]wsFileEntry, 0, len(entries))
	for _, e := range entries {
		if e.Dir && wsFileSkipDirs[e.Name] {
			continue
		}
		kept = append(kept, e)
	}
	if len(kept) > agentTreePerDirMax {
		rest := len(kept) - agentTreePerDirMax
		kept = kept[:agentTreePerDirMax]
		kept = append(kept, wsFileEntry{Name: "…（本目录其余 " + strconv.Itoa(rest) + " 项省略）"})
	}
	for i, e := range kept {
		if w.cut {
			return
		}
		branch, child := "├── ", "│   "
		if i == len(kept)-1 {
			branch, child = "└── ", "   "
		}
		name := e.Name
		if e.Dir {
			name += "/"
		}
		if !w.emit(prefix + branch + name) {
			return
		}
		if e.Dir {
			sub := e.Name
			if rel != "" {
				sub = rel + "/" + e.Name
			}
			w.walk(sub, prefix+child, depth+1)
		}
	}
}

// agentProjTreeBlock 任务启动入口：扫描+组装目录树区块（带 60s 缓存），无条目返回空不注入。
// 根取当前项目（.im_proj.json 的 cur，与系统提示"当前项目"同源），未设置则用工作区根
func (s *Server) agentProjTreeBlock(username string) string {
	if strings.TrimSpace(username) == "" {
		return ""
	}
	if v, ok := agentTreeCache.Load(username); ok {
		if e, ok := v.(*agentTreeCacheEntry); ok && time.Since(e.at) < agentTreeCacheTTL {
			return e.block
		}
	}
	cur := strings.TrimSpace(strings.Trim(wsProjMetaLoad(username).Cur, "/\\"))
	root, rootLabel := "", "工作区根"
	if cur != "" {
		root, rootLabel = cur, "当前项目 "+cur
	}
	w := &agentTreeWalk{s: s, user: username}
	w.walk(root, "", 1)
	if w.lines == 0 {
		agentTreeCache.Store(username, &agentTreeCacheEntry{root: root, at: time.Now()})
		return "" // 空工作区/扫描失败：静默不注入（大多数会话无项目结构需求）
	}
	block := "【项目结构】以下是" + rootLabel + "的目录树（深度 ≤" + strconv.Itoa(agentTreeMaxDepth) +
		" 层，已跳过依赖/构建目录），用于快速定位文件；目录详情用 list_dir、文件内容用 read_file 查看：\n" +
		strings.TrimRight(w.b.String(), "\n")
	if w.cut {
		block += "\n…（结构已截断）"
	}
	agentTreeCache.Store(username, &agentTreeCacheEntry{block: block, root: root, at: time.Now()})
	logger.Info("Agent 注入项目结构（用户 %s，根 %q，%d 行）", username, root, w.lines)
	return block
}
