import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import App from "./App";
import { isEmbedded } from "./store/panelAuth";

const styles = readFileSync("src/styles.css", "utf8");

vi.mock("./store/panelAuth", () => ({ isEmbedded: vi.fn() }));

afterEach(() => vi.clearAllMocks());

describe("panel embed spacing", () => {
  it.each([false, true])("adds the clearance wrapper only when embedded=%s", (embedded) => {
    vi.mocked(isEmbedded).mockReturnValue(embedded);
    const markup = renderToStaticMarkup(<MemoryRouter><App /></MemoryRouter>);
    expect(markup.includes('class="panel-embed"')).toBe(embedded);
  });

  it("reserves top space and offsets sticky headers only within the embed wrapper", () => {
    expect(styles).toMatch(/\.panel-embed\s*\{[^}]*padding-top:\s*var\(--panel-top-clearance\)/);
    expect(styles).toMatch(/\.panel-embed \.topnav,\s*\.panel-embed \.header\s*\{\s*top:\s*var\(--panel-top-clearance\)/);
  });
});
