package profile

import (
	"context"
	"errors"
)

var ErrInvalidGithubID = errors.New("invalid github id")
var ErrProfileNotFound = errors.New("profile not found")

type IntroRequest struct {
	GithubID int64 `json:"githubId"`
}

type IntroResponse struct {
	GithubID int64  `json:"githubId"`
	Login    string `json:"login"`
	Intro    string `json:"intro"`
}

type Service struct {
	repository *Repository
}

func NewService(repository *Repository) *Service {
	return &Service{repository: repository}
}

func (s *Service) GenerateIntro(ctx context.Context, request IntroRequest) (IntroResponse, error) {
	if request.GithubID <= 0 {
		return IntroResponse{}, ErrInvalidGithubID
	}

	login, err := s.repository.FindLoginByGithubID(ctx, request.GithubID)
	if err != nil {
		return IntroResponse{}, err
	}

	return IntroResponse{
		GithubID: request.GithubID,
		Login:    login,
		Intro:    login + "你是个好人呀",
	}, nil
}
