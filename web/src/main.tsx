import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuditPage } from "./components/audit-page";
import { auditScope } from "./lib/view";
import "./index.css";

function Root() {
  const [scope, setScope] = useState(() => auditScope());
  useEffect(() => {
    const change = () => setScope(auditScope());
    addEventListener("hashchange", change);
    return () => removeEventListener("hashchange", change);
  }, []);
  return scope ? <AuditPage key={scope} scope={scope} /> : <App key="notes" />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
