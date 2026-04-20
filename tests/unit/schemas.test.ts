import { describe, it, expect } from "vitest";
import { sftpConnectSchema } from "../../src/shared/schemas";

describe("sftpConnectSchema", () => {
  it("accepts password auth", () => {
    const r = sftpConnectSchema.safeParse({
      host: "example.com",
      username: "me",
      password: "secret",
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty host", () => {
    const r = sftpConnectSchema.safeParse({
      host: "",
      username: "me",
      password: "x",
    });
    expect(r.success).toBe(false);
  });
});
