# Token Query Infrastructure

This directory is the entry point for the next infrastructure iteration.

The previous SAM and raw CloudFormation deployment files have been moved to
[`legacy-sam/`](./legacy-sam/). They are kept as implementation references only:
resource boundaries, parameter names, and deployment notes may still be useful,
but new infrastructure should be created with CDK instead of SAM.

## Planned CDK Layout

The new CDK implementation should start from a clean set of stacks:

- `permissions`: GitHub Actions OIDC provider, deployment role, and AWS runtime roles.
- `foundation`: VPC, subnets, security groups, and database resources.
- `api`: production API Gateway, Lambda, custom domain, and runtime settings.
- `preview-api`: PR-scoped backend preview resources.

The production path and PR preview path should share the stable foundation
where practical. Preview deployments should create short-lived application
resources, not a full copy of networking and database infrastructure.

## Legacy SAM Reference

The legacy deployment documentation is available at:

- [`legacy-sam/DEPLOYMENT.md`](./legacy-sam/DEPLOYMENT.md)
- [`legacy-sam/IAM.md`](./legacy-sam/IAM.md)
- [`legacy-sam/template.yaml`](./legacy-sam/template.yaml)
- [`legacy-sam/network-template.yaml`](./legacy-sam/network-template.yaml)
- [`legacy-sam/db-template.yaml`](./legacy-sam/db-template.yaml)
- [`legacy-sam/iam-template.yaml`](./legacy-sam/iam-template.yaml)
