# CDK Migration Plan

This document records the planned infrastructure migration path for Token Query.
The goal is to move from the legacy SAM/CloudFormation setup to a CDK-managed
deployment that can evolve from the current Lambda API into a future
Lambda-to-Go-on-ECS architecture.

## Target Direction

Long term request flow:

```text
Cloudflare Worker
  -> AWS Lambda
      -> Go service on ECS/Fargate
          -> Aurora PostgreSQL
          -> GitHub API through NAT
```

First implementation milestone:

```text
Cloudflare Worker
  -> AWS Lambda
      -> Aurora PostgreSQL
      -> GitHub API through NAT
```

The first milestone intentionally keeps the current Lambda application shape.
After that path is stable, backend logic can move gradually from Lambda into a
Go service behind Cloud Map.

## Stack Layers

The CDK implementation is split into four layers.

### 1. Permission Layer

Planned stack name:

```text
token-query-permissions
```

Responsibilities:

- GitHub Actions OIDC provider.
- GitHub Actions deploy role.
- IAM policies needed by deployment workflows.
- Permissions that allow application stacks to create their own runtime roles.

Principle:

- Keep this layer limited to permissions that must exist before other stacks can
  deploy, such as the GitHub OIDC deploy entry point.
- Runtime roles should be created by the stack that owns the resource whenever
  possible. Lambda execution roles belong in the Lambda/API stack, ECS task
  roles belong in the Go stack, and CodeBuild service roles belong in the stack
  that defines the CodeBuild project.
- Do not pre-create resource-specific roles here unless there is a concrete
  cross-stack reason.

Initial implementation:

- `AWS::IAM::OIDCProvider` for `https://token.actions.githubusercontent.com`.
- `token-query-github-actions-deploy-role`.
- `/token-query/permissions/github-actions-deploy-role-arn`.
- The deploy role can manage and pass project-scoped roles matching
  `token-query-*`.

Deployment status:

- Deployed manually to `us-west-2`.
- `GitHubActionsDeployRoleArn`:
  `arn:aws:iam::707605822527:role/token-query-github-actions-deploy-role`.
- GitHub Actions secret `AWS_DEPLOY_ROLE_ARN` points to the CDK-managed deploy
  role above.
- The first deployed version also created
  `token-query-lambda-execution-role`; this role is being removed from the
  permissions layer so the application layer can own its runtime roles.

This layer is special because it defines the permissions used by CI/CD itself.
The first deployment should be performed manually from a trusted local AWS
session. After it exists, GitHub Actions can deploy the application and preview
layers.

The permissions stack uses `CliCredentialsStackSynthesizer` because it contains
only IAM and SSM resources. This makes the first deployment use the currently
authenticated local AWS identity instead of the CDK bootstrap deployment roles.
Later stacks that package Lambda or container assets can use the default CDK
synthesizer and the normal CDK bootstrap resources.

### 2. Foundation Layer

Planned stack name:

```text
token-query-foundation
```

Responsibilities:

- VPC.
- Public subnet.
- Private subnets.
- Internet Gateway.
- NAT Gateway.
- Lambda security group.
- Database security group.
- Go service security group.
- Aurora PostgreSQL.
- ECR repository for the Go service image.
- ECS cluster shared by production and preview Go services.
- Cloud Map private DNS namespace shared by production and preview Go services.
- CodeBuild project for building and pushing the Go service image.
- Stable SSM parameters or CloudFormation outputs consumed by application
  stacks.

This layer should change rarely. It is shared by the production API and PR
preview APIs. Preview deployments should not create their own VPC, NAT Gateway,
database, ECR repository, ECS cluster, or Cloud Map namespace.

Initial implementation:

- VPC `token-query-vpc` with CIDR `10.0.0.0/16`.
- One public subnet for the NAT Gateway.
- Three private subnets for Lambda, database, and future internal services.
- One NAT Gateway shared by the private subnets.
- `token-query-lambda-sg`.
- `token-query-db-sg`, allowing PostgreSQL 5432 from the Lambda security group.
- `token-query-go-sg`, allowing port 8080 from the Lambda security group.
- `token-query-db-sg` also allows PostgreSQL 5432 from `token-query-go-sg`.
- ECR repository `token-query-go`.
- ECS cluster `token-query-cluster`.
- Cloud Map private namespace `token-query.internal`.
- CodeBuild project `token-query-go-build`.
- Secrets Manager secret `token-query/db/master` for Aurora master credentials.
- Aurora PostgreSQL Serverless v2 cluster `token-query-db`.
- Aurora instance `token-query-db-instance-1`.
- SSM parameters:
  - `/token-query/foundation/vpc-id`
  - `/token-query/foundation/private-subnet-ids`
  - `/token-query/foundation/lambda-security-group-id`
  - `/token-query/foundation/db-cluster-endpoint`
  - `/token-query/foundation/db-credentials-secret-arn`
  - `/token-query/foundation/db-security-group-id`
  - `/token-query/foundation/go-security-group-id`
  - `/token-query/foundation/ecr-repository-name`
  - `/token-query/foundation/ecr-repository-uri`
  - `/token-query/foundation/ecs-cluster-name`
  - `/token-query/foundation/cloudmap-namespace-id`
  - `/token-query/foundation/cloudmap-namespace-name`
  - `/token-query/foundation/go-codebuild-project-name`

