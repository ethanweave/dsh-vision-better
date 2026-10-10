/**
 * Route decision for one turn: does the live session model see images natively?
 *
 * Capability comes from the same source the host uses for admission
 * (`llm.resolveModelInfo`). Policy, per the product spec:
 *  - declared image support  -> native: the relay never runs (0 requests);
 *  - declared text only      -> relay;
 *  - undeclared (`undefined`) -> relay: unknown is NEVER treated as support.
 */

/** @typedef {'native' | 'relay'} Route */

/**
 * @param {{ inputModalities?: readonly string[] } | undefined} modelInfo resolved model metadata.
 * @returns {Route} whether the turn goes native or through the relay.
 */
export function routeFor(modelInfo) {
  const modalities = modelInfo?.inputModalities;
  return Array.isArray(modalities) && modalities.includes("image") ? "native" : "relay";
}

/**
 * Human-readable reason for a route, for diagnostics and the settings page.
 * @param {{ inputModalities?: readonly string[] } | undefined} modelInfo resolved model metadata.
 * @returns {'declared-image' | 'declared-text-only' | 'undeclared'} reason tag.
 */
export function routeReason(modelInfo) {
  const modalities = modelInfo?.inputModalities;
  if (!Array.isArray(modalities)) return "undeclared";
  return modalities.includes("image") ? "declared-image" : "declared-text-only";
}
