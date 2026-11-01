import { describe, expect, it } from "vitest";
import { PLACEHOLDER_TITLE } from "../src/app/App";

// 骨架冒烟：只证明测试运行器 + TSX 导入链路通，以及运行环境是 Node 24。
// 这不是全项目通过证明；正式功能测试由后续任务的 tests/ 负责。
describe("P006 T001 skeleton smoke", () => {
  it("imports the placeholder shell title", () => {
    expect(PLACEHOLDER_TITLE).toBe("P006 反应骰 NoiseScope");
  });

  it("runs on Node 24", () => {
    const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
    expect(major).toBe(24);
  });
});
