import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

/**
 * "Look back" numbers over the user's past concerts (any concert they're a member of that has
 * started and wasn't cancelled or skipped). `tz` is an IANA zone for "on this day".
 */
export async function concertStats(db: Db, userId: string, now = new Date(), tz = "UTC") {
  const past = sql`select c.* from concerts c join concert_members m on m.concert_id = c.id
    where m.user_id = ${userId} and c.starts_at < ${now.toISOString()} and c.status not in ('cancelled','skipped')`;

  const [totals] = await db.execute<{ concerts: number; artists: number; venues: number; photos: number }>(sql`
    with p as (${past})
    select count(*)::int as concerts,
           count(distinct lower(artist))::int as artists,
           count(distinct lower(nullif(venue, '')))::int as venues,
           (select count(*)::int from photos ph where ph.concert_id in (select id from p)) as photos
    from p`);

  const perYear = await db.execute<{ year: number; count: number }>(sql`
    with p as (${past})
    select extract(year from starts_at at time zone ${tz})::int as year, count(*)::int as count
    from p group by 1 order by 1`);

  const topArtists = await db.execute<{ name: string; count: number }>(sql`
    with p as (${past})
    select min(artist) as name, count(*)::int as count from p
    group by lower(artist) order by count desc, name limit 10`);

  const topVenues = await db.execute<{ name: string; city: string; count: number }>(sql`
    with p as (${past})
    select min(venue) as name, min(city) as city, count(*)::int as count from p
    where venue <> '' group by lower(venue) order by count desc, name limit 10`);

  const topPeople = await db.execute<{ id: string; name: string; count: number }>(sql`
    with p as (${past})
    select pe.id, pe.name, count(*)::int as count from p
    join concert_people cp on cp.concert_id = p.id
    join people pe on pe.id = cp.person_id and pe.owner_id = ${userId}
    group by pe.id, pe.name order by count desc, pe.name limit 10`);

  const onThisDay = await db.execute<{ id: string; artist: string; venue: string; city: string; starts_at: string; photo_count: number }>(sql`
    with p as (${past})
    select p.id, p.artist, p.venue, p.city, p.starts_at,
      (select count(*)::int from photos ph where ph.concert_id = p.id) as photo_count
    from p
    where to_char(starts_at at time zone ${tz}, 'MM-DD') = to_char(${now.toISOString()}::timestamptz at time zone ${tz}, 'MM-DD')
      and extract(year from starts_at at time zone ${tz}) < extract(year from ${now.toISOString()}::timestamptz at time zone ${tz})
    order by starts_at desc`);

  return {
    totals: totals ?? { concerts: 0, artists: 0, venues: 0, photos: 0 },
    perYear: [...perYear],
    topArtists: [...topArtists],
    topVenues: [...topVenues],
    topPeople: [...topPeople],
    onThisDay: onThisDay.map((r) => ({
      id: r.id,
      artist: r.artist,
      venue: r.venue,
      city: r.city,
      startsAt: new Date(r.starts_at).toISOString(),
      photoCount: r.photo_count,
    })),
  };
}

export function validTimeZone(tz: string | undefined) {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}
