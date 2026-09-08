// 临时查询：阶段六十六排查 memlive58 会话行（验证完可删除）
package main

import (
	"fmt"
	"time"
	"unicode/utf8"

	"im-server/config"
	"im-server/model"
	"im-server/store"
)

func main() {
	cfg := config.Load()
	store.InitMySQL(cfg)
	var convs []model.Conversation
	store.DB.Where("user_id IN ?", []string{"memlive58", "ntf28127"}).Find(&convs)
	fmt.Println("会话行数:", len(convs))
	for _, c := range convs {
		fmt.Printf("user=%s target=%q last=%q time=%v pinned=%v\n", c.UserID, c.Target, c.LastMsg, c.LastTime, c.Pinned)
	}
	var msgs []model.Message
	store.DB.Where("to_user = 'memlive58' AND msg_type = 2").Order("id desc").Limit(3).Find(&msgs)
	fmt.Println("memlive58 最新私聊消息:")
	for _, m := range msgs {
		fmt.Printf("id=%d from=%q read=%v recalled=%v content=%.60q\n", m.ID, m.FromUser, m.IsRead, m.Recalled, m.Content)
	}
	// 阶段六十六验证：复现 touchConversation 的 200 字节截断（UTF-8 拦腰截断假说）
	if len(msgs) > 0 {
		raw := msgs[0].Content
		cut := raw
		if len(cut) > 200 {
			cut = cut[:200]
		}
		fmt.Printf("截断后字节尾片: %q\n", cut[len(cut)-12:])
		bad := !utf8.ValidString(cut)
		fmt.Println("截断结果是否无效 UTF-8:", bad)
		if !bad {
			// 截断本身合法时再试落库（列长 255 字符内）验证其他约束
			c := model.Conversation{UserID: "memlive58", Target: "AI助手", LastMsg: cut, LastTime: time.Now()}
			if err := store.DB.Create(&c).Error; err != nil {
				fmt.Println("会话行创建报错:", err)
			} else {
				fmt.Println("会话行创建成功 id=", c.ID)
				store.DB.Delete(&c)
			}
		}
	}
}
