package profile

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pws019/token-query/apps/go-service/internal/observability"
)

type Repository struct {
	db *pgxpool.Pool
}

func NewRepository(db *pgxpool.Pool) *Repository {
	return &Repository{db: db}
}

func (r *Repository) FindLoginByGithubID(ctx context.Context, githubID int64) (string, error) {
	var login string
	err := r.db.QueryRow(ctx, `
		SELECT login
		FROM github_profiles
		WHERE github_id = $1
	`, githubID).Scan(&login)

	if errors.Is(err, pgx.ErrNoRows) {
		observability.Warn(ctx, "go_profile_intro_db_not_found", map[string]any{
			"githubId": githubID,
		})
		return "", ErrProfileNotFound
	}
	if err != nil {
		observability.Error(ctx, "go_profile_intro_db_query_failed", map[string]any{
			"githubId": githubID,
			"error":    observability.ErrorString(err),
		})
		return "", err
	}

	observability.Info(ctx, "go_profile_intro_db_query_success", map[string]any{
		"githubId": githubID,
		"login":    login,
	})

	return login, nil
}
