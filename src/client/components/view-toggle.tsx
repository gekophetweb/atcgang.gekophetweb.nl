import { useEffect } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMe } from "../layout";
import { cx } from "../ui";

type View = "list" | "calendar";
const key = (userId: string) => `concerts.view.${userId}`;

export function getPreferredView(userId: string | undefined): View {
  if (!userId) return "list";
  try {
    return localStorage.getItem(key(userId)) === "calendar" ? "calendar" : "list";
  } catch {
    return "list";
  }
}

/** List/Calendar switch; the choice is remembered per user on this device. */
export function ViewToggle({ current }: { current: View }) {
  const { data: me } = useMe();
  useEffect(() => {
    if (!me) return;
    try {
      localStorage.setItem(key(me.id), current);
    } catch {
      /* storage unavailable */
    }
  }, [me, current]);
  const cls = (v: View) => cx("rounded-md px-3 py-1 text-sm", current === v ? "bg-zinc-700 text-white" : "text-zinc-400");
  return (
    <div className="flex rounded-lg bg-zinc-900 p-1">
      <Link to="/" search={{ view: "list" }} className={cls("list")}>
        List
      </Link>
      <Link to="/calendar" className={cls("calendar")}>
        Calendar
      </Link>
    </div>
  );
}

/** On the list page: jump to the calendar if that's what this user used last (unless they explicitly chose the list). */
export function useRedirectToPreferredView() {
  const { data: me } = useMe();
  const navigate = useNavigate();
  useEffect(() => {
    const explicit = new URLSearchParams(window.location.search).get("view") === "list";
    if (me && !explicit && getPreferredView(me.id) === "calendar") navigate({ to: "/calendar", replace: true });
  }, [me, navigate]);
}
