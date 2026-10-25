/**
 * The deployment's own trouble, from the SandboxProvider or the
 * SecretProvider: the provider refused the credentials or settings this
 * worker was started with — an API key it rejects, an identity without
 * the permissions it needs, a project or environment that doesn't
 * exist. Every request fails the same way until an operator fixes the
 * configuration, whatever session asks.
 *
 * The driver does not retry a bind that fails with it: it takes the
 * crash path, so a misconfigured worker restarts loudly instead of
 * holding every tool batch until the bind deadline. Not a
 * SandboxProvisionError, either: that ends the session's run, blaming
 * its config for what is the worker's. Adapters MUST throw it only for
 * a refusal no retry can change — never for an outage or a rate limit,
 * which the driver rides out.
 */
export class ProviderConfigError extends Error {}
