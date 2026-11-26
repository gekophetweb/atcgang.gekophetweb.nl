import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { api } from "../lib/api";
import { Button, Card, ErrorText, Spinner } from "../ui";

interface Preview {
  concert: { id: string; artist: string; title: string | null; venue: string; city: string; startsAt: string };
  inviter: string;
  role: string;
}

interface Accepted {
  concertId: string;
  duplicateOf: string | null;
}

export function InvitePage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({ queryKey: ["invite", token], queryFn: () => api.get<Preview>(`/invites/${token}`), retry: false });
  const accept = useMutation({
    mutationFn: () => api.post<Accepted>(`/invites/${token}/accept`),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["concerts"] });
      if (!r.duplicateOf) navigate({ to: "/concerts/$id", params: { id: r.concertId } });
    },
  });
  const merge = useMutation({
    mutationFn: (r: Accepted) => api.post(`/concerts/${r.duplicateOf}/merge-into/${r.concertId}`),
    onSuccess: (_x, r) => {
      qc.invalidateQueries({ queryKey: ["concerts"] });
      navigate({ to: "/concerts/$id", params: { id: r.concertId } });
    },
  });

  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorText error={error ?? "Invite not found"} />;
  const r = accept.data;
  return (
    <Card className="mx-auto max-w-md space-y-4">
      {r?.duplicateOf ? (
        <>
          <h1 className="text-xl font-bold">You already had this concert</h1>
          <p className="text-sm text-zinc-300">
            You have your own entry for {data.concert.artist} on the same day. Merge it into the shared one? Your photos, people and
            notes move over and your copy is removed.
          </p>
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => merge.mutate(r)} disabled={merge.isPending}>
              Merge
            </Button>
            <Link to="/concerts/$id" params={{ id: r.concertId }} className="rounded-lg bg-zinc-800 px-3 py-2 text-sm">
              Keep both
            </Link>
          </div>
          <ErrorText error={merge.error} />
        </>
      ) : (
        <>
          <h1 className="text-xl font-bold">{data.inviter} invited you</h1>
          <div>
            <p className="text-lg font-semibold">{data.concert.artist}</p>
            <p className="text-sm text-zinc-400">
              {new Date(data.concert.startsAt).toLocaleDateString(undefined, { dateStyle: "full" })} ·{" "}
              {[data.concert.venue, data.concert.city].filter(Boolean).join(", ")}
            </p>
          </div>
          <Button variant="primary" onClick={() => accept.mutate()} disabled={accept.isPending}>
            Join concert
          </Button>
          <ErrorText error={accept.error} />
        </>
      )}
    </Card>
  );
}
