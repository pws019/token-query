FROM golang:1.22-alpine AS build

WORKDIR /src

COPY go.mod ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/token-query-go ./cmd/server

FROM alpine:3.20

RUN addgroup -S app && adduser -S app -G app
USER app

WORKDIR /app
COPY --from=build /out/token-query-go /app/token-query-go

ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["/app/token-query-go"]
