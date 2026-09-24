module im-server

go 1.25.8

require (
	github.com/go-sql-driver/mysql v1.8.1
	github.com/golang-jwt/jwt/v5 v5.3.1
	github.com/gorilla/websocket v1.5.3
	github.com/minio/minio-go/v7 v7.3.0
	github.com/modelcontextprotocol/go-sdk v1.7.0
	github.com/philippgille/chromem-go v0.7.0
	github.com/pion/logging v0.2.4
	github.com/pion/turn/v4 v4.1.4
	github.com/redis/go-redis/v9 v9.22.0
	github.com/xuri/excelize/v2 v2.11.0
	golang.org/x/text v0.41.0
	gopkg.in/yaml.v3 v3.0.1
	gorm.io/driver/mysql v1.6.0
	gorm.io/gorm v1.31.2
)

// 2026-09-20 实测澄清：pion/stun v3.1.7 官方库的 magicCookie=0x2112A442 一直正确
// （RFC 5389 第 6 节标准值；Edge/libjuice/Twilio/Wireshark 实测均使用该值）。
// 此前"上游误写"属于误诊，曾据此创建本地修正副本 third_party/pion-stun 并改魔数为
// 0x2112A44E，反而导致服务端丢弃所有真实客户端请求（跨网通话"连接已断开"根因）。
// 现已恢复官方库并删除副本目录；原 replace 指令注释留档，勿再启用：
// replace github.com/pion/stun/v3 => ./third_party/pion-stun

require (
	filippo.io/edwards25519 v1.1.0 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/google/jsonschema-go v0.4.3 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/jinzhu/inflection v1.0.0 // indirect
	github.com/jinzhu/now v1.1.5 // indirect
	github.com/klauspost/compress v1.19.2 // indirect
	github.com/klauspost/cpuid/v2 v2.4.0 // indirect
	github.com/klauspost/crc32 v1.3.0 // indirect
	github.com/minio/crc64nvme v1.1.1 // indirect
	github.com/minio/md5-simd v1.1.2 // indirect
	github.com/philhofer/fwd v1.2.0 // indirect
	github.com/pion/dtls/v3 v3.1.5 // indirect
	github.com/pion/randutil v0.1.0 // indirect
	github.com/pion/stun/v3 v3.1.7 // indirect
	github.com/pion/transport/v4 v4.1.0 // indirect
	github.com/richardlehane/mscfb v1.0.7 // indirect
	github.com/richardlehane/msoleps v1.0.6 // indirect
	github.com/rs/xid v1.6.0 // indirect
	github.com/segmentio/asm v1.1.3 // indirect
	github.com/segmentio/encoding v0.5.4 // indirect
	github.com/tiendc/go-deepcopy v1.7.2 // indirect
	github.com/tinylib/msgp v1.6.4 // indirect
	github.com/wlynxg/anet v0.0.5 // indirect
	github.com/xuri/efp v0.0.1 // indirect
	github.com/xuri/nfp v0.0.2-0.20250530014748-2ddeb826f9a9 // indirect
	github.com/yosida95/uritemplate/v3 v3.0.2 // indirect
	github.com/zeebo/xxh3 v1.1.0 // indirect
	go.uber.org/atomic v1.11.0 // indirect
	go.yaml.in/yaml/v3 v3.0.5 // indirect
	golang.org/x/crypto v0.55.0 // indirect
	golang.org/x/net v0.58.0 // indirect
	golang.org/x/oauth2 v0.35.0 // indirect
	golang.org/x/sync v0.22.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	golang.org/x/time v0.15.0 // indirect
	gopkg.in/ini.v1 v1.67.3 // indirect
)
