package httpapi

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/pws019/token-query/apps/go-service/internal/observability"
	"github.com/pws019/token-query/apps/go-service/internal/profile"
)

type Handler struct {
	profileService *profile.Service
	mux            *http.ServeMux
}

func NewHandler(profileService *profile.Service) http.Handler {
	handler := &Handler{
		profileService: profileService,
		mux:            http.NewServeMux(),
	}

	handler.routes()
	return handler
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	metadata := observability.MetadataFromRequest(r)
	ctx := observability.ContextWithMetadata(r.Context(), metadata)
	w.Header().Set(observability.RequestIDHeader, metadata.RequestID)

	startedAt := time.Now()
	recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}

	observability.Info(ctx, "go_request_start", map[string]any{
		"method": r.Method,
		"path":   r.URL.Path,
	})

	h.mux.ServeHTTP(recorder, r.WithContext(ctx))

	observability.Info(ctx, "go_request_end", map[string]any{
		"method":     r.Method,
		"path":       r.URL.Path,
		"status":     recorder.status,
		"durationMs": time.Since(startedAt).Milliseconds(),
	})
}

func (h *Handler) routes() {
	h.mux.HandleFunc("GET /health", h.health)
	h.mux.HandleFunc("POST /profile/intro", h.generateIntro)
}

func (h *Handler) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"service": "token-query-go",
	})
}

func (h *Handler) generateIntro(w http.ResponseWriter, r *http.Request) {
	var request profile.IntroRequest
	if err := decodeJSON(r, &request); err != nil {
		observability.Warn(r.Context(), "go_profile_intro_invalid_request", map[string]any{
			"error": observability.ErrorString(err),
		})
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"code":  "invalid_request",
			"error": "Invalid request payload.",
		})
		return
	}

	response, err := h.profileService.GenerateIntro(r.Context(), request)
	if err != nil {
		if errors.Is(err, profile.ErrInvalidGithubID) {
			observability.Warn(r.Context(), "go_profile_intro_invalid_github_id", map[string]any{
				"githubId": request.GithubID,
			})
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"code":  "invalid_github_id",
				"error": "githubId must be a positive integer.",
			})
			return
		}
		if errors.Is(err, profile.ErrProfileNotFound) {
			observability.Warn(r.Context(), "go_profile_intro_profile_not_found", map[string]any{
				"githubId": request.GithubID,
			})
			writeJSON(w, http.StatusNotFound, map[string]any{
				"code":  "profile_not_found",
				"error": "GitHub profile was not found.",
			})
			return
		}

		observability.Error(r.Context(), "go_profile_intro_failed", map[string]any{
			"githubId": request.GithubID,
			"error":    observability.ErrorString(err),
		})
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"code":  "intro_failed",
			"error": "Self introduction generation failed.",
		})
		return
	}

	observability.Info(r.Context(), "go_profile_intro_success", map[string]any{
		"githubId": response.GithubID,
		"login":    response.Login,
	})

	writeJSON(w, http.StatusOK, response)
}

func decodeJSON(r *http.Request, target any) error {
	defer r.Body.Close()

	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)

	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("write_json_failed err=%v", err)
	}
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}
