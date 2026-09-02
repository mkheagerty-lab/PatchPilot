/**
 * Ed25519 public key (JWK) used to verify PatchPilot-issued entitlement
 * tokens (see ./entitlement.ts). The matching private key — and the tooling
 * that signs tokens with it — are not part of this repository; this constant
 * is the only thing an instance needs to verify a token.
 *
 * Deliberately a compiled-in constant, not an env var: an env var would let
 * anyone with shell/deploy access to a self-hosted instance repoint
 * verification at their own keypair and mint themselves an unlimited
 * entitlement, defeating the entire feature. Patching this source file is
 * the honest bar for "vendor-controlled."
 *
 * TODO(vendor-tooling): replace with the real PatchPilot public key once the
 * signing tooling produces one. The value below is a throwaway Ed25519
 * keypair generated purely for development/testing — no token signed with
 * its private half should ever be treated as a real entitlement, and that
 * private half is not stored anywhere in this repository.
 */
export const ENTITLEMENT_PUBLIC_KEY_JWK = {
  kty: "OKP",
  crv: "Ed25519",
  x: "sBhfE3pAye2goJOqQXaXg0HOsNDODakicSeOO2OWQZc",
} as const;
