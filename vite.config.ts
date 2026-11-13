import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createInterpretHandler } from "./server/interpret";

export default defineConfig({
  plugins: [react(), {
    name: "local-interpret-api",
    configureServer(server) {
      const interpret = createInterpretHandler();
      server.middlewares.use("/api/interpret", async (incoming, outgoing) => {
        try {
          const chunks: Buffer[] = [];
          let length = 0;
          for await (const chunk of incoming) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            length += buffer.byteLength;
            if (length > 4096) {
              outgoing.writeHead(413, { "Content-Type": "application/json", "Cache-Control": "no-store" });
              outgoing.end(JSON.stringify({ error: "Yêu cầu quá lớn.", code: "BODY_TOO_LARGE" }));
              return;
            }
            chunks.push(buffer);
          }
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (value) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
          }
          const method = incoming.method ?? "GET";
          const request = new Request(`http://${incoming.headers.host}/api/interpret`, {
            method,
            headers,
            body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
          });
          const response = await interpret(request);
          outgoing.writeHead(response.status, Object.fromEntries(response.headers));
          outgoing.end(await response.text());
        } catch {
          console.error("Local interpretation adapter failed");
          outgoing.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          outgoing.end(JSON.stringify({ error: "Không thể kết nối API local.", code: "LOCAL_API_ERROR" }));
        }
      });
    },
  }],
});
