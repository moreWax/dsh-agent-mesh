import { describe, expect, it } from "vitest";
import { SamClient } from "../src/core/index.js";

const live = process.env.SAM_LIVE === "1" ? describe : describe.skip;
live("live SAM node", () => {
  it("probes get_mesh_info over the user Unix socket", async () => {
    const info = await new SamClient().getMeshInfo();
    expect(info).toBeTypeOf("object");
    expect(info.local_api_socket ?? "").toContain("sam.sock");
  });
});
