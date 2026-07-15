package profile

import (
	"context"
	"errors"
)

var ErrInvalidGithubID = errors.New("invalid github id")

type IntroRequest struct {
	GithubID int64 `json:"githubId"`
}

type IntroResponse struct {
	GithubID int64  `json:"githubId"`
	Login    string `json:"login"`
	Intro    string `json:"intro"`
}

type Service struct{}

func NewService() *Service {
	return &Service{}
}

func (s *Service) GenerateIntro(_ context.Context, request IntroRequest) (IntroResponse, error) {
	if request.GithubID <= 0 {
		return IntroResponse{}, ErrInvalidGithubID
	}

	login := "mock-user"
	return IntroResponse{
		GithubID: request.GithubID,
		Login:    login,
		Intro:    login + "你是个好人呀",
	}, nil
}
