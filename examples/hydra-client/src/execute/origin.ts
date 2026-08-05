import { originMismatchMessage, rebaseOntoOrigin } from '../http/origin'
import { FINDING_KINDS, type Findings } from '../rdf/findings'
import type { Trace } from '../trace'

/**
 * Rebasing, with the disclosure that makes it honest (see `http/origin.ts` for the rule itself).
 *
 * The disclosure is not decoration. A silent rebase would be the client quietly rewriting an address
 * the server published, which is indistinguishable from the URL construction this whole component
 * exists to remove. Applied, said out loud, recorded — design D8's shape for every degradation.
 */

export interface DisclosureDeps {
  /** The origin this session is actually talking to. */
  readonly origin: string
  readonly findings: Findings
  readonly trace: Trace
}

export function rebaseAndDisclose(advertised: string, what: string, deps: DisclosureDeps): string {
  const { url, rebased } = rebaseOntoOrigin(advertised, deps.origin)
  if (!rebased) return url

  deps.trace.log(
    `${what} names ${advertised}, a different origin than the one serving this session. ` +
      `Using ${url} instead — recorded as a finding.`,
    'warn',
  )
  deps.findings.record({
    about: advertised,
    kind: FINDING_KINDS.originMismatch,
    message: originMismatchMessage(advertised, `origin ${new URL(deps.origin).origin}`, what),
  })

  return url
}
