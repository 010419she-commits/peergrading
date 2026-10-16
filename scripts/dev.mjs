// Set the development flag without depending on shell-specific environment syntax.
process.env.DEV_LOGIN = "1";
await import("../server.ts");
