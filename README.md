## USAGE

1. Go to https://discord.com/developers to register an application for yourself
2. Go to the OAUTH2 tab on the left for the application you just created
3. Add `http://127.0.0.1` as a redirect link
4. Use your authentication secrets along with the command below

```bash
DISCORD_CLIENT_ID=<discord_client_id> DISCORD_CLIENT_SECRET=<discord_client_secret> node discord-rpc-bridge.js
```

5. Open the html in your browser
