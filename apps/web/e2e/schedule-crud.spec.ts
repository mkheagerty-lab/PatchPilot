import { test, expect } from "@playwright/test";

// Runs against the isolated DEMO_MODE API+web pair spawned by playwright.config.ts
// (never a real dev/prod server) — the demo engineer is a fixed admin, so this
// also exercises the RBAC-write path (Save enabled, no "role doesn't include..."
// banner) without needing a second, non-admin demo identity.
test.describe("schedule create/edit", () => {
  test("creates a schedule, then edits its name", async ({ page }) => {
    const scheduleName = `E2E schedule ${Date.now()}`;

    await page.goto("/schedules");
    await expect(page.getByRole("heading", { name: "Schedules" })).toBeVisible();

    await page.getByRole("button", { name: "New schedule" }).click();
    await expect(page.getByRole("heading", { name: "New schedule" })).toBeVisible();

    const saveButton = page.getByRole("button", { name: "Create schedule" });
    await expect(saveButton).toBeDisabled();

    await page.getByPlaceholder(/nightly critical app patching/i).fill(scheduleName);
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    await expect(page.getByRole("heading", { name: "New schedule" })).toBeHidden();
    const row = page.getByRole("row", { name: new RegExp(scheduleName) });
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: "Edit" }).click();
    await expect(page.getByRole("heading", { name: "Edit schedule" })).toBeVisible();
    const nameInput = page.getByPlaceholder(/nightly critical app patching/i);
    await expect(nameInput).toHaveValue(scheduleName);

    // No parens/regex metacharacters here — the name is later wrapped in
    // `new RegExp(...)` unescaped to match it inside a table row's full text.
    const updatedName = `${scheduleName} EDITED`;
    await nameInput.fill(updatedName);
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect(page.getByRole("heading", { name: "Edit schedule" })).toBeHidden();
    await expect(page.getByRole("row", { name: new RegExp(updatedName) })).toBeVisible();

    // Clean up so repeated runs don't accumulate demo-fixture schedules.
    await page
      .getByRole("row", { name: new RegExp(updatedName) })
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(page.getByRole("row", { name: new RegExp(updatedName) })).toBeHidden();
  });
});
