import { Button, buttonVariants } from "@token-query/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@token-query/ui/components/card";
import { Input } from "@token-query/ui/components/input";
import { Label } from "@token-query/ui/components/label";
import { cn } from "@token-query/ui/lib/utils";
import { env } from "@token-query/env/web";
import { Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { Link } from "react-router";

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
      const response = await fetch(`${env.VITE_SERVER_URL}/api/github/profile`, {
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
      const response = await fetch(`${env.VITE_SERVER_URL}/api/github/profile`, {
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
    <main className="container mx-auto grid max-w-4xl gap-4 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">个人信息</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            输入 GitHub Token，查询当前账户并保存到数据库。
          </p>
        </div>
        <Link className={cn(buttonVariants({ variant: "outline" }))} to="/">
          返回首页
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>GitHub Token</CardTitle>
          <CardDescription>Token 只用于本次查询，不会保存到数据库。</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3">
            <div className="grid gap-2">
              <Label htmlFor="github-token">GitHub Token</Label>
              <Input
                id="github-token"
                type="password"
                value={token}
                placeholder="请输入 GitHub Token"
                autoComplete="off"
                onChange={(event) => setToken(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={isBusy} onClick={queryProfile}>
                {isQuerying ? "查询中..." : "查询"}
              </Button>
              <Button disabled={isBusy} variant="destructive" onClick={deleteProfile}>
                <Trash2 aria-hidden="true" />
                {isDeleting ? "删除中..." : "删除"}
              </Button>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            {message && <p className="text-sm text-muted-foreground">{message}</p>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>查询结果</CardTitle>
          <CardDescription>查询成功后展示 GitHub 当前账户信息。</CardDescription>
        </CardHeader>
        <CardContent>
          {profile ? (
            <div className="grid gap-4 md:grid-cols-[120px_1fr]">
              <div className="size-28 overflow-hidden border bg-muted">
                {profile.avatarUrl ? (
                  <img
                    className="size-full object-cover"
                    src={profile.avatarUrl}
                    alt={`${profile.login} avatar`}
                  />
                ) : (
                  <div className="flex size-full items-center justify-center text-xs text-muted-foreground">
                    头像
                  </div>
                )}
              </div>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <ProfileField label="GitHub ID" value={String(profile.githubId)} />
                <ProfileField label="用户名 login" value={profile.login} />
                <ProfileField label="昵称 name" value={profile.name || "-"} />
                <ProfileField
                  label="个人主页 htmlUrl"
                  value={
                    profile.htmlUrl ? (
                      <a
                        className="text-primary underline-offset-4 hover:underline"
                        href={profile.htmlUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {profile.htmlUrl}
                      </a>
                    ) : (
                      "-"
                    )
                  }
                />
                <ProfileField label="简介 bio" value={profile.bio || "-"} />
                <ProfileField label="公开仓库数 publicRepos" value={String(profile.publicRepos)} />
                <ProfileField label="粉丝数 followers" value={String(profile.followers)} />
                <ProfileField label="关注数 following" value={String(profile.following)} />
              </dl>
            </div>
          ) : (
            <div className="flex min-h-40 items-center justify-center border border-dashed text-sm text-muted-foreground">
              暂无查询结果
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function ProfileField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words">{value}</dd>
    </div>
  );
}
