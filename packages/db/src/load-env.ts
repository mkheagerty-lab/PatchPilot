import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Loads the repo-root `.env` into process.env BEFORE DATABASE_URL is read.
 *
 * The standalone db scripts (`pnpm db:migrate`, `pnpm db:seed`) run via tsx with
 * cwd = packages/db and no injected environment, so without this they never see
 * the root `.env` and fail with "DATABASE_URL is not set". Docker Compose injects
 * env directly (the file may be absent there), hence the existence guard. Node
 * does not overwrite already-set vars, so shell/Compose values take precedence.
 * Import this FIRST in any standalone db entrypoint.
 */
function loadRootEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      const envPath = join(dir, ".env");
      if (existsSync(envPath)) {
        (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(envPath);
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

loadRootEnv();
