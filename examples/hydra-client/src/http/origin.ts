/**
 * Keeping requests on the deployment that was connected to.
 *
 * A deployment may publish IRIs under its canonical origin while answering on another — this one does
 * exactly that, and inconsistently: response bodies are rebased to the request host, the
 * `apiDocumentation` Link header is not, and neither are the query-expansion templates in the
 * vocabulary. So a client following what it reads verbatim from a local boot would send authenticated
 * requests, **including writes**, to production.
 *
 * The only fact in hand at that moment is the origin of the response that carried the IRI, so that is
 * what is used. It is a convention the client invents, which the project's standing rule forbids
 * absent a brick wall — and issuing a POST to the wrong deployment is one. Design D8's treatment
 * applies: apply it, disclose it, record it as a conformance finding. The durable fix is server-side.
 *
 * Discovery (task 3.1) met this first, on the Link header; the execution layer meets it again on every
 * template it expands. The rule lives here, at the layer that owns URLs, so there is one of it.
 */

export interface Rebase {
  readonly url: string
  readonly rebased: boolean
}

/** Rebase an IRI onto an origin, leaving path, query and fragment alone. */
export function rebaseOntoOrigin(advertised: string, respondingOrigin: string): Rebase {
  try {
    const target = new URL(advertised)
    const origin = new URL(respondingOrigin)
    if (target.origin === origin.origin) return { url: advertised, rebased: false }
    return { url: origin.origin + target.pathname + target.search + target.hash, rebased: true }
  } catch {
    // Not an absolute IRI, so there is no origin to disagree about.
    return { url: advertised, rebased: false }
  }
}

/**
 * What the conformance report says about a rebase.
 *
 * One wording, wherever the rebase happens, because it is one defect in the deployment rather than a
 * different one per code path.
 */
export function originMismatchMessage(advertised: string, servingOrigin: string, what: string): string {
  return (
    `${what} is published as <${advertised}>, whose origin is not the ${servingOrigin} this deployment ` +
    `answers on. A client following it verbatim leaves the deployment it connected to, and for a write ` +
    `that means sending data to a different installation. Resolved against the connect origin instead. ` +
    `Publishing IRIs under the request host, as this API already does for response bodies, would fix it.`
  )
}
