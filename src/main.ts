// Delve: an endless, voice-driven D&D roguelike for Even G2.
//
// The phone page and the lens are two views over one App. In a plain browser
// (no Even host) the lens runs against a stub, so everything but the glasses
// mic can be developed and tested there.

import { waitForEvenAppBridge, AudioInputSource, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { Game, type Run, type HallEntry } from './engine/game'
import { App } from './app'
import { Glasses, stubHost } from './glasses'
import { mountPhone } from './phone'
import { useHost, readJson, KEYS, migrateSettings, type Settings } from './store'

const BRIDGE_WAIT_MS = 3000

// waitForEvenAppBridge() resolves in any browser; only the Even WebView has
// the flutter_inappwebview handler behind it. Give the host a moment to inject
// it, then fall back to the stub.
async function bridgeOrNull(): Promise<EvenAppBridge | null> {
  const deadline = Date.now() + BRIDGE_WAIT_MS
  while (!(window as { flutter_inappwebview?: unknown }).flutter_inappwebview) {
    if (Date.now() > deadline) return null
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return waitForEvenAppBridge()
}

const bridge = await bridgeOrNull()
useHost(bridge)

const [run, hall, saved] = await Promise.all([
  readJson<Run | null>(KEYS.run, null),
  readJson<HallEntry[]>(KEYS.hall, []),
  readJson<Partial<Settings>>(KEYS.settings, {}),
])
// A save from an incompatible version would crash the engine; start fresh.
const game = new Game(run && run.v === 1 ? run : null, hall)
const settings: Settings = migrateSettings(saved)
// Dev server only: `?server=host:port` points the simulator (whose phone page
// can't be typed into) at a Delve server. import.meta.env.DEV is false in the build.
if (import.meta.env.DEV) {
  const b = new URLSearchParams(location.search).get('server')
  if (b) settings.server = b.startsWith('http') ? b : `http://${b}`
}

let micOn = false
const app = new App(
  game,
  settings,
  {
    async mic(on) {
      if (!bridge || on === micOn) return
      micOn = on
      try {
        await bridge.audioControl(on, on ? AudioInputSource.Glasses : undefined)
      } catch (err) {
        console.warn('mic', err)
      }
    },
    exit() {
      void bridge?.audioControl(false)
      void bridge?.shutDownPageContainer(1)
    },
  },
  Boolean(bridge),
)

let phone: ReturnType<typeof mountPhone> | null = null
const glasses = new Glasses(bridge ?? stubHost, app, frame => phone?.drawLens(frame))
phone = mountPhone(document.querySelector<HTMLElement>('#app')!, app)

if (bridge) {
  bridge.onEvenHubEvent(event => {
    // Mic audio has its own branch and never falls through to gestures.
    const pcm = event.audioEvent?.audioPcm
    if (pcm) return app.pushAudio(pcm)
    glasses.handleEvent(event)
  })
}

await glasses.start()
void app.dm.check()

if (import.meta.env.DEV) Object.assign(window, { delve: { app, game, glasses } })
