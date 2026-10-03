import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { metadata } from "./page";
import { SignInForm } from "./sign-in-form";

// The sign-in page is the only page open to signed-out visitors. Its form
// posts the operator token to /api/auth/session and, on success, does a full
// page load of the validated `next` path (the cookie just changed, so every
// server-rendered page must be fetched again).

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

let assign: ReturnType<typeof vi.fn<(url: string) => void>>;
let respond: () => Promise<Response>;

beforeEach(() => {
  assign = vi.fn<(url: string) => void>();
  vi.spyOn(window, "location", "get").mockReturnValue({
    ...window.location,
    assign,
  });
  respond = async () => json({ ok: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => respond()),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function submit(token = "t".repeat(40)) {
  fireEvent.change(screen.getByLabelText(/operator token/i), {
    target: { value: token },
  });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
}

describe("SignInForm", () => {
  it("has a masked token field and a submit button that waits for a token", () => {
    render(<SignInForm next="/" />);

    const field = screen.getByLabelText(/operator token/i);

    expect(field).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: /sign in/i })).toBeDisabled();

    fireEvent.change(field, { target: { value: "x" } });

    expect(screen.getByRole("button", { name: /sign in/i })).toBeEnabled();
  });

  it("posts the token as JSON to /api/auth/session and goes to next on success", async () => {
    render(<SignInForm next="/acme/demo?utm=1" />);

    await submit("secret-token");

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith("/acme/demo?utm=1");
    });

    const [path, init] = vi.mocked(fetch).mock.calls[0]!;

    expect(path).toBe("/api/auth/session");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ token: "secret-token" });
  });

  it("goes to / when next is missing", async () => {
    render(<SignInForm />);

    await submit();

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith("/");
    });
  });

  it.each([
    "//evil.com",
    "https://evil.com/x",
    "/\\evil.com",
    "javascript:alert(1)",
  ])("never redirects to an unsafe next value: %s", async (next) => {
    render(<SignInForm next={next} />);

    await submit();

    await waitFor(() => {
      expect(assign).toHaveBeenCalledTimes(1);
    });
    expect(assign).toHaveBeenCalledWith("/");
  });

  it("shows the server's message on a 401 and stays on the page", async () => {
    respond = async () => json({ error: "That token is not right." }, 401);
    render(<SignInForm next="/acme/demo" />);

    await submit("wrong");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That token is not right.",
    );
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeEnabled();
  });

  it("shows the wait message on a 429", async () => {
    respond = async () =>
      json({ error: "Too many tries. Wait 15 minutes and try again." }, 429);
    render(<SignInForm />);

    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Too many tries/,
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it("shows a generic message when the request fails or the body is not JSON", async () => {
    respond = () => Promise.reject(new TypeError("Failed to fetch"));
    render(<SignInForm />);

    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /could not sign in/i,
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it("never echoes the token into the page or the address", async () => {
    respond = async () => json({ error: "That token is not right." }, 401);
    render(<SignInForm />);

    await submit("very-secret-token-value");
    await screen.findByRole("alert");

    expect(document.body.textContent).not.toContain("very-secret-token-value");
  });
});

describe("sign-in page metadata", () => {
  it("is not indexed", () => {
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
  });
});
