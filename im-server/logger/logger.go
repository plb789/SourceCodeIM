package logger

import (
	"log"
	"os"
)

var (
	infoLogger  = log.New(os.Stdout, "[INFO] ", log.LstdFlags)
	warnLogger  = log.New(os.Stdout, "[WARN] ", log.LstdFlags)
	errorLogger = log.New(os.Stderr, "[ERROR] ", log.LstdFlags)
)

// Info 记录常规信息
func Info(format string, v ...interface{}) {
	infoLogger.Printf(format, v...)
}

// Warn 记录警告信息
func Warn(format string, v ...interface{}) {
	warnLogger.Printf(format, v...)
}

// Error 记录错误信息
func Error(format string, v ...interface{}) {
	errorLogger.Printf(format, v...)
}
