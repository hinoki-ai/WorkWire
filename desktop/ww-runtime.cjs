const { app, protocol } = require("electron");

if (!app.isReady()) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "app",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

(async () => {
  const runtime = await import("./ww-runtime.mjs");
  const result = await runtime.runPackagedWwRuntime();
  if (result === "exit") {
    process.exit(process.exitCode ?? 0);
  }
})().catch((error) => {
  console.error("[WorkWire runtime] Failed to start.", error);
  process.exit(1);
});
