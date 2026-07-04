import { Button } from "@token-query/ui/components/button";
import { Input } from "@token-query/ui/components/input";
import {
  AtSign,
  BookOpen,
  ExternalLink,
  GitBranch,
  IdCard,
  KeyRound,
  LoaderCircle,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

import type { Route } from "./+types/profile";

type GithubProfile = {
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  htmlUrl: string | null;
  bio: string | null;
  publicRepos: number;
  followers: number;
  following: number;
};

const queryFailedError = "GitHub information query failed. Please check your token.";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "个人信息 - token-query" },
    { name: "description", content: "查询并保存 GitHub 个人信息" },
  ];
}

export default function Profile() {
  const [token, setToken] = useState("");
  const [profile, setProfile] = useState<GithubProfile | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [isQuerying, setIsQuerying] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  async function queryProfile() {
    setError("");
    setMessage("");
    setIsQuerying(true);

    try {
      const response = await fetch("/api/github/profile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token }),
      });
      const result = await response.json();

      if (!response.ok || !result.profile) {
        throw new Error(result.error || queryFailedError);
      }

      setProfile(result.profile);
      setMessage("查询成功。");
    } catch (err) {
      setError(err instanceof Error ? err.message : queryFailedError);
    } finally {
      setIsQuerying(false);
    }
  }

  async function deleteProfile() {
    setError("");
    setMessage("");
    setIsDeleting(true);

    try {
      const response = await fetch("/api/github/profile", {
        method: "DELETE",
      });
      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || "Delete failed. Please try again.");
      }

      setProfile(null);
      setMessage("Deleted successfully.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed. Please try again.");
    } finally {
      setIsDeleting(false);
    }
  }

  const isBusy = isQuerying || isDeleting;

  return (
    <main className="min-h-full bg-[#f9f9ff] text-[#181c23]">
      <div className="mx-auto grid w-full max-w-[1200px] gap-6 px-5 py-6 sm:px-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:py-8">
        <section className="min-w-0 space-y-6">
          <div className="rounded-2xl border border-[#c1c6d7] bg-white p-5 sm:p-6">
            <div className="flex flex-col gap-5">
              <div className="flex items-start gap-4">
                <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-[#d8e2ff] text-[#0058bc]">
                  <GitBranch className="size-5" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-[20px] font-semibold leading-[26px] text-[#181c23]">
                    连接 GitHub 账户
                  </h1>
                  <p className="mt-1 text-[15px] leading-[22px] text-[#5d5e63]">
                    输入 GitHub Token，查询当前账户资料并保存到数据库。
                  </p>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                <div className="relative min-w-0">
                  <KeyRound className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-[#717786]" />
                  <Input
                    id="github-token"
                    type="password"
                    value={token}
                    placeholder="Enter your GitHub Token..."
                    autoComplete="off"
                    disabled={isBusy}
                    className="h-12 rounded-xl border-0 bg-[#f1f3fe] pl-11 pr-4 text-[15px] leading-[22px] text-[#181c23] placeholder:text-[#717786] focus-visible:border-[#0058bc] focus-visible:ring-2 focus-visible:ring-[#0058bc]/20"
                    onChange={(event) => setToken(event.target.value)}
                  />
                </div>

                <Button
                  disabled={isBusy || !token.trim()}
                  className="h-12 rounded-xl bg-[#0058bc] px-5 text-[13px] font-medium leading-[18px] text-white transition-all hover:bg-[#0070eb] active:scale-[0.98]"
                  onClick={queryProfile}
                >
                  {isQuerying ? (
                    <>
                      <LoaderCircle className="size-4 animate-spin" />
                      查询中...
                    </>
                  ) : (
                    "查询"
                  )}
                </Button>

                <Button
                  disabled={isBusy || profile === null}
                  variant="destructive"
                  className="h-12 rounded-xl bg-[#ffdad6] px-5 text-[13px] font-medium leading-[18px] text-[#93000a] transition-all hover:bg-[#ffcbc5] active:scale-[0.98]"
                  onClick={deleteProfile}
                >
                  {isDeleting ? (
                    <>
                      <LoaderCircle className="size-4 animate-spin" />
                      删除中...
                    </>
                  ) : (
                    <>
                      <Trash2 className="size-4" aria-hidden="true" />
                      删除
                    </>
                  )}
                </Button>
              </div>

              {error && (
                <div className="rounded-xl border border-[#ffdad6] bg-[#fff3f1] px-4 py-3 text-[13px] font-medium leading-[18px] text-[#93000a]">
                  {error}
                </div>
              )}
              {message && (
                <div className="rounded-xl border border-[#c1c6d7]/70 bg-[#f1f3fe] px-4 py-3 text-[13px] font-medium leading-[18px] text-[#0058bc]">
                  {message}
                </div>
              )}
            </div>
          </div>

          {profile ? (
            <ProfileCard profile={profile} />
          ) : (
            <StatePanel
              icon={<UserRound className="size-5" />}
              title="尚未查询个人信息"
              description="输入 GitHub Token 并点击查询后，这里会展示账户资料。"
            />
          )}
        </section>

        <aside className="space-y-4">
          <div className="rounded-2xl border border-[#c1c6d7] bg-white p-5">
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#ecedf9] text-[#0058bc]">
                <ShieldCheck className="size-5" />
              </div>
              <div>
                <h2 className="text-[15px] font-semibold leading-[22px] text-[#181c23]">
                  Token 仅用于查询
                </h2>
                <p className="mt-1 text-[13px] leading-[18px] text-[#5d5e63]">
                  Token 不会写入数据库，接口只保存 GitHub 返回的公开账户字段。
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-[#c1c6d7] bg-white p-5">
            <p className="text-[11px] font-semibold uppercase leading-[14px] text-[#717786]">
              Current result
            </p>
            <p className="mt-3 text-[28px] font-semibold leading-[34px] text-[#181c23]">
              {profile === null ? "Waiting" : "Ready"}
            </p>
            <p className="mt-1 text-[13px] leading-[18px] text-[#5d5e63]">
              {profile === null ? "当前页面还没有查询结果。" : `@${profile.login} 已查询完成。`}
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}

function ProfileCard({ profile }: { profile: GithubProfile }) {
  const displayName = profile.name || profile.login;

  return (
    <div className="overflow-hidden rounded-2xl border border-[#c1c6d7] bg-white">
      <div className="border-b border-[#c1c6d7]/60 bg-[#f1f3fe] p-5 sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            {profile.avatarUrl ? (
              <img
                src={profile.avatarUrl}
                alt={`${profile.login} avatar`}
                className="size-20 rounded-full border border-white object-cover ring-1 ring-[#c1c6d7]"
              />
            ) : (
              <div className="flex size-20 items-center justify-center rounded-full bg-white text-[#0058bc] ring-1 ring-[#c1c6d7]">
                <UserRound className="size-8" />
              </div>
            )}

            <div className="min-w-0">
              <h2 className="truncate text-[24px] font-semibold leading-[30px] text-[#181c23]">
                {displayName}
              </h2>
              <p className="mt-1 flex items-center gap-2 text-[15px] leading-[22px] text-[#5d5e63]">
                <AtSign className="size-4" />
                {profile.login}
              </p>
            </div>
          </div>

          {profile.htmlUrl && (
            <a
              href={profile.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl bg-white px-3 text-[13px] font-medium leading-[18px] text-[#0058bc] ring-1 ring-[#c1c6d7] transition-all hover:bg-[#f9f9ff] active:scale-[0.98]"
            >
              Open GitHub
              <ExternalLink className="size-4" />
            </a>
          )}
        </div>
      </div>

      <div className="grid gap-4 p-5 sm:grid-cols-3 sm:p-6">
        <MetricCard
          icon={<BookOpen className="size-4" />}
          label="Public Repos"
          value={profile.publicRepos}
        />
        <MetricCard
          icon={<Users className="size-4" />}
          label="Followers"
          value={profile.followers}
        />
        <MetricCard
          icon={<UserRound className="size-4" />}
          label="Following"
          value={profile.following}
        />
      </div>

      <dl className="grid grid-cols-1 gap-4 border-t border-[#c1c6d7]/60 p-5 sm:grid-cols-2 sm:p-6">
        <FieldItem
          icon={<IdCard className="size-4" />}
          label="GitHub ID"
          value={profile.githubId}
        />
        <FieldItem icon={<AtSign className="size-4" />} label="Login" value={profile.login} />
        <FieldItem
          className="sm:col-span-2"
          icon={<ExternalLink className="size-4" />}
          label="Profile URL"
          value={profile.htmlUrl}
          href={profile.htmlUrl}
        />
        <FieldItem
          className="sm:col-span-2"
          icon={<UserRound className="size-4" />}
          label="Bio"
          value={profile.bio && profile.bio.length > 0 ? profile.bio : null}
        />
      </dl>
    </div>
  );
}

function StatePanel({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-72 items-center justify-center rounded-2xl border border-[#c1c6d7] bg-white p-8 text-center">
      <div className="max-w-sm">
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-[#d8e2ff] text-[#0058bc]">
          {icon}
        </div>
        <h2 className="mt-4 text-[20px] font-semibold leading-[26px] text-[#181c23]">{title}</h2>
        <p className="mt-2 text-[15px] leading-[22px] text-[#5d5e63]">{description}</p>
      </div>
    </div>
  );
}

function MetricCard({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-[#c1c6d7]/70 bg-[#f9f9ff] p-4">
      <div className="flex items-center gap-2 text-[#5d5e63]">
        {icon}
        <span className="text-[13px] font-medium leading-[18px]">{label}</span>
      </div>
      <p className="mt-3 text-[28px] font-semibold leading-[34px] text-[#181c23]">{value}</p>
    </div>
  );
}

function FieldItem({
  icon,
  label,
  value,
  href,
  className = "",
}: {
  icon: ReactNode;
  label: string;
  value: number | string | null;
  href?: string | null;
  className?: string;
}) {
  const empty = value === null || value === "";

  return (
    <div className={`rounded-2xl border border-[#c1c6d7]/70 bg-white p-4 ${className}`}>
      <dt className="flex items-center gap-2 text-[13px] font-medium leading-[18px] text-[#5d5e63]">
        <span className="text-[#717786]">{icon}</span>
        {label}
      </dt>
      <dd className="mt-2 break-words text-[15px] font-medium leading-[22px] text-[#181c23]">
        {empty ? (
          <span className="text-[#717786]">Not provided</span>
        ) : href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#0058bc] transition-colors hover:text-[#0070eb]"
          >
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}
