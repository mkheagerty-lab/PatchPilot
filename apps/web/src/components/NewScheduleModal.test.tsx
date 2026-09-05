import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Engineer } from "../lib/auth";
import { AuthContext } from "../lib/auth";
import type { Schedule } from "../lib/api";
import { NewScheduleModal } from "./NewScheduleModal";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
  },
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, api: apiMock };
});

function engineer(overrides: Partial<Engineer> = {}): Engineer {
  return {
    upn: "engineer@blackiron.example",
    displayName: "Test Engineer",
    homeTenantId: "tenant-1",
    role: "admin",
    permissions: ["operations:write"],
    theme: "light",
    ...overrides,
  };
}

function renderModal(
  ui: ReactNode,
  { eng = engineer() }: { eng?: Engineer } = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthContext.Provider value={eng}>{ui}</AuthContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiMock.get.mockResolvedValue([]);
  apiMock.post.mockResolvedValue({ id: "new-schedule" } as Schedule);
  apiMock.put.mockResolvedValue({ id: "existing-schedule" } as Schedule);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("NewScheduleModal", () => {
  it("disables Save until a name is entered, then creates via POST", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderModal(
      <NewScheduleModal open onClose={onClose} tenantId="tenant-1" groups={[]} />,
    );

    const saveButton = screen.getByRole("button", { name: "Create schedule" });
    expect(saveButton).toBeDisabled();

    await user.type(screen.getByPlaceholderText(/nightly critical app patching/i), "Nightly patch run");
    expect(saveButton).toBeEnabled();

    await user.click(saveButton);

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    expect(apiMock.post).toHaveBeenCalledWith(
      "/api/schedules",
      expect.objectContaining({ tenantId: "tenant-1", name: "Nightly patch run", channel: "live-response" }),
    );
    expect(apiMock.put).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("prefills from an existing schedule and saves via PUT", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const schedule: Schedule = {
      id: "sched-1",
      tenantId: "tenant-1",
      name: "Existing schedule",
      cron: "0 2 * * *",
      channel: "live-response",
      target: {},
      enabled: true,
      engineer: "someone@blackiron.example",
      createdAt: new Date().toISOString(),
    };

    renderModal(
      <NewScheduleModal open onClose={onClose} tenantId="tenant-1" groups={[]} schedule={schedule} />,
    );

    expect(screen.getByDisplayValue("Existing schedule")).toBeInTheDocument();
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    expect(saveButton).toBeEnabled();

    await user.click(saveButton);

    await waitFor(() => expect(apiMock.put).toHaveBeenCalledTimes(1));
    expect(apiMock.put).toHaveBeenCalledWith(
      "/api/schedules/sched-1",
      expect.objectContaining({ name: "Existing schedule" }),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("warns and disables Save when the engineer lacks operations:write", async () => {
    const user = userEvent.setup();
    renderModal(
      <NewScheduleModal open onClose={vi.fn()} tenantId="tenant-1" groups={[]} />,
      { eng: engineer({ permissions: [] }) },
    );

    expect(
      screen.getByText(/role doesn't include remediation write access/i),
    ).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText(/nightly critical app patching/i), "Blocked schedule");
    expect(screen.getByRole("button", { name: "Create schedule" })).toBeDisabled();
  });
});
