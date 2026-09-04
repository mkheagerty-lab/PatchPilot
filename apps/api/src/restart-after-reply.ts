import type { FastifyReply } from "fastify";

/**
 * Exits the process once `reply` has actually finished writing to the
 * socket, instead of guessing a fixed delay is "long enough".
 *
 * Three routes need this shape — onboarding-pairing.ts's /api/onboarding/pair,
 * and domains.ts's /verify and /delete — because each one flips config that
 * only takes effect on next boot (fresh Entra credentials, a newly-active
 * custom domain's login origin), and Compose's restart policy is the
 * mechanism that brings the process back with it applied.
 *
 * All three used to call `setTimeout(() => process.exit(0), 250)` right
 * after `reply.send(...)`, on the theory that 250ms is enough time for the
 * response to flush. That held up fine in-process (Fastify's `inject()` in
 * tests, and evidently the pairing script's direct HTTP client against this
 * exact VM) but live-observed on this same VM: clicking "Verify" on a custom
 * domain through the browser, over the real Caddy HTTPS reverse-proxy hop,
 * intermittently got a network error even though the server-side write
 * (`custom_domains.status = 'active'`) had already succeeded — the process
 * exiting before the last bytes made it through Caddy to the browser, not a
 * DNS or logic bug. `reply.raw`'s `finish` event fires once Node has hands
 * the complete response to the OS socket buffer, which is the actual signal
 * we want instead of a guess; `fallbackMs` still bounds the wait so a client
 * that disconnects early (or a 'finish' that never fires) can't hang the
 * process open indefinitely.
 */
export function exitAfterReply(reply: FastifyReply, opts: { drainMs?: number; fallbackMs?: number } = {}): void {
  const drainMs = opts.drainMs ?? 200;
  const fallbackMs = opts.fallbackMs ?? 2000;

  let exited = false;
  const exit = () => {
    if (exited) return;
    exited = true;
    process.exit(0);
  };

  reply.raw.once("finish", () => setTimeout(exit, drainMs));
  // Belt-and-suspenders: still restart even if the socket never reports
  // "finish" (client vanished mid-response, etc.) — matches the old
  // behavior's guarantee of eventually restarting, just not on the critical
  // path for the common case anymore.
  setTimeout(exit, fallbackMs);
}
