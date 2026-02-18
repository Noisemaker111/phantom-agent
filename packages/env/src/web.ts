import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  clientPrefix: "VITE_",
  client: {
    VITE_CONVEX_URL: z.string().url(),
    VITE_CONVEX_SITE_URL: z.string().url(),
    /**
     * Your Phantom Portal application ID.
     * Required for the OAuth PKCE flow in the background service worker.
     * Register at: https://developer.phantom.app
     */
    VITE_PHANTOM_APP_ID: z.string().min(1),
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runtimeEnv: (import.meta as any).env,
  emptyStringAsUndefined: true,
});
