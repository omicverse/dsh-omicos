/**
 * Browser half of @omicverse/dsh-omicos: contributes the「OmicOS」tab to
 * the session view strip. The strip IS the `conversation.view` list slot
 * (verified: the stock 轨迹 tab is itself a `ctx.slots.register({name:
 * 'conversation.view', id: 'trajectory', …})` by dsh-client-ui-trajectory)
 * — same registration, our id, our component.
 *
 * Same plugin entry convention as the host half (named exports; the
 * loader treats the module namespace as the plugin). The `dsh.client`
 * manifest's `inject` edge on dsh-client-ui-conversation guarantees the
 * slot row is declared before this bundle activates.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the slots-service Context merge (ctx.slots) and the
// 'conversation.view' SlotMap row (declared by the slot's owning package)
// into the program so the register call types.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { AccountTab } from './AccountTab.js'

export const name = 'omicos-client'

export const inject = ['slots']

export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'omicos',
        order: 20,
        label: () => 'OmicOS',
      },
      AccountTab,
    ),
  )
}
