# Incident log

Closed incidents affecting a deployed PatchPilot instance, newest first. This
is a factual record (what broke, why, how it was fixed and verified) — not a
process document. For day-to-day Azure VM operations, see
[infra/azure/README.md](../infra/azure/README.md), which now also has a
[Troubleshooting](../infra/azure/README.md#troubleshooting) section pointing
back here.

## 2026-09-05 — Self-update to v0.4.0 took the site down; recovered, then a second latent bug surfaced during verification

**Status:** Closed. Both root causes are fixed on `main` and in tagged
releases (v0.4.1, v0.4.2), applied to the affected VM, and confirmed durable
for both existing and newly-deployed VMs (see "Durability" below).

### Impact

The production Azure VM became unreachable (connection failures / no HTTPS
response) after Settings > Updates applied the v0.4.0 release via the
`updater` sidecar's self-update mechanism.

### Bug 1 — `updater` bind-mounted the repo checkout at a path that didn't match its real location on the host

**Root cause:** the `updater` sidecar reaches the **host's** Docker daemon
through a mounted `/var/run/docker.sock`, but the `docker compose` CLI it
invokes still runs *inside* that container and resolves the compose file's
relative bind-mount sources (`./Caddyfile`, `./backup.sh`) against **its
own** container-local working directory. The resulting absolute path is then
sent to the host daemon as a literal bind-mount source, which the host
resolves against the **real host filesystem** — not the updater container's
view of it.

The `updater` container mounted the checkout at `/repo`, but the real host
path (set up by `cloud-init.yaml` and documented throughout
`infra/azure/README.md`) is `/opt/patchpilot`. That mismatch meant every
path `docker compose` resolved inside the updater container was wrong on the
host side. Docker silently auto-created the (nonexistent) resolved path as
an empty directory and then failed any file bind-mount with "not a
directory: are you trying to mount a directory onto a file" — for the
`caddy` and `backup` services specifically, since they're the two services
with file (not directory) bind-mounts. `caddy` failing to start took the
whole site down.

**Fix:** mount the checkout inside the `updater` container at the exact same
absolute path it has on the real host (`/opt/patchpilot` on both sides), so
paths `docker compose` resolves locally are valid wherever the host daemon
resolves them too. See the comment on the `updater` service in
[infra/docker-compose.yml](../infra/docker-compose.yml) and in
[infra/updater/run.sh](../infra/updater/run.sh) for the full explanation,
kept in place so this doesn't regress.

**Shipped as:** [v0.4.1](../CHANGELOG.md#041---2026-09-05).

**Immediate remediation:** recreated the `caddy`/`backup` containers
directly on the host to restore service while the code fix was prepared,
then applied the real fix via a hotfix push directly to the VM, followed by
the formal PR/release/redeploy.

### Bug 2 — a run could succeed but its DB write-back could still fail, stranding it at `status='running'`

Found only because we didn't stop at "containers recovered" — we triggered a
**real** self-update through the actual `update_runs`/`updater` mechanism to
prove the fix held end-to-end, not just a manual container restart. The
update itself completed successfully, but the run's row in `update_runs`
never left `status='running'`.

**Root cause:** `run.sh` captures build output with `tail -c 20000`, which
cuts on a raw byte count, not a character boundary. Landing mid-multi-byte
UTF-8 character leaves an orphaned continuation byte, which Postgres
correctly rejects (`invalid byte sequence for encoding "UTF8"`) — failing
the `UPDATE ... SET status=..., output=...` write-back entirely, even though
the update it was reporting on had genuinely succeeded.

**Fix:** sanitize captured output to printable ASCII (+ tab/LF/CR) before it
ever reaches `psql` — the `output` column is a diagnostic log, not something
requiring non-ASCII fidelity — plus a status-only write-back retry as a
second line of defense, so a run can never be permanently stranded at
`status='running'` purely because of its log content. See `sanitize_output`
in [infra/updater/run.sh](../infra/updater/run.sh).

**Shipped as:** [v0.4.2](../CHANGELOG.md#042---2026-09-05).

**Data correction:** the one affected row from the live verification run was
manually updated to `status='succeeded'` in the production database, since
the container state and the updater's own log line both independently
confirmed the underlying update had genuinely succeeded.

### Verification performed

- Real self-update triggered end-to-end via `update_runs`/the `updater`
  sidecar (not a manual container restart) against the live VM, post-fix —
  completed with the site reachable throughout and the run row correctly
  reaching `status='succeeded'`.
- Confirmed in Settings > Updates in the live UI.

### Durability (existing VMs and new deployments)

- Both fixes live on `main` and in tagged releases, so every future
  self-update on any existing VM carries them automatically.
- `infra/azure/main.bicep`'s `repoRef` defaults to `main`, so a brand-new VM
  deployed with default parameters gets both fixes from first boot.
- First boot was never exposed to Bug 1's bug class in the first place:
  `cloud-init.yaml` runs `docker compose up -d --build` directly on the
  host, with no nested container or Docker-socket involved — that path only
  exists for the `updater` sidecar's later self-updates.
