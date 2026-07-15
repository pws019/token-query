package profile

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
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
		return "", ErrProfileNotFound
	}
	if err != nil {
		return "", err
	}

	return login, nil
}
