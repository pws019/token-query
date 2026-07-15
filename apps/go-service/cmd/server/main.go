package main

import (
	"log"
	"net/http"
	"os"
	"time"

	httpapi "github.com/pws019/token-query/apps/go-service/internal/http"
	"github.com/pws019/token-query/apps/go-service/internal/profile"
)

func main() {
	port := getenv("PORT", "8080")

	server := &http.Server{
		Addr:              ":" + port,
		Handler:           httpapi.NewHandler(profile.NewService()),
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("token-query-go service listening on :%s", port)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server failed: %v", err)
	}
}

func getenv(key string, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}
