import jwt from "@tsndr/cloudflare-worker-jwt";
import {
  RegistryTokenCapability,
  RegistryAuthProtocolTokenPayload,
  stripUsernamePasswordFromHeader,
  Authenticator,
} from "./auth";
import { base64UrlDecode } from "./utils";

/**
 * Reduces an audience value to a canonical `host[:port]` string for comparison.
 *
 * Accepts the two spellings that are in use:
 *   - a full origin, e.g. "https://registry.example", which is what
 *     `createToken()` documents and what its `registryUrl` argument implies
 *   - a bare host, e.g. "registry.example" or "registry.example:8787"
 *
 * The scheme is deliberately ignored. Two registries are distinguished by host,
 * not by whether a given request arrived over http or https, so comparing hosts
 * is what the cross-registry threat model actually calls for and it keeps local
 * http development working against tokens minted with an https audience.
 *
 * Returns null when the value is empty or cannot be read as either spelling.
 * Callers must treat null as a verification failure.
 */
function normalizeAudience(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }

  // Absolute URL form.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const { host } = new URL(trimmed);
      return host === "" ? null : host.toLowerCase();
    } catch {
      return null;
    }
  }

  // Bare host form. Reject anything carrying a path, query, fragment, or
  // userinfo so that a malformed audience can never normalize onto another
  // host (e.g. "registry-a.example@registry-b.example").
  if (/[/?#@\\]/.test(trimmed)) {
    return null;
  }

  try {
    const { host } = new URL(`https://${trimmed}`);
    return host === "" ? null : host.toLowerCase();
  } catch {
    return null;
  }
}

export function importKeyFromBase64(key: string): JsonWebKeyWithKid {
  // Decodes the base64 value and performs unicode normalization.
  // The library's `JsonWebKeyWithKid` type requires `kid`, but ES256/HS256 sign
  // and verify only need the key material at runtime, so casting is safe.
  return JSON.parse(base64UrlDecode(key)) as JsonWebKeyWithKid;
}

export async function newRegistryTokens(jwtPublicKey: string): Promise<RegistryTokens> {
  return new RegistryTokens(importKeyFromBase64(jwtPublicKey));
}

export class RegistryTokens implements Authenticator {
  private jwtPublicKey: JsonWebKeyWithKid;
  authmode: string;

  constructor(jwtPublicKey: JsonWebKeyWithKid) {
    this.authmode = "RegistryTokens";
    this.jwtPublicKey = jwtPublicKey;
  }

  /**
   * Very util function that showcases how do we generate private and public keys
   *
   * @example
   *    // Sample usage:
   *    try {
   *      const [privateKey, publicKey] = await RegistryTokens.createPrivateAndPublicKey();
   *      const registryTokens = await newRegistryTokens(publicKey);
   *      const token = await registryTokens.createToken("some-account-id", ["pull", "push"], 30, privateKey, "https://hello.com");
   *      const result = await registryTokens.verifyToken(request, token);
   *      console.log(JSON.stringify(result));
   *    } catch (err) {
   *      console.log("Error generating keys:", err.message);
   *    }
   */
  static async createPrivateAndPublicKey(): Promise<[string, string]> {
    const key = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const exportedPrivateKey = btoa(JSON.stringify(await crypto.subtle.exportKey("jwk", key.privateKey)));
    const exportedPublicKey = btoa(JSON.stringify(await crypto.subtle.exportKey("jwk", key.publicKey)));
    return [exportedPrivateKey, exportedPublicKey];
  }

  /**
   * @param registryUrl The registry this token may be used against, recorded as
   * the `aud` claim and enforced by {@link RegistryTokens.verifyAudience}. Accepts
   * an origin ("https://registry.example") or a bare host ("registry.example:8787");
   * only host and port are compared, scheme and path are ignored.
   */
  async createToken(
    accountID: string,
    caps: RegistryTokenCapability[],
    expirationMinutes: number,
    privateKeyString: string,
    registryUrl: string,
  ): Promise<string> {
    const privateKey = importKeyFromBase64(privateKeyString);
    // password is the signed JWT from the tokenPayload. Clients would treat this as an opaque identifier
    const tokenPayload: RegistryAuthProtocolTokenPayload = {
      username: "v0",
      account_id: accountID,
      capabilities: caps,
      exp: Math.floor(Date.now() / 1000) + 60 * expirationMinutes,
      aud: registryUrl,
    };

    const token = await jwt.sign(tokenPayload, privateKey, {
      algorithm: "ES256",
    });

    return token;
  }

  static checkIfV2OnlyPath(request: Request): boolean {
    return request.url.endsWith("/v2/");
  }

