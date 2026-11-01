; installer.nsh —— IM 客户端 NSIS 自定义钩子（electron-builder nsis.include 引入）
; 卸载时清理运行时建立的联机防火墙放行规则（IMClient-GameNet-* 前缀）：
;   游戏卸载/客户端卸载后规则指向的 exe 已不存在，残留规则不产生任何流量放行，仅作整洁清理；
;   netsh delete 不支持通配，故经 PowerShell DisplayName 通配批量删除；
;   卸载器若未提权则删除失败静默（无副作用，可手动清理）

!macro customUnInstall
  nsExec::Exec `powershell.exe -NoProfile -Command "Get-NetFirewallRule -DisplayName 'IMClient-GameNet-*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue"`
!macroend
