import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

const clientId = process.env.YOUTUBE_CLIENT_ID?.trim();
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET?.trim();
const port = Number(process.env.YOUTUBE_AUTH_PORT ?? 8765);

if (!clientId || !clientSecret) {
  throw new Error(
    "Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env before running this command.",
  );
}

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("YOUTUBE_AUTH_PORT must be a valid port number.");
}

const redirectUri = `http://127.0.0.1:${port}/oauth2/callback`;
const state = randomBytes(24).toString("hex");
const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authorizationUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: "https://www.googleapis.com/auth/youtube.force-ssl",
  access_type: "offline",
  prompt: "consent",
  state,
}).toString();

const result = new Promise<string>((resolve, reject) => {
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", redirectUri);
    if (requestUrl.pathname !== "/oauth2/callback") {
      response.writeHead(404).end("Not found");
      return;
    }

    try {
      if (requestUrl.searchParams.get("state") !== state) {
        throw new Error("OAuth state did not match. Please restart the authorization.");
      }
      const oauthError = requestUrl.searchParams.get("error");
      if (oauthError) {
        throw new Error(`Google authorization failed: ${oauthError}`);
      }
      const code = requestUrl.searchParams.get("code");
      if (!code) throw new Error("Google did not return an authorization code.");

      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }),
      });
      if (!tokenResponse.ok) {
        throw new Error(`Token exchange failed: ${await tokenResponse.text()}`);
      }

      const tokens = (await tokenResponse.json()) as {
        refresh_token?: string;
      };
      if (!tokens.refresh_token) {
        throw new Error(
          "Google did not return a refresh token. Revoke the app grant and run this command again.",
        );
      }

      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<h1>YouTube bot authorized</h1><p>You can close this tab and return to the terminal.</p>",
      );
      resolve(tokens.refresh_token);
    } catch (error) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : "Authorization failed");
      reject(error);
    } finally {
      server.close();
    }
  });

  server.on("error", reject);
  server.listen(port, "127.0.0.1", () => {
    console.info("\nOpen this URL in a browser and authorize the YouTube channel the bot should use:\n");
    console.info(authorizationUrl.toString());
    console.info("\nWaiting for Google to redirect back...\n");
  });

  const timeout = setTimeout(() => {
    server.close();
    reject(new Error("Authorization timed out after 10 minutes."));
  }, 10 * 60 * 1_000);
  timeout.unref();
});

const refreshToken = await result;
console.info("\nAdd this line to .env, then keep that file private:\n");
console.info(`YOUTUBE_REFRESH_TOKEN=${refreshToken}\n`);
