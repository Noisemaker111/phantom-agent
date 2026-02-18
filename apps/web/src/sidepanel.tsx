/**
 * Side Panel entry point.
 *
 * Mounts the PhantomConversation component in full-height side panel mode.
 * No TanStack Router — the extension has no client-side routing.
 * ConvexProvider is initialised directly with the deployment URL.
 */

import { ConvexProvider, ConvexReactClient } from "convex/react";
import React from "react";
import ReactDOM from "react-dom/client";

import { PhantomConversation } from "./components/PhantomConversation";
import "./index.css";

const convexUrl = import.meta.env.VITE_CONVEX_URL as string;
if (!convexUrl) {
  throw new Error("VITE_CONVEX_URL is not set. Add it to apps/web/.env");
}

const convex = new ConvexReactClient(convexUrl);

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found in sidepanel.html");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ConvexProvider client={convex}>
      <PhantomConversation compact={false} />
    </ConvexProvider>
  </React.StrictMode>,
);
