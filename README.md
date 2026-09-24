# Delve

An endless, voice-controlled D&D roguelike for Even Realities G2 glasses.

Tap the glasses and say what your hero does: "cast fireball", "attack the second goblin", "drink a potion", "go left",
"buy the ring". You can also say something that isn't on the list, like "kick the brazier onto the orc" or "bribe the
guard". A local AI Dungeon Master then picks an ability check and a DC and writes the outcome, and the dice decide.
Every third floor ends in a boss. Death is permanent, and the dungeon never ends.

## What's in it

- **6 classes**: Fighter, Rogue, Wizard, Cleric, Ranger (starts with a wolf) and Barbarian. Each has its own skills
  (Fireball, Sneak Attack, Rage, Hunter's Mark, Turn Undead and more), which unlock as you level.
- **D&D-style rules**: the six abilities, d20 attacks against AC, crits, saves, proficiency and advantage.
- **Monsters**: 40 of them in 4 tiers, with traits like poison, regeneration, breath weapons, summoning and packs.
  Elite prefixes and 8 bosses cycle back "Ascended" and keep getting tougher, so every run ends eventually.
- **Rooms**: fights, elites, treasure (locks and mimics), shrines, merchants, campfires, traps, mystery events and
  companions to recruit. Each step you choose one of 2–3 doors.
- **Loot**: potions, scrolls, magic weapons (+1 to +5, with flaming, frost, keen, vampiric, venom or holy), armor and
  12 trinkets such as Phoenix Feather, Luckstone and Boots of Speed.
- **Power-ups**: 3 perks to choose from at every level-up, blessings from shrines, and blood pacts.
- **11 companions**, each with an ability: a wolf, a dwarf, an elf archer, an owl, an imp, a fairy, a sellsword, a
  monk, a war priest, a clay golem and a cat.
- **Hall of Fame** for fallen heroes. The current run autosaves after every action.

## How voice works

The G2 SDK gives raw mic audio but no speech recognition, so Delve comes with its own small **Delve server**
(`server/`), which runs on your PC:

```
glasses mic ─PCM─▶ Delve server /stt (Whisper, auto-stop on silence) ─text─▶ intent matcher ─▶ engine
                                                        └─ no match ─▶ /api/chat (Ollama) ─▶ ruling ─▶ engine
```

- **`src/intent.ts`** fuzzy-matches speech to the options on screen. It handles Whisper's spellings ("firebolt",
  "rouge") and numbers ("two", "option 3"). If a sentence clearly means something else ("*throw* my potion at
  him"), it goes to the DM instead.
- **`src/dm.ts`** is the AI Dungeon Master. It narrates each turn, invents Mystery-room encounters and rules on
  freeform actions. Every reply uses an Ollama JSON schema. This stops qwen3's thinking builds from leaking their
  reasoning, since they ignore `think:false`.
- **The engine has final say.** The DM picks an ability, a DC and one effect from a fixed list, then `resolveRuling`
  clamps all of it. A chatty model can't hand out a +10 sword.
- **Without the server** the game is fully playable by gesture: swipe to highlight an option, tap to pick it. You
  can also use the phone.

The Delve server is standalone. It shares no code or process with any other G2 bridge. It needs Python with
`faster-whisper`, `aiohttp`, `numpy` and (optionally) `zeroconf`, plus Ollama running locally.

### Choosing the Dungeon Master's brain

In **Settings → Dungeon Master**, pick one of these providers:

| Provider | Needs | Notes |
|---|---|---|
| Local (Delve server + Ollama) | the Delve server | Free and private. qwen3:4b answers in about 0.4–1.2 s. |
| Claude (Anthropic) | your Anthropic API key | Defaults to `claude-opus-5` at low effort. Refusals fall back to another model server-side. |
| ChatGPT (OpenAI) | your OpenAI API key | Uses strict JSON-schema output. The default is the first of `gpt-5-mini` or `gpt-4.1-mini` your key can use. |
| OpenRouter | your OpenRouter key | Any of its ~400 models with structured-output support. |

The model list is fetched live from the provider, which also checks your key. Keys stay in Delve's private storage
on the phone and are sent only to that provider. Every narrated turn is a small paid call on your account.
Speech-to-text always goes through the Delve server, whichever provider you pick.

`src/llm.ts` makes these calls with plain `fetch` instead of the vendor SDKs. Even Hub's review rejects bundles
that contain URL literals missing from the manifest whitelist, and the SDKs embed documentation links in their
error messages. The only URLs in the bundle are the whitelisted API origins.

## Controls

Options appear on the lens as a list of pills. The one you're on is outlined and bright, and each pill shows a
short detail such as a perk's effect, a door's hint or an item's price. Three fit at a time, and the footer says when
there are more.

| Glasses | Does |
|---|---|
| Swipe | Move between pills. The firmware scrolls the list itself, with no delay. |
| Tap | Pick the pill you're on. **Speak** is always the first pill when voice is set up, so a plain tap means "talk"; tap again to send early. |
| Double-tap | Cancel listening or close a page. Otherwise open the **main menu** (pause), and double-tap again to resume. |
| Press and hold | The glasses menu: Main menu, Character, Inventory, Hands-free, How to play, Hall of Fame. |

The **main menu** opens at launch and whenever you double-tap. It offers Continue, New run (asks before abandoning
your hero), Hall of Fame, How to play, Hands-free and Exit. Your run is saved after every turn, so Exit keeps it.

You can say "menu" or "pause", "inventory", "character", "help", "repeat" and "hands free" at any time. Hands-free
mode reopens the mic after every turn.

## Setup

1. **Run the server** (for voice, and for the local Dungeon Master):
   ```
   cd server
   python -m venv .venv
   .venv\Scripts\pip install -r requirements.txt
   copy config.example.json config.json      # optional: pin "host" to your tailnet IP
   .\start.ps1                              # background; logs to delve-server.log
   ```
   It listens on port **8790**. To start it at every logon, run `.\install-autostart.ps1` once. On a machine with an
   NVIDIA GPU, Whisper runs on CUDA if the `nvidia-cublas-cu12` and `nvidia-cudnn-cu12` wheels are installed;
   otherwise it falls back to the CPU.
2. **Install the app.** Upload `delve.ehpk` in the Even Hub developer portal and install it as a private build.
   Open Delve, go to **Settings**, and enter your PC's MagicDNS name (`your-pc.tailXXXX.ts.net`; `:8790` is
   assumed) or `delve.local` on the same Wi-Fi. Those are the only hosts the manifest whitelists.
