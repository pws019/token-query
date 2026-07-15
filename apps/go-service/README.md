# token-query Go service

This service is the future Go runtime behind the Lambda API.

Current local endpoints:

```text
GET /health
POST /profile/intro
```

Run locally after Go is installed:

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

Expected mock response:

```json
{
  "githubId": 123,
  "login": "mock-user",
  "intro": "mock-user你是个好人呀"
}
```

Build the container:

```bash
docker build -t token-query-go ./apps/go-service
```
