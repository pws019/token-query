const { CloudFormationClient, ListStacksCommand } = require("@aws-sdk/client-cloudformation");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

const cfn = new CloudFormationClient({});
const sqs = new SQSClient({});
const secretsManager = new SecretsManagerClient({});

const previewStackPattern = /^token-query-preview-(api|go)-([a-z0-9-]+)$/;
const previewWorkerPattern = /^token-query-pr-([a-z0-9-]+)$/;
const prTitlePreviewIdPattern = /^((?:bug|feat|fix|chore|hotfix)-\d+):/;

async function getSecret(secretArn) {
  const result = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretArn }));
  return result.SecretString;
}

// ListStacks does not support DELETE_COMPLETE filtering server-side in a way that
// also gives us in-progress/failed states we care about, so pull everything and
// filter DELETE_COMPLETE out ourselves.
async function listPreviewStacks() {
  const stacks = [];
  let nextToken;

  do {
    const response = await cfn.send(new ListStacksCommand({ NextToken: nextToken }));
    for (const stack of response.StackSummaries || []) {
      if (stack.StackStatus === "DELETE_COMPLETE") {
        continue;
      }
      const match = previewStackPattern.exec(stack.StackName);
      if (match) {
        stacks.push({ stackName: stack.StackName, previewId: match[2] });
      }
    }
    nextToken = response.NextToken;
  } while (nextToken);

  return stacks;
}

async function listPreviewWorkers(accountId, apiToken) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });

  if (!response.ok) {
    throw new Error(`Cloudflare list workers failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  const workers = [];
  for (const script of body.result || []) {
    const match = previewWorkerPattern.exec(script.id);
    if (match) {
      workers.push({ workerName: script.id, previewId: match[1] });
    }
  }

  return workers;
}

async function listOpenPreviewIds(repo, token) {
  const response = await fetch(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=100`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "token-query-preview-reconciliation",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub list PRs failed: ${response.status} ${await response.text()}`);
  }

  const pulls = await response.json();
  const previewIds = new Set();
  for (const pull of pulls) {
    const match = prTitlePreviewIdPattern.exec(pull.title || "");
    if (match) {
      previewIds.add(match[1]);
    }
  }

  return previewIds;
}

async function deleteWorker(accountId, apiToken, workerName) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiToken}` },
    },
  );

  if (!response.ok && response.status !== 404) {
    throw new Error(`Cloudflare delete worker ${workerName} failed: ${response.status} ${await response.text()}`);
  }
}

exports.handler = async () => {
  const queueUrl = process.env.QUEUE_URL;
  const githubRepo = process.env.GITHUB_REPO;
  const cloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  const [githubToken, cloudflareApiToken] = await Promise.all([
    getSecret(process.env.GITHUB_TOKEN_SECRET_ARN),
    getSecret(process.env.CLOUDFLARE_TOKEN_SECRET_ARN),
  ]);

  const [previewStacks, previewWorkers, openPreviewIds] = await Promise.all([
    listPreviewStacks(),
    listPreviewWorkers(cloudflareAccountId, cloudflareApiToken),
    listOpenPreviewIds(githubRepo, githubToken),
  ]);

  const orphanStacks = previewStacks.filter((stack) => !openPreviewIds.has(stack.previewId));
  const orphanWorkers = previewWorkers.filter((worker) => !openPreviewIds.has(worker.previewId));

  console.log(
    JSON.stringify({
      event: "reconciliation_scan",
      previewStackCount: previewStacks.length,
      previewWorkerCount: previewWorkers.length,
      openPreviewIdCount: openPreviewIds.size,
      orphanStackCount: orphanStacks.length,
      orphanWorkerCount: orphanWorkers.length,
    }),
  );

  // Orphan CFN stacks are handed off to the existing preview-cleanup queue --
  // same DLQ/alarm safety net as the GitHub Actions failure path (Part 6), so
  // there is only one place that retries/reports CloudFormation deletions.
  for (const stack of orphanStacks) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          stackName: stack.stackName,
          previewId: stack.previewId,
          source: "reconciliation",
        }),
      }),
    );
    console.log(JSON.stringify({ event: "reconciliation_enqueued_stack", stackName: stack.stackName }));
  }

  // Cloudflare Workers aren't something the SQS consumer knows how to delete
  // (it only calls CloudFormation), so this deletes them directly instead of
  // inventing a second message shape for one resource type.
  for (const worker of orphanWorkers) {
    await deleteWorker(cloudflareAccountId, cloudflareApiToken, worker.workerName);
    console.log(JSON.stringify({ event: "reconciliation_deleted_worker", workerName: worker.workerName }));
  }
};