  async verifyToken(
    request: Request,
    token: string,
  ): Promise<{
    verified: boolean;
    payload: RegistryAuthProtocolTokenPayload | null;
  }> {
    try {
      // first verify the JWT
      if (!(await jwt.verify(token, this.jwtPublicKey, { algorithm: "ES256" }))) {
        console.warn("verifyToken: jwt.verify() failed");
        return { verified: false, payload: null };
      }

      // the JWT signature is valid, decode it now
      const decoded = jwt.decode(token);
      const payload = decoded.payload as RegistryAuthProtocolTokenPayload;

      // A valid signature only proves the token came from a trusted issuer. It
      // says nothing about which registry the issuer minted it for, so bind the
      // token to this registry before honouring any of its capabilities.
      if (!RegistryTokens.verifyAudience(request, payload)) {
        return { verified: false, payload: null };
      }

      return RegistryTokens.verifyPayload(request, payload);
    } catch (error) {
      // If the verification fails (e.g., due to token expiration or signature mismatch),
      // jwt.verify() will throw an error which we can catch here.

      // We could throw this error further up to allow more specific error handling,
      // or simply return {verified: false, payload: null  }to indicate token verification failure.
      console.warn(`verifyToken: ${(error as Error).message}`);
      return { verified: false, payload: null };
    }
  }

  /**
   * Checks that this token was minted for this registry.
   *
   * `createToken()` records the target registry in the `aud` claim. Without
   * this check, every registry that trusts the same `JWT_REGISTRY_TOKENS_PUBLIC_KEY`
   * accepts tokens minted for any of the others, so a token holder on one
   * registry can cross into another (for example dev into prod). This registry
   * applies no per-account or per-repository scoping, so such a token grants
   * the full extent of its capabilities against the whole target registry.
   *
   * Tokens without a usable `aud` are rejected: `aud` is a required field of
   * RegistryAuthProtocolTokenPayload and is always set by `createToken()`, so
   * accepting tokens that omit it would leave the bypass permanently open.
   */
  static verifyAudience(request: Request, payload: RegistryAuthProtocolTokenPayload): boolean {
    // Guard the type at runtime: RFC 7519 also permits `aud` to be an array,
    // which this registry does not issue and does not accept.
    if (typeof payload.aud !== "string") {
      console.warn("verifyToken: failed jwt verification: token is missing a string 'aud' claim");
      return false;
    }

    const audience = normalizeAudience(payload.aud);
    if (audience === null) {
      console.warn("verifyToken: failed jwt verification: token 'aud' claim is not a usable registry host");
      return false;
    }

    const expected = new URL(request.url).host.toLowerCase();
    if (audience !== expected) {
      // Neither value is secret, and a mismatch is usually a misconfigured
      // issuer, so log both to make that diagnosable.
      console.warn(
        `verifyToken: failed jwt verification: token audience "${audience}" does not match this registry "${expected}"`,
      );
      return false;
    }

    return true;
  }

  static verifyPayload(request: Request, payload: RegistryAuthProtocolTokenPayload) {
    // Check if token has expired
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && now >= payload.exp) {
      // The token has expired
      console.warn(`verifyV0Token: failed jwt verification: the token has expired`);
      return { verified: false, payload: null };
    }

    // ensure capabilities are satisfied
    switch (request.method) {
      // PULL or PUSH methods
      case "HEAD":
        // HEAD requests can be used by pushers like docker
        if (!payload.capabilities.includes("pull") && !payload.capabilities.includes("push")) {
          console.warn(
            `verifyToken: failed jwt verification: missing any capability for HEAD request in ${request.url}`,
          );
          return { verified: false, payload: null };
        }
        break;
      // PULL method
      case "GET":
        if (this.checkIfV2OnlyPath(request) && payload.capabilities.length === 0) {
          console.warn("verifyToken: failed jwt verification: missing any capabilities for GET request in /v2/");
          return { verified: false, payload: null };
        }

        if (this.checkIfV2OnlyPath(request)) {
          return { verified: true, payload };
        }

        if (!payload.capabilities.includes("pull")) {
          console.warn(
            `verifyToken: failed jwt verification: missing "pull" capability for ${request.method} HTTP method in ${request.url}`,
          );
          return { verified: false, payload: null };
        }
        break;

      // PUSH methods
      case "POST":
      case "PUT":
      case "DELETE":
      case "PATCH":
        if (!payload.capabilities.includes("push")) {
          console.warn(
            `verifyToken: failed jwt verification: missing "push" capability for ${request.method} HTTP method`,
          );
          return { verified: false, payload: null };
        }
        break;
      default:
        return { verified: false, payload: null };
    }

    return { verified: true, payload };
  }

  async checkCredentials(request: Request): Promise<{
    verified: boolean;
    payload: RegistryAuthProtocolTokenPayload | null;
  }> {
    const res = stripUsernamePasswordFromHeader(request);
    if ("verified" in res) {
      return res;
    }

    const [, password] = res;
    return this.verifyToken(request, password);
  }
}
