import React from "react";
import { createRoot } from "react-dom/client";
import { setNonce } from "get-nonce";
import "./i18n";
import "./styles.css";
import { csrfToken } from "./lib/api";
import App from "./App";

setNonce(csrfToken());
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
