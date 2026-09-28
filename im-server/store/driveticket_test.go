package store

import (
	"strings"
	"testing"
	"time"
)

// TestDriveTicketLifecycle 票据全生命周期：签发→校验→续期→过期→吊销
func TestDriveTicketLifecycle(t *testing.T) {
	DriveTicketInit(true, 2) // 2s 短 TTL 便于过期测试
	if !DriveTicketsEnabled() {
		t.Fatal("启用失败")
	}
	if DriveTicketTTL() != 2*time.Second {
		t.Fatalf("TTL 写入异常: %v", DriveTicketTTL())
	}
	// 签发：格式（32 位十六进制）与关联
	tk := DriveTicketIssue("drive/alice/a.txt")
	if len(tk) != 32 || strings.ContainsAny(tk, "gxyzXYZ-") {
		t.Fatalf("票据格式异常: %q", tk)
	}
	// 首次校验通过
	if !DriveTicketVerify(tk) {
		t.Fatal("有效票据校验未通过")
	}
	// 滑动续期：校验后 expire 后移（2s TTL 内校验两次仍有效）
	time.Sleep(1100 * time.Millisecond)
	if !DriveTicketVerify(tk) {
		t.Fatal("滑动续期内校验未通过")
	}
	// 吊销后立即失效
	if n := DriveTicketRevokeKey("drive/alice/a.txt"); n != 1 {
		t.Fatalf("吊销计数异常: %d", n)
	}
	if DriveTicketVerify(tk) {
		t.Fatal("吊销后票据仍有效")
	}
	// 过期失效（未吊销场景）
	tk2 := DriveTicketIssue("drive/alice/b.txt")
	time.Sleep(2100 * time.Millisecond)
	if DriveTicketVerify(tk2) {
		t.Fatal("过期票据仍有效")
	}
}

// TestDriveTicketDisabled 未启用时零行为
func TestDriveTicketDisabled(t *testing.T) {
	DriveTicketInit(false, 0)
	if DriveTicketsEnabled() {
		t.Fatal("开关未生效")
	}
	if DriveTicketVerify("anything") {
		t.Fatal("未启用时不应有票据可校验")
	}
}

// TestDriveTicketRevokeKeyIsolation 吊销按对象隔离：不误伤其他对象票据
func TestDriveTicketRevokeKeyIsolation(t *testing.T) {
	DriveTicketInit(true, 60)
	tkA := DriveTicketIssue("drive/alice/a.txt")
	tkB := DriveTicketIssue("drive/alice/b.txt")
	DriveTicketRevokeKey("drive/alice/a.txt")
	if DriveTicketVerify(tkA) {
		t.Fatal("目标对象票据未被吊销")
	}
	if !DriveTicketVerify(tkB) {
		t.Fatal("无关对象票据被误伤")
	}
}
