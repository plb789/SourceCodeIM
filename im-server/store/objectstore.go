package store

// ===== 网盘对象存储抽象层（MinIO / 本地磁盘双后端） =====
// 设计归口：网盘文件本体一律经本抽象层读写，im-server 作为唯一归口——
// 客户端永不接触 MinIO 凭据，元数据（im_drive_file）与文件本体解耦；
// storage=auto 时 MinIO 已配置则用 MinIO，否则降级本地磁盘（未部署 MinIO 功能完整可用）。

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"im-server/config"
	"im-server/logger"
)

// ObjectStore 网盘文件本体存储接口（Put 流式写入 / Open 读取 / Delete 删除 / Presign 预签名下载地址）
type ObjectStore interface {
	// Put 流式写入对象（size 为已知大小时传正值，未知传 -1；dispo 为下载 Content-Disposition
	// 原始文件名头——MinIO 预签名直连下载时回带该头，浏览器另存为显示原始文件名；本地后端忽略）
	Put(ctx context.Context, key string, r io.Reader, size int64, dispo string) error
	// Open 打开对象读取流（本地后端返回 *os.File 支持 Seek，可走 http.ServeContent 断点续传）
	Open(key string) (io.ReadCloser, int64, error)
	// Delete 删除对象（对象不存在视为成功，幂等）
	Delete(key string) error
	// Presign 生成短时效下载地址（本地后端不支持，返回错误——下载走服务端流式代理）
	Presign(key string, expiry time.Duration) (string, error)
	// Kind 后端类型标识（日志与启动信息用）：minio / local
	Kind() string
}

// objectStore 进程级单例（InitDrive 归口创建，网盘模块读用）
var objectStore ObjectStore

// driveTmpDir 分片上传临时目录（InitDriveStore 归口设定：local 后端跟随存储根目录，
// minio 后端落 exe目录/drive_data/up_tmp——分片临时盘独立于对象存储后端，始终本地磁盘）
var driveTmpDir string

// DriveTmpDir 获取分片上传临时根目录（drive.go 分片上传/会话 GC 共用）
func DriveTmpDir() string { return driveTmpDir }

// GetObjectStore 获取网盘存储后端单例
func GetObjectStore() ObjectStore { return objectStore }

// InitDriveStore 网盘存储后端初始化（main.go 启动归口调用；config 驱动选择后端，异常直接报错退出）
func InitDriveStore(cfg *config.Config) error {
	mode := cfg.Drive.Storage
	if mode == "" || mode == "auto" {
		// auto：MinIO 四项配置齐全即用 MinIO，否则降级本地磁盘
		if cfg.Drive.Minio.Endpoint != "" && cfg.Drive.Minio.AccessKey != "" {
			mode = "minio"
		} else {
			mode = "local"
		}
	}
	switch mode {
	case "minio":
		st, err := newMinioStore(cfg.Drive.Minio)
		if err != nil {
			return fmt.Errorf("MinIO 初始化失败: %w", err)
		}
		objectStore = st
		logger.Info("网盘存储后端: MinIO (%s, bucket=%s)", cfg.Drive.Minio.Endpoint, cfg.Drive.Minio.Bucket)
	case "local":
		dir := cfg.Drive.LocalDir
		if dir == "" {
			dir = filepath.Join(exeDirOrDot(), "drive_data")
		}
		st, err := newLocalStore(dir)
		if err != nil {
			return fmt.Errorf("网盘本地存储初始化失败: %w", err)
		}
		objectStore = st
		logger.Info("网盘存储后端: 本地磁盘 (%s)", dir)
	default:
		return fmt.Errorf("未知网盘存储类型 drive.storage: %s（可选 auto/minio/local）", mode)
	}
	// 分片上传临时目录归口设定（local 跟随存储根目录；minio 落 exe目录/drive_data/up_tmp）
	if mode == "local" {
		driveTmpDir = filepath.Join(objectStore.(*localStore).root, "up_tmp")
	} else {
		driveTmpDir = filepath.Join(exeDirOrDot(), "drive_data", "up_tmp")
	}
	if err := os.MkdirAll(driveTmpDir, os.ModePerm); err != nil {
		return fmt.Errorf("分片临时目录创建失败: %w", err)
	}
	return nil
}