3. **Pick the Dungeon Master** under Settings → Dungeon Master: local, or a cloud provider with your API key.

## Development

```
npm run dev        # http://localhost:5175 (phone UI + lens mirror; lens uses a stub host)
npm test           # provider, engine and intent tests, plus a bot that plays 150 runs per class
npm run pack       # build + delve.ehpk
npm run icons      # regenerate src/icons.gen.ts from @iconify-json/game-icons
```

- `/test/voice.html` (dev server only) fakes the Even host and streams `test/fixtures/*.wav` as G2 mic frames. This
  tests the real voice path: STT socket, intent matching and DM rulings. Try `delve.app.tap(); say('bolt')` in
  the console. Point it at a server with `?server=host:port`.
- `?server=host:port` on the dev server also works in the simulator, whose phone page you can't type into.
- Before submitting, run `grep -ohE "(https?|wss?)://[^\"'\`,);]*" dist/assets/*.js | sort -u`. Every hit must be in
  the `app.json` whitelist verbatim. The bundle should contain only `http://delve.local:8790` and the three cloud API origins.

### Balance

The test bot plays with a simple strategy and no real planning. On its median run it dies around floor 3–10,
depending on class; its best runs reach about floor 30. Floors past 16 scale without limit. Tune in
`src/engine/data.ts` (monsters, bosses) and `makeEnemy()` in `src/engine/game.ts`, and re-run `npm test`.

## Credits

Portraits and icons come from [game-icons.net](https://game-icons.net) and are used under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). The artists are Lorc, Delapouite, Skoll, Caro Asercion,
Cathelineau, DarkZaitzev, Starseeker and Willdabeast. The artist for each icon is listed in `src/icons.gen.ts`
(`ICON_AUTHORS`) and credited in the app under Settings. The rules take inspiration from the D&D 5e SRD.

## License

MIT (see `LICENSE`) for the code. The game-icons.net artwork in `src/icons.gen.ts` remains under CC BY 3.0 and must
keep its attribution.
