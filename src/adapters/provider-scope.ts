/**
 * Stable, secret-free identity for provider-native continuation data.
 *
 * Reasoning signatures/encrypted payloads are only valid for the protocol,
 * endpoint, and model that produced them. Query strings and URL credentials
 * are deliberately removed so provider_data can be persisted safely.
 */
export function providerScope(protocol: string, baseUrl: string, model: string): string {
  let endpoint = baseUrl.trim().replace(/\/+$/, "");
  try {
    const url = new URL(endpoint);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    endpoint = `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    // A non-URL local endpoint is still useful as an opaque scope. Strip the
    // most common secret-bearing suffixes without rejecting custom transports.
    endpoint = endpoint.split(/[?#]/, 1)[0];
  }
  return `${protocol}:${endpoint}:${model.trim()}`;
}
