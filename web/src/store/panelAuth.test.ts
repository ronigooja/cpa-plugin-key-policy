import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetKeyCache,
  obfuscateData,
  deobfuscateData,
  readPanelAuth,
  type PanelAuth,
} from "./panelAuth";

const STORAGE_KEY = "cli-proxy-auth";

// Build a panel-style persisted auth blob: zustand persist envelope
// {state, version} serialized to JSON, then obfuscated with the shared algo.
function storePanelAuth(auth: PanelAuth, version: "v1" | "v2" = "v2"): void {
  const envelope = JSON.stringify({
    state: {
      apiBase: auth.apiBase,
      managementKey: auth.managementKey,
      rememberPassword: true,
    },
    version: 0,
  });
  localStorage.setItem(STORAGE_KEY, panelObfuscate(envelope, version));
}

// Independent fixture matching the deployed panel, not the plugin's encoder.
function panelObfuscate(value: string, version: "v1" | "v2"): string {
  const key = new TextEncoder().encode(
    `cli-proxy-api-webui::secure-storage|${window.location.host}` +
      (version === "v1" ? `|${navigator.userAgent}` : ""),
  );
  const bytes = new TextEncoder().encode(value);
  const binary = Array.from(bytes, (byte, i) => String.fromCharCode(byte ^ key[i % key.length])).join("");
  return `enc::${version}::${btoa(binary)}`;
}

describe("panelAuth obfuscation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _resetKeyCache();
  });

  it("round-trips through obfuscate/deobfuscate", () => {
    const original = JSON.stringify({ state: { apiBase: "http://h:1", managementKey: "k" } });
    expect(deobfuscateData(obfuscateData(original))).toBe(original);
  });

  it.each(["v1", "v2"] as const)("decodes independent panel %s fixtures including UTF-8", (version) => {
    const original = JSON.stringify({ managementKey: "test-only-密钥-" + "x".repeat(200) });
    expect(deobfuscateData(panelObfuscate(original, version))).toBe(original);
  });

  it("encodes v2 exactly like the current panel", () => {
    const original = "test-only-".repeat(30);
    expect(obfuscateData(original)).toBe(panelObfuscate(original, "v2"));
  });

  it("decodes v2 after the user agent changes without mixing legacy cached keys", () => {
    const original = "test-only-".repeat(30);
    expect(deobfuscateData(panelObfuscate(original, "v1"))).toBe(original);
    const v2 = panelObfuscate(original, "v2");
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("changed-browser");
    expect(deobfuscateData(v2)).toBe(original);
  });

  it.each(["enc::v1::!invalid!", "enc::v2::!invalid!", "enc::v3::unknown", "plain", ""])(
    "returns malformed or unsupported payloads unchanged: %s", (payload) => {
      expect(deobfuscateData(payload)).toBe(payload);
    },
  );
});

describe("readPanelAuth", () => {
  const realSelf = window.self;
  const realTop = window.top;

  beforeEach(() => {
    localStorage.clear();
    _resetKeyCache();
  });

  afterEach(() => {
    localStorage.clear();
    _resetKeyCache();
    // Restore embedded state.
    Object.defineProperty(window, "self", { value: realSelf, configurable: true });
    Object.defineProperty(window, "top", { value: realTop, configurable: true });
  });

  function setEmbedded(embedded: boolean) {
    // window.self !== window.top → embedded
    Object.defineProperty(window, "self", { value: window, configurable: true });
    Object.defineProperty(window, "top", {
      value: embedded ? ({} as Window) : window,
      configurable: true,
    });
  }

  it("returns null when not embedded (direct page open)", () => {
    setEmbedded(false);
    storePanelAuth({ apiBase: "http://127.0.0.1:8317", managementKey: "secret-xyz" });
    expect(readPanelAuth()).toBeNull();
  });

  it.each(["v1", "v2"] as const)("reads %s apiBase + managementKey when embedded", (version) => {
    setEmbedded(true);
    storePanelAuth({ apiBase: "http://127.0.0.1:8317", managementKey: "secret-xyz" }, version);
    expect(readPanelAuth()).toEqual({
      apiBase: "http://127.0.0.1:8317",
      managementKey: "secret-xyz",
    });
  });

  it("returns null when managementKey is empty (remember password unchecked)", () => {
    setEmbedded(true);
    const envelope = JSON.stringify({
      state: { apiBase: "http://h:1", managementKey: "", rememberPassword: false },
      version: 0,
    });
    localStorage.setItem(STORAGE_KEY, obfuscateData(envelope));
    expect(readPanelAuth()).toBeNull();
  });

  it("returns null when nothing is stored", () => {
    setEmbedded(true);
    expect(readPanelAuth()).toBeNull();
  });

  it("returns null when the stored value is garbage", () => {
    setEmbedded(true);
    localStorage.setItem(STORAGE_KEY, "not-valid-json-or-obfuscated");
    expect(readPanelAuth()).toBeNull();
  });

  it.each(["v1", "v2"] as const)("rejects malformed %s auth without modifying storage", (version) => {
    setEmbedded(true);
    const raw = `enc::${version}::!invalid!`;
    localStorage.setItem(STORAGE_KEY, raw);
    expect(readPanelAuth()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
  });
});
