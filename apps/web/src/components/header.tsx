import { NavLink } from "react-router";
import { UserRound } from "lucide-react";

import { ModeToggle } from "./mode-toggle";

export default function Header() {
  return (
    <header className="sticky top-0 z-20 border-b border-[#c1c6d7]/55 bg-white/90 text-[#181c23] backdrop-blur-xl">
      <div className="mx-auto flex min-h-16 w-full max-w-[1200px] items-center justify-between gap-4 px-5 sm:px-8">
        <NavLink to="/profile" className="flex min-w-0 flex-1 items-center gap-3" end>
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#d8e2ff] text-[#0058bc]">
            <UserRound className="size-5" />
          </div>
          <div className="min-w-0 text-left">
            <h1 className="truncate text-[19px] font-semibold leading-[25px] sm:text-[22px] sm:leading-[28px]">
              个人信息
            </h1>
            <p className="truncate text-[12px] font-medium leading-[16px] text-[#717786]">
              GitHub Profile
            </p>
          </div>
        </NavLink>

        <nav className="flex items-center gap-2">
          <NavLink
            to="/profile"
            className={({ isActive }) =>
              [
                "inline-flex h-10 shrink-0 items-center justify-center rounded-xl border px-3 text-[13px] font-medium leading-[18px] transition-all active:scale-[0.98]",
                isActive
                  ? "border-[#0058bc]/35 bg-[#d8e2ff] text-[#0058bc]"
                  : "border-[#c1c6d7]/70 bg-[#f9f9ff] text-[#414755] hover:border-[#0058bc]/35 hover:bg-[#f1f3fe] hover:text-[#0058bc]",
              ].join(" ")
            }
            end
          >
            Profile
          </NavLink>
          <ModeToggle />
        </nav>
      </div>
    </header>
  );
}
