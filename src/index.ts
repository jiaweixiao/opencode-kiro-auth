import { KiroOAuthPlugin } from './plugin.js'
import { KiroV2Plugin } from './v2/plugin.js'

export { KiroOAuthPlugin } from './plugin.js'
export { KiroV2Plugin } from './v2/plugin.js'

export type { KiroConfig } from './plugin/config/index.js'
export type { KiroAuthMethod, KiroRegion, ManagedAccount } from './plugin/types.js'

/**
 * Single default export serving both plugin generations.
 *
 * OpenCode 1.x reads `server()`; OpenCode 2.x reads `setup()`. The two
 * implementations are independent: V1 returns a hooks object, while V2
 * registers everything through the plugin context.
 *
 * V1 object entrypoints require OpenCode 1.18.29 or newer.
 */
export default {
  ...KiroV2Plugin,
  server: KiroOAuthPlugin
}
