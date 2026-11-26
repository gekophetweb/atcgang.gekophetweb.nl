import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { currentUser, type Env } from "../context.js";
import {
  createLabel,
  createPerson,
  deleteLabel,
  deletePerson,
  labelInput,
  listLabels,
  listPeople,
  mergeLabels,
  mergePeople,
  personInput,
  updateLabel,
  updatePerson,
} from "../domain/people.js";

const mergeInput = z.object({ intoId: z.string() });

export function peopleRoutes({ db }: AppDeps) {
  const r = new Hono<Env>();

  r.get("/people", async (c) => c.json(await listPeople(db, currentUser(c).id)));
  r.post("/people", async (c) => c.json(await createPerson(db, currentUser(c).id, personInput.parse(await c.req.json())), 201));
  r.patch("/people/:id", async (c) =>
    c.json(await updatePerson(db, currentUser(c).id, c.req.param("id"), personInput.partial().parse(await c.req.json()))),
  );
  r.delete("/people/:id", async (c) => {
    await deletePerson(db, currentUser(c).id, c.req.param("id"));
    return c.body(null, 204);
  });
  r.post("/people/:id/merge", async (c) => {
    const { intoId } = mergeInput.parse(await c.req.json());
    await mergePeople(db, currentUser(c).id, c.req.param("id"), intoId);
    return c.body(null, 204);
  });

  r.get("/labels", async (c) => c.json(await listLabels(db, currentUser(c).id)));
  r.post("/labels", async (c) => c.json(await createLabel(db, currentUser(c).id, labelInput.parse(await c.req.json())), 201));
  r.patch("/labels/:id", async (c) =>
    c.json(await updateLabel(db, currentUser(c).id, c.req.param("id"), labelInput.partial().parse(await c.req.json()))),
  );
  r.delete("/labels/:id", async (c) => {
    await deleteLabel(db, currentUser(c).id, c.req.param("id"));
    return c.body(null, 204);
  });
  r.post("/labels/:id/merge", async (c) => {
    const { intoId } = mergeInput.parse(await c.req.json());
    await mergeLabels(db, currentUser(c).id, c.req.param("id"), intoId);
    return c.body(null, 204);
  });

  return r;
}
