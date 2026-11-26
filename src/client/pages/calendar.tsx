import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/react/daygrid";
import timeGridPlugin from "@fullcalendar/react/timegrid";
import listPlugin from "@fullcalendar/react/list";
import interactionPlugin from "@fullcalendar/react/interaction";
import classicThemePlugin from "@fullcalendar/react/themes/classic";
import "@fullcalendar/react/skeleton.css";
import "@fullcalendar/react/themes/classic/theme.css";
import "@fullcalendar/react/themes/classic/palette.css";
import { api, qs } from "../lib/api";
import type { Concert } from "../types";
import { ConcertForm, Modal, NewConcertButton } from "../components/concert-form";
import { ErrorText, PageTitle } from "../ui";
import { ViewToggle } from "../components/view-toggle";

const COLORS: Record<Concert["status"], string> = {
  planned: "#f97316",
  attending: "#22c55e",
  attended: "#6366f1",
  cancelled: "#71717a",
  skipped: "#71717a",
};

export function CalendarPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [addDate, setAddDate] = useState<Date | null>(null);
  const { data } = useQuery({
    queryKey: ["concerts", "range", range],
    queryFn: () => api.get<Concert[]>(`/concerts${qs({ from: range!.from, to: range!.to })}`),
    enabled: !!range,
  });
  const move = useMutation({
    mutationFn: (v: { id: string; startsAt: Date; endsAt: Date | null }) =>
      api.patch(`/concerts/${v.id}`, { startsAt: v.startsAt.toISOString(), endsAt: v.endsAt?.toISOString() ?? null }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["concerts"] }),
  });

  return (
    <div>
      <PageTitle
        actions={
          <>
            <ViewToggle current="calendar" />
            <NewConcertButton />
          </>
        }
      >
        Calendar
      </PageTitle>
      <ErrorText error={move.error} />
      <div className="atc-calendar rounded-xl border border-zinc-800 bg-zinc-900/60 p-2">
        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin, classicThemePlugin]}
          initialView={window.innerWidth < 640 ? "listMonth" : "dayGridMonth"}
          headerToolbar={{ start: "prev,next today", center: "title", end: "dayGridMonth,timeGridWeek,listMonth" }}
          listText="Agenda"
          firstDay={1}
          height="auto"
          editable
          eventDurationEditable={false}
          events={(data ?? []).map((c) => ({
            id: c.id,
            title: c.artist + (c.venue ? ` · ${c.venue}` : ""),
            start: c.startsAt,
            end: c.endsAt ?? undefined,
            color: COLORS[c.status],
            editable: c.myRole !== "viewer",
          }))}
          datesSet={(info) => {
            const from = info.start.toISOString();
            const to = info.end.toISOString();
            if (range?.from !== from || range?.to !== to) setRange({ from, to });
          }}
          dateClick={(info) => {
            const d = new Date(info.date);
            if (info.allDay) d.setHours(20, 0, 0, 0);
            setAddDate(d);
          }}
          eventClick={(info) => {
            info.jsEvent.preventDefault();
            navigate({ to: "/concerts/$id", params: { id: info.event.id } });
          }}
          eventDrop={(info) => {
            const c = data?.find((x) => x.id === info.event.id);
            if (!c || !info.event.start) return info.revert();
            // Keep the original time when dropped on a whole day in month view.
            const start = new Date(info.event.start);
            if (info.event.allDay) {
              const old = new Date(c.startsAt);
              start.setHours(old.getHours(), old.getMinutes(), 0, 0);
            }
            const dur = c.endsAt ? new Date(c.endsAt).getTime() - new Date(c.startsAt).getTime() : null;
            move.mutate(
              { id: c.id, startsAt: start, endsAt: dur === null ? null : new Date(start.getTime() + dur) },
              { onError: () => info.revert() },
            );
          }}
        />
      </div>
      <Modal open={!!addDate} onClose={() => setAddDate(null)} title="Add concert">
        {addDate && <ConcertForm defaultStart={addDate} onDone={() => setAddDate(null)} />}
      </Modal>
    </div>
  );
}
