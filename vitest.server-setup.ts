import { vi } from "vitest";

// "server-only" throws outside a React Server Components build, so every
// server-side test needs it stubbed. Stubbing it once here keeps the guard in
// the source files (it fails the build if server code reaches a browser bundle).
vi.mock("server-only", () => ({}));
