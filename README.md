# token-query

This project was created with [Better-T-Stack](https://github.com/AmanVarshney01/create-better-t-stack), a modern TypeScript stack that combines React, React Router, Hono, TRPC, and more.

## Features

- **TypeScript** - For type safety and improved developer experience
- **React Router** - Declarative routing for React
- **TailwindCSS** - Utility-first CSS for rapid UI development
- **Shared UI package** - shadcn/ui primitives live in `packages/ui`
- **Hono** - Lightweight, performant server framework
- **tRPC** - End-to-end type-safe APIs
- **Node.js** - Runtime environment
- **Drizzle** - TypeScript-first ORM
- **PostgreSQL** - Database engine
- **Turborepo** - Optimized monorepo build system

## Getting Started

First, install the dependencies:

```bash
pnpm install
```

## Database Setup

This project uses PostgreSQL with Drizzle ORM.

1. Make sure you have a PostgreSQL database set up.
2. Update your `apps/server/.env` file with your PostgreSQL connection details.

3. Apply the schema to your database:

```bash
pnpm run db:push
```

Then, run the development server:

```bash
pnpm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser to see the web application.
The API is running at [http://localhost:3000](http://localhost:3000).

## AWS Lambda Deployment

The Hono server supports both local Node.js serving and AWS Lambda deployment.

Build the server:

```bash
pnpm --filter server build
```

Build output:

- `apps/server/dist/index.mjs`: local Node.js entry
- `apps/server/dist/lambda.mjs`: AWS Lambda entry

For AWS Lambda, set the handler to one of the following, depending on your zip layout:

```text
lambda.handler       # if apps/server/dist/* is the zip root
dist/lambda.handler  # if the zip root contains the dist/ directory
```

Configure these Lambda environment variables:

```text
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE
CORS_ORIGIN=https://your-frontend-domain.example.com
INTERNAL_PROXY_TOKEN=shared-secret-with-cloudflare-worker
NODE_ENV=production
```

Local development reads the same variable names from `apps/server/.env`. In AWS, do not upload `.env`; configure the values in Lambda environment variables or through your deployment tool. If the database is in a private VPC, attach the Lambda function to the same VPC/subnets/security groups, or use an RDS Proxy endpoint in `DATABASE_URL`.

### SAM Lambda API Deployment

The Lambda API is deployed by `.github/workflows/deploy-lambda-api.yml` through AWS SAM. The first SAM migration phase manages the API Lambda and HTTP API Gateway, while reusing the existing VPC subnets, Lambda security group, and Aurora database.

Current target runtime shape:

```text
AWS_REGION=us-west-2
Runtime=nodejs22.x
Handler=lambda.handler
Architecture=arm64
```

Configure these GitHub repository variables:

```text
AWS_REGION=us-west-2
SAM_STACK_NAME=token-query-api
CORS_ORIGIN=https://app.doyouadoreme.online
PRIVATE_SUBNET_IDS_SSM_PARAM=/token-query/network/private-subnet-ids
LAMBDA_SECURITY_GROUP_ID_SSM_PARAM=/token-query/network/lambda-security-group-id
LAMBDA_EXECUTION_ROLE_ARN=arn:aws:iam::<account-id>:role/service-role/<lambda-execution-role>
CERTIFICATE_ARN=arn:aws:acm:<region>:<account-id>:certificate/<certificate-id>
```

These are SSM parameter paths, not literal resource IDs - `infra/network-template.yaml` publishes the actual values there on every network stack deploy, and CloudFormation resolves them live when the API stack deploys.

Configure these GitHub repository secrets:

```text
AWS_DEPLOY_ROLE_ARN=arn:aws:iam::<account-id>:role/<github-actions-lambda-deploy-role>
DB_PASSWORD=<aurora-master-password>   # must match DbMasterPassword used to deploy infra/db-template.yaml
INTERNAL_PROXY_TOKEN=shared-secret-with-cloudflare-worker
ADMIN_MIGRATION_TOKEN=temporary-admin-token   # optional; clear after database initialization
```

`DATABASE_URL` is no longer a stored secret - the API stack builds it at deploy time from `DB_PASSWORD` plus the Aurora endpoint it reads live from the `/token-query/db/cluster-endpoint` SSM parameter (published by `infra/db-template.yaml`). This means the connection string always points at whatever Aurora endpoint currently exists, even after the DB stack is torn down and recreated (recreating gives the cluster a new endpoint hostname; only the password needs to stay in sync).

The recommended AWS credential flow is GitHub OIDC. Because SAM deploys through CloudFormation and creates Lambda/API Gateway resources, the IAM role used by `AWS_DEPLOY_ROLE_ARN` needs CloudFormation, S3 artifact, Lambda, API Gateway, IAM role, logs, and VPC attachment permissions.

`sam deploy --resolve-s3` also creates or updates the SAM managed artifact stack named `aws-sam-cli-managed-default` the first time it runs. Include both the application stack and the SAM managed stack in the deployment role policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateChangeSet",
        "cloudformation:CreateStack",
        "cloudformation:DeleteChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStacks",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:GetTemplate",
        "cloudformation:UpdateStack"
      ],
      "Resource": [
        "arn:aws:cloudformation:us-west-2:<account-id>:stack/token-query-api/*",
        "arn:aws:cloudformation:us-west-2:<account-id>:stack/aws-sam-cli-managed-default/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:GetBucketLocation",
        "s3:GetObject",
        "s3:ListBucket",
        "s3:PutObject"
      ],
      "Resource": [
        "arn:aws:s3:::aws-sam-cli-managed-default-*",
        "arn:aws:s3:::aws-sam-cli-managed-default-*/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "lambda:AddPermission",
        "lambda:CreateFunction",
        "lambda:DeleteFunction",
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:RemovePermission",
        "lambda:TagResource",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration"
      ],
      "Resource": "arn:aws:lambda:us-west-2:<account-id>:function:token-query-api-*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "apigateway:DELETE",
        "apigateway:GET",
        "apigateway:PATCH",
        "apigateway:POST",
        "apigateway:PUT"
      ],
      "Resource": "arn:aws:apigateway:us-west-2::/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "iam:AttachRolePolicy",
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:DetachRolePolicy",
        "iam:GetRole",
        "iam:PassRole",
        "iam:TagRole"
      ],
      "Resource": "arn:aws:iam::<account-id>:role/token-query-api-*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:DeleteLogGroup",
        "logs:DescribeLogGroups",
        "logs:PutRetentionPolicy",
        "logs:TagResource"
      ],
      "Resource": "arn:aws:logs:us-west-2:<account-id>:log-group:/aws/lambda/token-query-api-*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeSubnets",
        "ec2:DescribeVpcs"
      ],
      "Resource": "*"
    }
  ]
}
```

For local deployment, build the server before SAM packages the Lambda artifact:

```bash
pnpm --filter server build
cd infra
sam build
sam deploy
```

SAM templates and config live under `infra/`: `infra/template.yaml` (Lambda + HTTP API, deployed by CI), `infra/network-template.yaml` and `infra/db-template.yaml` (VPC/Aurora, deployed manually only - never wired into the auto-triggered pipeline). `infra/samconfig.toml` stores non-secret deployment defaults for the API stack. Pass secret parameters through GitHub Actions secrets, `sam deploy --parameter-overrides`, or a future Secrets Manager/SSM integration.

The SAM stack outputs the new API endpoint as `ApiEndpoint`. After verifying `/api/health`, update the Cloudflare Worker `LAMBDA_API_ORIGIN` value to this endpoint when you are ready to cut traffic over from the manually created API Gateway.

Keep production runtime settings out of source control:

```text
DATABASE_URL
CORS_ORIGIN
INTERNAL_PROXY_TOKEN
ADMIN_MIGRATION_TOKEN   # temporary; remove or clear after database initialization
NODE_ENV
```

## Cloudflare Worker SSR Deployment

The frontend is deployed by GitHub Actions to the `token-query` Worker. The Worker serves React Router SSR and proxies `/api/*` requests to the AWS Lambda API. The workflow generates the Wrangler config at deploy time, so no checked-in `wrangler.jsonc` is required.

Configure these GitHub repository variables:

```text
CLOUDFLARE_WORKER_DOMAIN=your-frontend-domain.example.com
LAMBDA_API_ORIGIN=https://your-api-gateway-domain.example.com
```

Configure these GitHub repository secrets:

```text
CLOUDFLARE_ACCOUNT_ID=your-cloudflare-account-id
CLOUDFLARE_API_TOKEN=your-cloudflare-api-token
INTERNAL_PROXY_TOKEN=shared-secret-with-lambda
```

The Cloudflare API token needs these permissions:

```text
Account / Workers Scripts / Edit
Account / Account Settings / Read
Zone / Workers Routes / Edit
Zone / Zone / Read
User / User Details / Read
```

The workflow writes these values into the Cloudflare Worker runtime:

```text
LAMBDA_API_ORIGIN from GitHub repository variables
INTERNAL_PROXY_TOKEN from GitHub repository secrets
```

The workflow also enables Cloudflare Worker observability logs through the generated Wrangler config.

Bind the same custom frontend domain to the `token-query` Worker in Cloudflare Dashboard. `CLOUDFLARE_WORKER_DOMAIN` should be the Custom Domain host name only, without `https://` and without `/*`.

```bash
wrangler deploy --config=apps/web/wrangler.generated.jsonc --domain="$CLOUDFLARE_WORKER_DOMAIN" --keep-vars
```

## UI Customization

React web apps in this stack share shadcn/ui primitives through `packages/ui`.

- Change design tokens and global styles in `packages/ui/src/styles/globals.css`
- Update shared primitives in `packages/ui/src/components/*`
- Adjust shadcn aliases or style config in `packages/ui/components.json` and `apps/web/components.json`

### Add more shared components

Run this from the project root to add more primitives to the shared UI package:

```bash
npx shadcn@latest add accordion dialog popover sheet table -c packages/ui
```

Import shared components like this:

```tsx
import { Button } from "@token-query/ui/components/button";
```

### Add app-specific blocks

If you want to add app-specific blocks instead of shared primitives, run the shadcn CLI from `apps/web`.

## Project Structure

```
token-query/
├── apps/
│   ├── web/         # Frontend application (React + React Router)
│   └── server/      # Backend API (Hono, TRPC)
├── packages/
│   ├── ui/          # Shared shadcn/ui components and styles
│   ├── api/         # API layer / business logic
│   └── db/          # Database schema & queries
```

## Available Scripts

- `pnpm run dev`: Start all applications in development mode
- `pnpm run build`: Build all applications
- `pnpm run dev:web`: Start only the web application
- `pnpm run dev:server`: Start only the server
- `pnpm run check-types`: Check TypeScript types across all apps
- `pnpm run db:push`: Push schema changes to database
- `pnpm run db:generate`: Generate database client/types
- `pnpm run db:migrate`: Run database migrations
- `pnpm run db:studio`: Open database studio UI