Deployment notes:

- Deployed manually to `us-west-2`.
- The current implementation generates the database master password in Secrets
  Manager. Updating an existing manually-passworded database to this version
  rotates the master password to the generated secret value.
- This layer creates billable resources, especially NAT Gateway and Aurora.

### 3. Application Layer

Planned stack name:

```text
token-query-api
```

Responsibilities:

- Production Lambda function: `token-query-function`.
- Lambda execution role managed by the application stack.
- CloudWatch log group: `/aws/lambda/token-query-function`.
- HTTP API Gateway: `token-query-http-api`.
- Lambda proxy integration.
- API routes and `$default` auto-deploy stage.
- API Gateway custom domain for `api.doyouadoreme.online`.
- Root API mapping from `api.doyouadoreme.online` to the `$default` stage.
- Preview routing in the production Lambda entrypoint. When `APP_ENV=prod` and
  `X-Preview-Id` is present, the Lambda tries to invoke
  `token-query-pr-<preview-id>` before falling back to production logic.
- Outputs such as `ApiEndpoint`, `CustomDomainUrl`, `CustomDomainRegionalDomainName`,
  and `FunctionName`.

This layer is the first application milestone. It should replace the legacy SAM
API stack and prove the current backend works through CDK.

Implementation status:

- Implemented in `infra/cdk/lib/api-stack.ts`.
- Uses the prebuilt server artifact from `apps/server/dist`.
- Reads foundation values through SSM-backed CloudFormation parameters:
  - `/token-query/foundation/private-subnet-ids`
  - `/token-query/foundation/lambda-security-group-id`
  - `/token-query/foundation/db-cluster-endpoint`
- Reads the database credentials secret ARN from
  `/token-query/foundation/db-credentials-secret-arn`.
- Builds `DATABASE_URL` with a Secrets Manager dynamic reference during stack
  deployment, so CI does not need to pass the database password and the Lambda
  code does not need the AWS Secrets Manager SDK.
- `InternalProxyToken` and `AdminMigrationToken` are optional parameters for the
  first connectivity test. Set them when testing the Worker-protected path or
  admin database initialization.
- Creates the API Gateway custom domain with the existing ACM certificate:
  `arn:aws:acm:us-west-2:707605822527:certificate/6dd559f1-2c41-43ab-823a-ba094199fcb1`.
- Grants the production Lambda permission to invoke preview functions matching
  `token-query-pr-*`.
- After deployment, Cloudflare DNS for `api.doyouadoreme.online` should point to
  the stack output `CustomDomainRegionalDomainName`.

Recommended manual sequence:

```bash
pnpm --filter server build
pnpm --filter @token-query/infra-cdk cdk diff token-query-api
pnpm --filter @token-query/infra-cdk cdk deploy token-query-api
```

### 3b. Go Application Layer

Stack name:

```text
token-query-go
```

Responsibilities:

- Production Go ECS task execution role.
- Production Go ECS task role.
- CloudWatch log group `/ecs/token-query-go`.
- ECS task definition.
- ECS service `token-query-go-service`.
- Cloud Map service `go.token-query.internal`.
- Runtime environment for the Go container, including `PORT=8080`, database
  host metadata, and database password injected from Secrets Manager as an ECS
  container secret.
- Image tag parameter used to deploy a specific ECR image version.

This layer reuses foundation resources:

- ECR repository `token-query-go`.
- ECS cluster `token-query-cluster`.
- Private subnets.
- Go security group.
- Cloud Map namespace `token-query.internal`.
- Aurora endpoint and credentials secret.

Current implementation supports a manually supplied image tag:

```bash
pnpm --filter @token-query/infra-cdk cdk deploy token-query-go \
  --parameters ImageTag=<short-sha-or-manual-tag>
```

The production Go deployment workflow starts the foundation-managed CodeBuild
project, waits for it to push the image tag to ECR, then deploys this stack with
that tag.

### 4. Application Preview Layer

Planned stack naming pattern:

```text
token-query-preview-api-<preview-id>
```

Responsibilities:

- PR-scoped Lambda function.
- PR-scoped CloudWatch log group.
- No PR-scoped API Gateway. Preview Lambdas are invoked by the production Lambda
  router using the function name `token-query-pr-<preview-id>`.
- Preview ID runtime configuration.
- Destroy path when a PR is closed or merged.

This layer should be short-lived and cheap. It reuses the foundation layer and
only duplicates application compute resources.

The preview backend does not create its own custom domain or public API Gateway.
The external backend origin remains:

```text
https://api.doyouadoreme.online
```

When the frontend preview Worker sends `X-Preview-Id: <preview-id>`, the
production Lambda entrypoint checks whether it is running with `APP_ENV=prod`.
If so, it attempts to invoke `token-query-pr-<preview-id>` with the original
API Gateway event. If the preview function does not exist, the request falls
back to the production handler. Preview Lambdas run with `APP_ENV=preview`, so
  they do not recursively route preview requests.

