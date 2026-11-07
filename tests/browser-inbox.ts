// Fail closed. Actual browser/API/PostgreSQL integration remains UNRUN.
// The former runner exposed unauthenticated superuser/server-OS authority.
// No bypass: future provisioning/authentication/process ownership needs review.
// Historical logs are unchanged and never certified actual PG integration.
throw new Error('INBOX_PG_INTEGRATION_UNRUN_UNSAFE_RUNNER_DISABLED');
export {};
