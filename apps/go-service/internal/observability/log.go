package observability

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"time"
)

const RequestIDHeader = "X-Request-Id"

type contextKey string

const requestMetadataKey contextKey = "requestMetadata"

type RequestMetadata struct {
	RequestID string `json:"requestId,omitempty"`
	AppEnv    string `json:"appEnv,omitempty"`
	PreviewID string `json:"previewId,omitempty"`
}

func MetadataFromRequest(r *http.Request) RequestMetadata {
	requestID := r.Header.Get(RequestIDHeader)
	if !isSafeRequestID(requestID) {
		requestID = newRequestID()
	}

	appEnv := r.Header.Get("X-App-Env")
	if appEnv == "" {
		appEnv = "unknown"
	}

	return RequestMetadata{
		RequestID: requestID,
		AppEnv:    appEnv,
		PreviewID: r.Header.Get("X-Preview-Id"),
	}
}

func ContextWithMetadata(ctx context.Context, metadata RequestMetadata) context.Context {
	return context.WithValue(ctx, requestMetadataKey, metadata)
}

func MetadataFromContext(ctx context.Context) RequestMetadata {
	metadata, ok := ctx.Value(requestMetadataKey).(RequestMetadata)
	if !ok {
		return RequestMetadata{}
	}

	return metadata
}

func Info(ctx context.Context, event string, fields map[string]any) {
	write(ctx, "info", event, fields)
}

func Warn(ctx context.Context, event string, fields map[string]any) {
	write(ctx, "warn", event, fields)
}

func Error(ctx context.Context, event string, fields map[string]any) {
	write(ctx, "error", event, fields)
}

func ErrorString(err error) string {
	if err == nil {
		return ""
	}

	return err.Error()
}

func write(ctx context.Context, level string, event string, fields map[string]any) {
	metadata := MetadataFromContext(ctx)
	entry := map[string]any{
		"level":     level,
		"event":     event,
		"requestId": metadata.RequestID,
		"appEnv":    metadata.AppEnv,
	}

	if metadata.PreviewID != "" {
		entry["previewId"] = metadata.PreviewID
	}

	for key, value := range fields {
		entry[key] = value
	}

	payload, err := json.Marshal(entry)
	if err != nil {
		log.Printf(`{"level":"error","event":"log_marshal_failed","message":%q}`, err.Error())
		return
	}

	log.Print(string(payload))
}

func isSafeRequestID(requestID string) bool {
	if len(requestID) == 0 || len(requestID) > 128 {
		return false
	}

	for _, ch := range requestID {
		switch {
		case ch >= 'a' && ch <= 'z':
		case ch >= 'A' && ch <= 'Z':
		case ch >= '0' && ch <= '9':
		case ch == '.', ch == '_', ch == ':', ch == '-':
		default:
			return false
		}
	}

	return true
}

func newRequestID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return hex.EncodeToString([]byte(time.Now().UTC().Format(time.RFC3339Nano)))
	}

	return hex.EncodeToString(bytes[:])
}
