const { CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand } = require("@aws-sdk/client-cloudwatch-logs");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

const logsClient = new CloudWatchLogsClient({});
const secretsManager = new SecretsManagerClient({});

const FINGERPRINT_LABEL = "ops-agent-db-upsert-failed";
const GEMINI_MODEL = "gemini-flash-latest"; // alias, not a pinned version -- see docs/todayToDo-ai-ops-agent.md

async function getSecret(secretArn) {
  const result = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretArn }));
  return result.SecretString;
}

// Logs Insights queries are asynchronous: StartQuery returns a queryId immediately, the actual
// results have to be polled for with GetQueryResults until status flips to "Complete".
async function queryRecentDbUpsertFailedLogs(logGroupName, startTimeMs, endTimeMs) {
  const start = await logsClient.send(
    new StartQueryCommand({
      logGroupName,
      startTime: Math.floor(startTimeMs / 1000),
      endTime: Math.floor(endTimeMs / 1000),
      queryString:
        'fields @timestamp, @message | filter level = "error" and event = "github_profile_request_failed" and code = "database_upsert_failed" | sort @timestamp desc | limit 5',
      limit: 5,
    }),
  );

  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const result = await logsClient.send(new GetQueryResultsCommand({ queryId: start.queryId }));
    if (result.status === "Complete") {
      return (result.results || [])
        .map((row) => row.find((field) => field.field === "@message")?.value)
        .filter(Boolean);
    }
  }

  throw new Error(`Logs Insights query ${start.queryId} did not complete in time`);
}

async function askGeminiForRootCause(alarmName, logLines) {
  const apiKey = await getSecret(process.env.GEMINI_API_KEY_SECRET_ARN);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `以下是 token-query 项目 CloudWatch Alarm "${alarmName}" 触发时抓到的相关错误日志（JSON 格式，每行一条，来自 apps/server 的 queryAndSaveGithubProfile 数据库 upsert 调用）：

${logLines.join("\n")}

请用中文给出：1）最可能的根因（一句话）；2）建议的排查方向（1-2 条）。不要编造日志里没有的信息。`,
              },
            ],
          },
        ],
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Gemini API failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  return body.candidates[0].content.parts[0].text;
}

async function findExistingIssue(githubToken, repo) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/issues?state=open&labels=${FINGERPRINT_LABEL}`,
    { headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json" } },
  );
  if (!response.ok) {
    throw new Error(`GitHub search issues failed: ${response.status} ${await response.text()}`);
  }
  const issues = await response.json();
  return issues[0] ?? null;
}

async function createIssue(githubToken, repo, alarmName, analysis, logLines) {
  const body = [
    `**触发时间**: ${new Date().toISOString()}`,
    `**Alarm**: ${alarmName}`,
    ``,
    `**LLM 分析**:`,
    analysis,
    ``,
    `<details><summary>原始日志片段</summary>\n\n\`\`\`\n${logLines.join("\n")}\n\`\`\`\n</details>`,
  ].join("\n");

  const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json" },
    body: JSON.stringify({
      title: "[ops-agent] db_upsert_failed",
      body,
      labels: [FINGERPRINT_LABEL, "ops-agent"],
    }),
  });
  if (!response.ok) {
    throw new Error(`GitHub create issue failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function commentOnIssue(githubToken, repo, issueNumber, analysis) {
  const body = `**又触发了一次**（${new Date().toISOString()}）:\n\n${analysis}`;
  const response = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json" },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) {
    throw new Error(`GitHub create comment failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

exports.handler = async (event) => {
  const alarmName = event.detail.alarmName;
  const stateChangeTime = new Date(event.detail.state.timestamp).getTime();

  // Alarm evaluation has its own delay, so the log line that actually caused the ALARM state
  // can be several minutes older than the state-change timestamp -- widen the lookback rather
  // than aligning the window tightly to the event time.
  const logLines = await queryRecentDbUpsertFailedLogs(
    process.env.SOURCE_LOG_GROUP,
    stateChangeTime - 10 * 60 * 1000,
    stateChangeTime + 60 * 1000,
  );

  if (logLines.length === 0) {
    console.warn(JSON.stringify({ level: "warn", event: "ops_agent_no_logs_found", alarmName }));
    return;
  }

  const analysis = await askGeminiForRootCause(alarmName, logLines);
  const githubToken = await getSecret(process.env.GITHUB_TOKEN_SECRET_ARN);
  const repo = process.env.GITHUB_REPO;

  const existingIssue = await findExistingIssue(githubToken, repo);
  if (existingIssue) {
    await commentOnIssue(githubToken, repo, existingIssue.number, analysis);
    console.log(JSON.stringify({ level: "info", event: "ops_agent_commented", issue: existingIssue.number }));
  } else {
    const issue = await createIssue(githubToken, repo, alarmName, analysis, logLines);
    console.log(JSON.stringify({ level: "info", event: "ops_agent_issue_created", issue: issue.number }));
  }
};
