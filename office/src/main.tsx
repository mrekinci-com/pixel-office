import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./theme.css";
import "./style.css";
import "./shell.css";
import "./theme-controls.css";
import "./chat/chat.css";
import "./tasks.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
