import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const outbox = () =>
  readFileSync("e2e/.outbox.jsonl", "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { to: string; text: string });

async function login(page: Page, email: string) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send login code" }).click();
  await expect(page.getByText(/We sent a 6-digit code/)).toBeVisible();
  const mail = outbox().filter((m) => m.to === email).at(-1)!;
  const code = mail.text.match(/\b(\d{6})\b/)![1]!;
  await page.getByLabel("Code").fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** A real JPEG made in the browser, so the test needs no fixture files. */
async function jpeg(page: Page) {
  const b64 = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = 480;
    const g = c.getContext("2d")!;
    g.fillStyle = "#f97316";
    g.fillRect(0, 0, 640, 480);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/jpeg", 0.9));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    buf.forEach((x) => (s += String.fromCharCode(x)));
    return btoa(s);
  });
  return Buffer.from(b64, "base64");
}

test("log in → add a concert → upload photos → tag one", async ({ page }, info) => {
  const email = `e2e-${info.project.name}-${Date.now()}@example.com`;
  await login(page, email);
  await expect(page.getByRole("heading", { name: "Concerts" })).toBeVisible();

  await page.getByRole("button", { name: "+ Add concert" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Artist").fill("Foo Fighters");
  await dialog.getByLabel("Venue").fill("Ziggo Dome");
  await dialog.getByLabel("City").fill("Amsterdam");
  await dialog.getByLabel("Starts").fill("2026-06-01T20:00");
  await dialog.getByRole("button", { name: "Add concert" }).click();
  await expect(page.getByRole("heading", { name: "Foo Fighters" })).toBeVisible();

  const img = await jpeg(page);
  await page.locator("input[type=file]").setInputFiles([
    { name: "stage.jpg", mimeType: "image/jpeg", buffer: img },
    { name: "crowd.jpg", mimeType: "image/jpeg", buffer: img },
  ]);
  await expect(page.getByRole("heading", { name: /Photos \(2\)/ })).toBeVisible();
  await expect(page.locator("section ul img")).toHaveCount(2, { timeout: 20_000 }); // thumbnails ready

  await page.locator("section ul button").first().click();
  const viewer = page.getByRole("dialog", { name: "Photo viewer" });
  await viewer.getByLabel("Add label").fill("encore");
  await viewer.getByLabel("Add label").press("Enter");
  await expect(viewer.getByText("encore")).toBeVisible();
  await viewer.getByLabel("Tag person").fill("Zoe");
  await viewer.getByLabel("Tag person").press("Enter");
  await expect(viewer.getByText("Zoe")).toBeVisible();
  await viewer.getByRole("button", { name: "Close viewer" }).click();

  await page.goto("/photos");
  await page.getByLabel("Label").selectOption({ label: "encore" });
  await expect(page.locator("main ul img")).toHaveCount(1);
});
