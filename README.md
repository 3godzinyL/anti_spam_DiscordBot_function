[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)](https://discord.js.org/)
[![License](https://img.shields.io/badge/license-MIT-informational)](#)


# 💚 Node.js · 💛 JavaScript · 💙 Discord — Anti-Spam AutoMod


> **Anti-spam feature (AutoMod)** to include a Discord bot in your project.  
> Drop-in, ESM-friendly, with log channel, temp notices (auto-delete), and smart cooldowns.

---

## ✨ Features (at a glance)

| Features | Preview |
|----------|---------|
| - 🔗 **Multi-channel link spam** → instant **ban** (log only in your mod-log channel)<br>- 🧵 **Same text across 3+ channels (<3.5s)** → **24h mute**, Level-3 warning<br>- 🔁 **3× identical message (<2s)**<br>&nbsp;&nbsp;&nbsp;&nbsp;- text → **15m mute**<br>&nbsp;&nbsp;&nbsp;&nbsp;- text+link / link → **1h mute**<br>- ⚡ **Burst spam (≥5 msgs in <2s)**<br>&nbsp;&nbsp;&nbsp;&nbsp;- text → **30m mute** (L1)<br>&nbsp;&nbsp;&nbsp;&nbsp;- text+link / link → **3h mute** (L2)<br>- 🧹 **Temp notices auto-delete after 10s**<br>- 🧷 **Persistent logs** go only to your **LOG channel**<br>- 🛡️ **Auto “Muted” role**<br>- 🧊 Cooldown to prevent duplicate sanctions | <img src="https://cdn.discordapp.com/attachments/1421206587640381531/1421214768177483806/image.png?ex=68d838e5&is=68d6e765&hm=73af8fb6d7a723ebdbce2bcf00080f5979e64d94a85ac90923a11bbf91c3331d&" width="350"/> |

---

## 🚀 Quick Start (copy & paste)

> Your project must be **ESM** (have `"type": "module"` in `package.json`) and use **discord.js v14**.

1. **Add the file** `automod.js` to your bot’s root.

2. **Wire it in** your `index.js` (or main file):

```js
// index.js (ESM)
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { handleSpamDetection } from './automod.js'; // ⬅️ AutoMod (ESM export)

// Minimal client with required intents:
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,   // ⬅️ REQUIRED to read message text
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

// Hook: one-liner with safety
client.on('messageCreate', (m) => handleSpamDetection(m).catch(console.error));

client.login(process.env.DISCORD_TOKEN);
```

> **Alternative import** (if you prefer namespace style):
```js
import * as automod from './automod.js';
const { handleSpamDetection } = automod;
```

3. **Permissions the bot needs on the server**
   - `Manage Roles`, `Manage Channels`, `Manage Messages`, `Read Message History`
   - For auto-ban on link spam across channels: `Ban Members`

4. **Developer Portal → Bot → Privileged Gateway Intents**
   - Enable **Message Content Intent** ✅

---

## ⚙️ Configuration

Open `automod.js` and adjust, if needed:

```js
// Log channel (persistent embeds stay here)
const LOG_CHANNEL_ID = "1421196548833935510";

// Windows (ms) + thresholds
const SAME_MSG_WINDOW_MS = 2000;     // identical 3x in <2s
const BURST_WINDOW_MS    = 2000;     // ≥5 msgs in <2s (same channel)
const MULTI_CH_WINDOW_MS = 3500;     // same text across ≥3 channels in <3.5s

const IDENTICAL_COUNT = 3;           // identical trigger
const BURST_COUNT     = 5;           // burst trigger
const MULTI_CH_COUNT  = 3;           // channels trigger (multi-channel)
```

> The module auto-creates a `Muted` role with sane deny overwrites if it’s missing.

---

## 🧭 What AutoMod recognizes & how it reacts

| Scenario | Threshold | Action | Note |
|---|---:|---|---|
| **Identical message (same channel)** | **3×** in **<2s** | **15m mute** | if **text only** |
| Identical message (contains **link** or text+link) | 3× in <2s | **1h mute** + L2 warning | deletes those duplicates |
| **Burst spam** (same channel) | **≥5** in **<2s** | **30m mute** + L1 | text only |
| Burst spam (contains **link** or text+link) | ≥5 in <2s | **3h mute** + L2 | deletes the burst |
| **Multi-channel spam** (same text) | **3+ channels** in **<3.5s** | **24h mute** + L3 | text only |
| Multi-channel **link** spam (or text+link) | 3+ channels in <3.5s | **BAN** | zero tolerance |

- 🧹 In spammed channels: the bot posts a short notice and **auto-deletes it after 10s**  
- 📌 In **LOG channel**: it posts a persistent **embed** with all details (user, channels, action)

---

## 🎬 Demos

> Drop your own GIFs showcasing the behavior:

- **Single-channel spam (text/links)**  

  ![Single-channel spam demo](/0926.gif)

- **Multi-channel spam (same text or links across channels)**  

  ![Multi-channel spam demo](/0926_1_.gif)

---

## 🧠 How it works (under the hood)

<details>
<summary><strong>Rolling per-user window</strong></summary>

- For every message we record `{ ts, channelId, content, isLink, messageId }` in a short in-memory log per user (pruned to a few seconds).
- Detection functions run on this rolling window:
  - **`detectIdentical`** → groups by normalized text within `SAME_MSG_WINDOW_MS`
  - **`detectBurst`** → counts messages in `BURST_WINDOW_MS` for the same channel
  - **`detectMultiChannel`** → finds the same normalized text across `MULTI_CH_COUNT` channels within `MULTI_CH_WINDOW_MS`
- A small **cooldown** prevents duplicate sanctions being applied for the same burst in quick succession.
</details>

<details>
<summary><strong>Actions & hygiene</strong></summary>

- On triggers, the bot **deletes** the offending messages (bulk if possible).
- **Mutes** add the `Muted` role (created automatically if missing), with per-channel deny overwrites for sending.
- **Unmutes** are timed via `setTimeout` (15m / 30m / 1h / 3h / 24h).
- **Bans** apply for multi-channel link spam (requires `Ban Members` permission).
- **Temp notices** are posted in the spammed channel(s) and removed after **10s** to keep channels clean.
- **Persistent logs** are embedded to `LOG_CHANNEL_ID` only.
</details>

---

## 🧩 Drop-in to other bots

- Ensure your bot uses **ESM** and has **Message Content Intent** enabled.
- Import & attach a message listener (either form works):

```js
// ESM named import
import { handleSpamDetection } from './automod.js';
client.on('messageCreate', (m) => handleSpamDetection(m).catch(console.error));

// or namespace import
import * as automod from './automod.js';
client.on('messageCreate', (m) => automod.handleSpamDetection(m).catch(console.error));
```

- Provide required **permissions** to the bot role, and set your **LOG channel ID**.

---

## ✅ Checklist

- [ ] `package.json` has `"type": "module"`
- [ ] `discord.js` v14 installed
- [ ] Gateway **Message Content Intent** enabled
- [ ] Bot role has: Manage Roles, Manage Channels, Manage Messages, Read Message History (and **Ban Members** if you want autoban)
- [ ] `LOG_CHANNEL_ID` set in `automod.js`

---

## 📝 License

Released under the **MIT License** — do whatever, just leave a credit. Happy moderating! 🎯
