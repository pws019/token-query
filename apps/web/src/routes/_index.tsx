import { Navigate } from "react-router";

import type { Route } from "./+types/_index";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "个人信息 - token-query" },
    { name: "description", content: "查询并保存 GitHub 个人信息" },
  ];
}

export default function Index() {
  return <Navigate to="/profile" replace />;
}
