export type Status = "planned" | "attending" | "attended" | "cancelled" | "skipped";
export type Role = "owner" | "editor" | "viewer";

export const STATUS_LABELS: Record<Status, string> = {
  planned: "Planned",
  attending: "Going",
  attended: "Went",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

export interface Member {
  id: string;
  name: string;
  image: string | null;
  role: Role;
}

export interface PersonRef {
  id: string;
  name: string;
  linkedUserId: string | null;
}

export interface Concert {
  id: string;
  ownerId: string;
  artist: string;
  title: string | null;
  venue: string;
  city: string;
  country: string;
  startsAt: string;
  endsAt: string | null;
  status: Status;
  ticketInfo: string | null;
  setlistUrl: string | null;
  notes: string;
  rating: number | null;
  myRole: Role;
  photoCount: number;
  members: Member[];
  people: PersonRef[];
}

export interface ConcertDetail extends Concert {
  invites: { id: string; email: string | null; role: Role; expiresAt: string }[];
}

export interface Person {
  id: string;
  name: string;
  linkedUserId: string | null;
  linkedUserName: string | null;
  linkedUserImage: string | null;
  concertCount: number;
  photoCount: number;
}

export interface LabelT {
  id: string;
  name: string;
  color: string;
  photoCount: number;
}

export interface Photo {
  id: string;
  concertId: string;
  uploaderId: string;
  width: number | null;
  height: number | null;
  bytes: number;
  takenAt: string | null;
  caption: string | null;
  thumbsReady: boolean;
  createdAt: string;
  labels: { id: string; name: string; color: string }[];
  people: { id: string; name: string; x: number | null; y: number | null; linkedUserId: string | null; mine: boolean }[];
  concert?: { artist: string; startsAt: string; venue: string };
  canEdit: boolean;
  canDelete: boolean;
}