// exeDirOrDot exe 目录兜底（与 config 包 resolvePath 同语义，store 包内复用）
func exeDirOrDot() string {
	exePath, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exePath)
}

// ===== 本地磁盘后端 =====

type localStore struct {
	root string // 存储根目录（已确保存在）
}

func newLocalStore(root string) (*localStore, error) {
	if err := os.MkdirAll(root, os.ModePerm); err != nil {
		return nil, err
	}
	return &localStore{root: root}, nil
}

// safeLocalPath 对象 key → 根目录内绝对路径（防路径穿越：拼装后校验仍在根目录内）
func (s *localStore) safeLocalPath(key string) (string, error) {
	p := filepath.Join(s.root, filepath.FromSlash(key))
	absRoot, err := filepath.Abs(s.root)
	if err != nil {
		return "", err
	}
	absP, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(absP, absRoot+string(os.PathSeparator)) && absP != absRoot {
		return "", fmt.Errorf("非法对象 key: %s", key)
	}
	return p, nil
}

func (s *localStore) Put(_ context.Context, key string, r io.Reader, _ int64, _ string) error {
	p, err := s.safeLocalPath(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), os.ModePerm); err != nil {
		return err
	}
	out, err := os.Create(p)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, r)
	return err
}

func (s *localStore) Open(key string) (io.ReadCloser, int64, error) {
	p, err := s.safeLocalPath(key)
	if err != nil {
		return nil, 0, err
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, 0, err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, err
	}
	return f, info.Size(), nil
}

func (s *localStore) Delete(key string) error {
	p, err := s.safeLocalPath(key)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (s *localStore) Presign(_ string, _ time.Duration) (string, error) {
	return "", fmt.Errorf("本地存储不支持预签名")
}

func (s *localStore) Kind() string { return "local" }

// ===== MinIO 后端 =====

type minioStore struct {
	client *minio.Client
	bucket string
}

func newMinioStore(cfg config.MinioConfig) (*minioStore, error) {
	client, err := minio.New(cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: cfg.UseSSL,
	})
	if err != nil {
		return nil, err
	}
	bucket := cfg.Bucket
	if bucket == "" {
		bucket = "im-drive"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// 桶不存在自动创建（私有读写），免手工初始化部署
	exists, err := client.BucketExists(ctx, bucket)
	if err != nil {
		return nil, fmt.Errorf("MinIO 连接失败（检查 endpoint/网络）: %w", err)
	}
	if !exists {
		if err := client.MakeBucket(ctx, bucket, minio.MakeBucketOptions{}); err != nil {
			return nil, fmt.Errorf("MinIO 桶创建失败: %w", err)
		}
		logger.Info("MinIO 桶 %s 不存在，已自动创建", bucket)
	}
	return &minioStore{client: client, bucket: bucket}, nil
}

func (s *minioStore) Put(ctx context.Context, key string, r io.Reader, size int64, dispo string) error {
	sz := size
	opts := minio.PutObjectOptions{ContentType: "application/octet-stream"}
	if dispo != "" {
		// 对象级 Content-Disposition：预签名直连下载时浏览器另存为显示原始文件名
		opts.ContentDisposition = dispo
	}
	if sz < 0 {
		sz = -1 // minio-go：-1 流式上传（自动分片缓冲）
	}
	_, err := s.client.PutObject(ctx, s.bucket, key, r, sz, opts)
	return err
}

func (s *minioStore) Open(key string) (io.ReadCloser, int64, error) {
	obj, err := s.client.GetObject(context.Background(), s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, 0, err
	}
	info, err := obj.Stat()
	if err != nil {
		obj.Close()
		return nil, 0, err
	}
	return obj, info.Size, nil
}

func (s *minioStore) Delete(key string) error {
	return s.client.RemoveObject(context.Background(), s.bucket, key, minio.RemoveObjectOptions{})
}

// Presign 生成短时效 GET 预签名地址（下载 302 跳转直连 MinIO，省服务端带宽；
// 前提：客户端网络可达 MinIO endpoint——内网部署天然满足）
func (s *minioStore) Presign(key string, expiry time.Duration) (string, error) {
	u, err := s.client.PresignedGetObject(context.Background(), s.bucket, key, expiry, url.Values{})
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

func (s *minioStore) Kind() string { return "minio" }
