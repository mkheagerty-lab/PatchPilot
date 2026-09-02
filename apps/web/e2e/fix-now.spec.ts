import { test, expect } from "@playwright/test";

// Fix Now dispatch gating. DEMO_MODE's only tenant with vulnerability data
// ("Contoso Legal") is deliberately seeded read-only, and DEMO_MODE always
// disables the "opt into write actions" toggle on Settings -> Tenants (see
// apps/web/src/pages/settings/Tenants.tsx: `disabled={demoMode || ...}`) — so
// there is no fixture path to a successful dispatch. What *is* safe and
// valuable to verify against demo fixtures is the read-only gate itself: a
// read-only tenant must never be able to actually dispatch a remediation,
// client-side or server-side (apps/api/src/routes/jobs.ts re-checks
// tenant.readOnly via the same `preflight()` call before running anything).
test.describe("fix now dispatch gating", () => {
  test("blocks dispatch on a read-only tenant", async ({ page }) => {
    await page.goto("/vulnerabilities");
    await expect(page.getByRole("heading", { name: "Vulnerabilities" })).toBeVisible();

    // The default tenant selection (alphabetically-first reachable tenant) has
    // no vulnerability data — switch to the demo fixture tenant that does.
    await page.getByRole("button", { name: "Black Iron (MSP)" }).click();
    await page.getByRole("button", { name: /Contoso Legal/ }).click();

    await page.getByTitle("Run remediation").first().click();
    await expect(page.getByRole("heading", { name: "Remediation options" })).toBeVisible();

    await expect(page.getByText(/This tenant is read-only/)).toBeVisible();
    const dispatchButton = page.getByRole("button", { name: /^Dispatch (now|to \d+ devices)$/ });
    await expect(dispatchButton).toBeDisabled();
  });
});
