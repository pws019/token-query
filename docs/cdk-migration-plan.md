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
- Permissions that allow application stacks to create their own runtime roles
  for Lambda, CodeBuild, ECS task execution, and ECS tasks.

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

The permissions stack uses the legacy synthesizer because it contains only IAM
and SSM resources. This makes the first deployment use the currently
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
- Aurora PostgreSQL.
- Stable SSM parameters or CloudFormation outputs consumed by application
  stacks.

This layer should change rarely. It is shared by the production API and PR
preview APIs. Preview deployments should not create their own VPC, NAT Gateway,
or database.

Initial implementation:

- VPC `token-query-vpc` with CIDR `10.0.0.0/16`.
- One public subnet for the NAT Gateway.
- Three private subnets for Lambda, database, and future internal services.
- One NAT Gateway shared by the private subnets.
- `token-query-lambda-sg`.
- `token-query-db-sg`, allowing PostgreSQL 5432 from the Lambda security group.
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
- After deployment, Cloudflare DNS for `api.doyouadoreme.online` should point to
  the stack output `CustomDomainRegionalDomainName`.

Recommended manual sequence:

```bash
pnpm --filter server build
pnpm --filter @token-query/infra-cdk cdk diff token-query-api
pnpm --filter @token-query/infra-cdk cdk deploy token-query-api
```

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

## Destroy Order

Destroy stacks in the reverse order of their dependencies:

1. `token-query-preview-api-*`
2. `token-query-api`
3. `token-query-foundation`
4. `token-query-permissions`

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
