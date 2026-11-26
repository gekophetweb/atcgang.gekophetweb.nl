import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { LabelT, Person } from "../types";
import { PhotoGrid, usePhotos } from "../components/photo-grid";
import { Empty, ErrorText, Input, PageTitle, Select, Spinner } from "../ui";

export function PhotosPage({ me = false }: { me?: boolean }) {
  const [label, setLabel] = useState("");
  const [person, setPerson] = useState("");
  const [artist, setArtist] = useState("");
  const [year, setYear] = useState("");
  const { data: labels = [] } = useQuery({ queryKey: ["labels"], queryFn: () => api.get<LabelT[]>("/labels") });
  const { data: people = [] } = useQuery({ queryKey: ["people"], queryFn: () => api.get<Person[]>("/people") });
  const { data, isLoading, error } = usePhotos({
    me: me ? "1" : undefined,
    label: label || undefined,
    person: person || undefined,
    artist: artist || undefined,
    year: year || undefined,
  });
  const thisYear = new Date().getFullYear();

  return (
    <div>
      <PageTitle>{me ? "Photos of me" : "Photos"}</PageTitle>
      {me && <p className="mb-4 text-sm text-zinc-400">Photos friends tagged you in, from concerts you're a member of. You can remove your tag from any of them.</p>}
      <div className="mb-4 flex flex-wrap gap-2">
        <Input className="max-w-xs" type="search" placeholder="Artist" value={artist} onChange={(e) => setArtist(e.target.value)} aria-label="Artist" />
        <Select className="w-auto" value={year} onChange={(e) => setYear(e.target.value)} aria-label="Year">
          <option value="">Any year</option>
          {Array.from({ length: 40 }, (_, i) => thisYear - i).map((y) => (
            <option key={y}>{y}</option>
          ))}
        </Select>
        {!!labels.length && (
          <Select className="w-auto" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Label">
            <option value="">Any label</option>
            {labels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        )}
        {!me && !!people.length && (
          <Select className="w-auto" value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Person">
            <option value="">Anyone</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      {isLoading ? (
        <Spinner />
      ) : error ? (
        <ErrorText error={error} />
      ) : data?.length ? (
        <PhotoGrid photos={data} />
      ) : (
        <Empty>{me ? "Nobody has tagged you yet." : "No photos match."}</Empty>
      )}
    </div>
  );
}
