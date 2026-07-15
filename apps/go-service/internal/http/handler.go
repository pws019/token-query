package httpapi

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"

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
	h.mux.ServeHTTP(w, r)
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
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"code":  "invalid_request",
			"error": "Invalid request payload.",
		})
		return
	}

	response, err := h.profileService.GenerateIntro(r.Context(), request)
	if err != nil {
		if errors.Is(err, profile.ErrInvalidGithubID) {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"code":  "invalid_github_id",
				"error": "githubId must be a positive integer.",
			})
			return
		}

		log.Printf("profile_intro_failed githubId=%d err=%v", request.GithubID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"code":  "intro_failed",
			"error": "Self introduction generation failed.",
		})
		return
	}

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
