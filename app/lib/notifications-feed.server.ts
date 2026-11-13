import { signUserToken } from "@knocklabs/node";
import { knockEnv } from "~/lib/notifications.server";
import type { NotificationFeedClientConfig } from "~/lib/notifications-feed";

// Signs the per-user feed token (RS256) server-side. The browser then talks
// to the vendor directly with the public key plus this token, and the vendor
// rejects (403) a token on anyone else's feed — per-user security rests with
// the session, so the token is always signed for whoever the session (or the
// DevUI switcher) says is current. Switching users is a full-page POST and
// redirect, so the layout loader re-signs a fresh token on every switch.

// Bounded so a token minted for one DevUI user goes stale quickly; the
// socket re-authentication (#58) refreshes within this window.
const TOKEN_EXPIRY_SECONDS = 60 * 60;

// Null when the Knock keys are missing: keyless dev runs the feed on the
// empty adapter, the way the app runs without a Postmark token.
export async function getNotificationFeedConfig(
  cadenceUserId: number
): Promise<NotificationFeedClientConfig | null> {
  const publicApiKey = knockEnv("KNOCK_PUBLIC_API_KEY");
  const feedChannelId = knockEnv("KNOCK_FEED_CHANNEL_ID");
  const signingKey = knockEnv("KNOCK_SIGNING_KEY");
  if (!publicApiKey || !feedChannelId || !signingKey) return null;

  return {
    knockUserId: String(cadenceUserId),
    userToken: await signUserToken(String(cadenceUserId), {
      signingKey,
      expiresInSeconds: TOKEN_EXPIRY_SECONDS,
    }),
    publicApiKey,
    feedChannelId,
  };
}
