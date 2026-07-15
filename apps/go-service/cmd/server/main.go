package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	httpapi "github.com/pws019/token-query/apps/go-service/internal/http"
	"github.com/pws019/token-query/apps/go-service/internal/profile"
)

func main() {
	port := getenv("PORT", "8080")
	databaseURL := getenv("DATABASE_URL", "postgresql://postgres:password@localhost:5432/postgres")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		log.Fatalf("database pool creation failed: %v", err)
	}
	defer db.Close()

	if err := db.Ping(ctx); err != nil {
		log.Fatalf("database ping failed: %v", err)
	}

	server := &http.Server{
		Addr:              ":" + port,
		Handler:           httpapi.NewHandler(profile.NewService(profile.NewRepository(db))),
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
