import { useEffect, useState } from "react";

type ApiState = "checking" | "ok" | "unreachable";

export function App() {
  const [api, setApi] = useState<ApiState>("checking");

  useEffect(() => {
    fetch("/healthz")
      .then((res) => setApi(res.ok ? "ok" : "unreachable"))
      .catch(() => setApi("unreachable"));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", margin: "4rem auto", maxWidth: "40rem" }}>
      <h1>AI PR Review</h1>
      <p>Hello from the dashboard stub. Real screens arrive in Phase 10.</p>
      <p>
        API: <strong>{api}</strong>
      </p>
    </main>
  );
}
