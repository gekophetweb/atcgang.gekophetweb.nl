import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../lib/api";
import { Button, cx, Empty, PageTitle, Spinner } from "../ui";

interface Notification {
  id: string;
  type: "tagged" | "photos_added" | "invite_accepted" | string;
  payload: { actorName?: string; concertId?: string; artist?: string; count?: number };
  readAt: string | null;
  createdAt: string;
}

function text(n: Notification) {
  const who = n.payload.actorName ?? "Someone";
  const what = n.payload.count === 1 ? "a photo" : `${n.payload.count} photos`;
  switch (n.type) {
    case "tagged":
      return `${who} tagged you in ${what} from ${n.payload.artist}`;
    case "photos_added":
      return `${who} added ${what} to ${n.payload.artist}`;
    case "invite_accepted":
      return `${who} joined ${n.payload.artist}`;
    default:
      return n.type;
  }
}

export function NotificationsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["notifications"], queryFn: () => api.get<Notification[]>("/notifications") });
  const read = useMutation({
    mutationFn: () => api.patch("/notifications", { all: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  // Opening the page marks everything as read (the list still shows what was new).
  useEffect(() => {
    if (data?.some((n) => !n.readAt)) read.mutate();
     
  }, [data?.length]);

  return (
    <div>
      <PageTitle actions={<Button onClick={() => read.mutate()}>Mark all read</Button>}>Notifications</PageTitle>
      {isLoading ? (
        <Spinner />
      ) : !data?.length ? (
        <Empty>No notifications yet.</Empty>
      ) : (
        <ul className="divide-y divide-zinc-900">
          {data.map((n) => (
            <li key={n.id}>
              <Link
                to={n.type === "tagged" ? "/photos/me" : "/concerts/$id"}
                params={{ id: n.payload.concertId ?? "" }}
                className={cx("flex items-center gap-3 rounded-lg px-3 py-3 hover:bg-zinc-900", !n.readAt && "font-semibold")}
              >
                {!n.readAt && <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
                <span className="flex-1">{text(n)}</span>
                <time className="text-xs font-normal text-zinc-500" dateTime={n.createdAt}>
                  {new Date(n.createdAt).toLocaleString()}
                </time>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
