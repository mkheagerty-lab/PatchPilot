/**
 * Ed25519 public key (JWK) used to verify PatchPilot-issued entitlement
 * tokens (see ./entitlement.ts). The matching private key lives only in the
 * `patchpilot-licensing` vendor tool's deployed `.env`
 * (`ENTITLEMENT_SIGNING_PRIVATE_JWK`) and the vendor's password manager —
 * never in this repository. This constant is the only thing an instance
 * needs to verify a token.
 *
 * Deliberately a compiled-in constant, not an env var: an env var would let
 * anyone with shell/deploy access to a self-hosted instance repoint
 * verification at their own keypair and mint themselves an unlimited
 * entitlement, defeating the entire feature. Patching this source file is
 * the honest bar for "vendor-controlled."
 *
 * Real production key, generated 2026-09-02 via patchpilot-licensing's
 * `pnpm keygen`. Rotating this breaks every entitlement token issued against
 * the previous key — see that repo's README for the (currently unbuilt)
 * `kid`-based rotation path before ever changing this value.
 */
export const ENTITLEMENT_PUBLIC_KEY_JWK = {
  kty: "OKP",
  crv: "Ed25519",
  x: "n2IzFqifTR9GWArYj3pO98r6e546nFUdh47r18MeTDs",
} as const;