### 5. Go Application Preview Layer

Stack naming pattern:

```text
token-query-preview-go-<preview-id>
```

Responsibilities:

- PR-scoped ECS task definition revision.
- PR-scoped ECS service `token-query-go-pr-<preview-id>`.
- PR-scoped CloudWatch log group `/ecs/token-query-go-pr-<preview-id>`.
- PR-scoped Cloud Map service `go-<preview-id>.token-query.internal`.
- Image tag parameter, usually `<preview-id>-<short-sha>`.

Implemented workflows:

- `Deploy Go Preview` builds the Go image through CodeBuild and deploys
  `token-query-preview-go-<preview-id>`.
- `Cleanup Go Preview` destroys the same stack when the PR is closed or when
  manually dispatched with a `preview_id`.

This layer should copy application runtime resources only. It reuses:

- VPC.
- Private subnets.
- NAT gateway.
- Aurora database.
- ECR repository.
- ECS cluster.
- Cloud Map namespace.
- Security groups.

Preview Lambda should receive:

```text
GO_SERVICE_ORIGIN=http://go-<preview-id>.token-query.internal:8080
```

Production Lambda keeps:

```text
GO_SERVICE_ORIGIN=http://go.token-query.internal:8080
```

## Implementation Order

1. Create the CDK project skeleton under `infra/cdk`.
2. Implement and synthesize the permission layer.
3. Deploy the permission layer manually.
4. Implement the foundation layer.
5. Deploy the foundation layer manually or through a controlled workflow.
6. Implement the application layer for the current Lambda API.
7. Deploy the application layer.
8. Verify direct API Gateway access to `/health`.
9. Update Cloudflare Worker `LAMBDA_API_ORIGIN` to the new API endpoint.
10. Verify `Cloudflare Worker -> Lambda -> /health`.
11. Verify Lambda database access.
12. Verify Lambda outbound access to GitHub through NAT.
13. Implement the application preview layer.
14. Add backend PR preview deployment and cleanup workflows.
15. Add shared Go infrastructure to the foundation layer.
16. Add `token-query-go` for the production ECS/Fargate Go service.
17. Add CodeBuild for Go image build and ECR push.
18. Add `token-query-preview-go-<preview-id>` for PR-scoped Go ECS services.
19. Gradually migrate backend logic from Lambda into the Go service.

## Destroy Order

Destroy stacks in the reverse order of their dependencies:

1. `token-query-preview-api-*`
2. `token-query-preview-go-*`
3. `token-query-go`
4. `token-query-api`
5. `token-query-foundation`
6. `token-query-permissions`

Preview stacks should be destroyed first because they are short-lived
application resources that reuse the shared foundation layer. The main
application stack should be destroyed before the foundation layer because
Lambda, API Gateway, security groups, and VPC ENIs can keep foundation resources
in use.

The foundation layer should be destroyed only after all application and preview
stacks are gone. The permissions layer should be destroyed last because it owns
the deploy role used by GitHub Actions and may still be needed to clean up other
stacks.

Recommended manual sequence:

```bash
pnpm --filter @token-query/infra-cdk cdk destroy token-query-preview-api-<preview-id>
pnpm --filter @token-query/infra-cdk cdk destroy token-query-preview-go-<preview-id>
pnpm --filter @token-query/infra-cdk cdk destroy token-query-go
pnpm --filter @token-query/infra-cdk cdk destroy token-query-api
pnpm --filter @token-query/infra-cdk cdk destroy token-query-foundation
pnpm --filter @token-query/infra-cdk cdk destroy token-query-permissions
```

Avoid `cdk destroy --all` for normal cleanup. Explicit stack names make the
destructive path easier to review and reduce the chance of removing shared
foundation or permission resources unexpectedly.

## Configuration Principles

- Repository-level GitHub Actions variables are sufficient for this project
  stage. GitHub Environments are intentionally deferred.
- Sensitive values remain GitHub Secrets.
- Cloudflare runtime values may originate from GitHub Actions variables, but
  they should be documented as Worker runtime configuration.
- Foundation resource identifiers should be exported by CDK, not copied into
  GitHub variables.
- Preview deployments should copy application resources, not the entire cloud
  foundation.

Current GitHub Actions variables:

```text
AWS_REGION
CLOUDFLARE_WORKER_DOMAIN
CORS_ORIGIN
LAMBDA_API_ORIGIN
PREVIEW_BASE_DOMAIN
PREVIEW_LAMBDA_API_ORIGIN
```

Current GitHub Actions secrets:

```text
ADMIN_MIGRATION_TOKEN
AWS_DEPLOY_ROLE_ARN
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
DB_PASSWORD
INTERNAL_PROXY_TOKEN
```

## Review Checkpoints

Before deploying each layer, review:

- Which resources will be created.
- Which existing variables or secrets are consumed.
- Whether the layer is long-lived or PR-scoped.
- Whether the layer should be manually deployed or deployed by GitHub Actions.
- How the layer will be deleted or rolled back.

The migration should stay incremental. Each step should produce a deployable
state that can be tested before the next layer is added.
