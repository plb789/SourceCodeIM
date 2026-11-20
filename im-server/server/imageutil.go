package server

// imageutil.go —— 服务端图像处理工具（截图上传缩略图生成）
// 依赖：golang.org/x/image/draw (BiLinear 高质量缩放)
// 设计策略：
//   - 缩略图统一输出 300×300 JPEG quality=85（等比中心裁切 + BiLinear 高质量缩放）
//   - GIF 只解码首帧（Strategy ①：缩略图静态封面，点击大图才看完整动画）
//   - 失败返回 "" 不中断上传主流程（thumbnail 是锦上添花，原图必须成功）
//   - 单张缩略图通常 20-40KB，对比原图（MB 级）省 95%+ 流量

import (
	"fmt"
	"image"
	"image/jpeg"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/image/draw"

	"im-server/model"
	"im-server/store"
)

const thumbSize = 300 // 缩略图边长（像素）

// generateScreenshotThumb 读取 srcPath 图片，生成 300×300 JPEG 缩略图，保存到 dstDir。
// 返回 URL 路径（如 "/static/upload/screenshots/ss_xxx_thumb.jpg"），失败返回 "" 且 err != nil。
// GIF 只取首帧（image.Decode 对 GIF 只返回第一帧，天然符合 Strategy ①）。
func generateScreenshotThumb(srcPath, dstDir string) (string, error) {
	// ① 打开源文件
	f, err := os.Open(srcPath)
	if err != nil {
		return "", fmt.Errorf("open src: %w", err)
	}
	defer f.Close()

	// ② 解码图片（image.Decode 自动识别 PNG/JPG/GIF/BMP；GIF 只取首帧）
	srcImg, _, err := image.Decode(f)
	if err != nil {
		return "", fmt.Errorf("decode image: %w", err)
	}

	// ③ 计算等比中心裁切的源矩形（构图居中，裁掉边缘多余部分）
	b := srcImg.Bounds()
	w, h := b.Dx(), b.Dy()
	side := w
	if h < side {
		side = h
	}
	ox := (w - side) / 2
	oy := (h - side) / 2
	cropRect := image.Rect(b.Min.X+ox, b.Min.Y+oy, b.Min.X+ox+side, b.Min.Y+oy+side)

	// ④ 一步完成裁切 + 高质量 BiLinear 缩放到 300×300
	dst := image.NewRGBA(image.Rect(0, 0, thumbSize, thumbSize))
	draw.BiLinear.Scale(dst, dst.Bounds(), srcImg, cropRect, draw.Over, nil)

	// ⑤ 输出路径：与原图同目录，文件名 _thumb.jpg
	srcExt := strings.ToLower(filepath.Ext(srcPath))
	baseName := strings.TrimSuffix(filepath.Base(srcPath), srcExt)
	thumbName := baseName + "_thumb.jpg"
	dstPath := filepath.Join(dstDir, thumbName)
	if err := os.MkdirAll(dstDir, os.ModePerm); err != nil {
		return "", fmt.Errorf("mkdir dst: %w", err)
	}
	out, err := os.Create(dstPath)
	if err != nil {
		return "", fmt.Errorf("create dst: %w", err)
	}
	defer out.Close()

	// ⑥ 编码为 JPEG（质量 85：视觉品质好 + 文件小）
	if err := jpeg.Encode(out, dst, &jpeg.Options{Quality: 85}); err != nil {
		return "", fmt.Errorf("jpeg encode: %w", err)
	}

	// ⑦ 返回 URL 路径（正斜杠，相对 WebDir）
	url := "/static/upload/screenshots/" + filepath.Base(dstPath)
	return url, nil
}

// ensureThumbURL 确保截图记录有缩略图：有则返回，无则从原图生成并更新 DB。
// 用于列表接口对老数据做懒生成（现有截图首次请求时自动补缩略图）。
func ensureThumbURL(ss *model.ProfileScreenshot, webDir string) {
	if ss.ThumbURL != "" {
		return // 已有
	}
	localPath := filepath.Join(webDir, strings.TrimPrefix(ss.URL, "/"))
	if _, err := os.Stat(localPath); err != nil {
		return // 原图都不存在，放弃
	}
	thumbDir := filepath.Join(webDir, "static", "upload", "screenshots")
	thumbURL, tErr := generateScreenshotThumb(localPath, thumbDir)
	if tErr != nil {
		return // 失败就失败，不阻塞列表
	}
	ss.ThumbURL = thumbURL
	store.DB.Model(ss).Update("thumb_url", thumbURL)
}
