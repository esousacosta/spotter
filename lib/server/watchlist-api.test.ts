import { beforeEach, describe, expect, it, vi } from "vitest";

const { authMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
}));

vi.mock("@/auth", () => ({
  auth: authMock,
}));

vi.mock("@/lib/server/auth-settings", () => ({
  isAuthenticationEnabled: () => true,
}));

vi.mock("@/lib/server/db/client", () => ({
  getDatabase: vi.fn(),
}));

import { authenticatedWatchlistStore } from "@/lib/server/watchlist-api";

describe("authenticated watchlist API context", () => {
  beforeEach(() => {
    authMock.mockReset();
  });

  it("rejects unauthenticated requests", async () => {
    authMock.mockResolvedValue(null);

    const result = await authenticatedWatchlistStore();

    expect("response" in result).toBe(true);
    if (result.response) {
      expect(result.response.status).toBe(401);
      await expect(result.response.json()).resolves.toEqual({ error: "Authentication required." });
    }
  });
});
