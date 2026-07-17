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
  await import("./ww-main.mjs");
})().catch((error) => {
  console.error("[WW bootstrap] Failed to start WW.", error);
  process.exit(1);
});
