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

### CDK API Deployment

The backend API is deployed by `.github/workflows/deploy-api.yml` through AWS CDK. The PR preview API is deployed by `.github/workflows/deploy-api-preview.yml`.

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
CORS_ORIGIN=https://app.doyouadoreme.online
API_CUSTOM_DOMAIN_NAME=api.doyouadoreme.online
CERTIFICATE_ARN=arn:aws:acm:us-west-2:<account-id>:certificate/<certificate-id>
PREVIEW_BASE_DOMAIN=app.doyouadoreme.online
```

Configure these GitHub repository secrets:

```text
AWS_DEPLOY_ROLE_ARN=arn:aws:iam::<account-id>:role/<github-actions-deploy-role>
INTERNAL_PROXY_TOKEN=shared-secret-with-cloudflare-worker
ADMIN_MIGRATION_TOKEN=temporary-admin-token   # optional; clear after database initialization
```

The CDK foundation stack publishes VPC, security group, database endpoint, and database secret references through SSM parameters. The API stack builds `DATABASE_URL` with a Secrets Manager dynamic reference during deployment, so CI does not need the database password.

For local deployment, build the server before CDK packages the Lambda artifact:

```bash
pnpm --filter server build
pnpm --filter @token-query/infra-cdk cdk deploy token-query-api
```

Preview requests use the same public API origin. The app preview Worker sends `X-Preview-Id`, and the production API Lambda routes matching requests to `token-query-pr-<preview-id>` when that preview function exists.

GitHub Actions workflows are grouped by the public layer names:

```text
deploy-api.yml           # production backend API
deploy-api-preview.yml   # PR backend API preview
deploy-app.yml           # production frontend app Worker
deploy-app-preview.yml   # PR frontend app Worker preview
cleanup-preview.yml      # PR preview cleanup for both app and API resources
```

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
