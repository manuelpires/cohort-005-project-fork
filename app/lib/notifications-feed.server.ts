import { knockEnv, signFeedUserToken } from "~/lib/notifications.server";
import type { NotificationFeedClientConfig } from "~/lib/notifications-feed";

// Signs the per-user feed token server-side, behind the notification
// adapter (notifications.server.ts) — the key loading and the vendor's
// token shape stay Knock-side. The browser then talks to the vendor
// directly with the public key plus this token, and the vendor rejects
// (403) a token on anyone else's feed — per-user security rests with the
// session, so the token is always signed for whoever the session (or the
// DevUI switcher) says is current. Switching users is a full-page POST and
// redirect, so the layout loader re-signs a fresh token on every switch.

// Null when the Knock keys are missing: keyless dev runs the feed on the
// empty adapter, the way the app runs without a Postmark token.
export async function getNotificationFeedConfig(
  cadenceUserId: number
): Promise<NotificationFeedClientConfig | null> {
  const publicApiKey = knockEnv("KNOCK_PUBLIC_API_KEY");
  const feedChannelId = knockEnv("KNOCK_FEED_CHANNEL_ID");
  const userToken = await signFeedUserToken(cadenceUserId);
  if (!publicApiKey || !feedChannelId || !userToken) return null;

  return {
    knockUserId: String(cadenceUserId),
    userToken,
    publicApiKey,
    feedChannelId,
  };
}
