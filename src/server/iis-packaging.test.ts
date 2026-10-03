import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");

function read(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function readIfPresent(relativePath: string): string {
  const full = path.join(root, relativePath);

  return existsSync(full) ? readFileSync(full, "utf8") : "";
}

describe("next.config.js", () => {
  const source = read("next.config.js");

  it("always builds the standalone output", () => {
    expect(source).toMatch(/output:\s*["']standalone["']/);
    expect(source).not.toMatch(/output:[^\n]*\?/);
  });

  it("keeps project sources out of the traced output", () => {
    // A dynamic path in a server module made Turbopack trace the module's
    // whole folder, tests included, into .next/standalone/src.
    expect(source).toMatch(
      /outputFileTracingExcludes:\s*{[^}]*"\/\*\*":\s*\[\s*"\.\/src\/\*\*"/,
    );
  });

  it("no longer transpiles the removed S3 client", () => {
    expect(source).not.toContain("@aws-sdk");
  });

  it("no longer reads the Railway build flag", () => {
    expect(source).not.toContain("RAILWAY_DOCKER_BUILD");
  });
});

describe("package.json engines", () => {
  it("allows Node 24 (local) and Node 25 (host)", () => {
    const pkg = JSON.parse(read("package.json")) as {
      engines: { node: string };
    };

    expect(pkg.engines.node).toBe(">=24 <26");
  });
});

describe("deploy/iis/web.config", () => {
  const config = readIfPresent("deploy/iis/web.config");

  it("exists", () => {
    expect(existsSync(path.join(root, "deploy/iis/web.config"))).toBe(true);
  });

  it("configures the httpPlatformHandler for long SSE streams", () => {
    expect(config).toContain('responseBufferLimit="0"');
    expect(config).toContain('requestTimeout="00:10:00"');
    expect(config).toContain('processPath="node"');
    expect(config).toContain('arguments="server.js"');
    expect(config).toContain(
      String.raw`stdoutLogFile=".\App_Data\logs\node.log"`,
    );
  });

  it("keeps the panel's HTTPS redirect rule", () => {
    expect(config).toContain('name="httpTohttps"');
  });

  it("omits the sections this host locks (HTTP 500)", () => {
    expect(config).not.toMatch(/urlCompression/i);
    expect(config).not.toMatch(/requestFiltering/i);
  });

  it.each([
    ["PORT", "%HTTP_PLATFORM_PORT%"],
    ["NODE_ENV", "production"],
    ["HOSTNAME", "127.0.0.1"],
    ["DATA_DIR", "App_Data"],
    ["SSE_FLUSH_PAD_BYTES", "9216"],
  ])("sets %s", (name, value) => {
    expect(config).toContain(
      `<environmentVariable name="${name}" value="${value}" />`,
    );
  });

  it("holds no secrets", () => {
    for (const name of [
      "OPERATOR_TOKEN",
      "AI_API_KEY",
      "GITHUB_PAT",
      "GITHUB_TOKEN",
      "CACHE_KEY_SECRET",
      "VIDEO_ADMIN_TOKEN",
    ]) {
      expect(config).not.toContain(name);
    }

    expect(config).not.toMatch(/OPENAI_|ANTHROPIC_|OPENROUTER_/);
  });
});

describe("scripts/package-iis.ps1", () => {
  const script = readIfPresent("scripts/package-iis.ps1");

  it("exists", () => {
    expect(existsSync(path.join(root, "scripts/package-iis.ps1"))).toBe(true);
  });

  it("fails fast", () => {
    expect(script).toMatch(/Set-StrictMode/);
    expect(script).toMatch(/\$ErrorActionPreference\s*=\s*['"]Stop['"]/);
  });

  it("copies public and static assets into the standalone folder", () => {
    expect(script).toMatch(/public/);
    expect(script).toMatch(/\.next[\/]+static/);
    expect(script).toMatch(/\.next[\/]+standalone/);
  });

  it("copies the IIS web.config", () => {
    expect(script).toMatch(/deploy[\/]+iis[\/]+web\.config/);
  });

  it("ships the log folder", () => {
    expect(script).toMatch(/App_Data[\/]+logs/);
    expect(script).toContain(".keep");
  });

  it("keeps .env files out of the package", () => {
    expect(script).toMatch(/\.env/);
    expect(script).toMatch(/Remove-Item|throw/);
  });

  it("refuses a package that carries project sources", () => {
    expect(script).toMatch(/\$sources = Join-Path \$standalone 'src'/);
    expect(script).toMatch(/if \(Test-Path \$sources\) {\s*throw/);
  });

  it("produces a zip", () => {
    expect(script).toMatch(/Compress-Archive|\.zip|ZipFile/);
  });
});

describe("scripts/check-video-render-tracing.mjs", () => {
  it("has no route ceiling above 40 MB (no bundled Chromium)", () => {
    const source = read("scripts/check-video-render-tracing.mjs");
    const ceilings = [...source.matchAll(/maxBytes:\s*(\d+)\s*\*\s*MB/g)].map(
      (match) => Number(match[1]),
    );

    expect(ceilings.length).toBeGreaterThan(0);

    for (const ceiling of ceilings) {
      expect(ceiling).toBeLessThanOrEqual(40);
    }
  });
});
