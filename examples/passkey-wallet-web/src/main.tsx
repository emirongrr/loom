import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { AppServicesProvider } from "./app/AppServices";
import { NetworkProvider } from "./config/NetworkContext";
import "./styles/tokens.css";
import "./styles/app.css";

const root = document.getElementById("root");
if (!root) throw new Error("wallet root element is missing");

createRoot(root).render(
  <StrictMode>
    <NetworkProvider>
      <AppServicesProvider>
        <App />
      </AppServicesProvider>
    </NetworkProvider>
  </StrictMode>
);
