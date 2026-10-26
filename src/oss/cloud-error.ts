/** Shared cloud boundary error; DTO validation does not depend on the credential-owning service. */
export class CloudError extends Error { constructor(readonly status: number, message: string) { super(message) } }
