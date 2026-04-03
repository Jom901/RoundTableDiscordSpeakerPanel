<img width="2556" height="1305" alt="Screenshot_20260403_124906" src="https://github.com/user-attachments/assets/cfbadb40-b639-42b1-9939-ece02f89d125" />

## Features
1. Lists participants
1. Automatically picks up list of users in your channel
2. Automatically removes users from list of participants
3. Automatically lights up users who are actively speaking/triggering discord's mic recording

## USAGE

1. Go to https://discord.com/developers to register an application for yourself
2. Go to the OAUTH2 tab on the left for the application you just created
3. Add `http://127.0.0.1` as a redirect link
4. Use your authentication secrets along with the command below

```bash
DISCORD_CLIENT_ID=<discord_client_id> DISCORD_CLIENT_SECRET=<discord_client_secret> node discord-rpc-bridge.js
```

5. Open the html in your browser

