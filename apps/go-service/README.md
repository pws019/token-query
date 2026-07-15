# token-query Go service

This service is the future Go runtime behind the Lambda API.

Current local endpoints:

```text
GET /health
POST /profile/intro
```

Run locally after Go is installed. The service reads `DATABASE_URL`; when it is
not set, local dev falls back to `postgresql://postgres:password@localhost:5432/postgres`.

```bash
cd apps/go-service
go run ./cmd/server
```

Test:

```bash
curl http://localhost:8080/health
curl -X POST http://localhost:8080/profile/intro \
  -H "Content-Type: application/json" \
  -d '{"githubId":123}'
```

Expected response after a GitHub profile has already been saved by the Lambda
layer:

```json
{
  "githubId": 123,
  "login": "your-login",
  "intro": "your-login你是个好人呀"
}
```

Build the container:

```bash
docker build -t token-query-go ./apps/go-service
```
