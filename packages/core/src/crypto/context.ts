/**
 * The encryption context of a provider credential record. Both the api (when encrypting) and the worker (when
 * decrypting) build it from the same three facts, so a ciphertext copied to another row, scope or provider no
 * longer decrypts (see `encryptSecret`).
 */
export const credentialContext = (
  scope: { installationId: string; repoId?: string | null },
  provider: string,
): string => `credential:${scope.installationId}:${scope.repoId ?? "-"}:${provider}`;
