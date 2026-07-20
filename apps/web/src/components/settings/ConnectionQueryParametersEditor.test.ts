import { describe, expect, it } from "vite-plus/test";

import { makeQueryParameterRows, queryParametersFromRows } from "./ConnectionQueryParametersEditor";

describe("ConnectionQueryParametersEditor rows", () => {
  it("filters blank rows and keeps duplicate parameters ordered", () => {
    const rows = makeQueryParameterRows([
      { key: "tag", value: "one" },
      { key: "", value: "" },
      { key: "tag", value: "two" },
    ]);

    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(queryParametersFromRows(rows)).toEqual([
      { key: "tag", value: "one" },
      { key: "tag", value: "two" },
    ]);
  });

  it("reflects row removal without disturbing the remaining order", () => {
    const rows = makeQueryParameterRows([
      { key: "first", value: "1" },
      { key: "second", value: "2" },
      { key: "third", value: "3" },
    ]);

    expect(queryParametersFromRows(rows.filter((row) => row.key !== "second"))).toEqual([
      { key: "first", value: "1" },
      { key: "third", value: "3" },
    ]);
  });
});
