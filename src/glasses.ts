// Everything written to the glasses, and every gesture read from them.
//
// One fixed page layout for the whole game (portrait, caption, body, header,
// footer), created once; after that only changed text is re-sent, because
// every write is a BLE round trip. Portraits are pushed only when the subject
// changes.

import {
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  ImageContainerProperty,
  ImageRawDataUpdate,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import type { App } from './app'
import { portrait } from './art'
import type { IconName } from './icons.gen'
import {
  HEADER, BODY, FOOTER, CAPTION, ART,
  spread, footerLine, lensSafe, fitBody, optionRows, captionText, paginate, pageDots,
} from './lens'

export interface GlassesHost {
  createStartUpPageContainer(c: CreateStartUpPageContainer): Promise<number>
  rebuildPageContainer(c: RebuildPageContainer): Promise<boolean>
  textContainerUpgrade(c: TextContainerUpgrade): Promise<boolean>
  updateImageRawData(d: ImageRawDataUpdate): Promise<unknown>
  shutDownPageContainer(mode?: number): Promise<boolean>
}

/** What's on the lens, for the phone's mirror. */
export interface LensFrame {
  header: string
  body: string
  caption: string
  footer: string
  icon: IconName
  dim: boolean
}

const MENU = { sheet: 1, inventory: 2, help: 3, handsFree: 4, hall: 5 } as const

interface Features {
  menu: boolean
  brightness: boolean
}

export class Glasses {
  private features: Features = { menu: true, brightness: true }
  private sent: Record<string, string> = {}
  private artKey = ''
  private queue: Promise<unknown> = Promise.resolve()
  private pending = false
  private started = false
  frame: LensFrame = { header: '', body: '', caption: '', footer: '', icon: 'dice-twenty-faces-twenty', dim: false }

  constructor(
    private host: GlassesHost,
    private app: App,
    private onFrame: (f: LensFrame) => void = () => {},
  ) {
    app.paginator = text => paginate(text)
    app.onChange(() => this.render())
  }

  // --- startup -------------------------------------------------------------------------

  /**
   * The contextual menu and text brightness are newer than the rest of the page
   * API, and an older host may hang instead of refusing them. Each attempt is
   * bounded; a plainer page beats a blank lens.
   */
  async start(): Promise<void> {
    const attempts: Features[] = [
      { menu: true, brightness: true },
      { menu: false, brightness: true },
      { menu: false, brightness: false },
    ]
    let ok = false
    for (const features of attempts) {
      this.features = features
      let result = -1
      try {
        result = await Promise.race([
          this.host.createStartUpPageContainer(new CreateStartUpPageContainer(this.containers())),
          new Promise<number>(resolve => setTimeout(() => resolve(-1), 4000)),
        ])
      } catch (err) {
        console.warn('page refused', features, err)
      }
      if (result === 0) {
        ok = true
        break
      }
    }
    // After a WebView reload the host can keep the previous page, and "success"
    // doesn't mean it was replaced. Rebuild once into a known layout.
    if (!ok) this.features = { menu: true, brightness: false }
    const rebuilt = await this.host.rebuildPageContainer(new RebuildPageContainer(this.containers())).catch(() => false)
    if (!rebuilt && this.features.menu) {
      this.features = { ...this.features, menu: false }
      await this.host.rebuildPageContainer(new RebuildPageContainer(this.containers())).catch(() => false)
    }
    this.started = true
    this.render()
  }

  private text(c: { id: number; name: string; x: number; y: number; w: number; h: number; pad: number; brightness: number; border?: number; radius?: number }, content: string, capture: boolean) {
    return new TextContainerProperty({
      xPosition: c.x,
      yPosition: c.y,
      width: c.w,
      height: c.h,
      borderWidth: c.border ?? 0,
      borderColor: 5,
      ...(c.radius ? { borderRadius: c.radius } : {}),
      paddingLength: c.pad,
      containerID: c.id,
      containerName: c.name,
      content: content || ' ',
      ...(this.features.brightness ? { textColor: c.brightness } : {}),
      isEventCapture: capture ? 1 : 0,
    })
  }

  private containers() {
    const menu = this.features.menu
      ? {
          menuObject: new MenuContainerProperty({
            menuItems: [
              new MenuItemProperty({ itemID: MENU.sheet, itemName: 'Character' }),
              new MenuItemProperty({ itemID: MENU.inventory, itemName: 'Inventory' }),
              new MenuItemProperty({ itemID: MENU.handsFree, itemName: 'Hands-free on/off' }),
              new MenuItemProperty({ itemID: MENU.help, itemName: 'How to play' }),
              new MenuItemProperty({ itemID: MENU.hall, itemName: 'Hall of Fame' }),
            ],
          }),
        }
      : {}
    this.sent = {}
    this.artKey = ''
    return {
      containerTotalNum: 5,
      textObject: [
        this.text(HEADER, ' ', false),
        this.text(BODY, 'Loading...', true),
        this.text(FOOTER, ' ', false),
        this.text(CAPTION, ' ', false),
      ],
      imageObject: [new ImageContainerProperty({ xPosition: ART.x, yPosition: ART.y, width: ART.w, height: ART.h, containerID: ART.id, containerName: ART.name })],
      ...menu,
    }
  }

  // --- input -------------------------------------------------------------------------------

  /** Returns true if the event was a gesture or menu pick (audio is routed elsewhere). */
  handleEvent(event: EvenHubEvent): boolean {
    if (event.menuItemClickEvent?.itemID) {
      this.onMenu(event.menuItemClickEvent.itemID)
      return true
    }
    // CLICK_EVENT is 0 and protobuf drops zero values, so a bare tap arrives
    // as an envelope with no eventType. Default inside the envelope check, or
    // every event without a sysEvent would read as a tap.
    const typeOf = (e?: { eventType?: OsEventTypeList }) => (e ? e.eventType ?? OsEventTypeList.CLICK_EVENT : null)
    const sys = typeOf(event.sysEvent)
    const txt = typeOf(event.textEvent)
    const either = (t: OsEventTypeList) => sys === t || txt === t
    if (either(OsEventTypeList.DOUBLE_CLICK_EVENT)) return this.app.double(), true
    // A long press opens the glasses' own menu; acting on it here too would
    // do something behind that menu.
    if (either(OsEventTypeList.LONG_PRESS_EVENT) || either(OsEventTypeList.LONG_PRESS_RELEASE_EVENT)) return true
    if (txt === OsEventTypeList.SCROLL_TOP_EVENT) return this.app.swipe(-1), true
    if (txt === OsEventTypeList.SCROLL_BOTTOM_EVENT) return this.app.swipe(1), true
    if (either(OsEventTypeList.CLICK_EVENT)) return this.app.tap(), true
    return false
  }

  private onMenu(id: number) {
    if (id === MENU.sheet) return this.app.openPage('sheet')
    if (id === MENU.inventory) return this.app.openPage('inventory')
    if (id === MENU.help) return this.app.openPage('help')
    if (id === MENU.hall) return this.app.openPage('hall')
    if (id === MENU.handsFree) return this.app.toggleHandsFree()
  }

  // --- painting ---------------------------------------------------------------------------

  /** Coalesced: any number of calls while a paint is queued become one paint. */
  render() {
    if (this.pending) return
    this.pending = true
    this.queue = this.queue
      .then(() => {
        this.pending = false
        return this.paint()
      })
      // Load-bearing: one failed write must not leave the chain rejected, or
      // every later paint inherits the failure and the lens freezes.
      .catch(err => console.error('lens paint failed:', err))
  }

  private compose(): LensFrame {
    const app = this.app
    const g = app.game
    const header = spread(app.headerLeft(), app.headerRight())
    if (app.page) {
      const p = app.page
      return {
        header: spread(`◆ ${p.title}`, pageDots(p.index, p.pages.length)),
        body: p.pages[p.index] ?? '',
        caption: p.title,
        footer: footerLine(p.pages.length > 1 ? 'swipe: page   tap: close' : 'tap: close'),
        icon: p.icon,
        dim: false,
      }
    }
    const scene = g.scene()
    const story = app.story()
    const storyText = [story.text, story.tally ? `(${story.tally})` : ''].filter(Boolean).join(' ')
    const opts = app.visibleOptions()
    const highlight = app.selecting ? app.highlight : null
    return {
      header,
      body: fitBody(storyText, scene.prompt, optionRows(opts, highlight), app.narration ? 'start' : 'end'),
      caption: captionText(scene.caption, scene.bar),
      footer: footerLine(app.footer()),
      icon: scene.icon,
      dim: scene.dim,
    }
  }

  private async paint() {
    const f = this.compose()
    this.frame = f
    this.onFrame(f)
    if (!this.started) return
    await this.put(HEADER, f.header)
    await this.put(BODY, f.body)
    await this.put(CAPTION, f.caption)
    await this.put(FOOTER, f.footer)
    await this.pushArt(f.icon, f.dim)
  }

  private async put(c: { id: number; name: string }, content: string) {
    const text = lensSafe(content) || ' '
    const key = `${c.id}:${c.name}`
    if (this.sent[key] === text) return
    await this.host.textContainerUpgrade(new TextContainerUpgrade({ containerID: c.id, containerName: c.name, content: text }))
    this.sent[key] = text
  }

  private async pushArt(icon: IconName, dim: boolean) {
    const key = `${icon}|${dim}`
    if (this.artKey === key) return
    this.artKey = key
    const bytes = await portrait(icon, { size: ART.w, dim })
    if (this.artKey !== key) return // the scene moved on while it rendered
    const result = await this.host.updateImageRawData(new ImageRawDataUpdate({ containerID: ART.id, containerName: ART.name, imageData: bytes }))
    if (result !== 'success') console.warn('portrait push:', result)
  }
}

/** Stands in for the Even bridge in a plain browser. */
export const stubHost: GlassesHost = {
  createStartUpPageContainer: async () => 0,
  rebuildPageContainer: async () => true,
  textContainerUpgrade: async () => true,
  updateImageRawData: async () => 'success',
  shutDownPageContainer: async () => true,
}
