import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";

// One page, two windows: the transparent overlay (Bond) and the dashboard.
// Each is loaded lazily so a window only ever gets its OWN styles: the overlay's
// (transparent, no scrolling) must never reach the dashboard, and the dashboard's
// (opaque page background) must never reach the overlay.
const App = lazy(() => import("./App"));
const Dashboard = lazy(() => import("./dashboard/Dashboard"));
const view = new URLSearchParams(location.search).get("view");

if (view !== "dashboard") {
  // The browser's own right-click menu (Refresh, Inspect...) never belongs on a desktop companion.
  document.addEventListener("contextmenu", (e) => e.preventDefault());
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Suspense fallback={null}>{view === "dashboard" ? <Dashboard /> : <App />}</Suspense>
  </React.StrictMode>,
);
