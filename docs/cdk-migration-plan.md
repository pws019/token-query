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
- Runtime IAM roles for Lambda, CodeBuild, ECS task execution, and ECS tasks
  as those layers are introduced.

Initial implementation:

- `AWS::IAM::OIDCProvider` for `https://token.actions.githubusercontent.com`.
- `token-query-github-actions-deploy-role`.
- `token-query-lambda-execution-role`.
- `/token-query/permissions/github-actions-deploy-role-arn`.
- `/token-query/permissions/lambda-execution-role-arn`.

This layer is special because it defines the permissions used by CI/CD itself.
The first deployment should be performed manually from a trusted local AWS
session. After it exists, GitHub Actions can deploy the application and preview
layers.

The permissions stack uses a bootstrapless synthesizer because it contains only
IAM and SSM resources. This keeps the first deployment independent from CDK
asset publishing. Later stacks that package Lambda or container assets can use
the default CDK synthesizer and the normal CDK bootstrap resources.

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
- Aurora PostgreSQL.
- Stable SSM parameters or CloudFormation outputs consumed by application
  stacks.

This layer should change rarely. It is shared by the production API and PR
preview APIs. Preview deployments should not create their own VPC, NAT Gateway,
or database.

### 3. Application Layer

Planned stack name:

```text
token-query-api
```

Responsibilities:

- Production Lambda function.
- Lambda execution role.
- CloudWatch log group.
- HTTP API Gateway.
- Lambda integration.
- API routes and stage.
- Optional custom domain for `api.doyouadoreme.online`.
- Outputs such as `ApiEndpoint` and `FunctionName`.

This layer is the first application milestone. It should replace the legacy SAM
API stack and prove the current backend works through CDK.

### 4. Application Preview Layer

Planned stack naming pattern:

```text
token-query-preview-api-<preview-id>
```

Responsibilities:

- PR-scoped Lambda function.
- PR-scoped CloudWatch log group.
- Optional PR-scoped HTTP API Gateway.
- Preview ID runtime configuration.
- Destroy path when a PR is closed or merged.

This layer should be short-lived and cheap. It reuses the foundation layer and
only duplicates application compute resources.

## Implementation Order

1. Create the CDK project skeleton under `infra/cdk`.
2. Implement and synthesize the permission layer.
3. Deploy the permission layer manually.
4. Implement the foundation layer.
5. Deploy the foundation layer manually or through a controlled workflow.
6. Implement the application layer for the current Lambda API.
7. Deploy the application layer.
8. Verify direct API Gateway access to `/api/health`.
9. Update Cloudflare Worker `LAMBDA_API_ORIGIN` to the new API endpoint.
10. Verify `Cloudflare Worker -> Lambda -> /api/health`.
11. Verify Lambda database access.
12. Verify Lambda outbound access to GitHub through NAT.
13. Implement the application preview layer.
14. Add backend PR preview deployment and cleanup workflows.
15. Add ECS/Fargate and Cloud Map for the future Go service.
16. Gradually migrate backend logic from Lambda into the Go service.

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
