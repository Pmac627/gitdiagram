// Test helper: a signed-in operator for suites that call route handlers or the
// proxy directly. It is not imported by production code.
//
// Usage, at the top level of a test file (the calling file must also run
// `vi.mock("server-only", () => ({}))` itself, because vi.mock only applies to
// the file that declares it):
//
//   const session = registerOperatorSession();
//   new Request(url, { headers: { ...session.headers } });
//
// The helper sets OPERATOR_TOKEN and makes sure DATA_DIR points at an empty
// temporary folder for each test. The cookie getter mints against the current
// folder, including when a suite switches DATA_DIR in a later beforeEach.
import { afterEach, beforeEach } from "vitest";

import {
  ADMIN_SESSION_COOKIE,
  createAdminSession,
} from "~/server/auth/operator";
import {
  createTempDataDir,
  type TempDataDir,
} from "~/server/storage/test-data-dir";

/** A token long enough for the operator token rules (40+ characters). */
const TEST_OPERATOR_TOKEN = "o".repeat(48);

export interface OperatorSession {
  /** `name=value`, ready for a Cookie header. Minted for the current DATA_DIR. */
  readonly cookie: string;
  /** `{ cookie }`, to spread into request headers. */
  readonly headers: { cookie: string };
}

/** Registers beforeEach/afterEach hooks; call it at the top of a test file. */
export function registerOperatorSession(): OperatorSession {
  let cookie = "";
  let cookieDir = "";
  let dataDir: TempDataDir | null = null;
  let previousToken: string | undefined;
  let previousLegacy: string | undefined;

  beforeEach(async () => {
    previousToken = process.env.OPERATOR_TOKEN;
    previousLegacy = process.env.VIDEO_ADMIN_TOKEN;
    process.env.OPERATOR_TOKEN = TEST_OPERATOR_TOKEN;
    delete process.env.VIDEO_ADMIN_TOKEN;

    dataDir = await createTempDataDir();
    cookie = "";
    cookieDir = "";
  });

  afterEach(async () => {
    await dataDir?.dispose();
    dataDir = null;

    if (previousToken === undefined) {
      delete process.env.OPERATOR_TOKEN;
    } else {
      process.env.OPERATOR_TOKEN = previousToken;
    }

    if (previousLegacy === undefined) {
      delete process.env.VIDEO_ADMIN_TOKEN;
    } else {
      process.env.VIDEO_ADMIN_TOKEN = previousLegacy;
    }
  });

  function currentCookie(): string {
    const dir = process.env.DATA_DIR;

    if (dir && (!cookie || dir !== cookieDir)) {
      const session = createAdminSession();

      if (!session) {
        throw new Error(
          "The operator token or session store is unavailable for this test.",
        );
      }

      cookie = `${ADMIN_SESSION_COOKIE}=${session.value}`;
      cookieDir = dir;
    }

    return cookie;
  }

  return {
    get cookie() {
      return currentCookie();
    },
    get headers() {
      return { cookie: currentCookie() };
    },
  };
}
