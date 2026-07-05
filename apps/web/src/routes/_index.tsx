import { NavLink } from "react-router";

import type { Route } from "./+types/_index";
import styles from "../styles/architecture.module.css";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "架构图 - token-query" },
    { name: "description", content: "从浏览器到 Aurora：Cloudflare 与 AWS 之间的运行时架构" },
  ];
}

function cx(...classNames: Array<string | false | undefined>) {
  return classNames.filter(Boolean).join(" ");
}

export default function Index() {
  return (
    <div className={styles.archRoot}>
      <div className={styles.page}>
        <header className={styles.top}>
          <div className={styles.topBar}>
            <p className={styles.eyebrow}>token-query // runtime architecture</p>
            <NavLink to="/profile" className={styles.navLink}>
              → profile
            </NavLink>
          </div>
          <h1>From browser to Aurora, through Cloudflare and AWS</h1>
          <p>
            One request&apos;s path: the frontend is served and rendered by Cloudflare, proxied to
            an AWS-hosted API, and answered by a Lambda function that lives inside a private VPC
            alongside Aurora PostgreSQL. Four independent CloudFormation stacks provision the AWS
            half; only one of them deploys automatically.
          </p>
        </header>

        <div className={styles.pipeline}>
          {/* CLIENT */}
          <div className={cx(styles.zone, styles.client)}>
            <div className={styles.zoneHead}>
              <h2>
                <span className={styles.dot} />
                browser
              </h2>
              <span className={styles.where}>user&apos;s device</span>
            </div>
            <div className={styles.box}>
              <p className={styles.name}>app.doyouadoreme.online</p>
              <p className={styles.desc}>
                Requests the page, then calls the API for data — both routed through Cloudflare.
              </p>
            </div>
          </div>

          <div className={styles.arrowConnector}>
            <div className={styles.line}>
              <span className={styles.pulse} style={{ animationDelay: "0s" }} />
            </div>
            <span className={styles.label}>HTTPS</span>
            <div className={styles.arrowhead} />
          </div>

          {/* CLOUDFLARE */}
          <div className={cx(styles.zone, styles.cloudflare)}>
            <div className={styles.zoneHead}>
              <h2>
                <span className={styles.dot} />
                cloudflare
              </h2>
              <span className={styles.where}>Pages + Worker</span>
            </div>
            <div className={cx(styles.row, styles.cols2)}>
              <div className={cx(styles.box, styles.accentCf)}>
                <p className={styles.name}>Pages</p>
                <p className={styles.desc}>Hosts and serves the built frontend assets.</p>
              </div>
              <div className={cx(styles.box, styles.accentCf)}>
                <p className={styles.name}>
                  Worker <span className={styles.badge}>SSR + proxy</span>
                </p>
                <p className={styles.desc}>
                  Server-renders the frontend, then proxies API calls onward using a shared secret.
                </p>
              </div>
            </div>
            <div className={styles.certStrip}>
              <span className={styles.mono}>X-Internal-Proxy-Token</span>
              <span>
                — shared secret attached to every request the Worker forwards to AWS; the Lambda
                rejects anything without it.
              </span>
            </div>
          </div>

          <div className={styles.arrowConnector}>
            <div className={styles.line}>
              <span className={styles.pulse} style={{ animationDelay: "0.5s" }} />
            </div>
            <span className={styles.label}>LAMBDA_API_ORIGIN</span>
            <div className={styles.arrowhead} />
          </div>

          {/* EDGE / DNS / CERT */}
          <div className={cx(styles.zone, styles.edge)}>
            <div className={styles.zoneHead}>
              <h2>
                <span className={styles.dot} />
                dns + tls handoff
              </h2>
              <span className={styles.where}>api.doyouadoreme.online</span>
            </div>
            <div className={cx(styles.row, styles.cols2)}>
              <div className={cx(styles.box, styles.accentFlow)}>
                <p className={styles.name}>Cloudflare CNAME</p>
                <p className={styles.desc}>
                  Manually kept in sync — points at API Gateway&apos;s regional target, which
                  changes if the API stack is ever rebuilt.
                </p>
              </div>
              <div className={cx(styles.box, styles.accentFlow)}>
                <p className={styles.name}>ACM Certificate</p>
                <p className={styles.desc}>
                  DNS-validated TLS cert for the custom domain. Can&apos;t be managed by
                  CloudFormation — referenced by ARN only.
                </p>
              </div>
            </div>
          </div>

          <div className={styles.arrowConnector}>
            <div className={styles.line}>
              <span className={styles.pulse} style={{ animationDelay: "1s" }} />
            </div>
            <span className={styles.label}>HTTPS · custom domain mapping</span>
            <div className={styles.arrowhead} />
          </div>

          {/* AWS */}
          <div className={cx(styles.zone, styles.aws)}>
            <div className={styles.zoneHead}>
              <h2>
                <span className={styles.dot} />
                aws · us-west-2
              </h2>
              <span className={styles.where}>token-query-api</span>
            </div>

            <div className={cx(styles.box, styles.accentAws)}>
              <p className={styles.name}>
                HTTP API <span className={styles.badge}>token-query-http-api</span>
              </p>
              <p className={styles.desc}>
                API Gateway v2, single ANY /{"{proxy+}"} route forwarding straight to Lambda
                inside the VPC below.
              </p>
            </div>

            <div className={styles.vpcFrame}>
              <p className={styles.vpcLabel}>token-query-vpc — 10.0.0.0/16</p>
              <div className={styles.subnetRow}>
                <div className={cx(styles.subnet, styles.public)}>
                  <p className={styles.subnetTitle}>public subnet</p>
                  <div className={styles.box}>
                    <p className={styles.name}>NAT Gateway</p>
                    <p className={styles.desc}>
                      Only egress path out of the private subnets — every outbound call from
                      Lambda passes through here.
                    </p>
                  </div>
                </div>
                <div className={cx(styles.subnet, styles.private)}>
                  <p className={styles.subnetTitle}>private subnets ×2</p>
                  <div className={cx(styles.box, styles.accentAws)}>
                    <p className={styles.name}>
                      Lambda <span className={styles.badge}>token-query-function</span>
                    </p>
                    <p className={styles.desc}>
                      Hono app, Node.js 22 arm64 — its ENIs live inside these subnets.
                    </p>
                  </div>
                  <div className={styles.innerLink}>
                    <span className={styles.stub} />
                    <span className={styles.tag}>5432/tcp · via security group</span>
                  </div>
                  <div className={cx(styles.box, styles.accentDb)}>
                    <p className={styles.name}>
                      Aurora PostgreSQL <span className={styles.badge}>serverless v2</span>
                    </p>
                    <p className={styles.desc}>
                      token-query-db · 0.5–2 ACU, reachable only from the Lambda security group.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className={styles.branchConnector}>
            <span className={styles.fromTag}>↳ branching off Lambda</span>
            <span className={styles.branchLine} />
            <span className={styles.branchLabel}>
              via NAT · outbound 443 · <span className={styles.mono}>GET /user</span>
            </span>
            <span className={styles.branchArrowhead} />
          </div>

          {/* GITHUB (external, outbound business call) */}
          <div className={cx(styles.zone, styles.github)}>
            <div className={styles.zoneHead}>
              <h2>
                <span className={styles.dot} />
                github <span className={styles.badge}>external</span>
              </h2>
              <span className={styles.where}>api.github.com</span>
            </div>
            <div className={styles.box}>
              <p className={styles.name}>GET /user</p>
              <p className={styles.desc}>
                <span className={styles.mono}>POST /api/github/profile</span> — Lambda takes a
                caller-supplied token, fetches the profile through the NAT Gateway, then upserts it
                into <span className={styles.mono}>github_profiles</span> on Aurora (above) and
                returns it to the caller.
              </p>
            </div>
          </div>
        </div>

        {/* IaC LAYER */}
        <section className={styles.iac}>
          <h2>Infrastructure as code — four stacks</h2>
          <p className={styles.iacSub}>
            Each layer publishes its live values to SSM Parameter Store; the layer above reads
            them fresh on every deploy — no hand-copied IDs.
          </p>

          <div className={styles.stackRow}>
            <div className={cx(styles.stack, styles.manual)}>
              <p className={styles.stackName}>token-query-iam</p>
              <p className={styles.stackDesc}>
                GitHub OIDC provider, deploy role, Lambda execution role.
              </p>
              <p className={styles.stackTag}>→ /token-query/iam/*</p>
            </div>
            <div className={cx(styles.stack, styles.manual)}>
              <p className={styles.stackName}>token-query-network</p>
              <p className={styles.stackDesc}>
                VPC, subnets, routing, NAT, Lambda security group.
              </p>
              <p className={styles.stackTag}>→ /token-query/network/*</p>
            </div>
            <div className={cx(styles.stack, styles.manual)}>
              <p className={styles.stackName}>token-query-db</p>
              <p className={styles.stackDesc}>
                DB security group, subnet group, Aurora cluster + instance.
              </p>
              <p className={styles.stackTag}>→ /token-query/db/*</p>
            </div>
            <div className={cx(styles.stack, styles.ci)}>
              <p className={styles.stackName}>token-query-api</p>
              <p className={styles.stackDesc}>Lambda, HTTP API, custom domain mapping.</p>
              <p className={styles.stackTag}>reads all three ↑</p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
